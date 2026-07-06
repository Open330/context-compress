import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { observeAndAdjust, regretSummary } from "../../src/util/regret.js";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cc-regret-"));
	path = join(dir, "regret.json");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("observeAndAdjust", () => {
	it("does not adjust on the first observation", () => {
		const d = observeAndAdjust("some cmd", "aggressive", { path, now: 1_000 });
		assert.equal(d.adjusted, false);
		assert.equal(d.mode, "aggressive");
	});

	it("downgrades aggressive after repeated fast re-runs", () => {
		let t = 0;
		let last = observeAndAdjust("flaky cmd", "aggressive", { path, now: (t += 100) });
		// Each subsequent call is a fast re-run (within the 30s window) under aggressive.
		last = observeAndAdjust("flaky cmd", "aggressive", { path, now: (t += 100) });
		last = observeAndAdjust("flaky cmd", "aggressive", { path, now: (t += 100) });
		last = observeAndAdjust("flaky cmd", "aggressive", { path, now: (t += 100) });
		assert.equal(last.adjusted, true, "should downgrade after enough regret");
		assert.equal(last.mode, "balanced");
		assert.ok(last.regretRate >= 0.5);
	});

	it("does not blame balanced or conservative modes", () => {
		let t = 0;
		for (let i = 0; i < 5; i++) {
			observeAndAdjust("build cmd", "balanced", { path, now: (t += 100) });
		}
		const d = observeAndAdjust("build cmd", "balanced", { path, now: (t += 100) });
		assert.equal(d.adjusted, false);
		assert.equal(d.mode, "balanced");
		assert.equal(d.regretRate, 0, "balanced re-runs are not regret");
	});

	it("does not count slow re-runs as regret", () => {
		let t = 0;
		// Each re-run is > 30s apart — a normal edit→rerun cadence, not regret.
		for (let i = 0; i < 5; i++) {
			observeAndAdjust("test cmd", "aggressive", { path, now: (t += 60_000) });
		}
		const d = observeAndAdjust("test cmd", "aggressive", { path, now: (t += 60_000) });
		assert.equal(d.adjusted, false);
		assert.equal(d.mode, "aggressive");
		assert.equal(d.regretRate, 0);
	});

	it("regretSummary lists fingerprints with regret, highest first", () => {
		let t = 0;
		for (let i = 0; i < 4; i++)
			observeAndAdjust("bad cmd", "aggressive", { path, now: (t += 100) });
		observeAndAdjust("good cmd", "balanced", { path, now: (t += 100) });
		const summary = regretSummary({ path });
		assert.ok(summary.length >= 1);
		assert.equal(summary[0].fingerprint, "bad cmd");
		assert.ok(summary[0].regretRate > 0);
		assert.ok(!summary.some((s) => s.fingerprint === "good cmd"), "no-regret fps are omitted");
	});
});
