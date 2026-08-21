import { execFileSync, spawn } from "node:child_process";
import { loadConfig, resolveProjectDir } from "../config.js";
import {
	deduplicateLines,
	groupErrorLines,
	smartTruncate,
	stripAnsi,
	stripProgressLines,
} from "../executor.js";
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
	/** Overrides the configured cap; intended for tests and embedded callers. */
	maxOutputBytes?: number,
): string {
	let out = stripAnsi(stdout);
	// Conservative means "do not FILTER", not "do not bound". Returning here
	// skipped the response cap entirely: 8MB of stdout came back as 8,388,609
	// bytes against a 102,400-byte budget, on the one mode a caller picks when
	// they want the output intact — which is exactly when it is largest.
	if (mode === "conservative") {
		const cap = maxOutputBytes ?? loadConfig(resolveProjectDir()).maxOutputBytes;
		return Buffer.byteLength(out) > cap ? smartTruncate(out, cap) : out;
	}

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

	// Final response cap, matching the executor's last stage. Without it this
	// pipeline reproduced every compression stage except the one that bounds the
	// result, so a wrapped build returned megabytes where the same command
	// through `execute` returned maxOutputBytes with a truncation marker — and
	// the hook's auto-wrap is the path most callers actually get.
	const maxOutput = maxOutputBytes ?? loadConfig(resolveProjectDir()).maxOutputBytes;
	if (Buffer.byteLength(out) > maxOutput) {
		out = smartTruncate(out, maxOutput);
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
): { stream: boolean; cmdLine: string; ownArgs: string[] } | { unknownOption: string } {
	let stream = false;
	let commandStarted = false;
	const operands: string[] = [];
	/** Only the options before the command — what mode resolution may look at. */
	const ownArgs: string[] = [];

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
			ownArgs.push(arg);
			continue;
		}
		if (arg === "--mode") {
			ownArgs.push(arg);
			if (i + 1 < args.length) ownArgs.push(args[i + 1]);
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
	return { stream, cmdLine, ownArgs };
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

	// Split the arguments FIRST, then resolve the mode from our own slice only.
	// Scanning the raw array made `wrap webpack --mode production` fail with
	// "invalid --mode", stealing a flag that belongs to the child — the exact
	// thing parseWrapArgs's contract says cannot happen, `--` included.
	const parsed = parseWrapArgs(args);
	if ("unknownOption" in parsed) {
		return usageError(`unknown option "${parsed.unknownOption}"`, WRAP_USAGE);
	}
	const { stream, cmdLine, ownArgs } = parsed;

	const resolved = resolveMode(ownArgs);
	if (!resolved.ok) return modeError(resolved.value, WRAP_USAGE);
	const mode = resolved.mode;

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
			const cfg = loadConfig(resolveProjectDir());
			const captureCapBytes = options.captureCapBytes ?? cfg.hardCapBytes;
			runBuffered(proc, cmdLine, mode, captureCapBytes, cfg.maxOutputBytes, resolve);
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

/**
 * `wrap` compresses stdout and then wrote stderr back untouched: no ANSI strip,
 * no dedup/grouping, and never counted against `maxOutputBytes`. Claude Code's
 * Bash tool returns stderr to the model, so those bytes are context, not a
 * terminal — and `setup --auto` turns this path on by default, which makes it
 * the path most callers actually get. `SubprocessExecutor` fixed exactly this
 * for the `execute` tool; the CLI pipeline that claims to mirror it did not.
 *
 * Measured on a build emitting 60k coloured error lines: `execute` returned
 * 102,400 bytes with no escape sequences, `wrap` returned 4,020,042 bytes with
 * 60,000 of them.
 */
function normalizeStderr(stderr: string, maxOutputBytes: number): string {
	let text = stripAnsi(stderr);
	// Same threshold as the executor: below it, grouping costs more than it saves.
	if (text.length > 10_000) {
		text = groupErrorLines(deduplicateLines(stripProgressLines(text)));
	}
	return smartTruncate(text, maxOutputBytes);
}

function writeBufferedStderr(
	stderr: string,
	signal: NodeJS.Signals | null,
	capped: boolean,
	captureCapBytes: number,
	maxOutputBytes: number,
): void {
	if (stderr) {
		const normalized = normalizeStderr(stderr, maxOutputBytes);
		process.stderr.write(normalized);
		if (normalized && !normalized.endsWith("\n")) process.stderr.write("\n");
	}
	if (capped) {
		process.stderr.write(
			// Only claim completion when nothing killed the child. Saying a
			// SIGKILLed process "ran to completion" — and suppressing the signal
			// line, which this branch used to do — is the opposite of the truth.
			`context-compress wrap: combined stdout/stderr exceeded the ${formatBytes(captureCapBytes)} capture limit; later output was not captured.${signal ? ` The command was then killed by ${signal}.` : " The command itself ran to completion."} Re-run with --stream or increase CONTEXT_COMPRESS_HARD_CAP_BYTES.\n`,
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
	maxOutputBytes: number,
	resolve: (code: number) => void,
): void {
	/**
	 * Capture keeps a head and a rolling tail per stream. A build's verdict is its
	 * last line, and capping by "stop capturing" put a 46.8MB build's
	 * `ALL-TESTS-PASSED` on the wrong side of the cap. Before the cap existed the
	 * whole stream was buffered, so losing the tail is a regression, not a
	 * trade-off; a bounded ring restores it without restoring unbounded memory.
	 */
	type Sink = { head: Buffer[]; tail: Buffer[]; tailBytes: number; seen: number };
	const outSink: Sink = { head: [], tail: [], tailBytes: 0, seen: 0 };
	const errSink: Sink = { head: [], tail: [], tailBytes: 0, seen: 0 };
	// Bound the ring by the capture cap as well, so total retention stays within
	// twice the cap even when the cap is deliberately tiny.
	const tailCap = Math.min(maxOutputBytes, captureCapBytes);
	let capturedBytes = 0;
	let capped = false;

	const capture = (chunk: Buffer, sink: Sink): void => {
		sink.seen += chunk.length;
		let rest = chunk;
		if (!capped) {
			const remaining = captureCapBytes - capturedBytes;
			if (rest.length <= remaining) {
				sink.head.push(rest);
				capturedBytes += rest.length;
				return;
			}
			if (remaining > 0) sink.head.push(Buffer.from(rest.subarray(0, remaining)));
			rest = rest.subarray(Math.max(0, remaining));
			capturedBytes = captureCapBytes;
			capped = true;
			// Do NOT kill the child. `hardCapBytes` is the MCP server's memory guard,
			// where output is held in RAM for a tool response; `wrap` is transparent
			// passthrough of the user's own command. Applying the guard by killing the
			// process tree reported that 46.8MB build as exit 1 when it exited 0, and
			// any work it would have done after the cap never ran.
		}
		if (rest.length === 0) return;
		sink.tail.push(Buffer.from(rest));
		sink.tailBytes += rest.length;
		while (sink.tail.length > 1 && sink.tailBytes - sink.tail[0].length >= tailCap) {
			sink.tailBytes -= (sink.tail.shift() as Buffer).length;
		}
	};

	/** Head, a marker for the gap, then the most recent `tailCap` bytes. */
	/** Decode without emitting U+FFFD for a character split at a buffer edge. */
	const decodeTrimmed = (buf: Buffer, trimStart: boolean): string => {
		let start = 0;
		let end = buf.length;
		if (trimStart) while (start < end && (buf[start] & 0xc0) === 0x80) start++;
		// A trailing partial character has no continuation left to complete it.
		let back = end - 1;
		let seen = 0;
		while (back >= start && (buf[back] & 0xc0) === 0x80 && seen < 3) {
			back--;
			seen++;
		}
		if (back >= start) {
			const lead = buf[back];
			const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
			if (needed > 1 && back + needed > end) end = back;
		}
		return buf.subarray(start, end).toString("utf-8");
	};

	const assemble = (sink: Sink): string => {
		// The cap can land mid-character: the head split had no guard, so 2 of 3
		// offsets emitted a replacement character into the compressed response.
		const head = decodeTrimmed(Buffer.concat(sink.head), false);
		if (sink.tail.length === 0) return head;
		let tail = Buffer.concat(sink.tail);
		if (tail.length > tailCap) tail = tail.subarray(tail.length - tailCap);
		// Everything this stream produced, minus what survived. The previous
		// expression mixed the global capture counter with one sink's ring and never
		// counted a single ring eviction, so 1MB, 10MB and 100MB of loss all reported
		// "64.0KB past the limit" — wrong by up to 1,600x on the number whose whole
		// job is to tell the caller how much they are missing.
		const dropped = sink.seen - Buffer.byteLength(head) - tail.length;
		// `capped` is global but the sinks are per-stream, so the stream that never
		// overflowed was getting "… not captured — 0B past the limit …" spliced into
		// intact output.
		if (dropped <= 0) return head + decodeTrimmed(tail, true);

		const marker = `\n... [middle of the stream not captured — ${formatBytes(Math.max(0, dropped))} past the ${formatBytes(captureCapBytes)} capture limit] ...\n`;
		return head + marker + decodeTrimmed(tail, true);
	};

	proc.stdout?.on("data", (chunk: Buffer) => capture(chunk, outSink));
	proc.stderr?.on("data", (chunk: Buffer) => capture(chunk, errSink));

	proc.on("error", (err) => {
		process.stderr.write(`context-compress wrap: ${err.message}\n`);
		resolve(127);
	});

	proc.on("close", (code, signal) => {
		const stdout = assemble(outSink);
		const stderr = assemble(errSink);
		// auto mode triggers an LLM call; concrete modes are sync. Both flow
		// through compressOutputAsync.
		compressOutputAsync(stdout, cmdLine, mode).then(({ output: compressed }) => {
			process.stdout.write(compressed);
			if (compressed && !compressed.endsWith("\n")) process.stdout.write("\n");
			writeBufferedStderr(stderr, signal, capped, captureCapBytes, maxOutputBytes);
			// Signal-killed children report code=null — never mask that as success.
			// A capture cap is our limit, not the command's outcome: report what the
			// command actually returned.
			resolve(code ?? 1);
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
