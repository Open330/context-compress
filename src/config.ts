import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export type CompressionLevel = "normal" | "compact" | "ultra";

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
	/** Compression level: normal (default), compact (shorter labels), ultra (minimal output) */
	compressionLevel: CompressionLevel;
	/** Persist the knowledge base DB across MCP server restarts (default: false) */
	persistDb: boolean;
	/** Custom directory for the persistent DB (default: null, uses .context-compress/ in project dir) */
	dbDir: string | null;
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
	compressionLevel: "normal",
	persistDb: false,
	dbDir: null,
};

/** Overrides applied per compression level */
const LEVEL_OVERRIDES: Record<CompressionLevel, Partial<Config>> = {
	normal: {},
	compact: {
		maxOutputBytes: 51_200,
		searchMaxBytes: 20_480,
		batchMaxBytes: 40_960,
		searchLimit: 2,
		intentSearchThreshold: 3_000,
	},
	ultra: {
		maxOutputBytes: 25_600,
		searchMaxBytes: 10_240,
		batchMaxBytes: 20_480,
		searchLimit: 1,
		intentSearchThreshold: 2_000,
	},
};

const ConfigSchema = z.object({
	passthroughEnvVars: z.array(z.string()).optional(),
	debug: z.boolean().optional(),
	blockCurl: z.boolean().optional(),
	blockWebFetch: z.boolean().optional(),
	nudgeOnRead: z.boolean().optional(),
	nudgeOnGrep: z.boolean().optional(),
	intentSearchThreshold: z.number().int().positive().optional(),
	maxOutputBytes: z.number().int().positive().optional(),
	hardCapBytes: z.number().int().positive().optional(),
	searchMaxBytes: z.number().int().positive().optional(),
	batchMaxBytes: z.number().int().positive().optional(),
	searchLimit: z.number().int().positive().optional(),
	searchWindowMs: z.number().int().positive().optional(),
	searchReduceAfter: z.number().int().nonnegative().optional(),
	searchBlockAfter: z.number().int().positive().optional(),
	compressionLevel: z.enum(["normal", "compact", "ultra"]).optional(),
	persistDb: z.boolean().optional(),
	dbDir: z.string().nullable().optional(),
});

function parseIntEnv(key: string): number | undefined {
	const val = process.env[key];
	if (val === undefined) return undefined;
	const n = Number.parseInt(val, 10);
	return Number.isNaN(n) ? undefined : n;
}

