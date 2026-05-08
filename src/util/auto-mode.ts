/**
 * Auto mode: ask an LLM to pick the best compression mode for a given output.
 *
 * Backends, in priority order:
 *   1. Anthropic API     (fastest; needs ANTHROPIC_API_KEY)
 *   2. `claude -p` CLI   (works in Claude Code environments; ~3s per call)
 *   3. Heuristic         (last resort, no LLM)
 *
 * Decisions are cached per command fingerprint with a 24h TTL so repeated
 * commands don't pay the LLM round-trip cost. Cache lives at
 * ~/.context-compress/auto-cache.json so it survives across sessions.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FilterMode } from "../filters.js";

interface CacheEntry {
	mode: FilterMode;
	expires: number; // epoch ms
}

type CacheMap = Record<string, CacheEntry>;

const CACHE_PATH = join(homedir(), ".context-compress", "auto-cache.json");
const TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;
const SAMPLE_BYTES = 500;

export interface AutoOptions {
	apiKey?: string;
	model?: string;
	timeoutMs?: number;
	/** When true, do not read or write the cache. Useful for benchmarks. */
	noCache?: boolean;
	/** When true, skip API + CLI and use the heuristic. Useful for tests. */
	noLlm?: boolean;
}

function loadCache(): CacheMap {
	if (!existsSync(CACHE_PATH)) return {};
	try {
		return JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as CacheMap;
	} catch {
		return {};
	}
}

function saveCache(cache: CacheMap): void {
	try {
		mkdirSync(dirname(CACHE_PATH), { recursive: true });
		writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
	} catch {
		/* ignore — cache is best-effort */
	}
}

/**
 * Cache key: the first two whitespace-separated tokens of the command.
 * "git log -10 --abbrev-commit" → "git log"
 * Coarse enough to share decisions across argument variants, fine enough
 * that "git log" and "git diff" are tracked separately.
 */
function fingerprint(cmd: string): string {
	return cmd.trim().split(/\s+/).slice(0, 2).join(" ");
}

function buildPrompt(cmd: string, sample: string): string {
	return [
		"You pick the best output-compression mode for an AI coding agent.",
		"",
		`Command: ${cmd}`,
		"",
		"Output sample (first 500 chars, may be truncated):",
		"---",
		sample,
		"---",
		"",
		"Modes:",
		"- conservative: preserve everything verbatim (almost no compression)",
		"- balanced: drop universal noise (progress bars, hint lines, ./.., total N), truncate git log bodies past 3 lines, summarize find/ls -R past 20 entries; keeps all metadata",
		"- aggressive: drop metadata too (git log → one-line, ls -la → name+size, find → directory summary, drops file perms/dates)",
		"",
		"Pick whichever fits this output best. Reply with EXACTLY ONE WORD: conservative, balanced, or aggressive.",
	].join("\n");
}

function parseMode(text: string): FilterMode | null {
	const t = text.toLowerCase();
	if (t.includes("aggressive")) return "aggressive";
	if (t.includes("conservative")) return "conservative";
	if (t.includes("balanced")) return "balanced";
	return null;
}

interface AnthropicResponse {
	content?: Array<{ type: string; text: string }>;
}

async function callAnthropic(prompt: string, opts: AutoOptions): Promise<FilterMode> {
	const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new Error("no API key");

	const r = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: opts.model ?? "claude-haiku-4-5-20251001",
			max_tokens: 16,
			messages: [{ role: "user", content: prompt }],
		}),
		signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});

	if (!r.ok) throw new Error(`Anthropic API ${r.status}`);
	const data = (await r.json()) as AnthropicResponse;
	const text = data.content?.[0]?.text ?? "";
	const mode = parseMode(text);
	if (!mode) throw new Error(`could not parse mode from: ${text}`);
	return mode;
}

function callClaudeCli(prompt: string, timeoutMs: number): FilterMode {
	const r = spawnSync("claude", ["-p", prompt], {
		encoding: "utf-8",
		timeout: timeoutMs,
		// Avoid inheriting interactive/tty state that the CLI might react to.
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (r.status !== 0 || r.signal) throw new Error("claude CLI failed");
	const mode = parseMode(r.stdout);
	if (!mode) throw new Error(`could not parse mode from: ${r.stdout}`);
	return mode;
}

/**
 * Heuristic last-resort: pick a sensible mode without touching the LLM.
 * This is what auto mode degrades to when both API and CLI are unavailable
 * (or when AutoOptions.noLlm is true).
 *
 * Exported so callers / tests can use the heuristic directly.
 */
export function heuristicMode(cmd: string, output: string): FilterMode {
	const len = output.length;
	if (len < 1000) return "conservative";
	if (/^git\s+log\b/.test(cmd) && !cmd.includes("--oneline")) return "aggressive";
	if (/(test|jest|pytest|vitest)\b/.test(cmd) && len > 5000) return "aggressive";
	if (/^find\b/.test(cmd) && len > 2000) return "aggressive";
	if (/^ls\b/.test(cmd) && /-l/.test(cmd)) return "aggressive";
	return "balanced";
}

export interface AutoResult {
	mode: FilterMode;
	source: "cache" | "api" | "cli" | "heuristic";
}

/**
 * Pick a compression mode for the given command + output. Tries the LLM
 * (API → CLI), falls back to a heuristic. Caches per-command-fingerprint.
 */
export async function pickModeAuto(
	cmd: string,
	output: string,
	opts: AutoOptions = {},
): Promise<AutoResult> {
	const fp = fingerprint(cmd);
	const cache = opts.noCache ? {} : loadCache();
	const cached = cache[fp];
	if (cached && cached.expires > Date.now()) {
		return { mode: cached.mode, source: "cache" };
	}

	let mode: FilterMode;
	let source: AutoResult["source"];

	if (opts.noLlm) {
		mode = heuristicMode(cmd, output);
		source = "heuristic";
	} else {
		const sample = output.slice(0, SAMPLE_BYTES);
		const prompt = buildPrompt(cmd, sample);
		try {
			mode = await callAnthropic(prompt, opts);
			source = "api";
		} catch {
			try {
				mode = callClaudeCli(prompt, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
				source = "cli";
			} catch {
				mode = heuristicMode(cmd, output);
				source = "heuristic";
			}
		}
	}

	if (!opts.noCache) {
		cache[fp] = { mode, expires: Date.now() + TTL_MS };
		saveCache(cache);
	}
	return { mode, source };
}
