import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ALL_LANGUAGES, type ExecResult, type Language } from "../types.js";
import type { ToolContext } from "./context.js";

const LANGUAGE_ENUM = ALL_LANGUAGES as unknown as [Language, ...Language[]];

export function registerExecuteTool(server: McpServer, ctx: ToolContext): void {
	const { executor, tracker, withExecutionLimit, applyIntentFilter, bunDetected } = ctx;

	server.registerTool(
		"execute",
		{
			title: "Execute code in a sandbox",
			description: `Execute code in a sandboxed subprocess. Only stdout enters context — raw data stays in the subprocess. Use instead of bash/cat when output would exceed ~5KB. ${bunDetected ? "(Bun detected — JS/TS runs 3-5x faster) " : ""}Available: ${ALL_LANGUAGES.join(", ")}.

PREFER THIS OVER BASH for: API calls (gh, curl, aws), test runners (npm test, pytest), git queries (git log, git diff), data processing, and ANY CLI command that may produce large output. Bash should only be used for file mutations, git writes, and navigation.`,
			inputSchema: {
				language: z.enum(LANGUAGE_ENUM).describe("Runtime language"),
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
			// Arbitrary caller-supplied code: it may write files, and it may reach
			// the network. Both hints stay pessimistic so clients gate it correctly.
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async ({ language, code, intent, timeout }) => {
			const codeBytes = Buffer.byteLength(code);
			if (codeBytes > 1_024_000) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: code too large (${(codeBytes / 1024).toFixed(0)}KB). Max 1MB.`,
						},
					],
					isError: true,
				};
			}

			let result: ExecResult;
			try {
				result = await withExecutionLimit(() => executor.execute({ language, code, timeout }));
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { content: [{ type: "text" as const, text: msg }], isError: true };
			}

			if (result.networkBytes) {
				tracker.trackSandboxed(result.networkBytes);
			}

			let output = result.stdout;
			if (result.stderr && result.exitCode !== 0) {
				output += `\n\nSTDERR:\n${result.stderr}`;
			}

			if (intent) {
				output = applyIntentFilter(output, intent, `execute:${language}`);
			}

			const responseBytes = Buffer.byteLength(output);
			tracker.trackCall("execute", responseBytes);

			return { content: [{ type: "text" as const, text: output }] };
		},
	);
}
