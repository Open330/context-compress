import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ALL_LANGUAGES, type ExecResult, type Language } from "../types.js";
import { truncateToBytes } from "../util/byte-budget.js";
import { assembleExecResponse } from "../util/exec-status.js";
import type { ToolContext } from "./context.js";

const LANGUAGE_ENUM = ALL_LANGUAGES as unknown as [Language, ...Language[]];

/**
 * Upper bound on a requested timeout.
 *
 * The executor timer is the only thing that kills a runaway process, so an
 * unvalidated value pinned a concurrency slot indefinitely: eight calls with
 * timeout=2147483647 (24.8 days) exhausted MAX_CONCURRENT_EXECUTIONS and made
 * every later execution in the session fail.
 */
const MAX_TIMEOUT_MS = 600_000;

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
				timeout: z
					.number()
					.int()
					.positive()
					.max(MAX_TIMEOUT_MS)
					.default(30000)
					.describe(`Max execution time in ms (1-${MAX_TIMEOUT_MS})`),
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
			let indexableOutput = result.indexableStdout;
			// Kept out of `output` so the budget can reserve room for it below; a
			// concatenation here is clamped head-first and loses the diagnostic.
			let stderrBlock = "";
			if (result.stderr && result.exitCode !== 0) {
				stderrBlock = `\n\nSTDERR:\n${result.stderr}`;
				indexableOutput += stderrBlock;
			}

			if (intent) {
				const filtered = applyIntentFilter(indexableOutput, intent, `execute:${language}`);
				// Index the raw corpus, but hold the response to one invariant: asking a
				// question about the output must not enlarge it. The filter's own
				// threshold sees the raw bytes, so a chatty command whose curated
				// response was already small got swapped for a bigger summary rebuilt
				// from the noise the command filter had just removed — measured, a 227
				// byte `npm test` rollup with no PASS lines came back as 2,798 bytes
				// with 45 of them. The exception is an empty response: there is nothing
				// to preserve, and the summary is the only account of what was indexed.
				// Measured against the whole response, stderr included. Testing `output`
				// alone treated a failing command that writes only to stderr as having
				// no response to preserve, so the summary replaced a 1,897-byte answer
				// carrying every error line with 12,028 bytes carrying none of them.
				const currentBytes = Buffer.byteLength(output) + Buffer.byteLength(stderrBlock);
				const worthSwapping = Buffer.byteLength(filtered) < currentBytes || currentBytes === 0;
				if (filtered !== indexableOutput && worthSwapping) {
					output = filtered;
					// The corpus the summary was built from already contains stderr.
					stderrBlock = "";
				}
			}

			// Applied last so it survives the intent filter: without it, exit 7 with
			// no output is indistinguishable from a successful empty run.
			// Reserve the status footer's bytes BEFORE truncating. Appending it and
			// then clamping cut it straight back off, so a run that failed with a
			// nonzero exit came back looking merely truncated — the caller could not
			// tell a broken command from a chatty one.
			output = assembleExecResponse(output, stderrBlock, result, ctx.config.maxOutputBytes);

			const responseBytes = Buffer.byteLength(output);
			tracker.trackCall("execute", responseBytes);

			return { content: [{ type: "text" as const, text: output }] };
		},
	);
}
