import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SearchResult } from "../types.js";
import { assembleBudgetedResponse, byteLength } from "../util/byte-budget.js";
import type { ToolContext } from "./context.js";

/** Bounds one request; without it a single call can ask for unbounded work. */
const MAX_SEARCH_QUERIES = 16;

function formatQueryBlock(query: string, result: SearchResult): string {
	let block = `## ${query}\n`;
	if (result.corrected) block += `(corrected to: "${result.corrected}")\n`;

	if (result.results.length === 0) return `${block}No results found.\n`;
	for (const hit of result.results) {
		block += `\n--- [${hit.source}] ---\n### ${hit.title}\n\n${hit.snippet}\n`;
	}
	return block;
}

export function registerSearchTool(server: McpServer, ctx: ToolContext): void {
	const { store, tracker, config } = ctx;
	// Per-server-instance throttling state
	const searchCalls: number[] = [];

	server.registerTool(
		"search",
		{
			title: "Search the knowledge base",
			description:
				"Search indexed content. Pass ALL search questions as queries array in ONE call.\n\nTIPS: 2-4 specific terms per query. Use 'source' to scope results.",
			inputSchema: {
				queries: z
					.array(z.string())
					.max(MAX_SEARCH_QUERIES)
					.describe(
						`Array of search queries. Batch ALL questions in one call (max ${MAX_SEARCH_QUERIES}).`,
					),
				source: z
					.string()
					.optional()
					.describe("Filter to a specific indexed source (partial match)."),
				limit: z.number().int().positive().default(3).describe("Results per query (default: 3)"),
			},
			// Pure read over the local FTS5 index — no writes, no network.
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async ({ queries, source, limit }) => {
			const now = Date.now();
			while (searchCalls.length > 0 && searchCalls[0] < now - config.searchWindowMs) {
				searchCalls.shift();
			}

			// `>=` because this call is not counted until it is admitted below; the
			// old code pushed first and compared with `>`, so the threshold is the same.
			if (searchCalls.length >= config.searchBlockAfter) {
				// Do NOT record this attempt. Counting blocked calls meant a caller
				// retrying faster than the window could never fall back under the
				// limit, so the throttle became permanent for the session.
				const retryAfterMs = Math.max(0, searchCalls[0] + config.searchWindowMs - now);
				const msg =
					`Too many search calls in the last ${config.searchWindowMs / 1000}s. ` +
					`Retry in ${Math.ceil(retryAfterMs / 1000)}s, or pass all queries in ONE call ` +
					"— search(queries: [...]) accepts up to 16, and batch_execute takes " +
					"commands plus queries together when you also need to run something.";
				tracker.trackCall("search", Buffer.byteLength(msg));
				return { content: [{ type: "text" as const, text: msg }] };
			}

			searchCalls.push(now);
			const callCount = searchCalls.length;

			const effectiveLimit =
				callCount > config.searchReduceAfter ? 1 : Math.max(1, Math.min(limit, config.searchLimit));

			// searchMaxBytes caps the whole response, including the rate-limit notice
			// and the separators between blocks.
			const budget = config.searchMaxBytes;
			const output = assembleBudgetedResponse({
				blocks: queries.map((query) =>
					formatQueryBlock(query, store.search(query, { source, limit: effectiveLimit })),
				),
				limit: budget,
				trailing:
					callCount > config.searchReduceAfter
						? `\n⚠ Search rate limited (${callCount} calls in ${config.searchWindowMs / 1000}s). Results reduced to 1 per query.`
						: "",
				omissionNote: (omitted) =>
					`\n\n_(${omitted} of ${queries.length} query blocks omitted: ${budget}-byte response budget)_`,
			});
			tracker.trackCall("search", byteLength(output));

			return { content: [{ type: "text" as const, text: output }] };
		},
	);
}
