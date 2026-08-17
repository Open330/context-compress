import assert from "node:assert";
import { before, describe, it } from "node:test";
import { CORPUS, runCase } from "../../src/bench/quality.js";

describe("quality-regression benchmark", () => {
	it("has a corpus to measure", () => {
		assert.ok(CORPUS.length > 0, "an empty corpus would make every test below vacuous");
	});

	for (const c of CORPUS) {
		describe(c.name, () => {
			// Computed lazily inside the tests: running it at describe-registration
			// time meant a throw aborted file collection instead of failing a test.
			let result: ReturnType<typeof runCase>;
			before(() => {
				result = runCase(c);
			});
			const floor = c.minSurvival ?? 1.0;

			for (const mode of ["conservative", "balanced", "aggressive"] as const) {
				it(`${mode}: task-critical info survives (>= ${floor * 100}%)`, () => {
					const m = result.modes.find((entry) => entry.mode === mode);
					// Asserting presence matters: iterating result.modes generated no test
					// at all for a mode that went missing.
					assert.ok(m, `no result for ${mode}`);
					assert.ok(
						m.survival >= floor,
						`survival ${(m.survival * 100).toFixed(0)}% < ${floor * 100}% — missing: ${m.missing.join(", ")}`,
					);
				});
			}

			if (c.balancedKeepsValidJson) {
				// Previously this test was generated for every case with its whole body
				// inside the `if`, so three of four could never fail.
				it("balanced keeps JSON valid", () => {
					const balanced = result.modes.find((m) => m.mode === "balanced");
					assert.equal(balanced?.validJson, true, "balanced-mode JSON must remain parseable");
				});
			}

			it("aggressive is never larger than conservative", () => {
				const conservative = result.modes.find((m) => m.mode === "conservative");
				const aggressive = result.modes.find((m) => m.mode === "aggressive");
				assert.ok(conservative && aggressive, "both modes must produce a result");
				// `?? 0` on both sides used to make a missing result pass as 0 <= 0.
				assert.ok(
					aggressive.afterBytes <= conservative.afterBytes,
					`aggressive ${aggressive.afterBytes}B > conservative ${conservative.afterBytes}B`,
				);
			});
		});
	}

	it("actually compresses something across the corpus", () => {
		// The per-case assertion above is satisfied by identity (0% reduction on
		// every mode), so the harness that exists to prove compression could pass
		// while compressing nothing. At least one case must show real reduction.
		const reductions = CORPUS.flatMap((c) =>
			runCase(c)
				.modes.filter((m) => m.mode !== "conservative")
				.map((m) => 1 - m.afterBytes / m.beforeBytes),
		);
		const best = Math.max(...reductions);
		assert.ok(best > 0.2, `best non-conservative reduction was ${(best * 100).toFixed(0)}%`);
	});
});