function loadFileConfig(projectDir?: string): Partial<Config> {
	const paths = [
		projectDir && join(projectDir, ".context-compress.json"),
		join(homedir(), ".context-compress.json"),
	].filter(Boolean) as string[];

	for (const p of paths) {
		try {
			const raw = readFileSync(p, "utf-8");
			const parsed = JSON.parse(raw);
			const result = ConfigSchema.safeParse(parsed);
			if (result.success) {
				return result.data as Partial<Config>;
			}
			// Invalid config — fall back to defaults
			return {};
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
		partial.passthroughEnvVars = process.env.CONTEXT_COMPRESS_PASSTHROUGH_ENV.split(",")
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

	// Numeric overrides
	const maxOutput = parseIntEnv("CONTEXT_COMPRESS_MAX_OUTPUT_BYTES");
	if (maxOutput !== undefined) partial.maxOutputBytes = maxOutput;

	const hardCap = parseIntEnv("CONTEXT_COMPRESS_HARD_CAP_BYTES");
	if (hardCap !== undefined) partial.hardCapBytes = hardCap;

	const searchMax = parseIntEnv("CONTEXT_COMPRESS_SEARCH_MAX_BYTES");
	if (searchMax !== undefined) partial.searchMaxBytes = searchMax;

	const batchMax = parseIntEnv("CONTEXT_COMPRESS_BATCH_MAX_BYTES");
	if (batchMax !== undefined) partial.batchMaxBytes = batchMax;

	const searchLimit = parseIntEnv("CONTEXT_COMPRESS_SEARCH_LIMIT");
	if (searchLimit !== undefined) partial.searchLimit = searchLimit;

	const searchWindow = parseIntEnv("CONTEXT_COMPRESS_SEARCH_WINDOW_MS");
	if (searchWindow !== undefined) partial.searchWindowMs = searchWindow;

	const searchReduce = parseIntEnv("CONTEXT_COMPRESS_SEARCH_REDUCE_AFTER");
	if (searchReduce !== undefined) partial.searchReduceAfter = searchReduce;

	const searchBlock = parseIntEnv("CONTEXT_COMPRESS_SEARCH_BLOCK_AFTER");
	if (searchBlock !== undefined) partial.searchBlockAfter = searchBlock;

	const intentThreshold = parseIntEnv("CONTEXT_COMPRESS_INTENT_SEARCH_THRESHOLD");
	if (intentThreshold !== undefined) partial.intentSearchThreshold = intentThreshold;

	const level = process.env.CONTEXT_COMPRESS_LEVEL;
	if (level === "normal" || level === "compact" || level === "ultra") {
		partial.compressionLevel = level;
	}

	if (process.env.CONTEXT_COMPRESS_PERSIST_DB === "1") {
		partial.persistDb = true;
	}
	if (process.env.CONTEXT_COMPRESS_DB_DIR) {
		partial.dbDir = process.env.CONTEXT_COMPRESS_DB_DIR;
	}

	return partial;
}

let _config: Config | null = null;

export function loadConfig(projectDir?: string): Config {
	if (_config) return _config;

	const fileConfig = loadFileConfig(projectDir);
	const envConfig = loadEnvConfig();

	// Priority: ENV > file > level overrides > defaults
	const merged = { ...DEFAULTS, ...fileConfig, ...envConfig };
	const levelOverrides = LEVEL_OVERRIDES[merged.compressionLevel];
	// Level overrides only apply to values not explicitly set by user
	for (const [key, value] of Object.entries(levelOverrides)) {
		const k = key as keyof Config;
		if (!(k in fileConfig) && !(k in envConfig)) {
			(merged as Record<string, unknown>)[k] = value;
		}
	}

	// Sanity checks on final config (log when values are clamped)
	if (merged.maxOutputBytes < 1024) {
		console.error(
			`[context-compress] Config: maxOutputBytes clamped from ${merged.maxOutputBytes} to 1024`,
		);
		merged.maxOutputBytes = 1024;
	}
	if (merged.hardCapBytes < merged.maxOutputBytes) {
		console.error(
			`[context-compress] Config: hardCapBytes clamped from ${merged.hardCapBytes} to ${merged.maxOutputBytes}`,
		);
		merged.hardCapBytes = merged.maxOutputBytes;
	}
	if (merged.intentSearchThreshold < 0) {
		console.error(
			`[context-compress] Config: intentSearchThreshold clamped from ${merged.intentSearchThreshold} to 0`,
		);
		merged.intentSearchThreshold = 0;
	}
	if (merged.searchLimit < 1) {
		console.error(`[context-compress] Config: searchLimit clamped from ${merged.searchLimit} to 1`);
		merged.searchLimit = 1;
	}
	if (merged.searchWindowMs < 1000) {
		console.error(
			`[context-compress] Config: searchWindowMs clamped from ${merged.searchWindowMs} to 1000`,
		);
		merged.searchWindowMs = 1000;
	}
	if (merged.searchReduceAfter < 1) {
		console.error(
			`[context-compress] Config: searchReduceAfter clamped from ${merged.searchReduceAfter} to 1`,
		);
		merged.searchReduceAfter = 1;
	}
	if (merged.searchBlockAfter < merged.searchReduceAfter + 1) {
		const minVal = merged.searchReduceAfter + 1;
		console.error(
			`[context-compress] Config: searchBlockAfter clamped from ${merged.searchBlockAfter} to ${minVal}`,
		);
		merged.searchBlockAfter = minVal;
	}
	if (merged.searchMaxBytes < 1024) {
		console.error(
			`[context-compress] Config: searchMaxBytes clamped from ${merged.searchMaxBytes} to 1024`,
		);
		merged.searchMaxBytes = 1024;
	}
	if (merged.batchMaxBytes < 1024) {
		console.error(
			`[context-compress] Config: batchMaxBytes clamped from ${merged.batchMaxBytes} to 1024`,
		);
		merged.batchMaxBytes = 1024;
	}

	// dbDir implies persistDb
	if (merged.dbDir) merged.persistDb = true;
	_config = merged;
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
