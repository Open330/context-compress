import assert from "node:assert";
import { describe, it } from "node:test";
import {
	extractSnippet,
	positionsFromHighlight,
	stripMarkers,
} from "../../src/snippet.js";

const STX = "\x02";
const ETX = "\x03";

describe("snippet", () => {
	it("positionsFromHighlight returns empty array for empty input", () => {
		assert.deepStrictEqual(positionsFromHighlight(""), []);
	});

	it("positionsFromHighlight returns offsets from highlighted text", () => {
		const highlighted = `abc ${STX}def${ETX} ghi ${STX}j${ETX}`;
		assert.deepStrictEqual(positionsFromHighlight(highlighted), [4, 12]);
	});

	it("stripMarkers removes STX/ETX markers", () => {
		const input = `left ${STX}middle${ETX} right`;
		assert.strictEqual(stripMarkers(input), "left middle right");
	});

	it("stripMarkers returns clean text unchanged", () => {
		const input = "already clean text";
		assert.strictEqual(stripMarkers(input), input);
	});

	it("extractSnippet returns short text as-is", () => {
		const input = `hello ${STX}world${ETX}`;
		assert.strictEqual(extractSnippet(input), "hello world");
	});

	it("extractSnippet extracts windows around distant highlights in long text", () => {
		const highlighted =
			`${"a".repeat(500)}${STX}ALPHA${ETX}${"b".repeat(800)}${STX}BETA${ETX}${"c".repeat(500)}`;
		const snippet = extractSnippet(highlighted);

		assert.ok(snippet.startsWith("…"));
		assert.ok(snippet.endsWith("…"));
		assert.ok(snippet.includes("ALPHA"));
		assert.ok(snippet.includes("BETA"));
		assert.ok(snippet.includes("\n\n"));
		assert.ok(!snippet.includes(STX));
		assert.ok(!snippet.includes(ETX));
	});

	it("extractSnippet returns original text when there are no highlights", () => {
		const input = "x".repeat(2000);
		assert.strictEqual(extractSnippet(input, 10), input);
	});

	it("extractSnippet never returns empty for densely matched text", () => {
		// Matches closer together than the 300-char window merge into ONE span far
		// wider than maxLen. Dropping that span instead of clipping it returned "",
		// so the best-ranked hits — the ones with the most matches — arrived with no
		// content at all.
		const dense = Array.from(
			{ length: 20 },
			(_, i) => `${"pad ".repeat(50)}${STX}needle${ETX} ${i}`,
		).join(" ");

		const snippet = extractSnippet(dense);

		assert.notStrictEqual(snippet, "", "a densely matched chunk must still produce content");
		assert.ok(snippet.includes("needle"), "the match itself must be present");
		assert.ok(snippet.endsWith("…"), "clipping must be marked");
		assert.ok(!snippet.includes(STX) && !snippet.includes(ETX));
	});

	it("extractSnippet respects maxLen while staying non-empty", () => {
		const dense = Array.from({ length: 30 }, () => `${"x".repeat(80)}${STX}hit${ETX}`).join("");

		for (const maxLen of [1, 50, 200, 1500]) {
			const snippet = extractSnippet(dense, maxLen);
			assert.notStrictEqual(snippet, "", `maxLen ${maxLen} produced an empty snippet`);
			// The ellipsis markers are added after clipping, so allow a small margin.
			assert.ok(
				snippet.length <= maxLen + 2,
				`maxLen ${maxLen} produced ${snippet.length} chars`,
			);
		}
	});
});
