#!/usr/bin/env node
/**
 * Real-world compression benchmark.
 *
 * Runs actual commands in the current repository and measures compression
 * ratios. Unlike scripts/benchmark.ts (synthetic data, reproducible numbers),
 * this gives authentic numbers from real shell output — what an agent
 * would actually see if it ran these commands.
 *
 * Usage:
 *   tsx scripts/benchmark-real.ts             # full run
 *   tsx scripts/benchmark-real.ts --quick     # skip slow commands (npm test)
 *   tsx scripts/benchmark-real.ts --json      # machine-readable
 *
 * Skipped automatically if the underlying tool is missing (docker, kubectl).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { compressOutput } from "../src/cli/filter.js";

interface Probe {
	label: string;
	cmd: string;
	requires?: string; // executable that must exist for this probe
	slow?: boolean;
	timeoutMs?: number;
}

const PROBES: Probe[] = [
	// Light-weight queries (low compression ceiling, but representative)
	{ label: "git status", cmd: "git status" },
	{ label: "git log --oneline -50", cmd: "git log --oneline -50" },
	{ label: "git diff HEAD~3 HEAD --stat", cmd: "git diff HEAD~3 HEAD --stat" },
	{ label: "git ls-files", cmd: "git ls-files" },
	{ label: "git branch -a", cmd: "git branch -a" },
	{ label: "node --version + which", cmd: "node --version && which node" },
	{ label: "npm ls (top level)", cmd: "npm ls --depth=0 2>&1 || true" },
	{ label: "npm outdated", cmd: "npm outdated 2>&1 || true" },

	// Medium-weight (between 2-15KB, typical for non-trivial queries)
	{ label: "git log -10 (full)", cmd: "git log -10" },
	{ label: "git log -50 (full)", cmd: "git log -50" },
	{
		label: "find *.ts (no node_modules)",
		cmd: "find . -name '*.ts' -not -path './node_modules/*' -not -path './dist*/*'",
	},
	{ label: "ls -laR src/", cmd: "ls -laR src/" },
	{ label: "wc -l src/**/*.ts", cmd: "find src -name '*.ts' -exec wc -l {} +" },

	// Heavy (the cases that genuinely pressure the context window)
	{ label: "find . (entire tree, deps included)", cmd: "find . -type f 2>&1 | head -2000" },
	{
		label: "npm test",
		cmd: "npm test 2>&1 || true",
		slow: true,
		timeoutMs: 120_000,
	},
];

function which(bin: string): boolean {
	const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
		encoding: "utf-8",
	});
	return r.status === 0;
}

function runCommand(cmd: string, timeoutMs = 30_000): string | null {
	try {
		const out = execFileSync(process.platform === "win32" ? "cmd" : "bash", [
			process.platform === "win32" ? "/c" : "-c",
			cmd,
		], {
			encoding: "utf-8",
			maxBuffer: 100 * 1024 * 1024,
			timeout: timeoutMs,
			env: { ...process.env, FORCE_COLOR: "1" }, // capture realistic ANSI
		});
		return out;
	} catch (e: unknown) {
		const err = e as { stdout?: string; stderr?: string; status?: number };
		// Some commands (npm test with failing tests) exit non-zero but produce useful output.
		if (err.stdout) return err.stdout + (err.stderr ?? "");
		return null;
	}
}

interface Result {
	label: string;
	cmd: string;
	beforeBytes: number;
	afterBytes: number;
	ratioPct: number;
	beforeTokens: number;
	afterTokens: number;
	skipped?: string;
}

