import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getConfig, loadConfig, resetConfig } from "../../src/config.js";

const ENV_KEYS = [
	"CONTEXT_COMPRESS_DEBUG",
	"CONTEXT_COMPRESS_PASSTHROUGH_ENV",
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

describe("config file trust boundary", () => {
	beforeEach(() => {
		resetConfig();
		clearConfigEnv();
	});

	afterEach(() => {
		resetConfig();
		clearConfigEnv();
		if (ORIGINAL_HOME === undefined) delete process.env.HOME;
		else process.env.HOME = ORIGINAL_HOME;
	});

	/** Write both a fake home config and a project config, then load. */
	function withConfigs(home: unknown | null, project: unknown | null) {
		const homeDir = mkdtempSync(join(tmpdir(), "cc-home-"));
		const projectDir = mkdtempSync(join(tmpdir(), "cc-project-"));
		if (home !== null) {
			writeFileSync(join(homeDir, ".context-compress.json"), JSON.stringify(home));
		}
		if (project !== null) {
			writeFileSync(join(projectDir, ".context-compress.json"), JSON.stringify(project));
		}
		process.env.HOME = homeDir;
		resetConfig();
		const cfg = loadConfig(projectDir);
		return { cfg, cleanup: () => {
			rmSync(homeDir, { recursive: true, force: true });
			rmSync(projectDir, { recursive: true, force: true });
		} };
	}

	it("ignores user-scope-only keys in a project file", () => {
		const { cfg, cleanup } = withConfigs(null, {
			passthroughEnvVars: ["AWS_SECRET_ACCESS_KEY"],
			dbDir: "/tmp/attacker-chosen",
			persistDb: true,
			hardCapBytes: 999_999_999,
			// maxOutputBytes is user-scope-only too: the sanity clamp raises
			// hardCapBytes up to it, so leaving it project-settable handed the
			// memory guard straight back.
			maxOutputBytes: 900_000_000,
			searchLimit: 7,
		});
		try {
			assert.deepStrictEqual(cfg.passthroughEnvVars, []);
			assert.strictEqual(cfg.dbDir, null);
			assert.strictEqual(cfg.persistDb, false);
			assert.notStrictEqual(cfg.hardCapBytes, 999_999_999);
			assert.ok(
				cfg.hardCapBytes <= 16 * 1024 * 1024,
				`a project file must not raise the capture cap (got ${cfg.hardCapBytes})`,
			);
			assert.notStrictEqual(cfg.maxOutputBytes, 900_000_000);
			assert.strictEqual(cfg.searchLimit, 7, "project-safe keys still apply");
		} finally {
			cleanup();
		}
	});

	it("honors user-scope-only keys from the home file", () => {
		const { cfg, cleanup } = withConfigs({ passthroughEnvVars: ["GH_TOKEN"], persistDb: true }, null);
		try {
			assert.deepStrictEqual(cfg.passthroughEnvVars, ["GH_TOKEN"]);
			assert.strictEqual(cfg.persistDb, true);
		} finally {
			cleanup();
		}
	});

	it("layers a project file over the home file instead of replacing it", () => {
		// Returning on the first readable file meant a project file wiped every
		// home setting, including the user's own passthrough allowlist.
		const { cfg, cleanup } = withConfigs(
			{ passthroughEnvVars: ["GH_TOKEN"], searchLimit: 7 },
			{ intentBudgetBytes: 4_096 },
		);
		try {
			assert.deepStrictEqual(cfg.passthroughEnvVars, ["GH_TOKEN"], "home value survives");
			assert.strictEqual(cfg.searchLimit, 7, "home value survives");
			assert.strictEqual(cfg.intentBudgetBytes, 4_096, "project value applies");
		} finally {
			cleanup();
		}
	});

	it("cannot have its home allowlist widened by a project file", () => {
		const { cfg, cleanup } = withConfigs(
			{ passthroughEnvVars: ["GH_TOKEN"] },
			{ passthroughEnvVars: ["GH_TOKEN", "AWS_SECRET_ACCESS_KEY"] },
		);
		try {
			assert.deepStrictEqual(cfg.passthroughEnvVars, ["GH_TOKEN"]);
		} finally {
			cleanup();
		}
	});
});

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
		assert.strictEqual(cfg.maxOutputBytes, 102_400);
	});

	it("loads server file settings without exposing hook-only keys", () => {
		const dir = mkdtempSync(join(tmpdir(), "context-compress-config-"));
		try {
			writeFileSync(
				join(dir, ".context-compress.json"),
				JSON.stringify({
					passthroughEnvVars: ["GH_TOKEN"],
					debug: true,
					blockCurl: false,
					blockWebFetch: false,
					nudgeOnRead: false,
					nudgeOnGrep: false,
				}),
			);

			const cfg = loadConfig(dir);
			// Project-scope keys apply...
			assert.strictEqual(cfg.debug, true);
			// ...but a project file may not decide which of the user's secrets get
			// copied into every subprocess: the file travels with the repository, so
			// an untrusted clone could name AWS_SECRET_ACCESS_KEY and have the agent's
			// own `npm install` leak it.
			assert.deepStrictEqual(cfg.passthroughEnvVars, [], "project scope must not grant env access");
			for (const key of ["blockCurl", "blockWebFetch", "nudgeOnRead", "nudgeOnGrep"]) {
				assert.strictEqual(Object.hasOwn(cfg, key), false, `${key} is hook-only`);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
