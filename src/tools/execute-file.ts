import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ALL_LANGUAGES, type ExecResult, type Language } from "../types.js";
import { truncateToBytes } from "../util/byte-budget.js";
import { withExecStatus } from "../util/exec-status.js";
import { isWithinProject } from "../util/path.js";
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

export function registerExecuteFileTool(server: McpServer, ctx: ToolContext): void {
	const { executor, tracker, projectDir, withExecutionLimit, applyIntentFilter } = ctx;

	server.registerTool(
		"execute_file",
		{
			title: "Process a file in a sandbox",
			description:
				"Read a file and process it without loading contents into context. The file is read into a FILE_CONTENT variable inside the sandbox. Only your printed summary enters context.\n\nPREFER THIS OVER Read/cat for: log files, data files (CSV, JSON, XML), large source files for analysis, and any file where you need to extract specific information rather than read the entire content.",
			inputSchema: {
				path: z.string().describe("Absolute file path or relative to project root"),
				language: z.enum(LANGUAGE_ENUM).describe("Runtime language"),
				code: z
					.string()
					.describe(
						"Code to process FILE_CONTENT. Print summary via console.log/print/echo/IO.puts.",
					),
				intent: z.string().optional().describe("What you're looking for in the output."),
				timeout: z
					.number()
					.int()
					.positive()
					.max(MAX_TIMEOUT_MS)
					.default(30000)
					.describe(`Max execution time in ms (1-${MAX_TIMEOUT_MS})`),
			},
			// Same trust profile as `execute` — the supplied code is arbitrary, the
			// only added constraint is that the input path stays inside the project.
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async ({ path: filePath, language, code, intent, timeout }) => {
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

			const absPath = resolve(projectDir, filePath);
			if (!isWithinProject(absPath, projectDir)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: path "${filePath}" is outside the project directory`,
						},
					],
					isError: true,
				};
			}

			let result: ExecResult;
			try {
				result = await withExecutionLimit(() =>
					executor.executeFile({
						language,
						code,
						filePath: absPath,
						timeout,
					}),
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { content: [{ type: "text" as const, text: msg }], isError: true };
			}

			let output = result.stdout;
			let indexableOutput = result.indexableStdout;
			if (result.stderr && result.exitCode !== 0) {
				output += `\n\nSTDERR:\n${result.stderr}`;
				indexableOutput += `\n\nSTDERR:\n${result.stderr}`;
			}

			if (intent) {
				const filtered = applyIntentFilter(indexableOutput, intent, `file:${filePath}`);
				if (filtered !== indexableOutput) output = filtered;
			}

			// See execute.ts: a nonzero exit with no output must not read as success.
			output = withExecStatus(output, result);

			// stderr is appended above and is not covered by the executor's stdout
			// cap, so bound the COMBINED response — the configured cap is a promise
			// about what reaches the caller, not about one stream.
			output = truncateToBytes(output, ctx.config.maxOutputBytes);

			const responseBytes = Buffer.byteLength(output);
			tracker.trackCall("execute_file", responseBytes);

			return { content: [{ type: "text" as const, text: output }] };
		},
	);
}
