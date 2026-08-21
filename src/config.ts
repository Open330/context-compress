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
	/** Threshold in bytes to trigger intent-based search filtering */
	intentSearchThreshold: number;
	/** Byte budget for query-ranked content inlined into an intent-filtered summary */
	intentBudgetBytes: number;
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
	/** Max indexed sources retained; the oldest are pruned past this. 0 disables pruning. */
	maxIndexedSources: number;
}

const DEFAULTS: Config = {
	passthroughEnvVars: [],
	debug: false,
	intentSearchThreshold: 5_000,
	intentBudgetBytes: 1_800,
	maxOutputBytes: 102_400,
	// Peak RSS is a large multiple of the captured bytes because the post-capture
	// pipeline holds several full copies, and the binding limit is
	// MAX_CONCURRENT_EXECUTIONS (8), not BATCH_CONCURRENCY (4). Re-measured on
	// Node 24 / darwin-arm64 with error-shaped output at this 16MB cap:
	// concurrency 1 -> 472MB, 4 -> 746MB, 8 -> 1,201MB peak. An earlier note here
	// claimed the worst case stayed under ~0.9GB; that figure no longer holds and
	// the real ceiling is ~1.2GB, still well inside the default old-space. The
	// old 100MB cap extrapolated to several gigabytes. Numbers are platform- and
	// version-dependent, so re-measure before relying on the headroom rather than
	// trusting this comment.
	hardCapBytes: 16 * 1024 * 1024,
	searchMaxBytes: 40_960,
	batchMaxBytes: 81_920,
	searchLimit: 3,
	searchWindowMs: 60_000,
	searchReduceAfter: 3,
	searchBlockAfter: 8,
	compressionLevel: "normal",
	persistDb: false,
	dbDir: null,
	maxIndexedSources: 500,
};

/**
 * The smallest response budget that can carry content rather than markers alone.
 * Applies to `hardCapBytes` too, because the budget is clamped down to it.
 */
const MIN_OUTPUT_BYTES = 1024;

/** Overrides applied per compression level */
const LEVEL_OVERRIDES: Record<CompressionLevel, Partial<Config>> = {
	normal: {},
	compact: {
		maxOutputBytes: 51_200,
		searchMaxBytes: 20_480,
		batchMaxBytes: 40_960,
		searchLimit: 2,
		intentSearchThreshold: 3_000,
		intentBudgetBytes: 1_000,
	},
	ultra: {
		maxOutputBytes: 25_600,
		searchMaxBytes: 10_240,
		batchMaxBytes: 20_480,
		searchLimit: 1,
		intentSearchThreshold: 2_000,
		intentBudgetBytes: 500,
	},
};

const ConfigSchema = z.object({
	passthroughEnvVars: z.array(z.string()).optional(),
	debug: z.boolean().optional(),
	intentSearchThreshold: z.number().int().positive().optional(),
	intentBudgetBytes: z.number().int().positive().optional(),
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
	maxIndexedSources: z.number().int().nonnegative().optional(),
});

function parseIntEnv(key: string): number | undefined {
	const val = process.env[key];
	if (val === undefined) return undefined;
	const n = Number.parseInt(val, 10);
	return Number.isNaN(n) ? undefined : n;
}

/**
 * Keys a project-local `.context-compress.json` may NOT set.
 *
 * A project file travels with the repository, so an untrusted clone or a PR can
 * add one. These keys decide which of the user's real credentials are copied
 * into every subprocess environment, and where indexed content — including the
 * full uncompressed command output whose whole premise is that it stays in the
 * sandbox — is written and retained. Letting the untrusted artifact configure
 * the control that is supposed to contain it defeats the control. They are
 * honored only from the user's home file or the environment.
 */
/**
 * Keys a project-local `.context-compress.json` may not set. A project file
 * travels with the repository, so it is attacker-controlled. Exported so the
 * README's list of restricted keys can be asserted against this one — the two
 * drifted apart once already, and a doc that under-reports the list tells the
 * reader to configure something that is silently dropped.
 */
