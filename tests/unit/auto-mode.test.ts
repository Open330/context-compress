import assert from "node:assert";
import { describe, it } from "node:test";
import { heuristicMode, pickModeAuto, scrubSecrets } from "../../src/util/auto-mode.js";

describe("heuristicMode", () => {
	it("picks conservative for tiny outputs", () => {
		assert.strictEqual(heuristicMode("git status", "M foo.ts"), "conservative");
	});

	it("picks aggressive for git log full bodies", () => {
		const sample = "x".repeat(2000);
		assert.strictEqual(heuristicMode("git log -10", sample), "aggressive");
	});

	it("does NOT pick aggressive for git log --oneline (already compact)", () => {
		const sample = "x".repeat(2000);
		assert.notStrictEqual(heuristicMode("git log --oneline -10", sample), "aggressive");
	});

	it("picks aggressive for large test runner output", () => {
		const sample = "PASS test\n".repeat(1000);
		assert.strictEqual(heuristicMode("npm test", sample), "aggressive");
	});

	it("picks aggressive for ls -la (long-listing format)", () => {
		const sample = "drwxr-xr-x".repeat(200);
		assert.strictEqual(heuristicMode("ls -la /tmp", sample), "aggressive");
	});

	it("picks balanced for large generic output", () => {
		const sample = "a".repeat(5000);
		assert.strictEqual(heuristicMode("uname -a", sample), "balanced");
	});
});

describe("pickModeAuto with noLlm: true", () => {
	it("returns a heuristic decision without touching the LLM", async () => {
		const r = await pickModeAuto("git log -10", "x".repeat(2000), {
			noLlm: true,
			noCache: true,
		});
		assert.strictEqual(r.mode, "aggressive");
		assert.strictEqual(r.source, "heuristic");
	});

	it("returns conservative for tiny outputs", async () => {
		const r = await pickModeAuto("git status", "M foo.ts", {
			noLlm: true,
			noCache: true,
		});
		assert.strictEqual(r.mode, "conservative");
	});

	it("source is 'heuristic' when noLlm is true", async () => {
		const r = await pickModeAuto("npm install", "x".repeat(8000), {
			noLlm: true,
			noCache: true,
		});
		assert.strictEqual(r.source, "heuristic");
	});
});

describe("scrubSecrets", () => {
	it("redacts common token shapes before the sample leaves the machine", () => {
		const sample = [
			"AWS key: AKIAIOSFODNN7EXAMPLE",
			"github: ghp_abcdefghijklmnopqrstuvwxyz123456",
			"openai: sk-abcdefghijklmnopqrstuvwxyz",
			"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
			"password=hunter2secret",
			"API_KEY: abcdef1234567890",
		].join("\n");
		const scrubbed = scrubSecrets(sample);
		assert.ok(!scrubbed.includes("AKIAIOSFODNN7EXAMPLE"));
		assert.ok(!scrubbed.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"));
		assert.ok(!scrubbed.includes("sk-abcdefghijklmnopqrstuvwxyz"));
		assert.ok(!scrubbed.includes("eyJhbGciOiJIUzI1NiJ9"));
		assert.ok(!scrubbed.includes("hunter2secret"));
		assert.ok(!scrubbed.includes("abcdef1234567890"));
		assert.ok(scrubbed.includes("[REDACTED]"));
	});

	it("redacts credentials that appear in the command line, not just output", () => {
		// The command line is sent to the LLM too — it is just as likely to carry
		// a secret as the output sample is.
		assert.ok(!scrubSecrets('psql "postgres://admin:s3cr3t@db.internal/app"').includes("s3cr3t"));
		assert.ok(!scrubSecrets("mysql -uroot -phunter2 mydb").includes("hunter2"));
		assert.ok(
			!scrubSecrets('curl -H "Authorization: Bearer abcdefghijklmnop"').includes("abcdefghij"),
		);
		// The non-secret parts still have to survive, or mode selection degrades.
		const scrubbed = scrubSecrets('psql "postgres://admin:s3cr3t@db.internal/app"');
		assert.ok(scrubbed.includes("postgres://admin:"));
		assert.ok(scrubbed.includes("@db.internal/app"));
	});

	it("leaves ordinary output untouched", () => {
		const sample = "PASS src/foo.test.ts\n✓ works (3ms)\nTests: 5 passed, 5 total";
		assert.strictEqual(scrubSecrets(sample), sample);
		// URLs without credentials must not be touched by the userinfo rule.
		const url = "cloning https://github.com/acme/repo.git into ./repo";
		assert.strictEqual(scrubSecrets(url), url);
	});
});
