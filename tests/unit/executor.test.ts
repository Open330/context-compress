import assert from "node:assert";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Config, loadConfig, resetConfig } from "../../src/config.js";
import { SubprocessExecutor, deduplicateLines, groupErrorLines } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime/index.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_AWS_KEY = process.env.AWS_ACCESS_KEY_ID;

function isolateConfigHome(): void {
	process.env.HOME = `/tmp/context-compress-home-${process.pid}-${Date.now()}`;
}

async function createExecutor(configOverrides: Partial<Config> = {}): Promise<{
	executor: SubprocessExecutor;
	runtimes: Awaited<ReturnType<typeof detectRuntimes>>;
}> {
	resetConfig();
	const config = { ...loadConfig(), ...configOverrides };
	const runtimes = await detectRuntimes();
	return { executor: new SubprocessExecutor(runtimes, config), runtimes };
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processExists(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return !processExists(pid);
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
				return;
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
				return;
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
				return;
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
		"preserves executor-capped stdout before command filtering",
		{ timeout: 10_000 },
		async (t) => {
			const { executor, runtimes } = await createExecutor();
			if (!runtimes.has("shell")) {
				t.skip("shell runtime not detected");
				return;
			}

			try {
				const sentinel = "rpfhiddenexecutorsentinel";
				const result = await executor.execute({
					language: "shell",
					code: `npm test >/dev/null 2>&1 || true\nprintf '${sentinel}\\nPASS visible.test.ts\\nTests: 1 passed\\n'`,
					timeout: 10_000,
				});

				assert.strictEqual(result.exitCode, 0, result.stderr);
				assert.ok(!result.stdout.includes(sentinel), "filtered response must stay compact");
				assert.ok(
					result.indexableStdout.includes(sentinel),
					"pre-filter stdout must remain available for indexing",
				);
			} finally {
				executor.shutdown();
			}
		},
	);

	it(
		"returns chunked fetch responses before their bodies complete",
		{ timeout: 10_000 },
		async (t) => {
			const { executor, runtimes } = await createExecutor();
			if (!runtimes.has("javascript")) {
				t.skip("javascript runtime not detected");
				return;
			}

			let streamResponse: ServerResponse | undefined;
			let releasedWhileStreaming = false;
			const server = createServer((req, res) => {
				if (req.url === "/chunked") {
					streamResponse = res;
					res.writeHead(200, { "content-type": "text/plain" });
					res.write("alpha");
					return;
				}

				if (req.url === "/release") {
					releasedWhileStreaming = streamResponse !== undefined && !streamResponse.writableEnded;
					streamResponse?.end("omega");
					const body = "released";
					res.writeHead(200, { "content-length": Buffer.byteLength(body) });
					res.end(body);
					return;
				}

				res.writeHead(404).end();
			});

			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolve);
			});

			try {
				const address = server.address();
				assert.ok(address && typeof address !== "string");
				const baseUrl = `http://127.0.0.1:${address.port}`;
				const result = await executor.execute({
					language: "javascript",
					code: `
						const response = await fetch(${JSON.stringify(`${baseUrl}/chunked`)});
						await fetch(${JSON.stringify(`${baseUrl}/release`)});
						console.log(await response.text());
					`,
					timeout: 5_000,
				});

				assert.strictEqual(result.exitCode, 0, result.stderr);
				assert.strictEqual(result.stdout.trim(), "alphaomega");
				assert.ok(releasedWhileStreaming, "fetch must resolve before the chunked body completes");
				assert.strictEqual(result.networkBytes, Buffer.byteLength("released"));
			} finally {
				executor.shutdown();
				streamResponse?.destroy();
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				});
			}
		},
	);

	it(
		"uses a private temp leaf without touching the legacy shared parent",
		{ timeout: 10_000 },
		async (t) => {
			const { executor, runtimes } = await createExecutor();
			if (!runtimes.has("javascript")) {
				t.skip("javascript runtime not detected");
				return;
			}

			const legacyParent = join(tmpdir(), "context-compress");
			const sentinel = join(
				legacyParent,
				`legacy-sentinel-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
			);
			mkdirSync(legacyParent, { recursive: true });
			writeFileSync(sentinel, "legacy parent must remain untouched", { flag: "wx" });

			try {
				const result = await executor.execute({
					language: "javascript",
					code: `
						const { statSync } = await import("node:fs");
						console.log(JSON.stringify({
							cwd: process.cwd(),
							mode: statSync(process.cwd()).mode & 0o777,
						}));
					`,
					timeout: 10_000,
				});

				assert.strictEqual(result.exitCode, 0, result.stderr);
				const execution = JSON.parse(result.stdout.trim()) as { cwd: string; mode: number };
				const executionDir = execution.cwd;
				assert.strictEqual(realpathSync(dirname(executionDir)), realpathSync(tmpdir()));
				assert.match(basename(executionDir), /^context-compress-exec-/);
				if (process.platform !== "win32") {
					assert.strictEqual(execution.mode, 0o700, "private temp leaf must be mode 0700");
				}
				assert.ok(!existsSync(executionDir), "private temp leaf must be cleaned up");
				assert.strictEqual(readFileSync(sentinel, "utf8"), "legacy parent must remain untouched");
			} finally {
				executor.shutdown();
				rmSync(sentinel, { force: true });
			}
		},
	);

	it(
		"kills a timed-out command, its descendants, and reports the kill",
		{ timeout: 20_000 },
		async (t) => {
			if (process.platform === "win32") {
				t.skip("POSIX process-group semantics");
				return;
			}
			const { executor, runtimes } = await createExecutor();
			if (!runtimes.has("shell")) {
				t.skip("shell runtime not detected");
				return;
			}

			// The grandchild is detached from the direct child and outlives it, which
			// is exactly what spawn's own `timeout` option failed to kill.
			const started = Date.now();
			const result = await executor.execute({
				language: "shell",
				code: "sleep 30 & echo grandchild=$!; sleep 30",
				timeout: 1_500,
			});
			const elapsed = Date.now() - started;

			assert.ok(elapsed < 10_000, `must finish near the timeout, took ${elapsed}ms`);
			assert.strictEqual(result.killed, true);
			assert.strictEqual(result.exitCode, 1, "a killed process must never look successful");
			assert.match(result.stderr, /\[killed: timed out after/);

			const pid = Number(/grandchild=(\d+)/.exec(result.indexableStdout)?.[1]);
			assert.ok(Number.isInteger(pid) && pid > 0, `no grandchild pid in ${result.indexableStdout}`);
			assert.strictEqual(
				await waitForProcessExit(pid, 5_000),
				true,
				`grandchild ${pid} survived the timeout kill`,
			);
		},
	);

	it(
		"caps runaway output, kills the process, and marks the response",
		{ timeout: 20_000 },
		async (t) => {
			const { executor, runtimes } = await createExecutor({ hardCapBytes: 4_096 });
			if (!runtimes.has("shell")) {
				t.skip("shell runtime not detected");
				return;
			}

			const result = await executor.execute({
				language: "shell",
				code: "yes rpfcapprobe",
				timeout: 15_000,
			});

			assert.strictEqual(result.killed, true);
			assert.match(result.stdout, /\[output capped at [\d.]+KB — process killed\]/);
			assert.ok(
				!result.indexableStdout.includes("output capped at"),
				"the searchable corpus stays marker-free",
			);
			assert.ok(
				Buffer.byteLength(result.indexableStdout) <= 4_096,
				`retained corpus stays within the hard cap (${Buffer.byteLength(result.indexableStdout)})`,
			);
		},
	);

	it(
		"truncates a response past maxOutputBytes while keeping the full corpus searchable",
		{ timeout: 20_000 },
		async (t) => {
			const { executor, runtimes } = await createExecutor({ maxOutputBytes: 2_048 });
			if (!runtimes.has("shell")) {
				t.skip("shell runtime not detected");
				return;
			}

			const result = await executor.execute({
				language: "shell",
				code: "for i in $(seq 1 400); do echo \"rpftruncline $i unique-$i\"; done",
				timeout: 15_000,
			});

			assert.strictEqual(result.truncated, true);
			assert.strictEqual(result.killed, false, "truncation is not a kill");
			assert.strictEqual(result.exitCode, 0);
			assert.match(result.stdout, /truncated — showing first \d+ \+ last \d+ lines/);
			assert.ok(
				result.indexableStdout.includes("unique-400"),
				"the searchable corpus keeps content the response dropped",
			);
		},
	);

	it("normalizes ANSI once per execution", async (t) => {
		const { executor, runtimes } = await createExecutor();
		if (!runtimes.has("shell")) {
			t.skip("shell runtime not detected");
			return;
		}

		const result = await executor.execute({
			language: "shell",
			code: "printf 'plain \\033[31mred\\033[0m done\\n'",
			timeout: 10_000,
		});
		// One shared normalization feeds both outputs, so neither may contain ESC.
		assert.ok(!result.indexableStdout.includes(""), "searchable copy keeps escapes out");
		assert.ok(!result.stdout.includes(""), "response keeps escapes out");
		assert.match(result.indexableStdout, /plain red done/);

		// Guard against re-introducing the second full scan of the capped buffer.
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src/executor.ts"), "utf-8");
		assert.strictEqual(
			source.split("stripAnsi(stdout)").length - 1,
			1,
			"executor must strip ANSI from the captured stdout exactly once",
		);
	});

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
				return;
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

describe("groupErrorLines scale", () => {
	it("survives more distinct error groups than the argument limit", () => {
		// `resultLines.push(...grouped)` passes each element as an argument, which
		// overflows the call stack past roughly 125k groups. That RangeError was
		// thrown from inside the child's close listener, so the execute promise never
		// settled and the server's uncaughtException handler exited the process —
		// a `tsc`/`eslint` run on a large monorepo could kill the MCP server.
		const lines = Array.from(
			{ length: 130_000 },
			(_, i) => `src/f${i}.ts: error TS2304: cannot find name x${i}`,
		);
		// One duplicate, so the "grouping does not reduce output" early return does
		// not short-circuit before the spread.
		lines.push(lines[0]);

		const output = groupErrorLines(lines.join("\n"));

		assert.ok(output.includes("Grouped errors/warnings"), "grouping must still apply");
		assert.ok(output.split("\n").length > 100_000, "every group must be present");
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

describe("SubprocessExecutor requireRuntime", () => {
	beforeEach(() => {
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
	});

	it("fails closed when the required runtime is not installed", async (t) => {
		const { executor, runtimes } = await createExecutor();
		if (!runtimes.has("javascript")) {
			t.skip("javascript runtime not detected");
			return;
		}
		try {
			const result = await executor.execute({
				language: "javascript",
				code: "console.log('should not run')",
				requireRuntime: "definitely-not-a-real-runtime",
				timeout: 10_000,
			});
			assert.strictEqual(result.exitCode, 1);
			assert.match(result.stderr, /requires the "definitely-not-a-real-runtime" runtime/);
			assert.strictEqual(result.stdout, "", "code must not run on a substitute runtime");
		} finally {
			executor.shutdown();
		}
	});

	it("runs on the required runtime when it is available", async (t) => {
		const { executor, runtimes } = await createExecutor();
		if (!runtimes.has("javascript")) {
			t.skip("javascript runtime not detected");
			return;
		}
		try {
			const result = await executor.execute({
				language: "javascript",
				// process.versions.bun exists only under Bun.
				code: "console.log(process.versions.bun ? 'bun' : 'node')",
				requireRuntime: "node",
				timeout: 10_000,
			});
			assert.strictEqual(result.exitCode, 0, result.stderr);
			assert.strictEqual(result.stdout.trim(), "node");
		} finally {
			executor.shutdown();
		}
	});
});
