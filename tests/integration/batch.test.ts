import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, resetConfig } from "../../src/config.js";
import { SubprocessExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime/index.js";
import { ContentStore } from "../../src/store.js";

const ORIGINAL_HOME = process.env.HOME;

function isolateConfigHome(): void {
	process.env.HOME = `/tmp/context-compress-home-${process.pid}-${Date.now()}`;
}

describe("integration: batch execute flow", () => {
	beforeEach(() => {
		resetConfig();
		isolateConfigHome();
		delete process.env.CONTEXT_COMPRESS_PASSTHROUGH_ENV;
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
		"runs multiple shell commands, indexes combined output, and searches each section",
		{ timeout: 20_000 },
		async (t) => {
			const config = loadConfig();
			const runtimes = await detectRuntimes();
			if (!runtimes.has("shell")) {
				t.skip("shell runtime not detected");
			}

			const executor = new SubprocessExecutor(runtimes, config);
			const store = new ContentStore(":memory:");

			try {
				const commands = [
					'echo "section1"',
					'echo "section2"',
					'echo "section3"',
				];

				const results = await Promise.all(
					commands.map((code) =>
						executor.execute({ language: "shell", code, timeout: 10_000 }),
					),
				);

				for (const result of results) {
					assert.strictEqual(result.exitCode, 0);
				}

				const combined = results
					.map(
						(result, index) =>
							`## section${index + 1}\n\n${result.stdout.trim()}\n`,
					)
					.join("\n");

				store.index(combined, "batch_execute");

				assert.ok(store.search("section1").results.length > 0);
				assert.ok(store.search("section2").results.length > 0);
				assert.ok(store.search("section3").results.length > 0);
			} finally {
				store.close();
			}
		},
	);
});
