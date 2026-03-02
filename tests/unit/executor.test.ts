import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, resetConfig } from "../../src/config.js";
import { SubprocessExecutor } from "../../src/executor.js";
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
