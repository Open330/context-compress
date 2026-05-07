import { spawn } from "node:child_process";
import { deduplicateLines, groupErrorLines, stripAnsi, stripProgressLines } from "../executor.js";
import { applyCommandFilter } from "../filters.js";

const DEDUP_THRESHOLD = 10_000;

/**
 * Apply the full context-compress output pipeline to a buffer:
 *   stripAnsi → applyCommandFilter (if cmd known) → progress/dedup/group (if large)
 *
 * Mirrors what SubprocessExecutor does internally so the same compression
 * is available to standalone shell commands or other agents that don't
 * route through the MCP execute() tool.
 */
export function compressOutput(stdout: string, originalCmd?: string): string {
	let out = stripAnsi(stdout);
	if (originalCmd) {
		const filtered = applyCommandFilter(originalCmd, out);
		if (filtered.filtered) out = filtered.output;
	}
	if (out.length > DEDUP_THRESHOLD) {
		out = stripProgressLines(out);
		out = deduplicateLines(out);
		out = groupErrorLines(out);
	}
	return out;
}

/** Read stdin to a string. */
async function readStdin(): Promise<string> {
	process.stdin.setEncoding("utf-8");
	let buf = "";
	for await (const chunk of process.stdin) buf += chunk;
	return buf;
}

/**
 * `context-compress filter [--cmd '<orig>']`
 * Reads stdin, applies the pipeline, writes to stdout. Exits 0.
 */
export async function runFilter(args: string[]): Promise<number> {
	let cmd: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--cmd" && i + 1 < args.length) {
			cmd = args[i + 1];
			i++;
		}
	}
	const input = await readStdin();
	const compressed = compressOutput(input, cmd);
	process.stdout.write(compressed);
	if (!compressed.endsWith("\n")) process.stdout.write("\n");
	return 0;
}

/**
 * `context-compress wrap -- <cmd ...>` or `context-compress wrap <single-string>`
 *
 * Spawns the given command via the user shell, captures stdout/stderr,
 * applies the pipeline, prints filtered stdout (and unfiltered stderr) and
 * exits with the original command's exit code.
 *
 * Usage:
 *   context-compress wrap "npm test"
 *   context-compress wrap -- npm test
 */
export async function runWrap(args: string[]): Promise<number> {
	if (args.length === 0) {
		process.stderr.write("Usage: context-compress wrap <command...>\n");
		return 2;
	}
	// `--` separator: treat the rest as argv tokens; otherwise join (single string).
	const sepIdx = args.indexOf("--");
	const cmdLine = sepIdx >= 0 ? args.slice(sepIdx + 1).join(" ") : args.join(" ");

	if (!cmdLine.trim()) {
		process.stderr.write("Usage: context-compress wrap <command...>\n");
		return 2;
	}

	return await new Promise<number>((resolve) => {
		const proc = spawn(cmdLine, {
			shell: true,
			stdio: ["inherit", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		proc.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
		proc.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));

		proc.on("error", (err) => {
			process.stderr.write(`context-compress wrap: ${err.message}\n`);
			resolve(127);
		});

		proc.on("close", (code) => {
			const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
			const stderr = Buffer.concat(stderrChunks).toString("utf-8");
			const compressed = compressOutput(stdout, cmdLine);
			process.stdout.write(compressed);
			if (compressed && !compressed.endsWith("\n")) process.stdout.write("\n");
			if (stderr) process.stderr.write(stderr);
			resolve(code ?? 0);
		});
	});
}
