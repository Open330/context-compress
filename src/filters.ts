/**
 * Command-specific output filters.
 *
 * Three modes balance fidelity vs aggressiveness:
 *   - "conservative": no command-specific compression (callers strip ANSI only)
 *   - "balanced":     remove obvious noise (progress, hints, deprecations);
 *                     preserve metadata (commit bodies, file dates, etc.)
 *   - "aggressive":   match RTK's tactic of dropping metadata too — git log
 *                     becomes one-line per commit, ls -la drops perms/dates,
 *                     find lower threshold, grep groups by file.
 *
 * The mode is plumbed through the pipeline via compressOutput in cli/filter.ts.
 * Default is "balanced".
 */

export type FilterMode = "conservative" | "balanced" | "aggressive";

export const DEFAULT_MODE: FilterMode = "balanced";

export function parseMode(input: string | undefined): FilterMode {
	if (input === "aggressive" || input === "conservative") return input;
	return "balanced";
}

interface FilterResult {
	output: string;
	filtered: boolean;
}

/** Detect command type from code string and apply specialized filter */
export function applyCommandFilter(
	code: string,
	stdout: string,
	mode: FilterMode = DEFAULT_MODE,
): FilterResult {
	if (mode === "conservative") return { output: stdout, filtered: false };

	const cmd = code.trim().split(/\s+/)[0];
	const fullCmd = code.trim();

	// Git commands
	if (cmd === "git") return filterGit(fullCmd, stdout, mode);

	// Package managers
	if (cmd === "npm" || cmd === "yarn" || cmd === "pnpm" || cmd === "bun")
		return filterPackageManager(fullCmd, stdout, mode);

	// Test runners
	if (
		fullCmd.includes("test") ||
		fullCmd.includes("jest") ||
		fullCmd.includes("vitest") ||
		fullCmd.includes("pytest") ||
		fullCmd.includes("cargo test")
	) {
		return filterTestOutput(stdout);
	}

	// Build tools
	if (cmd === "cargo" || cmd === "make" || cmd === "gradle")
		return filterBuildOutput(fullCmd, stdout);

	// Docker/container
	if (cmd === "docker" || cmd === "kubectl") return filterContainerOutput(fullCmd, stdout);

	// ls/find/tree
	if (cmd === "ls" || cmd === "find" || cmd === "tree")
		return filterFileList(fullCmd, stdout, mode);

	// grep — aggressive mode only (group by file, drop long lines)
	if (cmd === "grep" || cmd === "rg" || cmd === "ripgrep") {
		if (mode === "aggressive") return filterGrep(stdout);
	}

	// System tabular commands: df, du, ps — aggressive mode only.
	if (mode === "aggressive") {
		if (cmd === "df") return filterDf(stdout);
		if (cmd === "du") return filterDu(stdout);
		if (cmd === "ps") return filterPs(stdout);
	}

	return { output: stdout, filtered: false };
}

export function filterGit(
	cmd: string,
	stdout: string,
	mode: FilterMode = DEFAULT_MODE,
): FilterResult {
	// git push/pull/fetch/clone: strip progress lines
	if (/git\s+(push|pull|fetch|clone)/.test(cmd)) {
		const lines = stdout.split("\n");
		const filtered = lines.filter(
			(l) =>
				!l.startsWith("remote: Counting") &&
				!l.startsWith("remote: Compressing") &&
				!l.startsWith("remote: Total") &&
				!l.includes("Unpacking objects:") &&
				!l.includes("Receiving objects:") &&
				!l.includes("Resolving deltas:") &&
				!/^\s*\d+%/.test(l),
		);
		return { output: filtered.join("\n"), filtered: true };
	}

	// git status: remove hint lines, keep branch and file status
	if (/git\s+status/.test(cmd)) {
		return { output: filterGitStatus(stdout, mode), filtered: true };
	}

	// git log — aggressive mode collapses each commit to one line
	if (/git\s+log/.test(cmd) && !cmd.includes("--oneline") && mode === "aggressive") {
		return { output: aggressiveGitLog(stdout), filtered: true };
	}

	// git diff — aggressive mode drops context lines for unified diffs.
	// Already-compact forms (--stat, --name-only, --name-status, --shortstat)
	// pass through since they ARE the summary.
	if (/git\s+diff/.test(cmd) && mode === "aggressive") {
		if (/--(stat|name-only|name-status|shortstat|numstat)\b/.test(cmd)) {
			return { output: stdout, filtered: false };
		}
		return { output: aggressiveGitDiff(stdout), filtered: true };
	}

	return { output: stdout, filtered: false };
}

