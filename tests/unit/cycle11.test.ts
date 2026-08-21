import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig, resetConfig } from "../../src/config.js";
import { groupErrorLines } from "../../src/executor.js";
import { applyCommandFilter } from "../../src/filters.js";
import { ContentStore } from "../../src/store.js";

describe("test-runner compression does not depend on the badge's column", () => {
	function suite(prefix: string): string {
		return [
			...Array.from(
				{ length: 1_000 },
				(_, i) => `${prefix}src/components/widget${i}.test.ts (1.0s)`,
			),
			"FAIL src/api/client.test.ts",
			"  ● client › times out",
			"    Timeout - Async callback was not invoked within 5000ms",
			"",
			"Test Suites: 1 failed, 1000 passed, 1001 total",
			"Tests: 1 failed, 4000 passed, 4001 total",
		].join("\n");
	}

	// Jest and Vitest write ` PASS  path`, indented by one space. SUMMARY_RE admits
	// that shape, so the badges were classified as summary lines — and the filter
	// that drops them was anchored at column 0, so it kept all thousand. Measured
	// before the fix: 46,105 -> 414 bytes at column 0, and 48,105 -> 48,222 —
	// LARGER than the input — in Jest's actual format.
	for (const [label, prefix] of [
		["column 0", "PASS "],
		["Jest/Vitest", " PASS  "],
		["deeper indent", "   PASS  "],
	] as const) {
		it(`compresses a passing suite: ${label}`, () => {
			const raw = suite(prefix);
			for (const mode of ["balanced", "aggressive"] as const) {
				const result = applyCommandFilter("npm test", raw, mode);
				const kept = (result.output.match(/PASS/g) ?? []).length;
				assert.strictEqual(kept, 0, `${label}/${mode}: kept ${kept} PASS badges`);
				assert.ok(
					Buffer.byteLength(result.output) < Buffer.byteLength(raw) / 10,
					`${label}/${mode}: ${Buffer.byteLength(result.output)} of ${Buffer.byteLength(raw)} bytes`,
				);
				assert.ok(result.output.includes("times out"), `${label}/${mode}: the failure was dropped`);
				assert.ok(result.output.includes("1 failed"), `${label}/${mode}: the counts were dropped`);
			}
		});
	}

	it("does not print a failing file twice", () => {
		// A FAIL badge is both a failure and a summary line.
		const raw = [
			" PASS  a.test.ts",
			" FAIL  b.test.ts",
			"  ● b › boom",
			"Tests: 1 failed, 1 passed",
		].join("\n");
		const out = applyCommandFilter("npm test", raw, "balanced").output;
		assert.strictEqual((out.match(/FAIL {2}b\.test\.ts/g) ?? []).length, 1, out);
	});
});

describe("fuzzy correction is bounded by term length", () => {
	it("does not run an unbounded Levenshtein on a near-miss", () => {
		// levenshtein() only early-exits once a row's minimum exceeds maxDist, so a
		// near-miss stays inside the band for the whole matrix and runs the full
		// O(n*m). Measured before the bound: 2,872ms for ONE search against a
		// 20,000-character vocabulary word, and search accepts 16 queries per call.
		const store = new ContentStore({ dbPath: ":memory:" });
		try {
			const word = "abcdefgh".repeat(2_500); // 20,000 characters
			store.index(`alpha bravo ${word} charlie`, "big");

			// Both sides are bounded, and either one alone prevents the cost — so
			// assert each, or a single-point revert stays green.
			// biome-ignore lint/suspicious/noExplicitAny: reaching the private handle
			const db = (store as any).db as {
				prepare: (sql: string) => {
					get: (...a: unknown[]) => unknown;
					run: (...a: unknown[]) => void;
				};
			};
			const longest = db.prepare("SELECT max(length(word)) AS m FROM vocabulary").get() as {
				m: number | null;
			};
			assert.ok((longest.m ?? 0) <= 64, `vocabulary holds a ${longest.m}-character word`);

			// Now force one in, so the query-side bound is what has to hold.
			db.prepare("INSERT OR IGNORE INTO vocabulary(word) VALUES (?)").run(word);
			const started = process.hrtime.bigint();
			store.search(`${word.slice(0, -1)}X`);
			const ms = Number(process.hrtime.bigint() - started) / 1e6;
			assert.ok(ms < 500, `one search took ${ms.toFixed(0)}ms`);
		} finally {
			store.close();
		}
	});
});

