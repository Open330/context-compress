import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { compressOutput } from "../../src/cli/filter.js";
import { type Config, loadConfig, resetConfig } from "../../src/config.js";
import { SubprocessExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime/index.js";

/**
 * The generic compression stages — progress stripping, adjacent deduplication,
 * error grouping — and the format-aware fallback are all unit-tested in
 * isolation, but nothing asserted they were *wired in*. Disabling every call
 * site in `compressOutput` and in the executor's close handler left the suite
 * green, so the product could ship doing no generic compression at all.
 *
 * Each test below drives the real entry point with input that ONLY the stage
 * under test can compress, so it fails if that stage is unhooked.
 */

const ORIGINAL_HOME = process.env.HOME;

function isolateConfigHome(): void {
	process.env.HOME = `/tmp/context-compress-home-${process.pid}-${Date.now()}`;
}

async function createExecutor(overrides: Partial<Config> = {}) {
	resetConfig();
	const config = { ...loadConfig(), ...overrides };
	const runtimes = await detectRuntimes();
	return { executor: new SubprocessExecutor(runtimes, config), runtimes };
}

/** Repeated identical lines: only adjacent dedup collapses these. */
function repeatedLines(line: string, count: number): string {
	return `${Array.from({ length: count }, () => line).join("\n")}\n`;
}

describe("generic pipeline wiring: compressOutput (CLI wrap/filter path)", () => {
	it("deduplicates identical lines past the balanced threshold", () => {
		// No command is passed, and the shape is not JSON/NDJSON/logs, so neither the
		// command filter nor the format filter can touch it.
		const input = repeatedLines("plain repeated payload line", 400);
		assert.ok(input.length > 5_000, "must exceed the balanced dedup threshold");

		const out = compressOutput(input, undefined, "balanced");

		assert.match(out, /\(×\d+ identical lines\)/, "adjacent dedup must be wired in");
		assert.ok(out.length < input.length / 2, `expected real reduction, got ${out.length}`);
	});

	it("leaves output below the threshold alone", () => {
		const small = repeatedLines("short repeated line", 5);
		assert.strictEqual(compressOutput(small, undefined, "balanced"), small);
	});

	it("strips progress lines", () => {
		// Pure progress bars: bracket, bar, percentage — no words, which is exactly
		// the shape stripProgressLines targets.
		const bars = Array.from(
			{ length: 300 },
			(_, i) => `[${"=".repeat(i % 40)}>${" ".repeat(40 - (i % 40))}] ${i % 100}%`,
		);
		const input = `${bars.join("\n")}\ndone building the thing\n`;
		assert.ok(input.length > 5_000);

		const out = compressOutput(input, undefined, "balanced");

		assert.ok(out.includes("done building the thing"), "real content must survive");
		assert.ok(!out.includes("=>"), `progress stripping must be wired in: ${out.slice(0, 120)}`);
	});

	it("strips download-progress lines", () => {
		const lines = Array.from(
			{ length: 300 },
			(_, i) => `Downloading ${i}.5 MB / 500.0 MB`,
		);
		const input = `${lines.join("\n")}\nbuild finished\n`;

		const out = compressOutput(input, undefined, "balanced");

		assert.ok(out.includes("build finished"));
		assert.ok(!out.includes("Downloading"), "download-progress stripping must be wired in");
	});

	it("groups repeated error shapes", () => {
		const errors = Array.from(
			{ length: 200 },
			(_, i) => `ERROR: cannot resolve module at line ${i}`,
		).join("\n");

		const out = compressOutput(`${errors}\n`, undefined, "balanced");

		assert.match(out, /Grouped errors\/warnings/, "error grouping must be wired in");
	});

	it("applies the format-aware fallback when no command filter matches", () => {
		// Pretty-printed JSON with no command: only applyFormatFilter compresses it.
		const rows = Array.from({ length: 200 }, (_, i) => ({
			id: i,
			name: `item-${i}`,
			description: "a reasonably long description field to give the payload some size",
		}));
		const input = JSON.stringify({ rows }, null, 2);
		assert.ok(input.length > 5_000);

		const out = compressOutput(input, undefined, "balanced");

		assert.ok(out.length < input.length, "format fallback must be wired in");
		assert.ok(out.includes("item-0"), "content must be preserved, not dropped");
	});

	it("does nothing beyond ANSI stripping in conservative mode", () => {
		const input = repeatedLines("plain repeated payload line", 400);
		const out = compressOutput(`[31m${input}[0m`, undefined, "conservative");
		assert.ok(!out.includes("["), "ANSI is always stripped");
		assert.doesNotMatch(out, /identical lines/, "conservative must not compress");
	});
});

describe("generic pipeline wiring: executor close handler", () => {
	beforeEach(() => {
		isolateConfigHome();
		resetConfig();
	});

	afterEach(() => {
		resetConfig();
		if (ORIGINAL_HOME === undefined) delete process.env.HOME;
		else process.env.HOME = ORIGINAL_HOME;
	});

	it(
		"deduplicates a command's repeated output past the 10KB threshold",
		{ timeout: 20_000 },
		async (t) => {
			const { executor, runtimes } = await createExecutor();
			if (!runtimes.has("shell")) {
				t.skip("shell runtime not detected");
				return;
			}

			// `seq | sed` output is not a recognized command shape, so the command
			// filter cannot claim it; only the generic stages can compress it.
			const result = await executor.execute({
				language: "shell",
				code: "for i in $(seq 1 600); do echo 'identical executor payload line'; done",
				timeout: 15_000,
			});

			assert.strictEqual(result.exitCode, 0, result.stderr);
			assert.ok(
				result.indexableStdout.length > 10_000,
				"the raw corpus must exceed the executor's generic threshold",
			);
			assert.match(
				result.stdout,
				/\(×\d+ identical lines\)/,
				"the executor must run the generic pipeline on its response",
			);
			assert.ok(
				result.stdout.length < result.indexableStdout.length / 2,
				"the response must be materially smaller than the retained corpus",
			);
		},
	);

	it(
		"applies the format-aware fallback to unrecognized structured output",
		{ timeout: 20_000 },
		async (t) => {
			const { executor, runtimes } = await createExecutor();
			if (!runtimes.has("javascript")) {
				t.skip("javascript runtime not detected");
				return;
			}

			const result = await executor.execute({
				language: "javascript",
				code: `
					const rows = Array.from({ length: 300 }, (_, i) => ({
						id: i,
						name: "item-" + i,
						note: "padding to make the document large enough to matter",
					}));
					console.log(JSON.stringify({ rows }, null, 2));
				`,
				timeout: 15_000,
			});

			assert.strictEqual(result.exitCode, 0, result.stderr);
			assert.ok(
				result.stdout.length < result.indexableStdout.length,
				"the format fallback must be wired into the executor",
			);
			assert.ok(result.stdout.includes("item-0"), "content must be preserved");
		},
	);
});