function filterGitStatus(stdout: string, mode: FilterMode): string {
	const lines = stdout.split("\n");
	const balanced = lines.filter((l) => !l.startsWith("  (use ") && l.trim() !== "");
	if (mode !== "aggressive") return balanced.join("\n");

	// Aggressive: collapse "Changes not staged"/"Untracked" sections to terse counts.
	// Keep: branch line, file paths with status prefix.
	const out: string[] = [];
	for (const l of balanced) {
		if (/^On branch/.test(l)) {
			out.push(l.replace(/^On branch /, "* "));
			continue;
		}
		if (/^Your branch is/.test(l)) continue;
		if (/^Changes (to be committed|not staged for commit):/.test(l)) continue;
		if (/^Untracked files:/.test(l)) {
			out.push("? Untracked:");
			continue;
		}
		if (/^no changes added to commit/.test(l)) continue;
		if (/^nothing to commit/.test(l)) {
			out.push("(clean)");
			continue;
		}
		// File status lines: "\tmodified:   foo.ts" → "M foo.ts"
		const m = l.match(/^\s*(modified|new file|deleted|renamed|typechange):\s*(.+)$/);
		if (m) {
			const code =
				(
					{ modified: "M", "new file": "A", deleted: "D", renamed: "R", typechange: "T" } as Record<
						string,
						string
					>
				)[m[1]] ?? "?";
			out.push(`${code} ${m[2]}`);
			continue;
		}
		out.push(l);
	}
	return out.join("\n");
}

/**
 * Convert verbose `git log` output to one line per commit:
 *   "<sha7> <subject> (<reltime>) <author>"
 * Body and "Date:" lines are dropped. Merge commits keep their subject.
 */
function aggressiveGitLog(stdout: string): string {
	const lines = stdout.split("\n");
	const out: string[] = [];
	let sha = "";
	let author = "";
	let date = "";
	let subject = "";
	let inCommit = false;
	let blanksAfterDate = 0;

	const flush = () => {
		if (!sha) return;
		const reltime = date ? ` (${humanReltime(date)})` : "";
		const auth = author ? ` <${author.replace(/\s*<.*?>/, "").trim()}>` : "";
		out.push(`${sha.slice(0, 7)} ${subject}${reltime}${auth}`);
	};

	for (const line of lines) {
		const m = line.match(/^commit\s+([0-9a-f]{7,40})/);
		if (m) {
			flush();
			sha = m[1];
			author = "";
			date = "";
			subject = "";
			inCommit = true;
			blanksAfterDate = 0;
			continue;
		}
		if (!inCommit) continue;
		if (/^Author:\s/.test(line)) {
			author = line.replace(/^Author:\s+/, "").trim();
			continue;
		}
		if (/^Date:\s/.test(line)) {
			date = line.replace(/^Date:\s+/, "").trim();
			continue;
		}
		if (line.trim() === "") {
			blanksAfterDate++;
			continue;
		}
		// First non-blank line after Date: is the subject. Skip body afterward.
		if (!subject && blanksAfterDate >= 1) {
			subject = line.trim();
		}
	}
	flush();
	return out.join("\n");
}

/**
 * Convert verbose unified diff to "+ added\n- removed" only — drop hunks/context.
 */