export const USER_SCOPE_ONLY_KEYS = [
	"passthroughEnvVars",
	"persistDb",
	"dbDir",
	"hardCapBytes",
	// `maxOutputBytes` belongs here too: the sanity clamp below raises
	// `hardCapBytes` UP to it, so leaving it project-settable handed the memory
	// guard straight back — a repo could restore a 900MB stream cap and the
	// clamp printed a line that made it look intentional.
	"maxOutputBytes",
	// Availability: with a huge window and a low block threshold, a repo could
	// switch `search` off for the rest of the session after two calls — and the
	// refusal message blames the caller for asking too often.
	"searchWindowMs",
	"searchBlockAfter",
	"searchReduceAfter",
	// Retention. The list above claims to govern where indexed content "is
	// written and retained", and this is the key that decides retained: `0`
	// disables pruning, so a repo could make a user-enabled persistent store grow
	// without bound in their own project directory.
	"maxIndexedSources",
	// Indirection. `compressionLevel` is not itself sensitive, but LEVEL_OVERRIDES
	// rewrites `maxOutputBytes`, `searchMaxBytes`, `batchMaxBytes`, `searchLimit`
	// and `intentSearchThreshold` — four of which are protected above. A project
	// file containing nothing but `{"compressionLevel":"normal"}` cancelled a
	// user's `ultra` and restored every default budget: maxOutputBytes 25,600 ->
	// 102,400, searchMaxBytes 10,240 -> 40,960, batchMaxBytes 20,480 -> 81,920,
	// searchLimit 1 -> 3 — while stderr printed that `maxOutputBytes` had been
	// refused, which made the refusal look effective. Set it from the home file
	// or CONTEXT_COMPRESS_COMPRESSION_LEVEL.
	"compressionLevel",
] as const satisfies readonly (keyof z.infer<typeof ConfigSchema>)[];

function readConfigFile(path: string, scope: "project" | "user"): Partial<Config> {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return {}; // Absent is the normal case.
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		// Silently discarding the whole file made a single typo revert every setting
		// with no signal at all, so say so on stderr.
		console.error(
			`[context-compress] Config: ignoring ${path} — invalid JSON (${
				err instanceof Error ? err.message : String(err)
			})`,
		);
		return {};
	}

	const result = ConfigSchema.safeParse(parsed);
	if (!result.success) {
		const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
		console.error(
			`[context-compress] Config: ignoring ${path} — invalid field(s): ${fields.join(", ")}`,
		);
		return {};
	}

	const config = result.data as Partial<Config>;
	if (scope === "project") {
		for (const key of USER_SCOPE_ONLY_KEYS) {
			if (config[key] === undefined) continue;
			delete config[key];
			console.error(
				`[context-compress] Config: ignoring "${key}" from ${path} — ` +
					"it is only honored from ~/.context-compress.json or the environment, " +
					"because a project file can arrive with untrusted code.",
			);
		}
	}
	return config;
}

/**
 * Home config is the base; a project file layers over it.
 *
 * Returning on the first readable file meant a project file *replaced* the
 * user's home config wholesale instead of overriding selected keys.
 */