function tokens(b: number): number {
	return Math.round(b / 4);
}
function fmt(n: number): string {
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${n}B`;
}
function pad(s: string, n: number): string {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;

function bench(probes: Probe[], opts: { quick: boolean }): Result[] {
	const results: Result[] = [];
	for (const p of probes) {
		if (p.slow && opts.quick) {
			results.push({
				label: p.label,
				cmd: p.cmd,
				beforeBytes: 0,
				afterBytes: 0,
				ratioPct: 0,
				beforeTokens: 0,
				afterTokens: 0,
				skipped: "slow",
			});
			continue;
		}
		if (p.requires && !which(p.requires)) {
			results.push({
				label: p.label,
				cmd: p.cmd,
				beforeBytes: 0,
				afterBytes: 0,
				ratioPct: 0,
				beforeTokens: 0,
				afterTokens: 0,
				skipped: `${p.requires} not installed`,
			});
			continue;
		}
		const out = runCommand(p.cmd, p.timeoutMs);
		if (out === null) {
			results.push({
				label: p.label,
				cmd: p.cmd,
				beforeBytes: 0,
				afterBytes: 0,
				ratioPct: 0,
				beforeTokens: 0,
				afterTokens: 0,
				skipped: "command failed",
			});
			continue;
		}
		const before = Buffer.byteLength(out, "utf-8");
		const compressed = compressOutput(out, p.cmd);
		const after = Buffer.byteLength(compressed, "utf-8");
		const ratio = before === 0 ? 0 : (1 - after / before) * 100;
		results.push({
			label: p.label,
			cmd: p.cmd,
			beforeBytes: before,
			afterBytes: after,
			ratioPct: ratio,
			beforeTokens: tokens(before),
			afterTokens: tokens(after),
		});
	}
	return results;
}

function reportHuman(results: Result[]): void {
	console.log("\n  Real-world compression benchmark — actual commands run in this repo\n");
	console.log(
		`  ${pad("Command", 38)}  ${pad("Before", 10)}  ${pad("After", 10)}  ${pad("Tokens (B→A)", 20)}  Reduction`,
	);
	console.log("  " + "─".repeat(102));

	let totalBefore = 0;
	let totalAfter = 0;
	let counted = 0;
	let largeBefore = 0;
	let largeAfter = 0;
	let largeCounted = 0;
	for (const r of results) {
		if (r.skipped) {
			console.log(
				`  ${pad(r.label, 38)}  ${pad("—", 10)}  ${pad("—", 10)}  ${pad(`(skipped: ${r.skipped})`, 20)}`,
			);
			continue;
		}
		const reductionStr = `${r.ratioPct.toFixed(1)}%`;
		const colored =
			r.ratioPct >= 89 ? G(reductionStr) : r.ratioPct >= 60 ? Y(reductionStr) : R(reductionStr);
		console.log(
			`  ${pad(r.label, 38)}  ${pad(fmt(r.beforeBytes), 10)}  ${pad(fmt(r.afterBytes), 10)}  ${pad(`${r.beforeTokens.toLocaleString()} → ${r.afterTokens.toLocaleString()}`, 20)}  ${colored}`,
		);
		totalBefore += r.beforeBytes;
		totalAfter += r.afterBytes;
		counted++;
		// "Large" = anything that would actually pressure the context window.
		// Small outputs (<2KB) have a low compression ceiling by definition;
		// the interesting question is what happens to genuinely noisy output.
		if (r.beforeBytes >= 2048) {
			largeBefore += r.beforeBytes;
			largeAfter += r.afterBytes;
			largeCounted++;
		}
	}
	console.log("  " + "─".repeat(102));

	if (counted === 0) {
		console.log("\n  No commands ran successfully.\n");
		return;
	}
	const overall = (1 - totalAfter / totalBefore) * 100;
	const overallStr = `${overall.toFixed(1)}%`;
	const overallC = overall >= 89 ? G(overallStr) : overall >= 60 ? Y(overallStr) : R(overallStr);
	console.log(
		`  ${pad("ALL commands (byte-weighted)", 38)}  ${pad(fmt(totalBefore), 10)}  ${pad(fmt(totalAfter), 10)}  ${pad(`${tokens(totalBefore).toLocaleString()} → ${tokens(totalAfter).toLocaleString()}`, 20)}  ${overallC}`,
	);
	if (largeCounted > 0) {
		const large = (1 - largeAfter / largeBefore) * 100;
		const largeStr = `${large.toFixed(1)}%`;
		const largeC =
			large >= 89 ? G(largeStr) : large >= 60 ? Y(largeStr) : R(largeStr);
		console.log(
			`  ${pad(`LARGE outputs only (≥2KB, ${largeCounted})`, 38)}  ${pad(fmt(largeBefore), 10)}  ${pad(fmt(largeAfter), 10)}  ${pad(`${tokens(largeBefore).toLocaleString()} → ${tokens(largeAfter).toLocaleString()}`, 20)}  ${largeC}`,
		);
	}
	console.log();
	console.log("  Notes:");
	console.log(
		"    • Small commands (<2KB) have inherently low compression ceiling — already minimal.",
	);
	console.log(
		"    • Compression value is highest where output is large (npm test, find, kubectl get,",
	);
	console.log(
		"      docker build, npm install). Those are the cases that pressure the context window.",
	);
	console.log(
		"    • RTK's claimed ~89% is on synthetic targeted commands. Real sessions mix big and small.",
	);
	console.log();
}

function main(): void {
	const args = process.argv.slice(2);
	const opts = { quick: args.includes("--quick"), json: args.includes("--json") };

	if (!existsSync(".git")) {
		console.error("Run from the repo root.");
		process.exit(2);
	}

	const results = bench(PROBES, opts);
	if (opts.json) {
		const counted = results.filter((r) => !r.skipped);
		const overallBefore = counted.reduce((a, b) => a + b.beforeBytes, 0);
		const overallAfter = counted.reduce((a, b) => a + b.afterBytes, 0);
		console.log(
			JSON.stringify(
				{
					results,
					overall: {
						beforeBytes: overallBefore,
						afterBytes: overallAfter,
						ratioPct: overallBefore ? (1 - overallAfter / overallBefore) * 100 : 0,
						commandsCounted: counted.length,
					},
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
