/**
 * ACON-style self-improving compression policy.
 *
 * ACON (Kang et al., 2026) optimizes a compression *guideline* in natural-language
 * space by analyzing cases where the full context succeeds but the compressed
 * context fails, then refines the guideline — no model fine-tuning. We can't run
 * paired trajectories at runtime, but we can approximate the failure signal from
 * the agent's own behavior: if a command is compressed aggressively and then
 * *re-run almost immediately*, the aggressive summary probably hid something the
 * agent needed. That's a "compression regret".
 *
 * The policy this drives is deliberately narrow and safe:
 *   - We only count a regret for a FAST re-run (default ≤ 30s) that followed an
 *     AGGRESSIVE compression. Balanced/conservative are never blamed — they
 *     rarely drop task-critical data, and normal edit→rerun loops (which are
 *     slower and usually ran under balanced) shouldn't be misread as regret.
 *   - The only adjustment is a one-step DOWNGRADE (aggressive → balanced) once a
 *     fingerprint's regret rate is high over enough samples. Downgrading only
 *     ever *reduces* compression, so a false positive costs a few tokens, never
 *     correctness. It never makes anything more aggressive on its own.
 *
 * State is a small JSON map at ~/.context-compress/regret.json, keyed by the same
 * command fingerprint the auto-mode cache uses, so it persists across sessions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FilterMode } from "../filters.js";

const DEFAULT_PATH = join(homedir(), ".context-compress", "regret.json");
const RERUN_WINDOW_MS = 30_000;
/**
 * Absolute number of aggressive-mode fast re-runs before we downgrade. Using a
 * count (not a decaying rate) gives hysteresis: once a fingerprint has proven
 * aggressive is a bad fit, it stays downgraded instead of oscillating back the
 * moment the re-runs stop (they stop *because* we downgraded).
 */
const REGRET_MIN_COUNT = 3;

interface FpRecord {
	/** Mode chosen the last time this fingerprint was compressed. */
	lastMode: FilterMode;
	/** Epoch ms of the last compression. */
	lastSeen: number;
	/** How many times we've decided a mode for this fingerprint. */
	observations: number;
	/** How many of those were preceded by a fast re-run under aggressive mode. */
	regrets: number;
}

type RegretMap = Record<string, FpRecord>;

export interface RegretOptions {
	path?: string;
	/** Injectable clock (epoch ms) for deterministic tests. */
	now?: number;
	/** Re-run window in ms; a re-run within this counts toward regret. */
	windowMs?: number;
}

export interface RegretDecision {
	/** Mode after any regret-driven adjustment. */
	mode: FilterMode;
	/** True when the chosen mode was downgraded due to regret. */
	adjusted: boolean;
	/** Current regret rate for this fingerprint (0–1). */
	regretRate: number;
}

function load(path: string): RegretMap {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as RegretMap;
	} catch {
		return {};
	}
}

function save(path: string, map: RegretMap): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(map, null, 2));
	} catch {
		/* best-effort */
	}
}

function downgrade(mode: FilterMode): FilterMode {
	if (mode === "aggressive") return "balanced";
	if (mode === "balanced") return "conservative";
	return "conservative";
}

/**
 * Record this compression decision, detect regret from a fast re-run, and return
 * a possibly-downgraded mode. Call this once per auto-mode decision (including
 * cache hits) so the re-run timeline stays accurate.
 */
export function observeAndAdjust(
	fingerprint: string,
	chosenMode: FilterMode,
	opts: RegretOptions = {},
): RegretDecision {
	const path = opts.path ?? DEFAULT_PATH;
	const now = opts.now ?? Date.now();
	const window = opts.windowMs ?? RERUN_WINDOW_MS;

	const map = load(path);
	const rec: FpRecord = map[fingerprint] ?? {
		lastMode: chosenMode,
		lastSeen: 0,
		observations: 0,
		regrets: 0,
	};

	// A fast re-run after an aggressive compression is our regret signal.
	const isFastRerun = rec.lastSeen > 0 && now - rec.lastSeen <= window;
	if (isFastRerun && rec.lastMode === "aggressive") {
		rec.regrets++;
	}
	rec.observations++;

	const regretRate = rec.observations > 0 ? rec.regrets / rec.observations : 0;
	const shouldAdjust = chosenMode === "aggressive" && rec.regrets >= REGRET_MIN_COUNT;
	const mode = shouldAdjust ? downgrade(chosenMode) : chosenMode;

	rec.lastMode = mode;
	rec.lastSeen = now;
	map[fingerprint] = rec;
	save(path, map);

	return { mode, adjusted: mode !== chosenMode, regretRate };
}

/** Read-only view of regret stats, for the `stats` tool / observability. */
export function regretSummary(opts: RegretOptions = {}): Array<{
	fingerprint: string;
	observations: number;
	regrets: number;
	regretRate: number;
}> {
	const map = load(opts.path ?? DEFAULT_PATH);
	return Object.entries(map)
		.map(([fingerprint, r]) => ({
			fingerprint,
			observations: r.observations,
			regrets: r.regrets,
			regretRate: r.observations > 0 ? r.regrets / r.observations : 0,
		}))
		.filter((r) => r.regrets > 0)
		.sort((a, b) => b.regretRate - a.regretRate);
}
