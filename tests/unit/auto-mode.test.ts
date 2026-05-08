import assert from "node:assert";
import { describe, it } from "node:test";
import { heuristicMode, pickModeAuto } from "../../src/util/auto-mode.js";

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