function aggressiveGitDiff(stdout: string): string {
	const lines = stdout.split("\n");
	const out: string[] = [];
	let currentFile = "";
	for (const line of lines) {
		const fm = line.match(/^diff --git a\/(.+?) b\//);
		if (fm) {
			currentFile = fm[1];
			out.push(`@@ ${currentFile}`);
			continue;
		}
		if (/^---\s|^\+\+\+\s|^index\s|^@@\s/.test(line)) continue;
		// Keep only +/- content lines (not "+++" / "---" headers, already filtered above)
		if (line.startsWith("+") || line.startsWith("-")) out.push(line);
	}
	return out.join("\n");
}

function humanReltime(dateStr: string): string {
	const d = new Date(dateStr);
	if (Number.isNaN(d.getTime())) return dateStr;
	const ms = Date.now() - d.getTime();
	const hours = Math.round(ms / 3600_000);
	if (hours < 1) return "just now";
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.round(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.round(months / 12)}y ago`;
}

export function filterPackageManager(
	cmd: string,
	stdout: string,
	mode: FilterMode = DEFAULT_MODE,
): FilterResult {
	// npm/yarn install: strip noise, keep summary
	if (/\b(install|add|i)\b/.test(cmd)) {
		const lines = stdout.split("\n");
		const filtered = lines.filter(
			(l) =>
				!l.startsWith("npm warn") &&
				!l.includes("packages are looking for funding") &&
				!l.includes("run `npm fund`") &&
				!l.startsWith("npm notice") &&
				!/^[\s│├└─]+$/.test(l) && // tree-drawing characters
				!/^\s*$/.test(l),
		);
		// Aggressive: keep only the final "added N packages" / vulnerability summary lines
		if (mode === "aggressive") {
			const summaryOnly = filtered.filter(
				(l) =>
					/^(added|removed|changed|audited)\s+\d+/.test(l) ||
					/vulnerabilit(y|ies)/i.test(l) ||
					/^npm\s+ERR/.test(l),
			);
			return { output: summaryOnly.join("\n"), filtered: true };
		}
		return { output: filtered.join("\n"), filtered: true };
	}

	// npm test: delegate to test filter
	if (/\btest\b/.test(cmd)) {
		return filterTestOutput(stdout);
	}

	// npm ls / list / ll — aggressive mode strips tree-drawing chars and
	// collapses identical version lines.
	if (mode === "aggressive" && /\b(ls|list|ll)\b/.test(cmd)) {
		return filterNpmLs(stdout);
	}

	return { output: stdout, filtered: false };
}

/** npm ls output — strip tree-drawing characters, drop "deduped" markers, dedupe identical lines. */
function filterNpmLs(stdout: string): FilterResult {
	const lines = stdout.split("\n");
	const seen = new Set<string>();
	const out: string[] = [];
	for (const l of lines) {
		// Strip box-drawing prefix: ├── ┬ │ └── ─ etc.
		const stripped = l.replace(/^[\s│├└─┬]+/u, "").trimEnd();
		if (!stripped) continue;
		// Drop "deduped" markers — they're noise once you know there's deduplication.
		if (/\bdeduped\b/.test(stripped)) continue;
		// Drop "extraneous" labels (can appear leading or inline).
		const cleaned = stripped.replace(/^extraneous\s+/, "").replace(/\s+\bextraneous\b/g, "");
		if (seen.has(cleaned)) continue;
		seen.add(cleaned);
		out.push(cleaned);
	}
	return { output: out.join("\n"), filtered: true };
}

const FAIL_MARKER_RE = /^\s*[✗✘×]\s/;
const FAIL_WORD_RE = /\bFAIL\b/;
const FAILED_RE = /\bfailed?\b/i;
const ERROR_RE = /\bERROR\b/;
const SUMMARY_RE =
	/^\s*(Tests?|Suites?|Test Suites)\s*:|^\s*(pass|fail|skip|pending|todo)\s|\b\d+\s+(passing|failing|pending|skipped)\b|^(ok|not ok)\s|^ℹ\s|^(PASS|FAIL)\s/i;

function isFailMarker(line: string): boolean {
	return (
		FAIL_MARKER_RE.test(line) ||
		FAIL_WORD_RE.test(line) ||
		FAILED_RE.test(line) ||
		ERROR_RE.test(line)
	);
}

function isSummaryLine(line: string): boolean {
	return SUMMARY_RE.test(line);
}

export function filterTestOutput(stdout: string): FilterResult {
	const lines = stdout.split("\n");
	const failures: string[] = [];
	const summary: string[] = [];
	let inFailure = false;
	let failCount = 0;

	for (const line of lines) {
		if (isFailMarker(line)) {
			inFailure = true;
			failCount++;
		}

		if (inFailure) {
			failures.push(line);
			if (line.trim() === "" && failures.length > 3) inFailure = false;
		}

		if (isSummaryLine(line)) {
			summary.push(line);
		}
	}

	// If all pass, return compact summary
	if (failCount === 0 && summary.length > 0) {
		return { output: summary.join("\n"), filtered: true };
	}

	// If failures exist, return failures + the rollup summary lines only.
	// Drop per-file PASS lines from the summary (the FAIL lines + counts are
	// what the agent needs; 200 PASS lines just inflate context).
	if (failures.length > 0) {
		const rollup = summary.filter((l) => !/^PASS\s/i.test(l));
		const result = [...failures, "", ...rollup].join("\n");
		return { output: result, filtered: true };
	}

	return { output: stdout, filtered: false };
}

export function filterBuildOutput(cmd: string, stdout: string): FilterResult {
	const lines = stdout.split("\n");
	// Strip: download progress, "Compiling X/Y" or "Compiling crate v1.2.3" lines,
	// blocking-on-lock messages, blank lines.
	// Keep: "Finished" lines, errors, and other meaningful output.
	const filtered = lines.filter(
		(l) =>
			!l.includes("Downloading") &&
			!l.includes("Downloaded") &&
			!/Compiling\s+\d+\s+of\s+\d+/.test(l) &&
			!/^\s*Compiling\s+[\w-]+\s+v\d/.test(l) &&
			!/^\s*Checking\s+[\w-]+\s+v\d/.test(l) &&
			!l.includes("Blocking waiting for file lock") &&
			!/^\s*$/.test(l),
	);
	return { output: filtered.join("\n"), filtered: filtered.length < lines.length };
}

export function filterContainerOutput(cmd: string, stdout: string): FilterResult {
	// docker build: strip layer progress, keep step lines and summary
	if (/docker\s+build/.test(cmd)) {
		const lines = stdout.split("\n");
		const filtered = lines.filter(
			(l) => !l.startsWith(" ---> ") && !l.startsWith("Sending build context") && !/^\s*$/.test(l),
		);
		return { output: filtered.join("\n"), filtered: true };
	}

	// kubectl get / describe / logs with many rows: summarize per namespace/status
	if (/^kubectl\s+(get|describe)\b/.test(cmd)) {
		const lines = stdout.split("\n").filter((l) => l.length > 0);
		// Keep header and short outputs as-is.
		if (lines.length <= 30) return { output: stdout, filtered: false };

		const header = lines[0];
		const rows = lines.slice(1);

		// `get` rows are columnar — first column is usually NAMESPACE or NAME.
		// Group by first column + last interesting column (STATUS or AGE).
		const headerCols = header.split(/\s{2,}/);
		const hasNamespace = headerCols[0]?.toUpperCase() === "NAMESPACE";
		const statusIdx = headerCols.findIndex((c) => /^STATUS$/i.test(c));

		const counts = new Map<string, number>();
		for (const row of rows) {
			const cols = row.split(/\s{2,}/);
			const ns = hasNamespace ? cols[0] : "(default)";
			const status = statusIdx >= 0 ? cols[statusIdx] : "—";
			const key = `${ns}\t${status}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}

		const summaryLines = [`${header}`, `(${rows.length} rows summarized by namespace/status)`];
		for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
			const [ns, status] = key.split("\t");
			summaryLines.push(`  ${ns} — ${status}: ${n}`);
		}
		return { output: summaryLines.join("\n"), filtered: true };
	}

	// docker ps and other compact tabular outputs: pass through.
	return { output: stdout, filtered: false };
}

