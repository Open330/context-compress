/**
 * Format-aware compression.
 *
 * Command-specific filters (filters.ts) only fire when the command is
 * recognized (git, npm, docker, …). A huge amount of large output comes from
 * commands we DON'T recognize — arbitrary tools that emit JSON, NDJSON, or
 * repetitive log lines. This module compresses by *shape of the output* rather
 * than by command name, so it catches that long tail.
 *
 * Design constraint — avoid "action-grammar destruction" (the failure mode of
 * token-level compressors like LLMLingua-2 in agent settings): we never remove
 * or reorder tokens *within* a structural unit. We operate on whole units —
 * minify JSON losslessly, collapse homogeneous array elements, and fold
 * repeated log lines into `template ×count` — and we always keep at least one
 * verbatim exemplar plus every error/warning line intact. The result is either
 * still-valid structured data or a clearly-labelled summary, never a mangled
 * half-token soup that a downstream parser or the model would choke on.
 */

import type { FilterMode } from "./filters.js";

export type OutputFormat = "json" | "ndjson" | "logs" | "plain";

export interface FormatFilterResult {
	output: string;
	filtered: boolean;
	format: OutputFormat;
}

/** Below this many bytes, structural compression isn't worth the fidelity risk. */
const MIN_BYTES_JSON = 1_000;
const MIN_LINES_LOGS = 30;

/** Homogeneous arrays longer than this get collapsed (aggressive) or flagged (balanced). */
const ARRAY_COLLAPSE_THRESHOLD = 20;
const ARRAY_KEEP_HEAD = 3;

/** String values longer than this are truncated in aggressive mode. */
const LONG_STRING_LIMIT = 500;

/**
 * Detect the shape of an output buffer. Deliberately cheap and conservative —
 * when in doubt, returns "plain" so nothing is touched.
 */
export function detectFormat(text: string): OutputFormat {
	const trimmed = text.trim();
	if (!trimmed) return "plain";
	if (isWholeJson(trimmed)) return "json";

	const lines = trimmed.split("\n");
	if (isNdjson(lines)) return "ndjson";
	if (isLogs(lines)) return "logs";
	return "plain";
}

function isWholeJson(trimmed: string): boolean {
	const wrapped =
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"));
	return wrapped && tryParse(trimmed);
}

/** NDJSON: most non-empty lines independently parse as JSON objects/arrays. */
function isNdjson(lines: string[]): boolean {
	if (lines.length < 3) return false;
	let jsonLines = 0;
	let sampled = 0;
	for (const line of lines) {
		const l = line.trim();
		if (!l) continue;
		sampled++;
		if (sampled > 50) break; // sampling cap — don't parse megabytes
		if ((l.startsWith("{") || l.startsWith("[")) && tryParse(l)) jsonLines++;
	}
	return sampled > 0 && jsonLines / sampled >= 0.8;
}

/**
 * Logs: many lines that (a) look log-like — leading timestamp or level token —
 * and (b) collapse to far fewer templates once variables are masked. Both
 * conditions are required so repetitive *prose* isn't mistaken for logs.
 */
function isLogs(lines: string[]): boolean {
	if (lines.length < MIN_LINES_LOGS) return false;
	const templates = new Set<string>();
	let counted = 0;
	let logLike = 0;
	for (const line of lines) {
		if (!line.trim()) continue;
		counted++;
		templates.add(maskVariables(line));
		if (LOG_LINE.test(line)) logLike++;
		if (counted > 200) break;
	}
	const repetitive = counted >= MIN_LINES_LOGS && templates.size <= counted * 0.5;
	const structured = counted > 0 && logLike / counted >= 0.5;
	return repetitive && structured;
}

