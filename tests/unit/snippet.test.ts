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
});