describe("a clock moved backwards does not fabricate regret", () => {
	it("treats a negative interval as not-a-fast-rerun", async () => {
		const { observeAndAdjust } = await import("../../src/util/regret.js");
		const dir = mkdtempSync(join(tmpdir(), "cc-regret-"));
		const path = join(dir, "regret.json");
		try {
			// Six runs ten minutes apart, with the clock going backwards — a
			// timezone-naive restore, an NTP correction, a VM resume. A negative delta
			// satisfies `<= window`, so every run read as a fast re-run: five
			// fabricated regrets and a persistent downgrade off `aggressive`.
			let now = 5_000_000_000;
			let downgraded = false;
			for (let i = 0; i < 6; i++) {
				const decision = observeAndAdjust("fp-clock", "aggressive", { path, now });
				if (decision.adjusted) downgraded = true;
				now -= 10 * 60 * 1000;
			}
			assert.ok(!downgraded, "a backwards clock downgraded the mode");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("a lone error keeps the line above it", () => {
	it("groups only what repeats", () => {
		// Moving every matched line to a trailing block separated four distinct Jest
		// failures from the `●` names directly above them, to save four lines. The
		// fixture needs enough real repetition for grouping to be worth applying at
		// all, or the size guard returns the input and the placement is never tested.
		const singles = [
			"● a › one",
			"  error: alpha assertion failed in module one",
			"● b › two",
			"  error: beta assertion failed in module two",
			"● c › three",
			"  error: gamma assertion failed in module three",
			"● d › four",
			"  error: delta assertion failed in module four",
		];
		const repeats = Array.from(
			{ length: 40 },
			() => "  warning: deprecated API used in a very long message line here",
		);
		const out = groupErrorLines([...singles, ...repeats, ""].join("\n"));

		assert.ok(out.includes("Grouped errors/warnings"), "grouping did not apply to the fixture");
		assert.match(out, /one[\s\S]{0,70}alpha assertion/, "a failure was separated from its error");
		assert.match(out, /four[\s\S]{0,70}delta assertion/, "a failure was separated from its error");
		assert.match(out, /×40/, "the repetition was not collapsed");
	});

	it("never returns more than it was given", () => {
		// The guard counted lines while its comment claimed to measure output: four
		// copies of a five-character error grew 38 bytes into 75.
		const input = [...Array.from({ length: 4 }, () => "ERR x"), "f1", "f2", "f3", "f4", "f5"].join(
			"\n",
		);
		const out = groupErrorLines(input);
		assert.ok(
			Buffer.byteLength(out) <= Buffer.byteLength(input),
			`grouping grew ${Buffer.byteLength(input)} bytes into ${Buffer.byteLength(out)}`,
		);
	});
});

describe("doctor checks the hook that will actually run", () => {
	it("reports a configured path that does not exist", () => {
		// The integrity check hashed doctor's own bundled copy, never the path
		// settings.json points at, and check 3 was a string predicate that never
		// stats the file. Any change of global prefix — an nvm bump, a reinstall to
		// a different root — left a dead path reported as "All checks passed".
		const home = mkdtempSync(join(tmpdir(), "cc-doctor-"));
		try {
			mkdirSync(join(home, ".claude"), { recursive: true });
			writeFileSync(
				join(home, ".claude", "settings.json"),
				JSON.stringify({
					hooks: {
						PreToolUse: [
							{
								matcher: "Bash",
								hooks: [
									{
										type: "command",
										command: "node /nonexistent/context-compress/hooks/pretooluse.mjs",
									},
								],
							},
						],
					},
				}),
			);
			const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "doctor"], {
				encoding: "utf-8",
				cwd: process.cwd(),
				env: { ...process.env, HOME: home },
				timeout: 60_000,
			});
			assert.match(r.stdout, /Hook script not found at \/nonexistent/, r.stdout);
			assert.ok(!/All checks passed/.test(r.stdout), "a dead hook path passed every check");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("every restricted key has an environment override", () => {
	it("honours CONTEXT_COMPRESS_MAX_INDEXED_SOURCES", () => {
		// The key is refused from a project file, so the environment was the only way
		// to set it — and there was no variable for it, while the README promised one
		// for every server setting.
		const previous = process.env.CONTEXT_COMPRESS_MAX_INDEXED_SOURCES;
		try {
			process.env.CONTEXT_COMPRESS_MAX_INDEXED_SOURCES = "42";
			resetConfig();
			assert.strictEqual(loadConfig().maxIndexedSources, 42);
		} finally {
			if (previous === undefined) delete process.env.CONTEXT_COMPRESS_MAX_INDEXED_SOURCES;
			else process.env.CONTEXT_COMPRESS_MAX_INDEXED_SOURCES = previous;
			resetConfig();
		}
	});
});
