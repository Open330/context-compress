import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
	/** Environment variables to pass through to subprocesses (default: none) */
	passthroughEnvVars: string[];
	/** Enable debug logging to stderr */
	debug: boolean;
	/** Block curl/wget commands in Bash hook */
	blockCurl: boolean;
	/** Block WebFetch tool in hook */
	blockWebFetch: boolean;
	/** Nudge on Read tool usage */
	nudgeOnRead: boolean;
	/** Nudge on Grep tool usage */
	nudgeOnGrep: boolean;
	/** Threshold in bytes to trigger intent-based search filtering */
	intentSearchThreshold: number;
	/** Default max output bytes for executor */
	maxOutputBytes: number;
	/** Hard cap in bytes for stream-level output (kills process if exceeded) */
	hardCapBytes: number;
	/** Max bytes for search results */
	searchMaxBytes: number;
	/** Max bytes for batch_execute output */
	batchMaxBytes: number;
	/** Default search result limit per query */
	searchLimit: number;
	/** Search throttling window in ms */
	searchWindowMs: number;
	/** Number of search calls before reducing results */
	searchReduceAfter: number;
	/** Number of search calls before blocking */
	searchBlockAfter: number;
}

const DEFAULTS: Config = {
	passthroughEnvVars: [],
	debug: false,
	blockCurl: true,
	blockWebFetch: true,
	nudgeOnRead: true,
	nudgeOnGrep: true,
	intentSearchThreshold: 5_000,
	maxOutputBytes: 102_400,
	hardCapBytes: 100 * 1024 * 1024,
	searchMaxBytes: 40_960,
	batchMaxBytes: 81_920,
	searchLimit: 3,
	searchWindowMs: 60_000,
	searchReduceAfter: 3,
	searchBlockAfter: 8,
};

function loadFileConfig(projectDir?: string): Partial<Config> {
	const paths = [
		projectDir && join(projectDir, ".context-compress.json"),
		join(process.env.HOME ?? "~", ".context-compress.json"),
	].filter(Boolean) as string[];

	for (const p of paths) {
		try {
			const raw = readFileSync(p, "utf-8");
			return JSON.parse(raw) as Partial<Config>;
		} catch {
			// File doesn't exist or invalid JSON — skip
		}
	}
	return {};
}

function loadEnvConfig(): Partial<Config> {
	const partial: Partial<Config> = {};

	if (process.env.CONTEXT_COMPRESS_DEBUG === "1") {
		partial.debug = true;
	}
	if (process.env.CONTEXT_COMPRESS_PASSTHROUGH_ENV) {
		partial.passthroughEnvVars = process.env.CONTEXT_COMPRESS_PASSTHROUGH_ENV
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	if (process.env.CONTEXT_COMPRESS_BLOCK_CURL !== undefined) {
		partial.blockCurl = process.env.CONTEXT_COMPRESS_BLOCK_CURL !== "0";
	}
	if (process.env.CONTEXT_COMPRESS_BLOCK_WEBFETCH !== undefined) {
		partial.blockWebFetch = process.env.CONTEXT_COMPRESS_BLOCK_WEBFETCH !== "0";
	}
	if (process.env.CONTEXT_COMPRESS_NUDGE_READ !== undefined) {
		partial.nudgeOnRead = process.env.CONTEXT_COMPRESS_NUDGE_READ !== "0";
	}
	if (process.env.CONTEXT_COMPRESS_NUDGE_GREP !== undefined) {
		partial.nudgeOnGrep = process.env.CONTEXT_COMPRESS_NUDGE_GREP !== "0";
	}

	return partial;
}

let _config: Config | null = null;

export function loadConfig(projectDir?: string): Config {
	if (_config) return _config;

	const fileConfig = loadFileConfig(projectDir);
	const envConfig = loadEnvConfig();

	// Priority: ENV > file > defaults
	_config = { ...DEFAULTS, ...fileConfig, ...envConfig };
	return _config;
}

export function getConfig(): Config {
	if (!_config) return loadConfig();
	return _config;
}

/** Reset config (for testing) */
export function resetConfig(): void {
	_config = null;
}