/** A line looks log-like if it opens with a timestamp/clock or carries a level token. */
const LOG_LINE =
	/^\s*(?:\[?\d{4}-\d{2}-\d{2}|\[?\d{2}:\d{2}:\d{2})|\b(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|PANIC)\b/;

function tryParse(s: string): boolean {
	try {
		JSON.parse(s);
		return true;
	} catch {
		return false;
	}
}

/**
 * Replace the *variable* parts of a line with stable placeholders so that
 * structurally-identical lines map to the same template. Order matters:
 * masks that would otherwise swallow more specific patterns run later.
 */
export function maskVariables(line: string): string {
	return (
		line
			// ISO-ish timestamps and clock times
			.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<TS>")
			.replace(/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<TIME>")
			// UUIDs
			.replace(
				/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
				"<UUID>",
			)
			// Hex blobs / hashes (sha, object ids)
			.replace(/\b0x[0-9a-fA-F]+\b/g, "<HEX>")
			.replace(/\b[0-9a-fA-F]{7,}\b/g, "<HASH>")
			// IPv4 (+ optional port)
			.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<IP>")
			// Absolute-ish paths
			.replace(/(?:\/[\w.-]+){2,}/g, "<PATH>")
			// Quoted strings
			.replace(/"[^"]*"/g, '"<STR>"')
			.replace(/'[^']*'/g, "'<STR>'")
			// Any remaining digit run last (masks unit-suffixed numbers like "13ms"
			// too; the specific patterns above already consumed structured values).
			.replace(/\d+/g, "<N>")
	);
}

/** Lines we never fold away, regardless of repetition; also error-salient lines to surface. */
export const ERROR_LINE =
	/\b(error|err|fatal|panic|exception|traceback|warn|warning|failed|failure)\b/i;
const KEEP_VERBATIM = ERROR_LINE;

/**
 * Pull up to `max` distinct error/warning lines from raw output, in order.
 * Used as a safety net so the most task-critical lines survive any summary.
 */
export function extractErrorLines(text: string, max = 5): string[] {
	return countErrorLines(text, max).lines;
}

/**
 * Distinct error/warning lines plus how many there are in total.
 *
 * Callers rendered `lines.length` as a statement about the document, so a run
 * with 40 distinct errors was reported as "5 error/warning line(s) in output"
 * and the caller fixed five and moved on.
 */
export function countErrorLines(text: string, max = 5): { lines: string[]; total: number } {
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t || !ERROR_LINE.test(t) || seen.has(t)) continue;
		seen.add(t);
		if (lines.length < max) lines.push(t);
	}
	return { lines, total: seen.size };
}

/**
 * Fold repeated log lines into `template ×count`, preserving first-appearance
 * order and keeping one verbatim exemplar per template. Error/warning lines are
 * always emitted verbatim and never merged.
 */
export function compressLogs(text: string): FormatFilterResult {
	const lines = text.split("\n");
	// Ordered list of groups, each keyed by its masked template.
	const order: string[] = [];
	const groups = new Map<string, { first: string; count: number }>();
	const verbatim: Array<{ index: number; line: string }> = [];

	lines.forEach((line, index) => {
		if (!line.trim()) return;
		if (KEEP_VERBATIM.test(line)) {
			verbatim.push({ index, line });
			return;
		}
		const key = maskVariables(line);
		const g = groups.get(key);
		if (g) {
			g.count++;
		} else {
			groups.set(key, { first: line, count: 1 });
			order.push(key);
		}
	});

	const parts: string[] = [];
	for (const key of order) {
		const g = groups.get(key);
		if (!g) continue;
		if (g.count === 1) {
			parts.push(g.first);
		} else {
			parts.push(`${g.first}\n    … ×${g.count} similar lines (template: ${truncate(key, 120)})`);
		}
	}

	let out = parts.join("\n");
	if (verbatim.length > 0) {
		out += `\n\n${verbatim.length} error/warning line(s) preserved verbatim:\n`;
		out += verbatim.map((v) => v.line).join("\n");
	}

	return { output: out, filtered: out.length < text.length, format: "logs" };
}

/** Compress NDJSON: fold structurally-identical records into a schema + count. */
export function compressNdjson(text: string, mode: FilterMode): FormatFilterResult {
	const lines = text.split("\n").filter((l) => l.trim());
	const shapes = new Map<string, { first: string; count: number }>();
	const order: string[] = [];
	let parsedAll = true;

	for (const line of lines) {
		let obj: unknown;
		try {
			obj = JSON.parse(line);
		} catch {
			parsedAll = false;
			break;
		}
		const shape = shapeOf(obj);
		const s = shapes.get(shape);
		if (s) {
			s.count++;
		} else {
			shapes.set(shape, { first: line, count: 1 });
			order.push(shape);
		}
	}

	if (!parsedAll) return { output: text, filtered: false, format: "ndjson" };

	// If every record shares one shape and there are many, summarize hard.
	const parts: string[] = [`NDJSON: ${lines.length} records, ${order.length} distinct shape(s).`];
	for (const shape of order) {
		const g = shapes.get(shape);
		if (!g) continue;
		const keep = mode === "aggressive" ? 1 : ARRAY_KEEP_HEAD;
		parts.push(`\nshape ${shape} — ${g.count} record(s). Example:`);
		parts.push(minifyJson(g.first, mode));
		if (g.count > keep) parts.push(`… (${g.count - 1} more of this shape)`);
	}
	const out = parts.join("\n");
	return { output: out, filtered: out.length < text.length, format: "ndjson" };
}

/** Compress a single JSON document. */
export function compressJson(text: string, mode: FilterMode): FormatFilterResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { output: text, filtered: false, format: "json" };
	}

	// Aggressive: recursively collapse long homogeneous arrays and long strings.
	const value = mode === "aggressive" ? summarizeValue(parsed) : parsed;
	// Balanced: lossless minify. Aggressive: minify the summarized structure.
	const out = JSON.stringify(value);
	// Only claim a win if we actually got smaller.
	if (out.length >= text.length) return { output: text, filtered: false, format: "json" };
	return { output: out, filtered: true, format: "json" };
}

