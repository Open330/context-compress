import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { SubprocessExecutor } from "./executor.js";
import { debug, error as logError } from "./logger.js";
import { type RuntimeMap, detectRuntimes, hasBun } from "./runtime/index.js";
import { SessionTracker } from "./stats.js";
import { ContentStore, cleanupStaleDbs } from "./store.js";
import type { Language } from "./types.js";

const LANGUAGES: [Language, ...Language[]] = [
	"javascript",
	"typescript",
	"python",
	"shell",
	"ruby",
	"go",
	"rust",
	"php",
	"perl",
	"r",
	"elixir",
];

function getVersion(): string {
	try {
		const __dirname = dirname(fileURLToPath(import.meta.url));
		const pkgPath = join(__dirname, "..", "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return pkg.version ?? "1.0.0";
	} catch {
		return "1.0.0";
	}
}

export async function createServer(config: Config) {
	const version = getVersion();
	debug("Version:", version);

	// Cleanup stale databases from previous sessions
	cleanupStaleDbs();

	// Detect runtimes in parallel
	const runtimes = await detectRuntimes();
	const bunDetected = hasBun(runtimes);
	debug("Runtimes detected:", runtimes.size);

	const executor = new SubprocessExecutor(runtimes, config);
	const store = new ContentStore();
	const tracker = new SessionTracker();

	// Search throttling state
	const searchCalls: number[] = [];

	const server = new McpServer({
		name: "context-compress",
		version,
	});

	// ─── Tool: execute ──────────────────────────────────────

	server.tool(
		"execute",
		`Execute code in a sandboxed subprocess. Only stdout enters context — raw data stays in the subprocess. Use instead of bash/cat when output would exceed 20 lines. ${bunDetected ? "(Bun detected — JS/TS runs 3-5x faster) " : ""}Available: ${LANGUAGES.join(", ")}.

PREFER THIS OVER BASH for: API calls (gh, curl, aws), test runners (npm test, pytest), git queries (git log, git diff), data processing, and ANY CLI command that may produce large output. Bash should only be used for file mutations, git writes, and navigation.`,
		{
			language: z.enum(LANGUAGES).describe("Runtime language"),
			code: z
				.string()
				.describe(
					"Source code to execute. Use console.log (JS/TS), print (Python/Ruby/Perl/R), echo (Shell), echo (PHP), fmt.Println (Go), or IO.puts (Elixir) to output a summary to context.",
				),
			intent: z
				.string()
				.optional()
				.describe(
					"What you're looking for in the output. When provided and output is large (>5KB), indexes output into knowledge base and returns section titles + previews — not full content. Use search(queries: [...]) to retrieve specific sections.",
				),
			timeout: z.number().default(30000).describe("Max execution time in ms"),
		},
		async ({ language, code, intent, timeout }) => {
			const result = await executor.execute({ language, code, timeout });

			if (result.networkBytes) {
				tracker.trackSandboxed(result.networkBytes);
			}

			let output = result.stdout;
			if (result.stderr && result.exitCode !== 0) {
				output += `\n\nSTDERR:\n${result.stderr}`;
			}

			// Intent-driven filtering for large outputs
			if (intent && Buffer.byteLength(output) > config.intentSearchThreshold) {
				const indexed = store.index(output, `execute:${language}`);
				tracker.trackIndexed(Buffer.byteLength(output));

				const searchResults = store.search(intent, { limit: 3 });
				const terms = store.getDistinctiveTerms(indexed.sourceId);

				let filtered = `Indexed ${indexed.totalChunks} sections from execute output.\n`;
				filtered += `${searchResults.results.length} sections matched "${intent}":\n\n`;
				for (const hit of searchResults.results) {
					filtered += `  - **${hit.title}**: ${hit.snippet.slice(0, 200)}\n`;
				}
				if (terms.length > 0) {
					filtered += `\nSearchable terms: ${terms.join(", ")}\n`;
				}
				filtered += "\nUse search(queries: [...]) to retrieve full content of any section.";
				output = filtered;
			}

			const responseBytes = Buffer.byteLength(output);
			tracker.trackCall("execute", responseBytes);

			return { content: [{ type: "text" as const, text: output }] };
		},
	);

	// ─── Tool: execute_file ─────────────────────────────────

	server.tool(
		"execute_file",
		"Read a file and process it without loading contents into context. The file is read into a FILE_CONTENT variable inside the sandbox. Only your printed summary enters context.\n\nPREFER THIS OVER Read/cat for: log files, data files (CSV, JSON, XML), large source files for analysis, and any file where you need to extract specific information rather than read the entire content.",
		{
			path: z.string().describe("Absolute file path or relative to project root"),
			language: z.enum(LANGUAGES).describe("Runtime language"),
			code: z
				.string()
				.describe(
					"Code to process FILE_CONTENT. Print summary via console.log/print/echo/IO.puts.",
				),
			intent: z.string().optional().describe("What you're looking for in the output."),
			timeout: z.number().default(30000).describe("Max execution time in ms"),
		},
		async ({ path: filePath, language, code, intent, timeout }) => {
			const absPath = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), filePath);

			const result = await executor.executeFile({
				language,
				code,
				filePath: absPath,
				timeout,
			});

			let output = result.stdout;
			if (result.stderr && result.exitCode !== 0) {
				output += `\n\nSTDERR:\n${result.stderr}`;
			}

			// Intent-driven filtering
			if (intent && Buffer.byteLength(output) > config.intentSearchThreshold) {
				const indexed = store.index(output, `file:${filePath}`);
				tracker.trackIndexed(Buffer.byteLength(output));

				const searchResults = store.search(intent, { limit: 3 });
				const terms = store.getDistinctiveTerms(indexed.sourceId);

				let filtered = `Indexed ${indexed.totalChunks} sections from "${filePath}" into knowledge base.\n`;
				filtered += `${searchResults.results.length} sections matched "${intent}":\n\n`;
				for (const hit of searchResults.results) {
					filtered += `  - **${hit.title}**: ${hit.snippet.slice(0, 200)}\n`;
				}
				if (terms.length > 0) {
					filtered += `\nSearchable terms: ${terms.join(", ")}\n`;
				}
				filtered += "\nUse search(queries: [...]) to retrieve full content of any section.";
				output = filtered;
			}

			const responseBytes = Buffer.byteLength(output);
			tracker.trackCall("execute_file", responseBytes);

			return { content: [{ type: "text" as const, text: output }] };
		},
	);

	// ─── Tool: index ────────────────────────────────────────

	server.tool(
		"index",
		"Index documentation or knowledge content into a searchable BM25 knowledge base. Chunks markdown by headings (keeping code blocks intact) and stores in ephemeral FTS5 database. The full content does NOT stay in context — only a brief summary is returned.\n\nWHEN TO USE:\n- Documentation (API docs, framework guides, code examples)\n- README files, migration guides, changelog entries\n- Any content with code examples you may need to reference precisely\n\nAfter indexing, use 'search' to retrieve specific sections on-demand.",
		{
			content: z
				.string()
				.optional()
				.describe("Raw text/markdown to index. Provide this OR path, not both."),
			path: z
				.string()
				.optional()
				.describe("File path to read and index (content never enters context)."),
			source: z.string().optional().describe("Label for the indexed content"),
		},
		async ({ content, path: filePath, source }) => {
			let text: string;
			let label = source ?? "indexed content";

			if (filePath) {
				const absPath = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), filePath);
				text = readFileSync(absPath, "utf-8");
				label = source ?? filePath;
			} else if (content) {
				text = content;
			} else {
				return {
					content: [{ type: "text" as const, text: "Error: provide either 'content' or 'path'" }],
				};
			}

			const result = store.index(text, label);
			tracker.trackIndexed(Buffer.byteLength(text));

			const summary = `Indexed "${label}": ${result.totalChunks} chunks (${result.codeChunks} with code). Use search(queries: [...]) to retrieve sections.`;
			tracker.trackCall("index", Buffer.byteLength(summary));

			return { content: [{ type: "text" as const, text: summary }] };
		},
	);

	// ─── Tool: search ───────────────────────────────────────

	server.tool(
		"search",
		"Search indexed content. Pass ALL search questions as queries array in ONE call.\n\nTIPS: 2-4 specific terms per query. Use 'source' to scope results.",
		{
			queries: z
				.array(z.string())
				.describe("Array of search queries. Batch ALL questions in one call."),
			source: z
				.string()
				.optional()
				.describe("Filter to a specific indexed source (partial match)."),
			limit: z.number().default(3).describe("Results per query (default: 3)"),
		},
		async ({ queries, source, limit }) => {
			// Progressive throttling
			const now = Date.now();
			searchCalls.push(now);
			// Clean old entries outside window
			while (searchCalls.length > 0 && searchCalls[0] < now - config.searchWindowMs) {
				searchCalls.shift();
			}

			const callCount = searchCalls.length;

			if (callCount > config.searchBlockAfter) {
				const msg =
					"Too many search calls in quick succession. Use batch_execute instead to run commands and search in one call.";
				tracker.trackCall("search", Buffer.byteLength(msg));
				return { content: [{ type: "text" as const, text: msg }] };
			}

			const effectiveLimit =
				callCount > config.searchReduceAfter ? 1 : Math.min(limit, config.searchLimit);

			const allResults: string[] = [];
			let totalBytes = 0;

			for (const query of queries) {
				if (totalBytes > config.searchMaxBytes) break;

				const result = store.search(query, { source, limit: effectiveLimit });

				let block = `## ${query}\n`;
				if (result.corrected) {
					block += `(corrected to: "${result.corrected}")\n`;
				}

				if (result.results.length === 0) {
					block += "No results found.\n";
				} else {
					for (const hit of result.results) {
						block += `\n--- [${hit.source}] ---\n### ${hit.title}\n\n${hit.snippet}\n`;
					}
				}

				allResults.push(block);
				totalBytes += Buffer.byteLength(block);
			}

			if (callCount > config.searchReduceAfter) {
				allResults.push(
					`\n⚠ Search rate limited (${callCount} calls in ${config.searchWindowMs / 1000}s). Results reduced to 1 per query.`,
				);
			}

			const output = allResults.join("\n---\n\n");
			tracker.trackCall("search", Buffer.byteLength(output));

			return { content: [{ type: "text" as const, text: output }] };
		},
	);

	// ─── Tool: fetch_and_index ──────────────────────────────

	server.tool(
		"fetch_and_index",
		"Fetches URL content, converts HTML to markdown, indexes into searchable knowledge base, and returns a ~3KB preview. Full content stays in sandbox — use search() for deeper lookups.\n\nBetter than WebFetch: preview is immediate, full content is searchable, raw HTML never enters context.",
		{
			url: z.string().describe("The URL to fetch and index"),
			source: z.string().optional().describe("Label for the indexed content"),
		},
		async ({ url, source }) => {
			const label = source ?? url;

			// Use executor to fetch and convert HTML to markdown in subprocess
			const fetchCode = buildFetchCode(url);
			const result = await executor.execute({
				language: "javascript",
				code: fetchCode,
				timeout: 30_000,
			});

			if (result.exitCode !== 0 || !result.stdout.trim()) {
				const errMsg = `Failed to fetch ${url}: ${result.stderr || "empty response"}`;
				tracker.trackCall("fetch_and_index", Buffer.byteLength(errMsg));
				return { content: [{ type: "text" as const, text: errMsg }] };
			}

			const markdown = result.stdout;
			tracker.trackSandboxed(result.networkBytes ?? 0);

			const indexed = store.index(markdown, label);
			tracker.trackIndexed(Buffer.byteLength(markdown));

			// Return ~3KB preview
			const preview = markdown.slice(0, 3072);
			const terms = store.getDistinctiveTerms(indexed.sourceId);

			let output = `Indexed "${label}": ${indexed.totalChunks} chunks.\n\n`;
			output += `**Preview:**\n${preview}`;
			if (markdown.length > 3072) output += "\n…(truncated)";
			if (terms.length > 0) {
				output += `\n\nSearchable terms: ${terms.join(", ")}`;
			}
			output += "\n\nUse search(queries: [...]) to retrieve full content of any section.";

			tracker.trackCall("fetch_and_index", Buffer.byteLength(output));

			return { content: [{ type: "text" as const, text: output }] };
		},
	);

	// ─── Tool: batch_execute ────────────────────────────────

	server.tool(
		"batch_execute",
		"Execute multiple commands in ONE call, auto-index all output, and search with multiple queries. Returns search results directly — no follow-up calls needed.\n\nTHIS IS THE PRIMARY TOOL. Use this instead of multiple execute() calls.\n\nOne batch_execute call replaces 30+ execute calls + 10+ search calls.\nProvide all commands to run and all queries to search — everything happens in one round trip.",
		{
			commands: z
				.array(
					z.object({
						label: z.string().describe("Section header for this command's output"),
						command: z.string().describe("Shell command to execute"),
					}),
				)
				.describe("Commands to execute as a batch."),
			queries: z
				.array(z.string())
				.describe(
					"Search queries to extract information from indexed output. Use 5-8 comprehensive queries.",
				),
			timeout: z.number().default(60000).describe("Max execution time in ms (default: 60s)"),
		},
		async ({ commands, queries, timeout }) => {
			// Performance fix: Execute all commands in parallel with Promise.allSettled
			const commandResults = await Promise.allSettled(
				commands.map(async (cmd) => {
					const result = await executor.execute({
						language: "shell",
						code: cmd.command,
						timeout,
					});
					return { label: cmd.label, result };
				}),
			);

			// Build combined output with markdown sections
			let combined = "";
			const inventory: string[] = [];

			for (let i = 0; i < commandResults.length; i++) {
				const settled = commandResults[i];
				const label = commands[i].label;

				if (settled.status === "fulfilled") {
					const { result } = settled.value;
					const output = result.stdout || "(no output)";
					combined += `## ${label}\n\n${output}\n\n`;
					const lineCount = output.split("\n").length;
					inventory.push(`- **${label}**: ${lineCount} lines`);
				} else {
					combined += `## ${label}\n\n(error: ${settled.reason})\n\n`;
					inventory.push(`- **${label}**: error`);
				}
			}

			// Index combined output
			const indexed = store.index(combined, "batch_execute");
			tracker.trackIndexed(Buffer.byteLength(combined));

			// Run all search queries
			const searchResults: string[] = [];
			let totalBytes = 0;

			for (const query of queries) {
				if (totalBytes > config.batchMaxBytes) break;

				// Try scoped search first, then global fallback
				let result = store.search(query, { source: "batch_execute", limit: 5 });
				if (result.results.length === 0) {
					result = store.search(query, { limit: 5 });
				}

				let block = `## ${query}\n\n`;
				if (result.results.length === 0) {
					block += "No results found.\n";
				} else {
					for (const hit of result.results) {
						block += `--- [${hit.source}] ---\n### ${hit.title}\n\n${hit.snippet}\n\n`;
					}
				}

				searchResults.push(block);
				totalBytes += Buffer.byteLength(block);
			}

			const terms = store.getDistinctiveTerms(indexed.sourceId);

			let output = `**Inventory** (${commands.length} commands):\n${inventory.join("\n")}\n\n`;
			output += searchResults.join("\n---\n\n");
			if (terms.length > 0) {
				output += `\n\nSearchable terms: ${terms.join(", ")}`;
			}

			tracker.trackCall("batch_execute", Buffer.byteLength(output));

			return { content: [{ type: "text" as const, text: output }] };
		},
	);

	// ─── Tool: stats ────────────────────────────────────────

	server.tool(
		"stats",
		"Returns context consumption statistics for the current session. Shows total bytes returned to context, breakdown by tool, call counts, estimated token usage, and context savings ratio.",
		{},
		async () => {
			const report = tracker.formatReport();
			tracker.trackCall("stats", Buffer.byteLength(report));
			return { content: [{ type: "text" as const, text: report }] };
		},
	);

	// ─── Transport ──────────────────────────────────────────

	return {
		async start() {
			const transport = new StdioServerTransport();
			await server.connect(transport);
			debug("MCP server started on stdio");
		},
	};
}

