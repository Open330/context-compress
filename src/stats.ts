import { readFileSync } from "node:fs";
import type { CumulativeStats, SessionStats } from "./types.js";
import { writeJsonAtomic } from "./util/atomic-json.js";
import { regretSummary } from "./util/regret.js";
import { formatBytes } from "./utils.js";

const BAR_WIDTH = 20;

/** Render an ASCII bar: [████████░░░░] 80% */
function asciiBar(ratio: number, width = BAR_WIDTH): string {
	const filled = Math.round(ratio * width);
	const empty = width - filled;
	return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${(ratio * 100).toFixed(0)}%`;
}

/** Format cost estimate: Sonnet ($3/MTok) as reference point */
function tokenCost(tokens: number): string {
	// Show range: Haiku ($0.80/MTok) to Opus ($15/MTok), Sonnet ($3/MTok) as reference
	const sonnetCost = (tokens / 1_000_000) * 3;
	if (sonnetCost < 0.01) return "<$0.01";
	return `~$${sonnetCost.toFixed(2)} (Sonnet)`;
}

/**
 * The file lives under the project directory, so its shape is not ours to trust:
 * it is committed by whoever wrote the repository. Parsing it and handing the
 * result to arithmetic threw out of the `stats` tool — a missing `perCommand`
 * produced "Cannot read properties of undefined", and a numeric `firstSeen`
 * produced "cumulative.firstSeen.split is not a function". Anything unexpected
 * is treated as absent, which the callers already handle.
 */
function validateCumulative(value: unknown): CumulativeStats | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	const numbers = ["totalBytesSaved", "totalBytesProcessed", "totalCalls", "totalSessions"];
	for (const key of numbers) {
		if (typeof v[key] !== "number" || !Number.isFinite(v[key] as number)) return null;
	}
	if (typeof v.firstSeen !== "string" || typeof v.lastSeen !== "string") return null;
	// Normalized rather than rejected: files written before `perCommand` existed
	// are legitimate, and the caller indexes into it unconditionally.
	const perCommand =
		typeof v.perCommand === "object" && v.perCommand !== null ? v.perCommand : {};
	return { ...v, perCommand } as CumulativeStats;
}

export class SessionTracker {
	private stats: SessionStats = {
		calls: {},
		bytesReturned: {},
		bytesIndexed: 0,
		bytesSandboxed: 0,
		sessionStart: Date.now(),
	};

	private cumulativeFile: string | null;

	/** High-water marks: what saveCumulative() has already flushed. */
	private savedKeptOut = 0;
	private savedReturned = 0;
	private savedCalls: Record<string, number> = {};
	private sessionCounted = false;

	constructor(cumulativeFile?: string) {
		this.cumulativeFile = cumulativeFile ?? null;
	}

	trackCall(toolName: string, responseBytes: number): void {
		this.stats.calls[toolName] = (this.stats.calls[toolName] ?? 0) + 1;
		this.stats.bytesReturned[toolName] = (this.stats.bytesReturned[toolName] ?? 0) + responseBytes;
	}

	trackIndexed(bytes: number): void {
		this.stats.bytesIndexed += bytes;
	}

	trackSandboxed(bytes: number): void {
		this.stats.bytesSandboxed += bytes;
	}

	getSnapshot(): Readonly<SessionStats> {
		// Deep-copy the nested maps so callers can't observe later mutations
		// (or mutate our internal state) through the snapshot.
		return {
			...this.stats,
			calls: { ...this.stats.calls },
			bytesReturned: { ...this.stats.bytesReturned },
		};
	}

	/** Load cumulative stats from disk */
	loadCumulative(): CumulativeStats | null {
		if (!this.cumulativeFile) return null;
		try {
			const data = readFileSync(this.cumulativeFile, "utf-8");
			return validateCumulative(JSON.parse(data));
		} catch {
			return null;
		}
	}

	/** Save current session stats to cumulative file (delta-only: safe to call repeatedly) */
	saveCumulative(): void {
		if (!this.cumulativeFile) return;
		const snap = this.stats;
		const keptOut = snap.bytesIndexed + snap.bytesSandboxed;
		const totalReturned = Object.values(snap.bytesReturned).reduce((a, b) => a + b, 0);

		// Only accumulate what changed since the last save — calling this on
		// every stats request must not inflate cumulative totals.
		const dKeptOut = keptOut - this.savedKeptOut;
		const dReturned = totalReturned - this.savedReturned;
		const dCalls: Record<string, number> = {};
		for (const [name, count] of Object.entries(snap.calls)) {
			const delta = count - (this.savedCalls[name] ?? 0);
			if (delta > 0) dCalls[name] = delta;
		}
		if (
			dKeptOut <= 0 &&
			dReturned <= 0 &&
			Object.keys(dCalls).length === 0 &&
			this.sessionCounted
		) {
			return; // nothing new to flush
		}

		const cumulative = this.loadCumulative() ?? {
			totalBytesSaved: 0,
			totalBytesProcessed: 0,
			totalCalls: 0,
			totalSessions: 0,
			firstSeen: new Date().toISOString(),
			lastSeen: new Date().toISOString(),
			perCommand: {},
		};

		cumulative.totalBytesSaved += dKeptOut;
		cumulative.totalBytesProcessed += dKeptOut + dReturned;
		cumulative.totalCalls += Object.values(dCalls).reduce((a, b) => a + b, 0);
		if (!this.sessionCounted) {
			cumulative.totalSessions += 1;
			this.sessionCounted = true;
		}
		cumulative.lastSeen = new Date().toISOString();

		// Per-command breakdown
		for (const [name, delta] of Object.entries(dCalls)) {
			if (!cumulative.perCommand[name]) {
				cumulative.perCommand[name] = { calls: 0 };
			}
			cumulative.perCommand[name].calls += delta;
		}

		try {
			writeJsonAtomic(this.cumulativeFile, cumulative);
			this.savedKeptOut = keptOut;
			this.savedReturned = totalReturned;
			for (const [name, count] of Object.entries(snap.calls)) {
				this.savedCalls[name] = count;
			}
		} catch {
			// Ignore write errors
		}
	}

	formatReport(): string {
		const snap = this.stats;
		const elapsed = Date.now() - snap.sessionStart;
		const mins = Math.floor(elapsed / 60_000);
		const secs = Math.floor((elapsed % 60_000) / 1000);

		const totalCalls = Object.values(snap.calls).reduce((a, b) => a + b, 0);
		const totalReturned = Object.values(snap.bytesReturned).reduce((a, b) => a + b, 0);
		const keptOut = snap.bytesIndexed + snap.bytesSandboxed;
		const totalProcessed = keptOut + totalReturned;
		const savingsRatio =
			totalReturned > 0
				? totalProcessed / totalReturned
				: keptOut > 0
					? Number.POSITIVE_INFINITY
					: 1;
		const reductionPct =
			totalProcessed > 0 ? ((1 - totalReturned / totalProcessed) * 100).toFixed(1) : "0.0";
		const estTokensLo = Math.round(totalReturned / 5);
		const estTokensHi = Math.round(totalReturned / 3);
		const estTokensAvoidedLo = Math.round(keptOut / 5);
		const estTokensAvoidedHi = Math.round(keptOut / 3);
		const estTokensMid = Math.round(totalReturned / 4);
		const estTokensAvoidedMid = Math.round(keptOut / 4);

		const lines: string[] = [];

		lines.push("## Session Statistics\n");
		lines.push("| Metric | Value |");
		lines.push("|--------|-------|");
		lines.push(`| Session time | ${mins}m ${secs}s |`);
		lines.push(`| Tool calls | ${totalCalls} |`);
		lines.push(`| Total data processed | ${formatBytes(totalProcessed)} |`);
		lines.push(`| Kept in sandbox | ${formatBytes(keptOut)} |`);
		lines.push(`| Context consumed | ${formatBytes(totalReturned)} |`);
		lines.push(
			`| Est. tokens used | ~${estTokensLo.toLocaleString()}-${estTokensHi.toLocaleString()} tokens (${tokenCost(estTokensMid)}) |`,
		);
		lines.push(
			`| Est. tokens saved | ~${estTokensAvoidedLo.toLocaleString()}-${estTokensAvoidedHi.toLocaleString()} tokens (${tokenCost(estTokensAvoidedMid)}) |`,
		);
		const savingsLabel = Number.isFinite(savingsRatio) ? `${savingsRatio.toFixed(1)}x` : "∞";
		lines.push(`| **Savings ratio** | **${savingsLabel}** (${reductionPct}% reduction) |`);

		// Visual savings bar
		if (totalProcessed > 0) {
			const savingsBar = asciiBar(keptOut / totalProcessed);
			lines.push(`\n**Context savings:** ${savingsBar}`);
			lines.push(
				`  Sandbox: ${formatBytes(keptOut)} kept out | Context: ${formatBytes(totalReturned)} entered`,
			);
		}

		if (totalCalls > 0) {
			lines.push("\n## Per-Tool Breakdown\n");

			// Find max bytes for bar scaling
			const maxBytes = Math.max(...Object.values(snap.bytesReturned));

			for (const [name, calls] of Object.entries(snap.calls)) {
				const bytes = snap.bytesReturned[name] ?? 0;
				const tokLo = Math.round(bytes / 5);
				const tokHi = Math.round(bytes / 3);
				const barRatio = maxBytes > 0 ? bytes / maxBytes : 0;
				const bar = "█".repeat(Math.max(1, Math.round(barRatio * 15)));
				lines.push(
					`  ${name.padEnd(16)} ${String(calls).padStart(3)} calls  ${bar} ${formatBytes(bytes)} (~${tokLo.toLocaleString()}-${tokHi.toLocaleString()} tok)`,
				);
			}
		}

		lines.push(
			`\nContext-compress kept ${formatBytes(keptOut)} out of context (${reductionPct}% savings).`,
		);

		// Cumulative stats section
		const cumulative = this.loadCumulative();
		if (cumulative) {
			lines.push("\n## Cumulative Savings (All Sessions)\n");
			lines.push("| Metric | Value |");
			lines.push("|--------|-------|");
			lines.push(`| Sessions tracked | ${cumulative.totalSessions} |`);
			lines.push(`| Total data processed | ${formatBytes(cumulative.totalBytesProcessed)} |`);
			lines.push(`| Total kept out of context | ${formatBytes(cumulative.totalBytesSaved)} |`);
			const cumTokensMid = Math.round(cumulative.totalBytesSaved / 4);
			lines.push(`| Est. total tokens saved | ~${cumTokensMid.toLocaleString()} |`);
			lines.push(`| Tracking since | ${cumulative.firstSeen.split("T")[0]} |`);
		}

		// ACON self-improvement: commands whose aggressive compression kept
		// triggering fast re-runs and were auto-downgraded to preserve fidelity.
		const regrets = regretSummary();
		if (regrets.length > 0) {
			lines.push("\n## Auto-Mode Self-Tuning (regret-adjusted)\n");
			lines.push("| Command | Re-runs / Obs | Regret |");
			lines.push("|---------|---------------|--------|");
			for (const r of regrets.slice(0, 10)) {
				lines.push(
					`| \`${r.fingerprint}\` | ${r.regrets}/${r.observations} | ${(r.regretRate * 100).toFixed(0)}% |`,
				);
			}
		}

		return lines.join("\n");
	}
}
