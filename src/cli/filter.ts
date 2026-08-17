import { execFileSync, spawn } from "node:child_process";
import { loadConfig } from "../config.js";
import { deduplicateLines, groupErrorLines, stripAnsi, stripProgressLines } from "../executor.js";
import {
	applyCommandFilter,
	DEFAULT_MODE,
	type FilterMode,
	isRequestedMode,
	parseRequestedMode,
	REQUESTED_MODES,
	type RequestedMode,
} from "../filters.js";
import { applyFormatFilter } from "../format-filter.js";
import { pickModeAuto } from "../util/auto-mode.js";
import { StreamCompressor } from "../util/stream-compress.js";
import { formatBytes } from "../utils.js";

// Generic dedup/progress/group pipeline kicks in once output crosses these
// thresholds. Lower thresholds = pipeline runs on more outputs = better
// compression on mid-size noisy outputs. Higher = preserve small outputs as-is.
const BALANCED_DEDUP_THRESHOLD = 5_000;
const AGGRESSIVE_DEDUP_THRESHOLD = 2_000;

/**
 * Apply the full context-compress output pipeline to a buffer.
 *
 *   conservative: ANSI strip only — preserve everything else.
 *   balanced:     ANSI strip → command filter (drops universal noise:
 *                 progress bars, hint lines, ./.., 'total N', truncates
 *                 git log bodies past 3 lines) → dedup/group (if >5KB).
 *                 Preserves all metadata (perms, dates, commit headers).
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

	let commandFiltered = false;
	if (originalCmd) {
		const filtered = applyCommandFilter(originalCmd, out, mode);
		if (filtered.filtered) {
			out = filtered.output;
			commandFiltered = true;
		}
	}

	// Format-aware fallback: when no command-specific filter matched, compress by
	// the *shape* of the output (JSON minify/collapse, log template folding).
	// This catches the long tail of unrecognized commands emitting structured data.
	if (!commandFiltered) {
		const fmt = applyFormatFilter(out, mode);
		if (fmt.filtered) out = fmt.output;
	}

	const threshold = mode === "aggressive" ? AGGRESSIVE_DEDUP_THRESHOLD : BALANCED_DEDUP_THRESHOLD;
	if (out.length > threshold) {
		out = stripProgressLines(out);
		out = deduplicateLines(out);
		out = groupErrorLines(out);
	}
	return out;
}

/**
 * Async variant that handles the "auto" meta-mode by asking an LLM to
 * pick conservative/balanced/aggressive for the given command + output.
 * Concrete modes route to the synchronous compressOutput.
 */
export async function compressOutputAsync(
	stdout: string,
	originalCmd: string | undefined,
	mode: RequestedMode = DEFAULT_MODE,
): Promise<{ output: string; resolvedMode: FilterMode; autoSource?: string }> {
	if (mode !== "auto") {
		return { output: compressOutput(stdout, originalCmd, mode), resolvedMode: mode };
	}
	const result = await pickModeAuto(originalCmd ?? "", stdout);
	return {
		output: compressOutput(stdout, originalCmd, result.mode),
		resolvedMode: result.mode,
		autoSource: result.source,
	};
}

const MODE_LIST = REQUESTED_MODES.join("|");
const FILTER_USAGE = `Usage: context-compress filter [--cmd '<original command>'] [--mode <${MODE_LIST}>]`;
const WRAP_USAGE = `Usage: context-compress wrap [--stream] [--mode <${MODE_LIST}>] <command...>`;

/** Report a usage problem on stderr and yield the conventional exit code. */
function usageError(message: string, usage: string): number {
	process.stderr.write(`context-compress: ${message}\n${usage}\n`);
	return 2;
}

type ModeResolution = { ok: true; mode: RequestedMode } | { ok: false; value: string | undefined };

/**
 * Resolve mode from CLI args, env, or default — in that priority order.
 *
 * An explicit `--mode` is validated: silently substituting balanced for a
 * misspelled mode meant the caller got compression they never asked for. An
 * invalid environment value is ambient rather than requested, so it warns and
 * falls back instead of failing every wrapped command.
 */
