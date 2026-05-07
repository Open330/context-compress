/**
 * Command-specific output filters.
 * Applied before generic dedup/truncation for better token reduction.
 */

interface FilterResult {
	output: string;
	filtered: boolean;
}

/** Detect command type from code string and apply specialized filter */
export function applyCommandFilter(code: string, stdout: string): FilterResult {
	const cmd = code.trim().split(/\s+/)[0];
	const fullCmd = code.trim();

	// Git commands
	if (cmd === "git") return filterGit(fullCmd, stdout);

	// Package managers
	if (cmd === "npm" || cmd === "yarn" || cmd === "pnpm" || cmd === "bun")
		return filterPackageManager(fullCmd, stdout);

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
	if (cmd === "ls" || cmd === "find" || cmd === "tree") return filterFileList(fullCmd, stdout);

	return { output: stdout, filtered: false };
}

export function filterGit(cmd: string, stdout: string): FilterResult {
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
		const lines = stdout.split("\n");
		const filtered = lines.filter((l) => !l.startsWith("  (use ") && l.trim() !== "");
		return { output: filtered.join("\n"), filtered: true };
	}

	// git log and other commands: keep as-is
	return { output: stdout, filtered: false };
}

export function filterPackageManager(cmd: string, stdout: string): FilterResult {
	// npm/yarn install: strip noise, keep summary
	if (/\b(install|add|i)\b/.test(cmd)) {
		const lines = stdout.split("\n");
		const filtered = lines.filter(
			(l) =>
				!l.startsWith("npm warn") &&
				!l.includes("packages are looking for funding") &&
				!l.includes("run `npm fund`") &&
				!l.startsWith("npm notice") &&
				!/^[\s\u2502\u251C\u2514\u2500]+$/.test(l) && // tree-drawing characters
				!/^\s*$/.test(l),
		);
		return { output: filtered.join("\n"), filtered: true };
	}

	// npm test: delegate to test filter
	if (/\btest\b/.test(cmd)) {
		return filterTestOutput(stdout);
	}

	return { output: stdout, filtered: false };
}

const FAIL_MARKER_RE = /^\s*[\u2717\u2718\u00D7]\s/;
const FAIL_WORD_RE = /\bFAIL\b/;
const FAILED_RE = /\bfailed?\b/i;
const ERROR_RE = /\bERROR\b/;
const SUMMARY_RE =
	/^\s*(Tests?|Suites?|Test Suites)\s*:|^\s*(pass|fail|skip|pending|todo)\s|\b\d+\s+(passing|failing|pending|skipped)\b|^(ok|not ok)\s|^\u2139\s|^(PASS|FAIL)\s/i;

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

export function filterFileList(cmd: string, stdout: string): FilterResult {
	const lines = stdout.split("\n").filter((l) => l.trim() !== "");

	// If output is short, keep as-is
	if (lines.length <= 30) return { output: stdout, filtered: false };

	// Group by directory for find/ls -R
	if (cmd.includes("-R") || cmd.startsWith("find")) {
		const dirs = new Map<string, number>();
		for (const line of lines) {
			const parts = line.split("/");
			const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
			dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
		}

		// If many files, summarize by directory
		if (dirs.size > 5 && lines.length > 50) {
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
