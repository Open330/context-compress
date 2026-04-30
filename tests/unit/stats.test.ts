import assert from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("saveCumulative persists stats to disk", () => {
		const dir = join(tmpdir(), `cc-test-cumulative-${process.pid}`);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "stats.json");

		try {
			const tracker = new SessionTracker(filePath);
			tracker.trackCall("execute", 100);
			tracker.trackIndexed(400);
			tracker.trackSandboxed(200);
			tracker.saveCumulative();

			assert.ok(existsSync(filePath), "cumulative file should exist");
			const data = JSON.parse(readFileSync(filePath, "utf-8"));
			assert.strictEqual(data.totalSessions, 1);
			assert.strictEqual(data.totalBytesSaved, 600); // indexed + sandboxed
			assert.strictEqual(data.totalBytesProcessed, 700); // saved + returned
			assert.strictEqual(data.totalCalls, 1);
			assert.ok(data.perCommand.execute);
			assert.strictEqual(data.perCommand.execute.calls, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("saveCumulative accumulates across multiple saves", () => {
		const dir = join(tmpdir(), `cc-test-cumulative2-${process.pid}`);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "stats.json");

		try {
			// First session
			const tracker1 = new SessionTracker(filePath);
			tracker1.trackCall("execute", 100);
			tracker1.trackIndexed(400);
			tracker1.saveCumulative();

			// Second session
			const tracker2 = new SessionTracker(filePath);
			tracker2.trackCall("search", 50);
			tracker2.trackIndexed(300);
			tracker2.saveCumulative();

			const data = JSON.parse(readFileSync(filePath, "utf-8"));
			assert.strictEqual(data.totalSessions, 2);
			assert.strictEqual(data.totalBytesSaved, 700); // 400 + 300
			assert.strictEqual(data.totalCalls, 2); // 1 + 1
			assert.ok(data.perCommand.execute);
			assert.ok(data.perCommand.search);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("formatReport includes cumulative section when file exists", () => {
		const dir = join(tmpdir(), `cc-test-cumulative3-${process.pid}`);
		mkdirSync(dir, { recursive: true });
		const filePath = join(dir, "stats.json");

		try {
			const tracker = new SessionTracker(filePath);
			tracker.trackCall("execute", 100);
			tracker.trackIndexed(400);
			tracker.saveCumulative();

			const report = tracker.formatReport();
			assert.ok(report.includes("Cumulative Savings (All Sessions)"));
			assert.ok(report.includes("Sessions tracked"));
			assert.ok(report.includes("Tracking since"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loadCumulative returns null when no file", () => {
		const tracker = new SessionTracker();
		assert.strictEqual(tracker.loadCumulative(), null);
	});

	it("saveCumulative is a no-op without cumulative file", () => {
		const tracker = new SessionTracker();
		tracker.trackCall("execute", 100);
		// Should not throw
		tracker.saveCumulative();
	});
});