function resolveMode(args: string[]): ModeResolution {
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== "--mode") continue;
		const value = args[i + 1];
		// A following flag means the value is missing, not that the flag is a mode.
		if (value === undefined || value.startsWith("-") || !isRequestedMode(value)) {
			return { ok: false, value };
		}
		return { ok: true, mode: value };
	}

	const fromEnv = process.env.CONTEXT_COMPRESS_MODE;
	if (fromEnv !== undefined && fromEnv !== "" && !isRequestedMode(fromEnv)) {
		process.stderr.write(
			`context-compress: ignoring invalid CONTEXT_COMPRESS_MODE="${fromEnv}" (using ${DEFAULT_MODE})\n`,
		);
	}
	return { ok: true, mode: parseRequestedMode(fromEnv) };
}

function modeError(value: string | undefined, usage: string): number {
	return usageError(
		value === undefined || value.startsWith("-")
			? `--mode requires a value (${MODE_LIST})`
			: `invalid --mode "${value}" (expected ${MODE_LIST})`,
		usage,
	);
}

/**
 * Split `wrap` arguments into our own options and the child command line.
 *
 * Options are recognized only before the command begins: everything from the
 * first operand (or `--`) onward belongs to the child, flags included. An
 * unrecognized leading option is reported rather than joined into the command,
 * which is how `wrap --moode x ls` used to reach the shell verbatim.
 */
function parseWrapArgs(
	args: string[],
): { stream: boolean; cmdLine: string } | { unknownOption: string } {
	let stream = false;
	let commandStarted = false;
	const operands: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (commandStarted) {
			operands.push(arg);
			continue;
		}
		if (arg === "--") {
			commandStarted = true;
			operands.push(arg);
			continue;
		}
		if (arg === "--stream") {
			stream = true;
			continue;
		}
		if (arg === "--mode") {
			// Value already validated by resolveMode; skip it here.
			i++;
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") return { unknownOption: arg };
		commandStarted = true;
		operands.push(arg);
	}

	const separatorIndex = operands.indexOf("--");
	const cmdLine =
		separatorIndex >= 0 ? operands.slice(separatorIndex + 1).join(" ") : operands.join(" ");
	return { stream, cmdLine };
}

/** Read stdin to a string. */
async function readStdin(): Promise<string> {
	process.stdin.setEncoding("utf-8");
	let buf = "";
	for await (const chunk of process.stdin) buf += chunk;
	return buf;
}

/**
 * `context-compress filter [--cmd '<orig>'] [--mode conservative|balanced|aggressive|auto]`
 * Reads stdin, applies the pipeline, writes to stdout. Exits 0.
 */
