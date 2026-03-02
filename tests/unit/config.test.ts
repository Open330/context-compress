import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getConfig, loadConfig, resetConfig } from "../../src/config.js";

const ENV_KEYS = [
	"CONTEXT_COMPRESS_DEBUG",
	"CONTEXT_COMPRESS_PASSTHROUGH_ENV",
	"CONTEXT_COMPRESS_BLOCK_CURL",
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
});
