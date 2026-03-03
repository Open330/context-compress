import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getConfig, loadConfig, resetConfig } from "../../src/config.js";

const ENV_KEYS = [
	"CONTEXT_COMPRESS_DEBUG",
	"CONTEXT_COMPRESS_PASSTHROUGH_ENV",
	"CONTEXT_COMPRESS_BLOCK_CURL",
	"CONTEXT_COMPRESS_MAX_OUTPUT_BYTES",
	"CONTEXT_COMPRESS_HARD_CAP_BYTES",
	"CONTEXT_COMPRESS_SEARCH_MAX_BYTES",
	"CONTEXT_COMPRESS_BATCH_MAX_BYTES",
	"CONTEXT_COMPRESS_SEARCH_LIMIT",
	"CONTEXT_COMPRESS_SEARCH_WINDOW_MS",
	"CONTEXT_COMPRESS_SEARCH_REDUCE_AFTER",
	"CONTEXT_COMPRESS_SEARCH_BLOCK_AFTER",
	"CONTEXT_COMPRESS_INTENT_SEARCH_THRESHOLD",
];

const ORIGINAL_HOME = process.env.HOME;

function clearConfigEnv(): void {
	for (const key of ENV_KEYS) {
		delete process.env[key];
	}
}

describe("config", () => {
	beforeEach(() => {
		resetConfig();
		clearConfigEnv();
		process.env.HOME = `/tmp/context-compress-home-${process.pid}-${Date.now()}`;
	});

	afterEach(() => {
		resetConfig();
		clearConfigEnv();
		if (ORIGINAL_HOME === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = ORIGINAL_HOME;
		}
	});

	it("loads defaults", () => {
		const cfg = loadConfig();
		assert.deepStrictEqual(cfg.passthroughEnvVars, []);
		assert.strictEqual(cfg.debug, false);
		assert.strictEqual(cfg.blockCurl, true);
	});

	it("enables debug when CONTEXT_COMPRESS_DEBUG=1", () => {
		process.env.CONTEXT_COMPRESS_DEBUG = "1";
		const cfg = loadConfig();
		assert.strictEqual(cfg.debug, true);
	});

	it("splits passthrough env vars from CONTEXT_COMPRESS_PASSTHROUGH_ENV", () => {
		process.env.CONTEXT_COMPRESS_PASSTHROUGH_ENV = "GH_TOKEN,AWS_PROFILE";
		const cfg = loadConfig();
		assert.deepStrictEqual(cfg.passthroughEnvVars, ["GH_TOKEN", "AWS_PROFILE"]);
	});

	it("sets blockCurl false when CONTEXT_COMPRESS_BLOCK_CURL=0", () => {
		process.env.CONTEXT_COMPRESS_BLOCK_CURL = "0";
		const cfg = loadConfig();
		assert.strictEqual(cfg.blockCurl, false);
	});

	it("getConfig returns loaded singleton", () => {
		const loaded = loadConfig();
		const fetched = getConfig();
		assert.strictEqual(fetched, loaded);
	});

	it("applies numeric ENV overrides", () => {
		process.env.CONTEXT_COMPRESS_MAX_OUTPUT_BYTES = "200000";
		process.env.CONTEXT_COMPRESS_SEARCH_LIMIT = "5";
		process.env.CONTEXT_COMPRESS_INTENT_SEARCH_THRESHOLD = "10000";
		const cfg = loadConfig();
		assert.strictEqual(cfg.maxOutputBytes, 200000);
		assert.strictEqual(cfg.searchLimit, 5);
		assert.strictEqual(cfg.intentSearchThreshold, 10000);
	});

	it("ignores non-numeric ENV values", () => {
		process.env.CONTEXT_COMPRESS_MAX_OUTPUT_BYTES = "not_a_number";
		const cfg = loadConfig();
		assert.strictEqual(cfg.maxOutputBytes, 102_400); // default
	});

	it("falls back to defaults on invalid file config", () => {
		// With HOME pointing to a non-existent directory, loadFileConfig returns {}
		// so we get defaults
		const cfg = loadConfig("/tmp/nonexistent-dir-" + Date.now());
		assert.strictEqual(cfg.blockCurl, true);
		assert.strictEqual(cfg.maxOutputBytes, 102_400);
	});
});
