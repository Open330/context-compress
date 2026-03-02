import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, resetConfig } from "../../src/config.js";
import { SubprocessExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime/index.js";
import { SessionTracker } from "../../src/stats.js";
import { ContentStore } from "../../src/store.js";

const ORIGINAL_HOME = process.env.HOME;

function isolateConfigHome(): void {
	process.env.HOME = `/tmp/context-compress-home-${process.pid}-${Date.now()}`;
}

async function createComponents() {
	resetConfig();
	const config = loadConfig();
	const runtimes = await detectRuntimes();
	const executor = new SubprocessExecutor(runtimes, config);
	const store = new ContentStore(":memory:");
	const tracker = new SessionTracker();
	return { executor, store, tracker, runtimes };
}

describe("integration: tool-chain components", () => {
	beforeEach(() => {
		resetConfig();
		delete process.env.CONTEXT_COMPRESS_PASSTHROUGH_ENV;
		isolateConfigHome();
	});

	afterEach(() => {
		resetConfig();
		if (ORIGINAL_HOME === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = ORIGINAL_HOME;
		}
	});

	it(
		"executes JavaScript then indexes and searches the output",
		{ timeout: 15_000 },
		async (t) => {
			const { executor, store, runtimes } = await createComponents();
			try {
				if (!runtimes.has("javascript")) {
					t.skip("javascript runtime not detected");
				}

				const exec = await executor.execute({
					language: "javascript",
					code: 'console.log("integration-js-output")',
					timeout: 10_000,
				});
				assert.strictEqual(exec.exitCode, 0);
				assert.match(exec.stdout, /integration-js-output/);

				store.index(`# Command Output\n\n${exec.stdout.trim()}`, "execute:javascript");
				const search = store.search("integration-js-output");
				assert.ok(search.results.length > 0);
				assert.match(search.results[0].snippet, /integration-js-output/);
			} finally {
				store.close();
			}
		},
	);

	it(
		"executes Python and returns expected output",
		{ timeout: 15_000 },
		async (t) => {
			const { executor, store, runtimes } = await createComponents();
			try {
				if (!runtimes.has("python")) {
					t.skip("python runtime not detected");
				}

				const exec = await executor.execute({
					language: "python",
					code: 'print("integration-python-output")',
					timeout: 10_000,
				});
				assert.strictEqual(exec.exitCode, 0);
				assert.match(exec.stdout, /integration-python-output/);
			} finally {
				store.close();
			}
		},
	);

	it("indexes markdown and finds matching heading", () => {
		const store = new ContentStore(":memory:");
		try {
			const markdown = `
# Deployment Guide
Use this document for deployment steps.

---

## Health Checks
Run smoke checks after deployment.
`.trim();

			store.index(markdown, "docs:deployment");
			const search = store.search("Deployment Guide");
			assert.ok(search.results.length > 0);
			assert.match(search.results[0].title, /Deployment Guide/);
		} finally {
			store.close();
		}
	});

	it(
		"tracks stats for execute/index flow and formats report",
		{ timeout: 15_000 },
		async (t) => {
			const { executor, store, tracker, runtimes } = await createComponents();
			try {
				if (!runtimes.has("shell")) {
					t.skip("shell runtime not detected");
				}

				const exec = await executor.execute({
					language: "shell",
					code: 'echo "stats-integration-output"',
					timeout: 10_000,
				});
				assert.strictEqual(exec.exitCode, 0);

				tracker.trackCall("execute", Buffer.byteLength(exec.stdout));
				tracker.trackIndexed(Buffer.byteLength(exec.stdout));
				tracker.trackSandboxed(128);

				store.index(`# Stats\n\n${exec.stdout.trim()}`, "stats:integration");
				const report = tracker.formatReport();

				assert.ok(report.includes("Session Statistics"));
				assert.ok(report.includes("Savings ratio"));
				assert.ok(report.includes("execute"));
			} finally {
				store.close();
			}
		},
	);
});
