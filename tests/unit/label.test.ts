import assert from "node:assert";
import { describe, it } from "node:test";
import { compactLabel } from "../../src/util/label.js";

const SAMPLE = `Indexed 5 sections from execute:javascript.
2 sections matched "errors":

  - **Connection failure**: timeout after 30s
  - **Auth failed**: 401 Unauthorized

Searchable terms: timeout, retry, connection
Use search(queries: [...]) to retrieve full content of any section.`;

describe("compactLabel", () => {
	it("returns input unchanged at the 'normal' level", () => {
		const out = compactLabel(SAMPLE, "normal");
		assert.strictEqual(out, SAMPLE);
	});

	it("rewrites the search hint at the 'compact' level", () => {
		const out = compactLabel(SAMPLE, "compact");
		assert.ok(out.includes("→ search() for details"));
		assert.ok(!out.includes("Use search(queries: [...]) to retrieve full content"));
	});

	it("strips markdown bold and shortens hints at the 'ultra' level", () => {
		const out = compactLabel(SAMPLE, "ultra");
		assert.ok(!out.includes("**"));
		assert.ok(out.includes("→ search() for more"));
		assert.ok(!out.match(/^Searchable terms:/m));
	});

	it("compact preserves searchable-terms line", () => {
		const out = compactLabel(SAMPLE, "compact");
		assert.ok(out.includes("Searchable terms:"));
	});
});
