import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ALL_LANGUAGES, type ExecResult, type Language } from "../types.js";
import { isWithinProject } from "../util/path.js";
import type { ToolContext } from "./context.js";

const LANGUAGE_ENUM = ALL_LANGUAGES as unknown as [Language, ...Language[]];

export function registerExecuteFileTool(server: McpServer, ctx: ToolContext): void {
	const { executor, tracker, projectDir, withExecutionLimit, applyIntentFilter } = ctx;

	server.tool(
		"execute_file",
		"Read a file and process it without loading contents into context. The file is read into a FILE_CONTENT variable inside the sandbox. Only your printed summary enters context.\n\nPREFER THIS OVER Read/cat for: log files, data files (CSV, JSON, XML), large source files for analysis, and any file where you need to extract specific information rather than read the entire content.",
		{
			path: z.string().describe("Absolute file path or relative to project root"),
			language: z.enum(LANGUAGE_ENUM).describe("Runtime language"),
			code: z
				.string()
				.describe(
					"Code to process FILE_CONTENT. Print summary via console.log/print/echo/IO.puts.",
				),
			intent: z.string().optional().describe("What you're looking for in the output."),
			timeout: z.number().default(30000).describe("Max execution time in ms"),
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
			if (result.stderr && result.exitCode !== 0) {
				output += `\n\nSTDERR:\n${result.stderr}`;
			}

			if (intent) {
				output = applyIntentFilter(output, intent, `file:${filePath}`);
			}

			const responseBytes = Buffer.byteLength(output);
			tracker.trackCall("execute_file", responseBytes);

			return { content: [{ type: "text" as const, text: output }] };
		},
	);
}