// ─── HTML to Markdown conversion code (runs in subprocess) ──

function buildFetchCode(url: string): string {
	const escaped = JSON.stringify(url);
	return `
const url = ${escaped};
const resp = await fetch(url);
if (!resp.ok) { console.error("HTTP " + resp.status); process.exit(1); }
const html = await resp.text();

// Strip unwanted tags
let md = html
  .replace(/<script[^>]*>[\\s\\S]*?<\\/script>/gi, "")
  .replace(/<style[^>]*>[\\s\\S]*?<\\/style>/gi, "")
  .replace(/<nav[^>]*>[\\s\\S]*?<\\/nav>/gi, "")
  .replace(/<header[^>]*>[\\s\\S]*?<\\/header>/gi, "")
  .replace(/<footer[^>]*>[\\s\\S]*?<\\/footer>/gi, "");

// Convert headings
md = md.replace(/<h1[^>]*>(.*?)<\\/h1>/gi, "# $1\\n");
md = md.replace(/<h2[^>]*>(.*?)<\\/h2>/gi, "## $1\\n");
md = md.replace(/<h3[^>]*>(.*?)<\\/h3>/gi, "### $1\\n");
md = md.replace(/<h4[^>]*>(.*?)<\\/h4>/gi, "#### $1\\n");

// Convert code blocks
md = md.replace(/<pre[^>]*><code[^>]*>(.*?)<\\/code><\\/pre>/gis, "\`\`\`\\n$1\\n\`\`\`\\n");
md = md.replace(/<code[^>]*>(.*?)<\\/code>/gi, "\`$1\`");

// Convert links
md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\\/a>/gi, "[$2]($1)");

// Convert lists
md = md.replace(/<li[^>]*>(.*?)<\\/li>/gi, "- $1\\n");

// Convert paragraphs
md = md.replace(/<p[^>]*>(.*?)<\\/p>/gis, "$1\\n\\n");
md = md.replace(/<br\\s*\\/?>/gi, "\\n");

// Strip remaining tags
md = md.replace(/<[^>]+>/g, "");

// Decode entities
md = md.replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, " ");

// Clean whitespace
md = md.replace(/\\n{3,}/g, "\\n\\n").trim();

console.log(md);
`;
}
