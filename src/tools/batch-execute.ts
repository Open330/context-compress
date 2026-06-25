import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { limitConcurrency } from "../utils.js";
import type { ToolContext } from "./context.js";

export function registerBatchExecuteTool(server: McpServer, ctx: ToolContext): void {
	const { executor, store, tracker, config, withExecutionLimit } = ctx;

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

			// Cap the combined buffer so a few high-output commands can't exhaust
			// memory before indexing. Per-command output is also capped so one
			// command can't consume the whole budget.
			const COMBINED_CAP = config.batchMaxBytes;
			const PER_COMMAND_CAP = Math.max(64_000, Math.floor(COMBINED_CAP / 4));

			let combined = "";
			const inventory: string[] = [];
			let truncatedCommands = 0;

			for (let i = 0; i < commandResults.length; i++) {
				const settled = commandResults[i];
				const label = commands[i].label;

				if (settled.status === "fulfilled") {
					const { result } = settled.value;
					let output = result.stdout || "(no output)";
					const lineCount = output.split("\n").length;
					if (Buffer.byteLength(output) > PER_COMMAND_CAP) {
						output = `${output.slice(0, PER_COMMAND_CAP)}\n…(output truncated)`;
						truncatedCommands++;
					}
					combined += `## ${label}\n\n${output}\n\n`;
					inventory.push(`- **${label}**: ${lineCount} lines`);
				} else {
					combined += `## ${label}\n\n(error: ${settled.reason})\n\n`;
					inventory.push(`- **${label}**: error`);
				}

				if (Buffer.byteLength(combined) >= COMBINED_CAP) {
					combined += "\n…(remaining command output omitted: combined size limit reached)\n";
					truncatedCommands += commandResults.length - i - 1;
					break;
				}
			}

			const indexed = store.index(combined, "batch_execute");
			tracker.trackIndexed(Buffer.byteLength(combined));

			const searchResults: string[] = [];
			let totalBytes = 0;

			for (const query of queries) {
				if (totalBytes > config.batchMaxBytes) break;

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
			if (truncatedCommands > 0) {
				output += `_Note: ${truncatedCommands} command output(s) truncated to stay within size limits; use search() to retrieve indexed content._\n\n`;
			}
			output += searchResults.join("\n---\n\n");
			if (terms.length > 0) {
				output += `\n\nSearchable terms: ${terms.join(", ")}`;
			}

			tracker.trackCall("batch_execute", Buffer.byteLength(output));

			return { content: [{ type: "text" as const, text: output }] };
		},
	);
}
