import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";

export function registerStatsTool(server: McpServer, ctx: ToolContext): void {
	const { tracker } = ctx;

	server.tool(
		"stats",
		"Returns context consumption statistics for the current session. Shows total bytes returned to context, breakdown by tool, call counts, estimated token usage, context savings ratio, and visual charts.",
		{},
		async () => {
			tracker.saveCumulative();
			const report = tracker.formatReport();
			tracker.trackCall("stats", Buffer.byteLength(report));
			return { content: [{ type: "text" as const, text: report }] };
		},
	);
}
