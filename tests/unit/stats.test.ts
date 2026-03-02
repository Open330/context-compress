import assert from "node:assert";
import { describe, it } from "node:test";
import { SessionTracker } from "../../src/stats.js";

describe("SessionTracker", () => {
	it("tracks calls, indexed bytes, and sandboxed bytes", () => {
		const tracker = new SessionTracker();
		tracker.trackCall("execute", 120);
		tracker.trackCall("execute", 80);
		tracker.trackIndexed(500);
		tracker.trackSandboxed(300);

		const snap = tracker.getSnapshot();
		assert.strictEqual(snap.calls.execute, 2);
		assert.strictEqual(snap.bytesReturned.execute, 200);
		assert.strictEqual(snap.bytesIndexed, 500);
		assert.strictEqual(snap.bytesSandboxed, 300);
	});

	it("formatReport includes headline and savings ratio", () => {
		const tracker = new SessionTracker();
		tracker.trackCall("execute", 100);
		tracker.trackIndexed(400);
		tracker.trackSandboxed(200);

		const report = tracker.formatReport();
		assert.ok(report.includes("Session Statistics"));
		assert.ok(report.includes("Savings ratio"));
		assert.ok(report.includes("execute"));
	});
});