export function filterFileList(
	cmd: string,
	stdout: string,
	mode: FilterMode = DEFAULT_MODE,
): FilterResult {
	const isLs = /^ls\b/.test(cmd);

	// Aggressive mode for `ls -l*` — strip permissions/owner/date, keep name + size
	if (mode === "aggressive" && isLs && /-l/.test(cmd)) {
		return { output: aggressiveLsLong(stdout), filtered: true };
	}

	// Aggressive mode lowers find/ls -R summary thresholds to be much more compact
	const minLines = mode === "aggressive" ? 10 : 30;
	const summarizeAt = mode === "aggressive" ? 15 : 50;
	const minDirs = mode === "aggressive" ? 3 : 5;

	const lines = stdout.split("\n").filter((l) => l.trim() !== "");
	if (lines.length <= minLines) return { output: stdout, filtered: false };

	// Group by directory for find/ls -R
	if (cmd.includes("-R") || cmd.startsWith("find")) {
		const dirs = new Map<string, number>();
		for (const line of lines) {
			const parts = line.split("/");
			const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
			dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
		}

		if (dirs.size > minDirs && lines.length > summarizeAt) {
			const summary = Array.from(dirs.entries())
				.sort((a, b) => b[1] - a[1])
				.map(([dir, count]) => `  ${dir}/ (${count} files)`)
				.join("\n");
			return {
				output: `${lines.length} files found:\n${summary}`,
				filtered: true,
			};
		}
	}

	return { output: stdout, filtered: false };
}

