/**
 * Quality-regression benchmark.
 *
 * The usual compression metric is "% tokens removed" — but for an agent, the
 * number that actually matters is whether the *task-critical information
 * survived* the compression (cf. ACON / the agent-compression literature, which
 * evaluates end-task success, not token ratio). A compressor that drops 99% of
 * bytes is worthless if it also drops the error message the agent needed.
 *
 * This harness runs a fixed corpus of (command, output, must-contain) cases
 * through the real compression pipeline at every mode and reports two numbers
 * per case: reduction % and survival % (fraction of must-contain assertions still
 * present). It's consumed both by a CLI report (npm run bench:quality) and by a
 * unit test that fails if survival regresses below the per-case floor — so the
 * Phase 1–3 compressors can't silently start eating important output.
 */

import { compressOutput } from "../cli/filter.js";
import type { FilterMode } from "../filters.js";

export interface BenchCase {
	name: string;
	command: string;
	output: string;
	/** Substrings that MUST survive compression in every mode. */
	mustContain: string[];
	/** If true, balanced-mode output must remain parseable JSON. */
	balancedKeepsValidJson?: boolean;
	/** Minimum acceptable survival ratio (default 1.0 — everything must survive). */
	minSurvival?: number;
}

export interface ModeResult {
	mode: FilterMode;
	beforeBytes: number;
	afterBytes: number;
	reduction: number; // 0–1
	survival: number; // 0–1
	missing: string[];
	validJson: boolean | null;
}

export interface CaseResult {
	name: string;
	modes: ModeResult[];
}

const MODES: FilterMode[] = ["conservative", "balanced", "aggressive"];

function jsonBlob(): string {
	return JSON.stringify(
		{
			status: "ok",
			total: 128,
			users: Array.from({ length: 60 }, (_, i) => ({
				id: i,
				name: `user_${i}`,
				email: `user${i}@example.com`,
				role: i === 0 ? "admin" : "member",
			})),
		},
		null,
		2,
	);
}

function ndjsonBlob(): string {
	return Array.from({ length: 40 }, (_, i) =>
		JSON.stringify({ ts: 1_700_000_000 + i, level: "info", msg: "req", path: `/api/${i}` }),
	).join("\n");
}

function logBlob(): string {
	const lines = Array.from(
		{ length: 200 },
		(_, i) =>
			`2026-07-06T10:00:${String(i % 60).padStart(2, "0")}.001Z INFO [http] GET /api/items/${i} 200 in ${i % 40}ms`,
	);
	lines.splice(120, 0, "2026-07-06T10:02:00.000Z ERROR [db] connection timeout to db-primary:5432");
	return lines.join("\n");
}

function gitLogBlob(): string {
	return Array.from(
		{ length: 25 },
		(_, i) =>
			`commit ${"a".repeat(40 - String(i).length)}${i}\nAuthor: Dev <dev@example.com>\nDate:   Mon Jul 6 10:0${i % 10}:00 2026\n\n    Fix issue number ${i} in the widget renderer\n`,
	).join("\n");
}

export const CORPUS: BenchCase[] = [
	{
		name: "pretty-json (unrecognized cmd)",
		command: "somecli users --json",
		output: jsonBlob(),
		mustContain: ['"role"', "admin", "user_0"],
		balancedKeepsValidJson: true,
	},
	{
		name: "ndjson stream",
		command: "logcli tail --json",
		output: ndjsonBlob(),
		mustContain: ["path", "level"],
	},
	{
		name: "app logs with an error",
		command: "myservice serve -v",
		output: logBlob(),
		mustContain: ["connection timeout to db-primary:5432", "ERROR"],
	},
	{
		name: "git log",
		command: "git log -25",
		output: gitLogBlob(),
		// Aggressive git log keeps subjects one-per-line; subjects must survive.
		mustContain: ["Fix issue number 0", "Fix issue number 24"],
	},
];

function survival(output: string, mustContain: string[]): { survival: number; missing: string[] } {
	if (mustContain.length === 0) return { survival: 1, missing: [] };
	const missing = mustContain.filter((s) => !output.includes(s));
	return { survival: (mustContain.length - missing.length) / mustContain.length, missing };
}

function isValidJson(s: string): boolean {
	try {
		JSON.parse(s);
		return true;
	} catch {
		return false;
	}
}

export function runCase(c: BenchCase): CaseResult {
	const beforeBytes = Buffer.byteLength(c.output);
	const modes = MODES.map((mode): ModeResult => {
		const out = compressOutput(c.output, c.command, mode);
		const afterBytes = Buffer.byteLength(out);
		const { survival: s, missing } = survival(out, c.mustContain);
		return {
			mode,
			beforeBytes,
			afterBytes,
			reduction: beforeBytes > 0 ? 1 - afterBytes / beforeBytes : 0,
			survival: s,
			missing,
			validJson: c.balancedKeepsValidJson && mode === "balanced" ? isValidJson(out) : null,
		};
	});
	return { name: c.name, modes };
}

export function runQualityBench(corpus: BenchCase[] = CORPUS): CaseResult[] {
	return corpus.map(runCase);
}

export function formatBenchReport(results: CaseResult[] = runQualityBench()): string {
	const lines: string[] = ["# Quality-Regression Benchmark", ""];
	lines.push("| Case | Mode | Reduction | Survival | Valid JSON |");
	lines.push("|------|------|-----------|----------|------------|");
	for (const r of results) {
		for (const m of r.modes) {
			const vj = m.validJson === null ? "—" : m.validJson ? "✓" : "✗";
			lines.push(
				`| ${r.name} | ${m.mode} | ${(m.reduction * 100).toFixed(0)}% | ${(m.survival * 100).toFixed(0)}% | ${vj} |`,
			);
		}
	}
	return lines.join("\n");
}
