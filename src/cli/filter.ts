import { spawn } from "node:child_process";
import { deduplicateLines, groupErrorLines, stripAnsi, stripProgressLines } from "../executor.js";
import { DEFAULT_MODE, type FilterMode, applyCommandFilter, parseMode } from "../filters.js";
import { StreamCompressor } from "../util/stream-compress.js";

const DEDUP_THRESHOLD = 10_000;
// Aggressive mode lowers the dedup threshold so even mid-size outputs
// get the full progress/dedup/group treatment.
const AGGRESSIVE_DEDUP_THRESHOLD = 2_000;

/**
 * Apply the full context-compress output pipeline to a buffer.
 *
 *   conservative: ANSI strip only — preserve everything else.
 *   balanced:     ANSI strip → command filter → dedup/group (if >10KB).
 *                 Strips noise; preserves metadata (commit bodies, file dates).
 *   aggressive:   balanced + aggressive command filters that drop metadata
 *                 (git log → oneline, ls -la → name+size, etc.) and lower
 *                 the dedup threshold to 2KB.
 *
 * Mirrors what SubprocessExecutor does internally so the same compression
 * is available to standalone shell commands or other agents that don't
 * route through the MCP execute() tool.
 */
export function compressOutput(
	stdout: string,
	originalCmd?: string,
	mode: FilterMode = DEFAULT_MODE,
): string {
	let out = stripAnsi(stdout);
	if (mode === "conservative") return out;

	if (originalCmd) {
		const filtered = applyCommandFilter(originalCmd, out, mode);
		if (filtered.filtered) out = filtered.output;
	}

	const threshold = mode === "aggressive" ? AGGRESSIVE_DEDUP_THRESHOLD : DEDUP_THRESHOLD;
	if (out.length > threshold) {
		out = stripProgressLines(out);
		out = deduplicateLines(out);
		out = groupErrorLines(out);
	}
	return out;
}

/** Resolve mode from CLI args, env, or default — in that priority order. */
function resolveMode(args: string[]): FilterMode {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--mode" && i + 1 < args.length) {
			return parseMode(args[i + 1]);
		}
	}
	return parseMode(process.env.CONTEXT_COMPRESS_MODE);
}

/** Read stdin to a string. */
async function readStdin(): Promise<string> {
	process.stdin.setEncoding("utf-8");
	let buf = "";
	for await (const chunk of process.stdin) buf += chunk;
	return buf;
}

/**
 * `context-compress filter [--cmd '<orig>'] [--mode conservative|balanced|aggressive]`
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
	const mode = resolveMode(args);
	const input = await readStdin();
	const compressed = compressOutput(input, cmd, mode);
	process.stdout.write(compressed);
	if (!compressed.endsWith("\n")) process.stdout.write("\n");
	return 0;
}

/**
 * `context-compress wrap [--stream] -- <cmd ...>`
 *
 * Default (buffered): spawn cmd, capture all stdout, apply full pipeline,
 * print filtered stdout, propagate child's exit code.
 *
 * `--stream`: emit filtered output line-by-line as the child produces it.
 * Use for long-running commands (tail -f, cargo watch, builds with
 * progressive output) where buffering would defer all output until exit.
 * Stream mode applies ANSI strip + progress filter + adjacent dedup only —
 * command-aware filters need the full output.
 *
 * Usage:
 *   context-compress wrap "npm test"
 *   context-compress wrap --stream "tail -f /var/log/app.log"
 *   context-compress wrap -- npm test
 */
export async function runWrap(args: string[]): Promise<number> {
	if (args.length === 0) {
		process.stderr.write("Usage: context-compress wrap [--stream] [--mode <m>] <command...>\n");
		return 2;
	}

	let stream = false;
	const remaining: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--stream") {
			stream = true;
		} else if (a === "--mode" && i + 1 < args.length) {
			// Consumed by resolveMode below; skip the value here.
			i++;
		} else {
			remaining.push(a);
		}
	}

	const mode = resolveMode(args);
	const sepIdx = remaining.indexOf("--");
	const cmdLine = sepIdx >= 0 ? remaining.slice(sepIdx + 1).join(" ") : remaining.join(" ");

	if (!cmdLine.trim()) {
		process.stderr.write("Usage: context-compress wrap [--stream] [--mode <m>] <command...>\n");
		return 2;
	}

	return await new Promise<number>((resolve) => {
		const proc = spawn(cmdLine, {
			shell: true,
			stdio: ["inherit", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});

		if (stream) {
			runStreaming(proc, resolve);
		} else {
			runBuffered(proc, cmdLine, mode, resolve);
		}
	});
}

function runBuffered(
	proc: ReturnType<typeof spawn>,
	cmdLine: string,
	mode: FilterMode,
	resolve: (code: number) => void,
): void {
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
		const compressed = compressOutput(stdout, cmdLine, mode);
		process.stdout.write(compressed);
		if (compressed && !compressed.endsWith("\n")) process.stdout.write("\n");
		if (stderr) process.stderr.write(stderr);
		resolve(code ?? 0);
	});
}

function runStreaming(proc: ReturnType<typeof spawn>, resolve: (code: number) => void): void {
	const compressor = new StreamCompressor();

	proc.stdout?.setEncoding("utf-8");
	proc.stdout?.on("data", (chunk: string) => {
		const out = compressor.process(chunk);
		if (out) process.stdout.write(out);
	});

	// stderr passes through unchanged — typically small, error-relevant.
	proc.stderr?.on("data", (c: Buffer) => process.stderr.write(c));

	proc.on("error", (err) => {
		process.stderr.write(`context-compress wrap: ${err.message}\n`);
		resolve(127);
	});

	proc.on("close", (code) => {
		const tail = compressor.flush();
		if (tail) process.stdout.write(tail);
		resolve(code ?? 0);
	});
}
