import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "./context.js";

export function registerSearchTool(server: McpServer, ctx: ToolContext): void {
	const { store, tracker, config } = ctx;
	// Per-server-instance throttling state
	const searchCalls: number[] = [];

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
			const now = Date.now();
			searchCalls.push(now);
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
}