/**
 * Recursively summarize a parsed JSON value (aggressive mode only):
 *   - arrays longer than the threshold → keep head + `{ "…": "N more items" }`
 *   - strings longer than the limit    → truncate with a char count
 * Object keys are preserved (they carry structure/meaning).
 */
function summarizeValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		const mapped = value.slice(0, ARRAY_COLLAPSE_THRESHOLD).map(summarizeValue);
		if (value.length > ARRAY_COLLAPSE_THRESHOLD) {
			mapped.splice(ARRAY_KEEP_HEAD);
			mapped.push({ "…": `${value.length - ARRAY_KEEP_HEAD} more items (search to retrieve)` });
		}
		return mapped;
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = summarizeValue(v);
		return out;
	}
	if (typeof value === "string" && value.length > LONG_STRING_LIMIT) {
		return `${value.slice(0, LONG_STRING_LIMIT)}…(${value.length} chars)`;
	}
	return value;
}

/** A stable structural signature of a JSON value (keys + value kinds, not data). */
function shapeOf(value: unknown): string {
	if (Array.isArray(value)) return `[${value.length ? shapeOf(value[0]) : ""}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value).sort().join(",")}}`;
	}
	return typeof value;
}

function minifyJson(line: string, mode: FilterMode): string {
	try {
		const v = mode === "aggressive" ? summarizeValue(JSON.parse(line)) : JSON.parse(line);
		return JSON.stringify(v);
	} catch {
		return line;
	}
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Entry point: detect the output's format and apply the matching structural
 * compressor. Returns the input unchanged (filtered:false) when the format is
 * plain, too small to bother, or compression didn't actually shrink it.
 *
 * Conservative mode is a no-op — callers already short-circuit it, but we guard
 * here too so this is safe to call unconditionally.
 */
export function applyFormatFilter(text: string, mode: FilterMode): FormatFilterResult {
	if (mode === "conservative") return { output: text, filtered: false, format: "plain" };

	const format = detectFormat(text);
	switch (format) {
		case "json":
			if (Buffer.byteLength(text) < MIN_BYTES_JSON)
				return { output: text, filtered: false, format };
			return compressJson(text, mode);
		case "ndjson":
			if (Buffer.byteLength(text) < MIN_BYTES_JSON)
				return { output: text, filtered: false, format };
			return compressNdjson(text, mode);
		case "logs":
			return compressLogs(text);
		default:
			return { output: text, filtered: false, format: "plain" };
	}
}
