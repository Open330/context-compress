import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isPrivateHost, resolveAndValidate } from "../network.js";
import type { ExecResult } from "../types.js";
import { buildFetchCode } from "../util/fetch-code.js";
import { detectInjectionPatterns } from "../utils.js";
import type { ToolContext } from "./context.js";

export function registerFetchAndIndexTool(server: McpServer, ctx: ToolContext): void {
	const { executor, store, tracker, withExecutionLimit } = ctx;

	server.registerTool(
		"fetch_and_index",
		{
			title: "Fetch a URL and index it",
			description:
				"Fetches URL content, converts HTML to markdown, indexes into searchable knowledge base, and returns a ~3KB preview. Full content stays in sandbox — use search() for deeper lookups.\n\nBetter than WebFetch: preview is immediate, full content is searchable, raw HTML never enters context.",
			inputSchema: {
				url: z.string().describe("The URL to fetch and index"),
				source: z.string().optional().describe("Label for the indexed content"),
			},
			// Reaches arbitrary external hosts (SSRF-filtered), then writes to the
			// knowledge base. Additive, so not destructive.
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async ({ url, source }) => {
			try {
				const parsed = new URL(url);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					return {
						content: [{ type: "text" as const, text: "Error: only http/https URLs are allowed" }],
						isError: true,
					};
				}
				if (isPrivateHost(parsed.hostname)) {
					return {
						content: [
							{ type: "text" as const, text: "Error: internal/private URLs are not allowed" },
						],
						isError: true,
					};
				}
			} catch {
				return {
					content: [{ type: "text" as const, text: `Error: invalid URL "${url}"` }],
					isError: true,
				};
			}

			let resolvedIp: string | null = null;
			try {
				const validated = await resolveAndValidate(url);
				resolvedIp = validated.resolvedIp;
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: ${err instanceof Error ? err.message : "DNS validation failed"}`,
						},
					],
					isError: true,
				};
			}

			const label = source ?? url;
			const fetchCode = buildFetchCode(url, resolvedIp);
			let result: ExecResult;
			try {
				result = await withExecutionLimit(() =>
					executor.execute({
						language: "javascript",
						code: fetchCode,
						timeout: 30_000,
						// Not negotiable: Bun's node:http shim ignores both `lookup` and
						// `createConnection`, so the IP pinning that defends against DNS
						// rebinding would be silently inert there. See fetch-code.ts.
						requireRuntime: "node",
					}),
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { content: [{ type: "text" as const, text: msg }], isError: true };
			}

			if (result.exitCode !== 0 || !result.indexableStdout.trim()) {
				const errMsg = `Failed to fetch ${url}: ${result.stderr || "empty response"}`;
				tracker.trackCall("fetch_and_index", Buffer.byteLength(errMsg));
				return { content: [{ type: "text" as const, text: errMsg }], isError: true };
			}

			const markdown = result.indexableStdout;
			const responseMarkdown = result.stdout;
			tracker.trackSandboxed(result.networkBytes ?? 0);

			const injectionWarnings = detectInjectionPatterns(markdown);

			const indexed = store.index(markdown, label);
			tracker.trackIndexed(Buffer.byteLength(markdown));

			const preview = responseMarkdown.slice(0, 3072);
			const terms = store.getDistinctiveTerms(indexed.sourceId);

			let output = `Indexed "${label}": ${indexed.totalChunks} chunks.\n\n`;
			output += `**Preview:**\n${preview}`;
			if (responseMarkdown.length > 3072) output += "\n…(truncated)";
			if (terms.length > 0) {
				output += `\n\nSearchable terms: ${terms.join(", ")}`;
			}
			output += "\n\nUse search(queries: [...]) to retrieve full content of any section.";
			if (injectionWarnings.length > 0) {
				output += `\n\n⚠ Content safety notice: detected patterns (${injectionWarnings.join(", ")}). Review indexed content before relying on it.`;
			}

			tracker.trackCall("fetch_and_index", Buffer.byteLength(output));

			return { content: [{ type: "text" as const, text: output }] };
		},
	);
}
