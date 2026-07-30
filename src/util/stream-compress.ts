/**
 * Line-by-line streaming compressor for long-running commands.
 *
 * Unlike the buffered pipeline (executor.ts / cli/filter.ts), this can emit
 * compressed output before the child process exits. Necessary for
 * `tail -f`, `cargo watch`, build commands with progressive output, etc.
 *
 * Trade-off: only stream-safe transformations are applied —
 *   - ANSI stripping (per-line, no state)
 *   - Progress/spinner line removal (per-line, no state)
 *   - Adjacent-duplicate dedup (single-line lookback)
 *
 * Skipped because they need full output:
 *   - applyCommandFilter (needs to detect summary/test markers globally)
 *   - groupErrorLines (needs full set of error patterns)
 *   - smartTruncate (needs final length)
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape detection requires \x1b
const ANSI_RE_G = /\x1b\[[0-9;]*[a-zA-Z]/g;

const PROGRESS_BAR_RE = /^[\s[│├└─═━▓░█▒▏▎▍▌▋▊▉\]>=#\-.\d%]+$/;
// A progress bar must contain an actual progress marker — otherwise plain
// numeric lines ("12345") and separators ("----") would be deleted too.
const PROGRESS_MARKER_RE = /%|=>|[▓░█▒▏▎▍▌▋▊▉]/;
const SPINNER_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\-\\|/]\s/;
const DOWNLOAD_RE = /(?:downloading|uploading|fetching|resolving)\s+[\d.]+\s*[kmg]?b/i;
const SPEED_ETA_RE = /\d+\.?\d*\s*[kmg]?b\/s/i;
const ETA_RE = /eta|remaining/i;

function isProgressLine(line: string): boolean {
	const t = line.trim();
	if (t === "") return false; // keep empty lines (they delimit blocks)
	if (PROGRESS_BAR_RE.test(t) && t.length > 3 && PROGRESS_MARKER_RE.test(t)) return true;
	if (SPINNER_RE.test(t)) return true;
	if (DOWNLOAD_RE.test(t)) return true;
	if (SPEED_ETA_RE.test(t) && ETA_RE.test(t)) return true;
	return false;
}

/**
 * Stateful streaming compressor. Feed it chunks via `process(chunk)`, get
 * compressed output back. Call `flush()` at end-of-stream to drain any
 * buffered incomplete line + emit any pending dedup counter.
 */
export class StreamCompressor {
	private buffer = "";
	private prevLine: string | null = null;
	private repeatCount = 0;

	/** Process a chunk; returns the filtered output ready to emit (may be empty). */
	process(chunk: string): string {
		this.buffer += chunk;
		const lastNl = this.buffer.lastIndexOf("\n");
		if (lastNl < 0) return ""; // no complete line yet
		const complete = this.buffer.slice(0, lastNl);
		this.buffer = this.buffer.slice(lastNl + 1);

		let out = "";
		for (const raw of complete.split("\n")) {
			const filtered = raw.replace(ANSI_RE_G, "");
			if (isProgressLine(filtered)) continue;

			if (filtered === this.prevLine && filtered.trim() !== "") {
				this.repeatCount++;
				continue;
			}

			out += this.drainRepeatCounter();
			out += `${filtered}\n`;
			this.prevLine = filtered;
		}
		return out;
	}

	/** Drain any remaining buffered line and emit final dedup counter. */
	flush(): string {
		let out = "";
		if (this.buffer.length > 0) {
			out += this.consumeBufferedLine();
		}
		out += this.drainRepeatCounter();
		return out;
	}

	/** Process the partial line in `buffer` (no trailing newline) and clear the buffer. */
	private consumeBufferedLine(): string {
		const filtered = this.buffer.replace(ANSI_RE_G, "");
		this.buffer = "";
		if (isProgressLine(filtered)) return "";
		if (filtered === this.prevLine && filtered.trim() !== "") {
			this.repeatCount++;
			return "";
		}
		const counter = this.drainRepeatCounter();
		this.prevLine = filtered;
		return counter + filtered + (filtered.endsWith("\n") ? "" : "\n");
	}

	/**
	 * End a run of duplicates. Matches executor.deduplicateLines semantics:
	 * 3+ identical consecutive lines collapse to one line + a ×N marker
	 * (N = total including the already-emitted first line); a single duplicate
	 * is re-emitted verbatim — never silently dropped.
	 */
	private drainRepeatCounter(): string {
		let out = "";
		if (this.repeatCount >= 2) {
			out = `  ... (×${this.repeatCount + 1} identical lines)\n`;
		} else if (this.repeatCount === 1 && this.prevLine !== null) {
			out = `${this.prevLine}\n`;
		}
		this.repeatCount = 0;
		return out;
	}
}
