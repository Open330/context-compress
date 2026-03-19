import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, resetConfig } from "../../src/config.js";
import { SubprocessExecutor, deduplicateLines, groupErrorLines } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime/index.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_AWS_KEY = process.env.AWS_ACCESS_KEY_ID;

function isolateConfigHome(): void {
	process.env.HOME = `/tmp/context-compress-home-${process.pid}-${Date.now()}`;
}

async function createExecutor(): Promise<{
	executor: SubprocessExecutor;
	runtimes: Awaited<ReturnType<typeof detectRuntimes>>;
}> {
	resetConfig();
	const config = loadConfig();
	const runtimes = await detectRuntimes();
	return { executor: new SubprocessExecutor(runtimes, config), runtimes };
}

describe("SubprocessExecutor", () => {
	beforeEach(() => {
		delete process.env.CONTEXT_COMPRESS_PASSTHROUGH_ENV;
		delete process.env.CONTEXT_COMPRESS_DEBUG;
		isolateConfigHome();
		resetConfig();
	});

	afterEach(() => {
		resetConfig();
		if (ORIGINAL_HOME === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = ORIGINAL_HOME;
		}
		if (ORIGINAL_AWS_KEY === undefined) {
			delete process.env.AWS_ACCESS_KEY_ID;
		} else {
			process.env.AWS_ACCESS_KEY_ID = ORIGINAL_AWS_KEY;
		}
	});

	it(
		"executes JavaScript code",
		{ timeout: 10_000 },
		async (t) => {
			const { executor, runtimes } = await createExecutor();
			if (!runtimes.has("javascript")) {
				t.skip("javascript runtime not detected");
			}

			const result = await executor.execute({
				language: "javascript",
				code: 'console.log("hello")',
				timeout: 10_000,
			});

			assert.strictEqual(result.exitCode, 0);
			assert.match(result.stdout, /hello/);
		},
	);

	it(
		"executes Python code",
		{ timeout: 10_000 },
		async (t) => {
			const { executor, runtimes } = await createExecutor();
			if (!runtimes.has("python")) {
				t.skip("python runtime not detected");
			}

			const result = await executor.execute({
				language: "python",
				code: 'print("hello")',
				timeout: 10_000,
			});

			assert.strictEqual(result.exitCode, 0);
			assert.match(result.stdout, /hello/);
		},
	);

	it(
		"executes shell code",
		{ timeout: 10_000 },
		async (t) => {
			const { executor, runtimes } = await createExecutor();
			if (!runtimes.has("shell")) {
				t.skip("shell runtime not detected");
			}

			const result = await executor.execute({
				language: "shell",
				code: "echo hello",
				timeout: 10_000,
			});

			assert.strictEqual(result.exitCode, 0);
			assert.match(result.stdout, /hello/);
		},
	);

	it(
		"returns an error for invalid language",
		{ timeout: 10_000 },
		async () => {
			const { executor } = await createExecutor();
			const result = await executor.execute({
				language: "invalid" as never,
				code: "echo hello",
				timeout: 10_000,
			});

			assert.strictEqual(result.exitCode, 1);
			assert.match(result.stderr, /not available/i);
		},
	);

	it(
		"does not pass through credentials by default",
		{ timeout: 10_000 },
		async (t) => {
			const secret = "AKIA_TEST_SECRET_123";
			process.env.AWS_ACCESS_KEY_ID = secret;

			const { executor, runtimes } = await createExecutor();
			if (!runtimes.has("shell")) {
				t.skip("shell runtime not detected");
			}

			const result = await executor.execute({
				language: "shell",
				code: 'echo "${AWS_ACCESS_KEY_ID:-missing}"',
				timeout: 10_000,
			});

			assert.strictEqual(result.exitCode, 0);
			assert.ok(!result.stdout.includes(secret));
			assert.match(result.stdout, /missing/);
		},
	);
});

describe("deduplicateLines", () => {
	it("collapses 3+ identical consecutive lines", () => {
		const input = ["aaa", "aaa", "aaa", "aaa"].join("\n");
		const result = deduplicateLines(input);
		assert.ok(result.includes("(×4 identical lines)"));
		// The original line should appear once
		const lines = result.split("\n");
		assert.strictEqual(lines.filter((l) => l === "aaa").length, 1);
	});

	it("does not collapse exactly 2 identical consecutive lines", () => {
		const input = ["aaa", "aaa", "bbb"].join("\n");
		const result = deduplicateLines(input);
		assert.ok(!result.includes("×"));
		assert.strictEqual(result, input);
	});

	it("returns input as-is when fewer than 3 lines", () => {
		const one = "single line";
		assert.strictEqual(deduplicateLines(one), one);

		const two = "first\nsecond";
		assert.strictEqual(deduplicateLines(two), two);
	});

	it("handles mixed runs of duplicates and unique lines", () => {
		const input = [
			"unique1",
			"dup",
			"dup",
			"dup",
			"dup",
			"unique2",
			"another",
			"another",
			"unique3",
		].join("\n");
		const result = deduplicateLines(input);
		// "dup" run should be collapsed
		assert.ok(result.includes("(×4 identical lines)"));
		// "another" run (only 2) should NOT be collapsed
		assert.ok(!result.includes("×2"));
		// unique lines preserved
		assert.ok(result.includes("unique1"));
		assert.ok(result.includes("unique2"));
		assert.ok(result.includes("unique3"));
	});
});

describe("groupErrorLines", () => {
	it("groups multiple similar error lines with count", () => {
		const input = [
			"some preamble",
			"Error: unused variable at line 10",
			"Error: unused variable at line 20",
			"Error: unused variable at line 30",
			"Error: unused variable at line 40",
			"Error: unused variable at line 50",
		].join("\n");
		const result = groupErrorLines(input);
		// Should contain grouped output with a count
		assert.ok(result.includes("×5"));
		assert.ok(result.includes("Grouped errors/warnings"));
	});

	it("returns input as-is when fewer than 5 lines", () => {
		const input = ["Error: a", "Error: b", "Error: c"].join("\n");
		const result = groupErrorLines(input);
		assert.strictEqual(result, input);
	});

	it("returns input as-is when there are no error patterns", () => {
		const input = [
			"line one",
			"line two",
			"line three",
			"line four",
			"line five",
			"line six",
		].join("\n");
		const result = groupErrorLines(input);
		assert.strictEqual(result, input);
	});

	it("returns input as-is when grouped count is below threshold", () => {
		const input = [
			"line one",
			"line two",
			"line three",
			"Error: something at line 5",
			"Error: other thing at line 10",
			"line six",
		].join("\n");
		const result = groupErrorLines(input);
		// Only 2 error lines grouped → below threshold of 4
		assert.strictEqual(result, input);
	});
});