/**
 * Strip `ls -l` metadata; emit "name [size]" rows + directory headers.
 *
 * For `ls -laR` (recursive), each subdir gets its own header section. The
 * subdir entries inside the parent's listing are redundant (they reappear
 * as section headers below), so we drop them. We also drop "." and ".."
 * entries, "total N" lines, and blank lines.
 */
function aggressiveLsLong(stdout: string): string {
	const lines = stdout.split("\n");
	const out: string[] = [];
	let inSection = false;
	for (const line of lines) {
		// Directory header from `ls -laR`: "src/dir:" — emit as `dir/`.
		if (/^[^\s]+:$/.test(line.trim())) {
			out.push(line.trim());
			inSection = true;
			continue;
		}
		// `total N` lines from ls -l — drop
		if (/^total\s+\d+/.test(line)) continue;
		// Empty lines — drop
		if (line.trim() === "") continue;
		// ls -l row: drwxr-xr-x  3 jiun  staff  96 May  6 14:20 name
		const m = line.match(
			/^([dlcb-])[rwxst@+\-]{9,}\s+\d+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+\S+\s+(.+)$/,
		);
		if (m) {
			const type = m[1];
			const sizeStr = m[2];
			const name = m[3];

			// "." and ".." entries are noise in any listing
			if (name === "." || name === "..") continue;

			// In recursive sections, directory entries get their own section
			// header below — emitting them here is redundant.
			if (type === "d" && inSection) continue;

			out.push(name + (type === "d" ? "/" : ` ${formatSize(sizeStr)}`));
			continue;
		}
		// Fallback: keep line (unknown format)
		out.push(line);
	}
	return out.join("\n");
}

