import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExecResult, SearchResult } from "../types.js";
import { limitConcurrency } from "../utils.js";
import type { ToolContext } from "./context.js";

function getExecutionStatus(result: ExecResult): string {
	if (result.killed) return "killed";
	if (result.exitCode === 0) return "completed";
	if (result.exitCode === null) return "unknown";
	return "failed";
}

function formatCommandResult(
	label: string,
	result: ExecResult,
): { corpus: string; inventory: string } {
	const output = result.indexableStdout || "(no output)";
	const lineCount = (result.stdout || "(no output)").split("\n").length;
	const status = getExecutionStatus(result);
	const exitCode = result.exitCode === null ? "unknown" : String(result.exitCode);
	const diagnostics = [
		"### Execution diagnostics",
		`Status: ${status}`,
		`Exit code: ${exitCode}`,
		`Killed: ${result.killed ? "yes" : "no"}`,
		`Output truncated: ${result.truncated ? "yes" : "no"}`,
	].join("\n");
	const stderr = result.stderr ? `\n\n### STDERR\n\n${result.stderr}` : "";
	const corpus = `## ${label}\n\n${output}\n\n${diagnostics}${stderr}`;

	if (result.exitCode === 0 && !result.killed && !result.truncated) {
		return { corpus, inventory: `- **${label}**: ${lineCount} lines` };
	}

	const states: string[] = [];
	if (status === "failed") states.push("failed");
	if (result.killed) states.push("killed");
	if (result.truncated) states.push("truncated");
	return {
		corpus,
		inventory: `- **${label}**: ${lineCount} lines — ${states.join(", ") || status} (exit ${exitCode})`,
	};
}

function formatSearchBlock(query: string, result: SearchResult): string {
	let block = `## ${query}\n\n`;
	if (result.results.length === 0) return `${block}No results found.\n`;

	for (const hit of result.results) {
		block += `--- [${hit.source}] ---\n### ${hit.title}\n\n${hit.snippet}\n\n`;
	}
	return block;
}

export function registerBatchExecuteTool(server: McpServer, ctx: ToolContext): void {
	const { executor, store, tracker, config, withExecutionLimit } = ctx;

	server.registerTool(
		"batch_execute",
		{
			title: "Run commands and search in one call",
			description:
				"Execute multiple commands in ONE call, auto-index all output, and search with multiple queries. Returns search results directly — no follow-up calls needed.\n\nTHIS IS THE PRIMARY TOOL. Use this instead of multiple execute() calls.\n\nOne batch_execute call replaces 30+ execute calls + 10+ search calls.\nProvide all commands to run and all queries to search — everything happens in one round trip.",
			inputSchema: {
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
			// Runs arbitrary shell commands — same pessimistic hints as `execute`.
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async ({ commands, queries, timeout }) => {
			const commandResults = await limitConcurrency(
				commands.map((cmd) => async () => {
					const result = await withExecutionLimit(() =>
						executor.execute({
							language: "shell",
							code: cmd.command,
							timeout,
						}),
					);
					return { label: cmd.label, result };
				}),
				4,
			);

			const inventory: string[] = [];
			const indexedSourceIds: number[] = [];

			for (let i = 0; i < commandResults.length; i++) {
				const settled = commandResults[i];
				const label = commands[i].label;

				if (settled.status === "fulfilled") {
					const { result } = settled.value;
					const { corpus, inventory: inventoryEntry } = formatCommandResult(label, result);
					const indexed = store.index(corpus, "batch_execute");
					indexedSourceIds.push(indexed.sourceId);
					tracker.trackIndexed(Buffer.byteLength(corpus));
					inventory.push(inventoryEntry);
				} else {
					const errorOutput = `## ${label}\n\n(error: ${settled.reason})`;
					const indexed = store.index(errorOutput, "batch_execute");
					indexedSourceIds.push(indexed.sourceId);
					tracker.trackIndexed(Buffer.byteLength(errorOutput));
					inventory.push(`- **${label}**: error`);
				}
			}

			const searchResults: string[] = [];
			let totalBytes = 0;

			for (const query of queries) {
				if (totalBytes > config.batchMaxBytes) break;

				let result = store.search(query, { source: "batch_execute", limit: 5 });
				if (result.results.length === 0) {
					result = store.search(query, { limit: 5 });
				}

				const block = formatSearchBlock(query, result);

				searchResults.push(block);
				totalBytes += Buffer.byteLength(block);
			}

			const terms = [
				...new Set(indexedSourceIds.flatMap((sourceId) => store.getDistinctiveTerms(sourceId))),
			].slice(0, 40);

			let output = `**Inventory** (${commands.length} commands):\n${inventory.join("\n")}\n\n`;
			output += searchResults.join("\n---\n\n");
			if (terms.length > 0) {
				output += `\n\nSearchable terms: ${terms.join(", ")}`;
			}

			tracker.trackCall("batch_execute", Buffer.byteLength(output));

			return { content: [{ type: "text" as const, text: output }] };
		},
	);
}
