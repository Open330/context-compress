#!/usr/bin/env node
/**
 * Benchmark context-compress against realistic CLI outputs that are
 * typical sources of token waste in coding-agent sessions.
 *
 * Usage:
 *   tsx scripts/benchmark.ts                 # human report to stdout
 *   tsx scripts/benchmark.ts --json          # machine-readable JSON
 *
 * What it does: takes synthetic-but-representative outputs for each command
 * RTK targets, pipes them through the same compression pipeline that
 * SubprocessExecutor / context-compress wrap apply (stripAnsi →
 * applyCommandFilter → progress/dedup/group), and reports compression
 * ratio per command + an overall summary.
 *
 * RTK reports an average of ~89% reduction across its targeted commands
 * (https://www.rtk-ai.app). This benchmark gives a like-for-like number
 * for context-compress so we can compare honestly.
 */

import { compressOutput } from "../src/cli/filter.js";

interface Sample {
	cmd: string;
	label: string;
	input: string;
}

const ANSI = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;

const SAMPLES: Sample[] = [
	{
		label: "git push (50 progress lines)",
		cmd: "git push origin main",
		input: [
			"Enumerating objects: 247, done.",
			"Counting objects: 100% (247/247), done.",
			...Array.from(
				{ length: 30 },
				(_, i) => `remote: Counting objects: ${Math.round((i / 30) * 100)}% (${i * 8}/247)`,
			),
			...Array.from(
				{ length: 15 },
				(_, i) => `remote: Compressing objects: ${Math.round((i / 15) * 100)}% (${i * 4}/60)`,
			),
			"remote: Total 247 (delta 119), reused 0 (delta 0)",
			"To github.com:user/repo.git",
			"   abc123..def456  main -> main",
		].join("\n"),
	},
	{
		label: "git status (typical)",
		cmd: "git status",
		input: [
			"On branch feature/big-refactor",
			"Your branch is ahead of 'origin/feature/big-refactor' by 3 commits.",
			'  (use "git push" to publish your local commits)',
			"",
			"Changes not staged for commit:",
			'  (use "git add <file>..." to update what will be committed)',
			'  (use "git restore <file>..." to discard changes in working directory)',
			"\tmodified:   src/server.ts",
			"\tmodified:   src/store.ts",
			"\tmodified:   src/network.ts",
			"",
			"Untracked files:",
			'  (use "git add <file>..." to include in what will be committed)',
			"\tsrc/tools/",
			"\tsrc/util/",
			"\ttests/unit/path.test.ts",
			"",
			'no changes added to commit (use "git add" and/or "git commit -a")',
		].join("\n"),
	},
	{
		label: "npm install (large, with warnings)",
		cmd: "npm install",
		input: [
			...Array.from(
				{ length: 80 },
				(_, i) => `npm warn deprecated package-${i}@1.0.0: This package is deprecated, use v2 instead`,
			),
			"npm notice ",
			"npm notice New patch version available: 11.0.1 -> 11.0.2",
			"npm notice ",
			"",
			"added 1247 packages, and audited 1248 packages in 23s",
			"",
			"189 packages are looking for funding",
			"  run `npm fund` for details",
			"",
			"3 vulnerabilities (1 moderate, 2 high)",
			"",
			"To address all issues, run:",
			"  npm audit fix",
		].join("\n"),
	},
	{
		label: "npm test (200 passing, 1 failing)",
		cmd: "npm test",
		input: [
			...Array.from(
				{ length: 80 },
				(_, i) => `PASS src/foo${i}.test.ts\n  ✓ test ${i} should work (${(Math.random() * 5).toFixed(1)}ms)`,
			).flat(),
			"FAIL src/buggy.test.ts",
			"  ✗ regression: should not divide by zero (3.2ms)",
			"    AssertionError [ERR_ASSERTION]: Expected non-NaN result",
			"        at TestContext.<anonymous> (/repo/src/buggy.test.ts:42:10)",
			"        at Test.runInAsyncScope (node:async_hooks:214:14)",
			"",
			"ℹ tests 201",
			"ℹ pass 200",
			"ℹ fail 1",
			"ℹ duration_ms 14572",
		].join("\n"),
	},
	{
		label: "cargo build (release, deps + finished)",
		cmd: "cargo build --release",
		input: [
			...Array.from(
				{ length: 60 },
				(_, i) => `   Compiling crate-${i} v${i % 5}.${i % 3}.${i % 7}`,
			),
			...Array.from({ length: 12 }, () => "    Blocking waiting for file lock on package cache"),
			"   Compiling my-app v0.1.0 (/repo)",
			"    Finished `release` profile [optimized] in 47.32s",
		].join("\n"),
	},
	{
		label: "find -name *.ts (deep tree)",
		cmd: "find . -name '*.ts'",
		input: Array.from({ length: 600 }, (_, i) => {
			const dir = `src/${["app", "lib", "tools", "util", "tests", "shared"][i % 6]}/${["a", "b", "c", "d"][i % 4]}`;
			return `${dir}/file${i}.ts`;
		}).join("\n"),
	},
	{
		label: "docker build (multi-stage, 18 steps)",
		cmd: "docker build -t app .",
		input: [
			"Sending build context to Docker daemon  124.5MB",
			...Array.from({ length: 18 }, (_, i) => [
				`Step ${i + 1}/18 : ${["FROM node:18", "WORKDIR /app", "COPY . .", "RUN npm ci", "RUN npm run build", "FROM node:18-slim"][i % 6]}`,
				` ---> Using cache`,
				` ---> ${Math.random().toString(16).slice(2, 14)}`,
			]).flat(),
			"Successfully built abc123def456",
			"Successfully tagged app:latest",
		].join("\n"),
	},
	{
		label: "ANSI-heavy npm test output",
		cmd: "npm test",
		input: [
			...Array.from(
				{ length: 50 },
				(_, i) =>
					`\x1b[32m  ✓\x1b[0m \x1b[2mtest case ${i} should pass (${(Math.random() * 3).toFixed(0)}ms)\x1b[0m`,
			),
			"\x1b[32mPASS\x1b[0m src/foo.test.ts",
			"\x1b[31mFAIL\x1b[0m src/bar.test.ts",
			"  \x1b[31m✗\x1b[0m regression test",
			"\x1b[36mℹ\x1b[0m tests 51",
			"\x1b[36mℹ\x1b[0m pass 50",
			"\x1b[36mℹ\x1b[0m fail 1",
		].join("\n"),
	},
	{
		label: "deduplication-heavy log",
		cmd: "tail -n 1000 /var/log/app.log",
		input: Array.from({ length: 200 }, () =>
			"[2026-05-07 12:34:56] DEBUG [pool] connection acquired from idle pool",
		).join("\n") +
			"\n" +
			Array.from({ length: 50 }, () =>
				"[2026-05-07 12:34:57] WARN  [retry] backing off, attempt 3/5",
			).join("\n"),
	},
	{
		label: "kubectl get pods (large namespace)",
		cmd: "kubectl get pods -A",
		input: [
			"NAMESPACE     NAME                                READY   STATUS    RESTARTS   AGE",
			...Array.from({ length: 250 }, (_, i) => {
				const ns = ["default", "kube-system", "monitoring", "ingress"][i % 4];
				return `${ns.padEnd(13)} pod-${i}-${Math.random().toString(36).slice(2, 7).padEnd(11)}   1/1     Running   0          ${i}d`;
			}),
		].join("\n"),
	},
];