function formatSize(s: string): string {
	const n = Number.parseInt(s, 10);
	if (Number.isNaN(n)) return s;
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)}K`;
	return `${n}B`;
}

/**
 * Group grep output by file, truncate long matched lines, drop redundant context.
 * Aggressive only — balanced mode passes grep through.
 */
export function filterGrep(stdout: string): FilterResult {
	const lines = stdout.split("\n").filter((l) => l.length > 0);
	if (lines.length === 0) return { output: stdout, filtered: false };

	const byFile = new Map<string, string[]>();
	for (const line of lines) {
		// grep -rn / rg: "path:lineNo:content"
		const m = line.match(/^([^:]+):(\d+):(.*)$/);
		if (!m) {
			// Plain match — group under "(no path)"
			const arr = byFile.get("(no path)") ?? [];
			arr.push(line.length > 100 ? `${line.slice(0, 100)}…` : line);
			byFile.set("(no path)", arr);
			continue;
		}
		const [, file, lineNo, content] = m;
		const truncated = content.length > 100 ? `${content.slice(0, 100)}…` : content;
		const arr = byFile.get(file) ?? [];
		arr.push(`  L${lineNo}: ${truncated.trim()}`);
		byFile.set(file, arr);
	}

	const out: string[] = [];
	for (const [file, hits] of byFile) {
		out.push(`${file} (${hits.length})`);
		for (const h of hits.slice(0, 8)) out.push(h);
		if (hits.length > 8) out.push(`  ... +${hits.length - 8} more matches`);
	}
	return { output: out.join("\n"), filtered: true };
}

/**
 * df output — drop pseudo-filesystems (tmpfs, devfs, /dev/loop, etc.) that
 * are usually noise, and shrink padding to single space.
 */
export function filterDf(stdout: string): FilterResult {
	const lines = stdout.split("\n");
	if (lines.length === 0) return { output: stdout, filtered: false };
	const header = lines[0];
	const out: string[] = [header.replace(/\s{2,}/g, " ")];
	for (const line of lines.slice(1)) {
		if (!line.trim()) continue;
		// Drop noisy pseudo-filesystems
		if (/^(tmpfs|devfs|devtmpfs|udev|overlay|map\s|none\s|\/dev\/loop)/.test(line)) continue;
		out.push(line.replace(/\s{2,}/g, " "));
	}
	return { output: out.join("\n"), filtered: true };
}

/** du -a / du -h with many entries: keep just the largest 20 + total. */
export function filterDu(stdout: string): FilterResult {
	const lines = stdout.split("\n").filter((l) => l.trim() !== "");
	if (lines.length <= 25) return { output: stdout, filtered: false };
	// Each line is "<size>\t<path>" — sort by size descending.
	const parsed = lines
		.map((l) => {
			const m = l.match(/^([\d.]+[KMGT]?B?)?\s*(.*)$/);
			if (!m) return null;
			const sizeRaw = m[1] ?? "0";
			const path = m[2];
			return { sizeRaw, sizeBytes: parseDuSize(sizeRaw), path, line: l };
		})
		.filter((x): x is NonNullable<typeof x> => x !== null);
	parsed.sort((a, b) => b.sizeBytes - a.sizeBytes);
	const top = parsed.slice(0, 20).map((p) => p.line);
	return {
		output: `(top 20 of ${parsed.length} entries by size)\n${top.join("\n")}`,
		filtered: true,
	};
}

function parseDuSize(s: string): number {
	const m = s.match(/^([\d.]+)([KMGT])?B?$/i);
	if (!m) return 0;
	const n = Number.parseFloat(m[1]);
	const unit = (m[2] ?? "").toUpperCase();
	const factor =
		unit === "T"
			? 1024 ** 4
			: unit === "G"
				? 1024 ** 3
				: unit === "M"
					? 1024 ** 2
					: unit === "K"
						? 1024
						: 1;
	return n * factor;
}

/**
 * ps aux output — keep PID, %CPU, %MEM, COMMAND only. Strip USER, VSZ, RSS,
 * STAT, START, TIME and the heavy padding. Drop kernel/system noise.
 */
export function filterPs(stdout: string): FilterResult {
	const lines = stdout.split("\n");
	if (lines.length <= 2) return { output: stdout, filtered: false };
	const header = lines[0];
	// `\b%CPU\b` doesn't match because % is not a word char; use plain includes.
	const isAux = header.includes("USER") && header.includes("%CPU") && header.includes("%MEM");
	if (!isAux) return { output: stdout, filtered: false };

	const out: string[] = ["PID  %CPU %MEM CMD"];
	for (const line of lines.slice(1)) {
		if (!line.trim()) continue;
		// ps aux columns: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND
		const parts = line.trim().split(/\s+/);
		if (parts.length < 11) continue;
		const pid = parts[1];
		const cpu = parts[2];
		const mem = parts[3];
		const cmd = parts.slice(10).join(" ");
		// Drop kernel threads (PID < 100, COMMAND in brackets) — usually noise
		if (/^\[.*\]$/.test(cmd)) continue;
		out.push(`${pid.padEnd(5)} ${cpu.padStart(4)} ${mem.padStart(4)} ${cmd}`);
	}
	return { output: out.join("\n"), filtered: true };
}
