#!/usr/bin/env node
/**
 * Head-to-head benchmark: context-compress vs RTK on real commands.
 *
 * Asks the same conceptual question (e.g. "what's the git status?") to
 * both tools and measures how many bytes each returns. RTK has its own
 * subcommands (rtk git status, rtk ls, rtk find) that internally run the
 * native command and filter; context-compress wraps the raw shell command.
 *
 * Usage:
 *   RTK_BIN=/tmp/rtk-bench/rtk/target/release/rtk \
 *     tsx scripts/benchmark-vs-rtk.ts                 # human report
 *   RTK_BIN=... tsx scripts/benchmark-vs-rtk.ts --quick  # skip slow
 *   RTK_BIN=... tsx scripts/benchmark-vs-rtk.ts --json   # JSON
 *
 * If RTK_BIN env var is unset, defaults to `rtk` from PATH.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { compressOutput } from "../src/cli/filter.js";
import type { FilterMode } from "../src/filters.js";

const MODES: FilterMode[] = ["conservative", "balanced", "aggressive"];

interface Probe {
	label: string;
	raw: { cmd: string; args?: string[] }; // baseline: bash -c cmd
	rtk: { argv: string[] }; // rtk subcommand invocation
	slow?: boolean;
	timeoutMs?: number;
}

const RTK_BIN = process.env.RTK_BIN ?? "rtk";

const PROBES: Probe[] = [
	{
		label: "git status",
		raw: { cmd: "git status" },
		rtk: { argv: ["git", "status"] },
	},
	{
		label: "git log -10",
		raw: { cmd: "git log -10" },
		rtk: { argv: ["git", "log", "-n", "10"] },
	},
	{
		label: "git log -50",
		raw: { cmd: "git log -50" },
		rtk: { argv: ["git", "log", "-n", "50"] },
	},
	{
		label: "git diff HEAD~3 --stat",
		raw: { cmd: "git diff HEAD~3 HEAD --stat" },
		// RTK's `diff` takes file args, not git refs — closest is rtk git
		rtk: { argv: ["git", "diff", "HEAD~3", "HEAD", "--stat"] },
	},
	{
		label: "ls src/",
		raw: { cmd: "ls src/" },
		rtk: { argv: ["ls", "src/"] },
	},
	{
		label: "ls -laR src/",
		raw: { cmd: "ls -laR src/" },
		// RTK's ls has its own opinionated output; pass src/ for comparable scope
		rtk: { argv: ["ls", "src/"] },
	},
	{
		label: "find *.ts in src/",
		raw: { cmd: "find src -name '*.ts'" },
		rtk: { argv: ["find", "*.ts", "src"] },
	},
	{
		label: "grep TODO src/",
		raw: { cmd: "grep -rn 'TODO' src/ 2>&1 || true" },
		rtk: { argv: ["grep", "TODO", "src/"] },
	},
	{
		label: "npm test",
		raw: { cmd: "npm test 2>&1 || true" },
		rtk: { argv: ["test", "npm", "test"] },
		slow: true,
		timeoutMs: 120_000,
	},
];

function runRaw(cmd: string, timeoutMs = 30_000): string | null {
	const r = spawnSync(process.platform === "win32" ? "cmd" : "bash", [
		process.platform === "win32" ? "/c" : "-c",
		cmd,
	], {
		encoding: "utf-8",
		maxBuffer: 100 * 1024 * 1024,
		timeout: timeoutMs,
		env: { ...process.env, FORCE_COLOR: "1" },
	});
	if (r.error) return null;
	return (r.stdout ?? "") + (r.stderr ?? "");
}

function runRtk(argv: string[], timeoutMs = 60_000): string | null {
	const r = spawnSync(RTK_BIN, argv, {
		encoding: "utf-8",
		maxBuffer: 100 * 1024 * 1024,
		timeout: timeoutMs,
		env: {
			...process.env,
			// Suppress the "no hook installed" advisory line so it doesn't
			// inflate RTK's byte count for one-shot runs.
			RTK_TELEMETRY: "0",
			NO_COLOR: "1",
		},
	});
	if (r.error) return null;
	return (r.stdout ?? "") + (r.stderr ?? "");
}

interface Row {
	label: string;
	rawBytes: number;
	rtkBytes: number;
	rtkRatioPct: number;
	ccByMode: Record<FilterMode, { bytes: number; ratioPct: number }>;
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
function colorPct(pct: number): string {
	const s = `${pct.toFixed(1)}%`;
	if (pct >= 80) return G(s);
	if (pct >= 50) return Y(s);
	return R(s);
}

function emptyCcByMode(): Record<FilterMode, { bytes: number; ratioPct: number }> {
	return {
		conservative: { bytes: 0, ratioPct: 0 },
		balanced: { bytes: 0, ratioPct: 0 },
		aggressive: { bytes: 0, ratioPct: 0 },
	};
}

function bench(opts: { quick: boolean }): Row[] {
	const rows: Row[] = [];
	for (const p of PROBES) {
		if (p.slow && opts.quick) {
			rows.push({
				label: p.label,
				rawBytes: 0,
				rtkBytes: 0,
				rtkRatioPct: 0,
				ccByMode: emptyCcByMode(),
				skipped: "slow",
			});
			continue;
		}
		const rawOut = runRaw(p.raw.cmd, p.timeoutMs ?? 30_000);
		if (rawOut === null) {
			rows.push({
				label: p.label,
				rawBytes: 0,
				rtkBytes: 0,
				rtkRatioPct: 0,
				ccByMode: emptyCcByMode(),
				skipped: "raw command failed",
			});
			continue;
		}
		const rtkOut = runRtk(p.rtk.argv, p.timeoutMs ?? 60_000);
		if (rtkOut === null) {
			rows.push({
				label: p.label,
				rawBytes: Buffer.byteLength(rawOut, "utf-8"),
				rtkBytes: 0,
				rtkRatioPct: 0,
				ccByMode: emptyCcByMode(),
				skipped: "rtk failed",
			});
			continue;
		}

		const rawBytes = Buffer.byteLength(rawOut, "utf-8");
		const rtkBytes = Buffer.byteLength(rtkOut, "utf-8");
		const ccByMode = emptyCcByMode();
		for (const m of MODES) {
			const out = compressOutput(rawOut, p.raw.cmd, m);
			const bytes = Buffer.byteLength(out, "utf-8");
			ccByMode[m] = {
				bytes,
				ratioPct: rawBytes ? (1 - bytes / rawBytes) * 100 : 0,
			};
		}

		rows.push({
			label: p.label,
			rawBytes,
			rtkBytes,
			rtkRatioPct: rawBytes ? (1 - rtkBytes / rawBytes) * 100 : 0,
			ccByMode,
		});
	}
	return rows;
}

function reportHuman(rows: Row[]): void {
	console.log("\n  Head-to-head: context-compress (3 modes) vs RTK\n");
	console.log(
		`  ${pad("Command", 26)}  ${pad("Raw", 8)}  ${pad("RTK", 8)} ${pad("", 6)}  ${pad("CC-cons", 8)} ${pad("", 6)}  ${pad("CC-bal", 8)} ${pad("", 6)}  ${pad("CC-aggr", 8)} ${pad("", 6)}`,
	);
	console.log("  " + "─".repeat(112));

	let rawTotal = 0;
	let rtkTotal = 0;
	const modeTotals: Record<FilterMode, number> = {
		conservative: 0,
		balanced: 0,
		aggressive: 0,
	};
	let counted = 0;

	for (const r of rows) {
		if (r.skipped) {
			console.log(`  ${pad(r.label, 26)}  (skipped: ${r.skipped})`);
			continue;
		}
		const rtkPct = r.rtkRatioPct;
		const cons = r.ccByMode.conservative;
		const bal = r.ccByMode.balanced;
		const aggr = r.ccByMode.aggressive;
		console.log(
			`  ${pad(r.label, 26)}  ${pad(fmt(r.rawBytes), 8)}  ${pad(fmt(r.rtkBytes), 8)} ${pad(`(${rtkPct.toFixed(0)}%)`, 6)}  ${pad(fmt(cons.bytes), 8)} ${pad(`(${cons.ratioPct.toFixed(0)}%)`, 6)}  ${pad(fmt(bal.bytes), 8)} ${pad(`(${bal.ratioPct.toFixed(0)}%)`, 6)}  ${pad(fmt(aggr.bytes), 8)} ${pad(colorPct(aggr.ratioPct), 16)}`,
		);
		rawTotal += r.rawBytes;
		rtkTotal += r.rtkBytes;
		modeTotals.conservative += cons.bytes;
		modeTotals.balanced += bal.bytes;
		modeTotals.aggressive += aggr.bytes;
		counted++;
	}
	console.log("  " + "─".repeat(112));

	if (counted === 0) {
		console.log("\n  No valid measurements.\n");
		return;
	}
	const rtkOverall = (1 - rtkTotal / rawTotal) * 100;
	const consOverall = (1 - modeTotals.conservative / rawTotal) * 100;
	const balOverall = (1 - modeTotals.balanced / rawTotal) * 100;
	const aggrOverall = (1 - modeTotals.aggressive / rawTotal) * 100;

	console.log(
		`  ${pad("OVERALL (byte-weighted)", 26)}  ${pad(fmt(rawTotal), 8)}  ${pad(fmt(rtkTotal), 8)} ${pad(colorPct(rtkOverall), 16)}  ${pad(fmt(modeTotals.conservative), 8)} ${pad(colorPct(consOverall), 16)}  ${pad(fmt(modeTotals.balanced), 8)} ${pad(colorPct(balOverall), 16)}  ${pad(fmt(modeTotals.aggressive), 8)} ${pad(colorPct(aggrOverall), 16)}`,
	);
	console.log();
	console.log(`  Raw total:      ${fmt(rawTotal)} (${tokens(rawTotal).toLocaleString()} tok)`);
	console.log(
		`  RTK:            ${fmt(rtkTotal)} (${tokens(rtkTotal).toLocaleString()} tok) — ${colorPct(rtkOverall)} reduction`,
	);
	console.log(
		`  CC conservative ${fmt(modeTotals.conservative)} (${tokens(modeTotals.conservative).toLocaleString()} tok) — ${colorPct(consOverall)} reduction`,
	);
	console.log(
		`  CC balanced     ${fmt(modeTotals.balanced)} (${tokens(modeTotals.balanced).toLocaleString()} tok) — ${colorPct(balOverall)} reduction`,
	);
	console.log(
		`  CC aggressive   ${fmt(modeTotals.aggressive)} (${tokens(modeTotals.aggressive).toLocaleString()} tok) — ${colorPct(aggrOverall)} reduction`,
	);
	console.log();
	const best = Math.max(rtkOverall, balOverall, aggrOverall);
	if (aggrOverall === best) {
		console.log(
			`  context-compress aggressive leads (${(aggrOverall - rtkOverall).toFixed(1)}pp over RTK, ${(aggrOverall - balOverall).toFixed(1)}pp over balanced).`,
		);
	} else if (rtkOverall === best) {
		console.log(
			`  RTK leads (${(rtkOverall - aggrOverall).toFixed(1)}pp over CC aggressive, ${(rtkOverall - balOverall).toFixed(1)}pp over CC balanced).`,
		);
	} else {
		console.log(`  CC balanced leads.`);
	}
	console.log();
}

function main(): void {
	const args = process.argv.slice(2);
	const opts = { quick: args.includes("--quick"), json: args.includes("--json") };

	if (!existsSync(".git")) {
		console.error("Run from the repo root.");
		process.exit(2);
	}

	// Verify RTK binary exists
	const probe = spawnSync(RTK_BIN, ["--version"], { encoding: "utf-8" });
	if (probe.status !== 0) {
		console.error(
			`Cannot find RTK binary at "${RTK_BIN}". Set RTK_BIN env var to its absolute path.`,
		);
		process.exit(2);
	}
	console.log(`Using RTK: ${probe.stdout.trim()}`);

	const rows = bench(opts);
	if (opts.json) {
		console.log(JSON.stringify(rows, null, 2));
	} else {
		reportHuman(rows);
	}
}

main();
