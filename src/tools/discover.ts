import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";

export function registerDiscoverTool(server: McpServer, ctx: ToolContext): void {
	const { store, tracker, dbFallback } = ctx;

	server.tool(
		"discover",
		"Shows what's in the knowledge base and suggests optimization opportunities. Lists all indexed sources, chunk counts, searchable terms, and recommends next actions. Use this to understand what data is available for search.",
		{},
		async () => {
			const storeStats = store.getStats();
			const snap = tracker.getSnapshot();
			const lines: string[] = [];

			lines.push("## Knowledge Base Discovery\n");

			if (storeStats.totalSources === 0) {
				lines.push("No content indexed yet. Use these tools to build the knowledge base:\n");
				lines.push("- `batch_execute` — run commands and auto-index output");
				lines.push("- `execute` with `intent` — auto-indexes large output");
				lines.push("- `index` — index documentation or files");
				lines.push("- `fetch_and_index` — fetch and index web pages");
			} else {
				lines.push("| Metric | Value |");
				lines.push("|--------|-------|");
				lines.push(`| Indexed sources | ${storeStats.totalSources} |`);
				lines.push(`| Total chunks | ${storeStats.totalChunks} |`);
				lines.push(`| Vocabulary size | ${storeStats.vocabularySize} |`);
				lines.push(
					`| Trigram index | ${storeStats.hasTrigramTable ? "active" : "lazy (not yet needed)"} |`,
				);

				const sources = store.listSources();
				if (sources.length > 0) {
					lines.push("\n### Indexed Sources\n");
					for (const src of sources) {
						lines.push(
							`- **${src.label}** — ${src.chunkCount} chunks${src.codeChunks > 0 ? ` (${src.codeChunks} with code)` : ""}`,
						);
					}
				}

				const terms = store.getDistinctiveTerms();
				if (terms.length > 0) {
					lines.push("\n### Top Searchable Terms\n");
					lines.push(terms.slice(0, 20).join(", "));
				}
			}

			lines.push("\n### Optimization Suggestions\n");
			const totalCalls = Object.values(snap.calls).reduce((a, b) => a + b, 0);

			if (totalCalls === 0) {
				lines.push("- Start by using `batch_execute` to run multiple commands at once");
			} else {
				const searchCalls = snap.calls.search ?? 0;
				const executeCalls = snap.calls.execute ?? 0;
				const batchCalls = snap.calls.batch_execute ?? 0;

				if (executeCalls > 3 && batchCalls === 0) {
					lines.push(
						"- **Use batch_execute** — you've made multiple execute calls that could be batched into one",
					);
				}
				if (searchCalls > 5) {
					lines.push("- **Batch your searches** — pass multiple queries in a single search() call");
				}
				if (storeStats.totalChunks > 50) {
					lines.push(
						"- **Use source filtering** — scope searches with `source` parameter for faster, targeted results",
					);
				}
				if (storeStats.totalSources === 0 && totalCalls > 2) {
					lines.push(
						"- **Index more content** — use `intent` parameter in execute calls to auto-index large output",
					);
				}
			}

			if (dbFallback) {
				lines.push(
					"\n⚠ **Warning:** Persistent DB creation failed — using in-memory storage. Indexed data will not survive restarts.",
				);
			}

			const output = lines.join("\n");
			tracker.trackCall("discover", Buffer.byteLength(output));
			return { content: [{ type: "text" as const, text: output }] };
		},
	);
}