function loadFileConfig(projectDir?: string): Partial<Config> {
	const user = readConfigFile(join(homedir(), ".context-compress.json"), "user");
	if (!projectDir) return user;
	const project = readConfigFile(join(projectDir, ".context-compress.json"), "project");
	return { ...user, ...project };
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

	const intentBudget = parseIntEnv("CONTEXT_COMPRESS_INTENT_BUDGET_BYTES");
	if (intentBudget !== undefined) partial.intentBudgetBytes = intentBudget;

	const level = process.env.CONTEXT_COMPRESS_LEVEL;
	if (level === "normal" || level === "compact" || level === "ultra") {
		partial.compressionLevel = level;
	}

	// The README states every server setting has an environment override, and this
	// key is refused from a project file, so the environment was the ONLY way to
	// set it — and there was no way.
	const maxIndexed = parseIntEnv("CONTEXT_COMPRESS_MAX_INDEXED_SOURCES");
	if (maxIndexed !== undefined) partial.maxIndexedSources = maxIndexed;

	if (process.env.CONTEXT_COMPRESS_PERSIST_DB === "1") {
		partial.persistDb = true;
	}
	if (process.env.CONTEXT_COMPRESS_DB_DIR) {
		partial.dbDir = process.env.CONTEXT_COMPRESS_DB_DIR;
	}

	return partial;
}

let _config: Config | null = null;

/**
 * The project root, resolved the same way everywhere.
 *
 * Three call sites disagreed: the server used `CLAUDE_PROJECT_DIR ?? cwd`,
 * src/index.ts passed only `CLAUDE_PROJECT_DIR` (so a client that does not set
 * it never read the project config), and the CLI passed nothing at all — while
 * the store still put a persistent DB under `cwd`, i.e. inside a directory whose
 * config had been refused.
 */
export function resolveProjectDir(): string {
	return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

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
	// `hardCapBytes` needs the same floor as the budget it bounds. Without it the
	// floor below was self-defeating: maxOutputBytes was raised to 1024 and then
	// clamped straight back down to an arbitrarily small capture cap, and at any
	// effective budget of 11..162 bytes the truncator could return only markers —
	// a response with no content at all.
	if (merged.hardCapBytes < MIN_OUTPUT_BYTES) {
		console.error(
			`[context-compress] Config: hardCapBytes clamped from ${merged.hardCapBytes} to ${MIN_OUTPUT_BYTES}`,
		);
		merged.hardCapBytes = MIN_OUTPUT_BYTES;
	}
	if (merged.maxOutputBytes < MIN_OUTPUT_BYTES) {
		console.error(
			`[context-compress] Config: maxOutputBytes clamped from ${merged.maxOutputBytes} to ${MIN_OUTPUT_BYTES}`,
		);
		merged.maxOutputBytes = MIN_OUTPUT_BYTES;
	}
	// Clamp the RESPONSE budget down to the capture cap, never the capture cap up.
	// `hardCapBytes` is the memory guard: a per-execution stream past ~512MB makes
	// Buffer.concat().toString() throw RangeError synchronously inside the child's
	// close listener, which the server's uncaughtException handler turns into
	// process.exit(1). Raising it to satisfy a larger maxOutputBytes inverted the
	// safety relationship — the guard must bound the budget, not follow it.
	if (merged.maxOutputBytes > merged.hardCapBytes) {
		console.error(
			`[context-compress] Config: maxOutputBytes clamped from ${merged.maxOutputBytes} to ${merged.hardCapBytes} (the capture cap)`,
		);
		merged.maxOutputBytes = merged.hardCapBytes;
	}
	// A window this long is indistinguishable from "search is off".
	const MAX_SEARCH_WINDOW_MS = 10 * 60 * 1000;
	if (merged.searchWindowMs > MAX_SEARCH_WINDOW_MS) {
		console.error(
			`[context-compress] Config: searchWindowMs clamped from ${merged.searchWindowMs} to ${MAX_SEARCH_WINDOW_MS}`,
		);
		merged.searchWindowMs = MAX_SEARCH_WINDOW_MS;
	}
	if (merged.intentSearchThreshold < 0) {
		console.error(
			`[context-compress] Config: intentSearchThreshold clamped from ${merged.intentSearchThreshold} to 0`,
		);
		merged.intentSearchThreshold = 0;
	}
	if (merged.intentBudgetBytes < 0) {
		console.error(
			`[context-compress] Config: intentBudgetBytes clamped from ${merged.intentBudgetBytes} to 0`,
		);
		merged.intentBudgetBytes = 0;
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
