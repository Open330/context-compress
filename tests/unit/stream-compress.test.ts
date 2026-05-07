import assert from "node:assert";
import { describe, it } from "node:test";
import { StreamCompressor } from "../../src/util/stream-compress.js";

describe("StreamCompressor", () => {
	it("emits each non-empty line as it sees a newline", () => {
		const c = new StreamCompressor();
		assert.strictEqual(c.process("hello"), "");
		assert.strictEqual(c.process("\nworld\n"), "hello\nworld\n");
	});

	it("buffers an incomplete trailing line until newline arrives", () => {
		const c = new StreamCompressor();
		assert.strictEqual(c.process("partial"), "");
		assert.strictEqual(c.process(" line"), "");
		assert.strictEqual(c.process("\n"), "partial line\n");
	});

	it("strips ANSI codes per line", () => {
		const c = new StreamCompressor();
		const out = c.process("\x1b[32mPASS\x1b[0m foo.test.ts\n");
		assert.strictEqual(out, "PASS foo.test.ts\n");
	});

	it("drops pure progress-bar lines", () => {
		const c = new StreamCompressor();
		const input = "[==========>          ] 45%\nReal output line\n";
		const out = c.process(input);
		assert.ok(!out.includes("45%"));
		assert.ok(out.includes("Real output line"));
	});

	it("drops spinner-prefixed progress lines", () => {
		const c = new StreamCompressor();
		const out = c.process("⠋ Fetching dependencies\nResolved 12 packages\n");
		assert.ok(!out.includes("⠋"));
		assert.ok(out.includes("Resolved 12"));
	});

	it("collapses adjacent identical lines and emits a counter", () => {
		const c = new StreamCompressor();
		// 5 identical, then a different line — should emit "first identical" once,
		// then "(×N identical)", then the different line.
		const input = "same\nsame\nsame\nsame\nsame\ndifferent\n";
		const out = c.process(input);
		assert.match(out, /^same\n/);
		assert.ok(out.includes("×4 identical lines"));
		assert.ok(out.includes("different"));
		const sameCount = (out.match(/^same$/gm) ?? []).length;
		assert.strictEqual(sameCount, 1, "should emit 'same' exactly once");
	});

	it("flush() drains buffered partial line and pending dedup counter", () => {
		const c = new StreamCompressor();
		c.process("dup\ndup\ndup\n");
		// `dup\n` repeated; only the first emitted by process(), counter pending.
		const tail = c.flush();
		assert.match(tail, /×2 identical lines/);
	});

	it("flush() emits a buffered final line without trailing newline", () => {
		const c = new StreamCompressor();
		c.process("complete\n");
		c.process("incomplete-no-newline");
		const tail = c.flush();
		assert.strictEqual(tail, "incomplete-no-newline\n");
	});

	it("preserves empty lines (do not collapse blanks)", () => {
		const c = new StreamCompressor();
		const out = c.process("a\n\nb\n");
		assert.strictEqual(out, "a\n\nb\n");
	});

	it("survives binary-ish content without crashing", () => {
		const c = new StreamCompressor();
		const out = c.process("normal\n\x00\x01\x02 weird control bytes\nafter\n");
		// Whatever the output is, it should not throw and should still
		// contain the human-readable lines.
		assert.ok(out.includes("normal"));
		assert.ok(out.includes("after"));
	});
});