export async function runFilter(args: string[]): Promise<number> {
	const resolved = resolveMode(args);
	if (!resolved.ok) return modeError(resolved.value, FILTER_USAGE);

	let cmd: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--cmd") {
			// The value is an arbitrary command string, so it may begin with a dash.
			if (i + 1 >= args.length) return usageError("--cmd requires a value", FILTER_USAGE);
			cmd = args[i + 1];
			i++;
			continue;
		}
		if (arg === "--mode") {
			i++;
			continue;
		}
		// Previously ignored, which hid typos like `--modee aggressive`.
		return usageError(`unexpected argument "${arg}"`, FILTER_USAGE);
	}

	const mode = resolved.mode;
	const input = await readStdin();
	const { output: compressed } = await compressOutputAsync(input, cmd, mode);
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
export async function runWrap(
	args: string[],
	/** Override the configured hard cap; intended for embedded callers and deterministic tests. */
	options: { captureCapBytes?: number } = {},
): Promise<number> {
	if (args.length === 0) return usageError("a command is required", WRAP_USAGE);

	const resolved = resolveMode(args);
	if (!resolved.ok) return modeError(resolved.value, WRAP_USAGE);
	const mode = resolved.mode;

	const parsed = parseWrapArgs(args);
	if ("unknownOption" in parsed) {
		return usageError(`unknown option "${parsed.unknownOption}"`, WRAP_USAGE);
	}
	const { stream, cmdLine } = parsed;

	if (!cmdLine.trim()) return usageError("a command is required", WRAP_USAGE);

	return await new Promise<number>((resolve) => {
		const proc = spawn(cmdLine, {
			shell: true,
			stdio: ["inherit", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
			// A separate process group lets the capture cap terminate the shell and
			// descendants that may otherwise keep its stdout/stderr pipes open.
			detached: process.platform !== "win32",
		});

		if (stream) {
			runStreaming(proc, resolve);
		} else {
			const captureCapBytes = options.captureCapBytes ?? loadConfig().hardCapBytes;
			runBuffered(proc, cmdLine, mode, captureCapBytes, resolve);
		}
	});
}

/** Kill the spawned shell and all descendants so no writer can keep a capture pipe open. */
function killProcessTree(pid: number): void {
	try {
		if (process.platform === "win32") {
			execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)]);
		} else {
			process.kill(-pid, "SIGKILL");
		}
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already exited.
		}
	}
}

function writeBufferedStderr(
	stderr: string,
	signal: NodeJS.Signals | null,
	capped: boolean,
	captureCapBytes: number,
): void {
	if (stderr) process.stderr.write(stderr);
	if (capped) {
		process.stderr.write(
			`context-compress wrap: combined stdout/stderr exceeded the ${formatBytes(captureCapBytes)} capture limit; process killed. Re-run with --stream or increase CONTEXT_COMPRESS_HARD_CAP_BYTES.\n`,
		);
	} else if (signal) {
		process.stderr.write(`context-compress wrap: killed by ${signal}\n`);
	}
}

function runBuffered(
	proc: ReturnType<typeof spawn>,
	cmdLine: string,
	mode: RequestedMode,
	captureCapBytes: number,
	resolve: (code: number) => void,
): void {
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	let capturedBytes = 0;
	let capped = false;

	const capture = (chunk: Buffer, chunks: Buffer[]): void => {
		if (capped) return;

		const remaining = captureCapBytes - capturedBytes;
		if (chunk.length <= remaining) {
			chunks.push(chunk);
			capturedBytes += chunk.length;
			return;
		}

		// Retain only the portion within the cap; never keep the overflowing chunk.
		if (remaining > 0) chunks.push(Buffer.from(chunk.subarray(0, remaining)));
		capturedBytes = captureCapBytes;
		capped = true;
		if (proc.pid) killProcessTree(proc.pid);
	};

	proc.stdout?.on("data", (chunk: Buffer) => capture(chunk, stdoutChunks));
	proc.stderr?.on("data", (chunk: Buffer) => capture(chunk, stderrChunks));

	proc.on("error", (err) => {
		process.stderr.write(`context-compress wrap: ${err.message}\n`);
		resolve(127);
	});

	proc.on("close", (code, signal) => {
		const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
		const stderr = Buffer.concat(stderrChunks).toString("utf-8");
		// auto mode triggers an LLM call; concrete modes are sync. Both flow
		// through compressOutputAsync.
		compressOutputAsync(stdout, cmdLine, mode).then(({ output: compressed }) => {
			process.stdout.write(compressed);
			if (compressed && !compressed.endsWith("\n")) process.stdout.write("\n");
			writeBufferedStderr(stderr, signal, capped, captureCapBytes);
			// Signal-killed children report code=null — never mask that as success.
			resolve(capped ? 1 : (code ?? 1));
		});
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

	proc.on("close", (code, signal) => {
		const tail = compressor.flush();
		if (tail) process.stdout.write(tail);
		if (signal) process.stderr.write(`context-compress wrap: killed by ${signal}\n`);
		// Signal-killed children report code=null — never mask that as success.
		resolve(code ?? 1);
	});
}