interface Result {
	label: string;
	beforeBytes: number;
	afterBytes: number;
	ratioPct: number; // 100 - (after/before)*100
	beforeTokens: number; // bytes/4 estimate
	afterTokens: number;
}

function tokens(bytes: number): number {
	return Math.round(bytes / 4);
}

function bench(): Result[] {
	return SAMPLES.map((s) => {
		const before = Buffer.byteLength(s.input, "utf-8");
		const out = compressOutput(s.input, s.cmd);
		const after = Buffer.byteLength(out, "utf-8");
		const ratio = before === 0 ? 0 : (1 - after / before) * 100;
		return {
			label: s.label,
			beforeBytes: before,
			afterBytes: after,
			ratioPct: ratio,
			beforeTokens: tokens(before),
			afterTokens: tokens(after),
		};
	});
}

function fmtBytes(n: number): string {
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${n}B`;
}

function pad(s: string, n: number): string {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function reportHuman(results: Result[]): void {
	console.log(
		"\nContext-compress compression benchmark — vs. RTK's claimed ~89% average\n",
	);
	console.log(
		`  ${pad("Command", 38)}  ${pad("Before", 10)}  ${pad("After", 10)}  ${pad("Tokens (B→A)", 18)}  Reduction`,
	);
	console.log("  " + "─".repeat(95));

	let totalBefore = 0;
	let totalAfter = 0;
	for (const r of results) {
		const reductionStr = `${r.ratioPct.toFixed(1)}%`;
		const colored =
			r.ratioPct >= 89 ? ANSI(reductionStr) : r.ratioPct >= 60 ? reductionStr : RED(reductionStr);
		console.log(
			`  ${pad(r.label, 38)}  ${pad(fmtBytes(r.beforeBytes), 10)}  ${pad(fmtBytes(r.afterBytes), 10)}  ${pad(`${r.beforeTokens.toLocaleString()} → ${r.afterTokens.toLocaleString()}`, 18)}  ${colored}`,
		);
		totalBefore += r.beforeBytes;
		totalAfter += r.afterBytes;
	}
	console.log("  " + "─".repeat(95));

	const overallRatio = (1 - totalAfter / totalBefore) * 100;
	const totalTokensBefore = tokens(totalBefore);
	const totalTokensAfter = tokens(totalAfter);
	const overallStr = `${overallRatio.toFixed(1)}%`;
	const overallColored =
		overallRatio >= 89 ? ANSI(overallStr) : overallRatio >= 60 ? overallStr : RED(overallStr);

	console.log(
		`  ${pad("OVERALL", 38)}  ${pad(fmtBytes(totalBefore), 10)}  ${pad(fmtBytes(totalAfter), 10)}  ${pad(`${totalTokensBefore.toLocaleString()} → ${totalTokensAfter.toLocaleString()}`, 18)}  ${overallColored}`,
	);
	console.log();
	console.log(
		`  RTK reports ~89% average. context-compress achieved ${overallStr} on this set.\n`,
	);
}

function main(): void {
	const results = bench();
	if (process.argv.includes("--json")) {
		const overallBefore = results.reduce((a, b) => a + b.beforeBytes, 0);
		const overallAfter = results.reduce((a, b) => a + b.afterBytes, 0);
		console.log(
			JSON.stringify(
				{
					results,
					overall: {
						beforeBytes: overallBefore,
						afterBytes: overallAfter,
						ratioPct: (1 - overallAfter / overallBefore) * 100,
						beforeTokens: tokens(overallBefore),
						afterTokens: tokens(overallAfter),
					},
					rtkClaim: 89,
				},
				null,
				2,
			),
		);
	} else {
		reportHuman(results);
	}
}

main();
