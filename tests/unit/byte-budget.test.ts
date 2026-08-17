import assert from "node:assert";
import { describe, it } from "node:test";
import { byteLength, truncateToBytes } from "../../src/util/byte-budget.js";

describe("byteLength", () => {
	it("counts UTF-8 bytes, not characters", () => {
		assert.strictEqual(byteLength("abc"), 3);
		assert.strictEqual(byteLength("가"), 3);
		assert.strictEqual(byteLength("🙂"), 4);
	});
});

describe("truncateToBytes", () => {
	it("returns short text unchanged", () => {
		assert.strictEqual(truncateToBytes("short", 1_024), "short");
	});

	it("never exceeds the budget", () => {
		const out = truncateToBytes("x".repeat(5_000), 100);
		assert.ok(byteLength(out) <= 100, `got ${byteLength(out)}`);
		assert.match(out, /truncated/);
	});

	it("does not split a multi-byte character", () => {
		// Each "가" is 3 bytes, so a naive byte slice lands mid-character.
		for (const budget of [64, 65, 66, 67]) {
			const out = truncateToBytes("가".repeat(200), budget);
			assert.ok(byteLength(out) <= budget, `budget ${budget}: got ${byteLength(out)}`);
			assert.ok(!out.includes("�"), `budget ${budget} produced a replacement character`);
		}
	});

	it("degrades to a partial marker when the budget cannot hold body plus marker", () => {
		const out = truncateToBytes("x".repeat(100), 5);
		assert.ok(byteLength(out) <= 5);
		assert.ok(!out.startsWith("x"), "a budget this small must not look like real content");
	});

	it("returns nothing for a non-positive budget", () => {
		assert.strictEqual(truncateToBytes("anything", 0), "");
	});
});
