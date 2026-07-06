import assert from "node:assert";
import { describe, it } from "node:test";
import { CORPUS, runCase } from "../../src/bench/quality.js";

describe("quality-regression benchmark", () => {
	for (const c of CORPUS) {
		describe(c.name, () => {
			const result = runCase(c);
			const floor = c.minSurvival ?? 1.0;

			for (const m of result.modes) {
				it(`${m.mode}: task-critical info survives (>= ${floor * 100}%)`, () => {
					assert.ok(
						m.survival >= floor,
						`survival ${(m.survival * 100).toFixed(0)}% < ${floor * 100}% — missing: ${m.missing.join(", ")}`,
					);
				});
			}

			it("balanced keeps JSON valid when required", () => {
				const balanced = result.modes.find((m) => m.mode === "balanced");
				if (c.balancedKeepsValidJson) {
					assert.equal(balanced?.validJson, true, "balanced-mode JSON must remain parseable");
				}
			});

			it("compresses (aggressive reduces size vs conservative)", () => {
				const conservative = result.modes.find((m) => m.mode === "conservative");
				const aggressive = result.modes.find((m) => m.mode === "aggressive");
				assert.ok(
					(aggressive?.afterBytes ?? 0) <= (conservative?.afterBytes ?? 0),
					"aggressive should not be larger than conservative",
				);
			});
		});
	}
});
