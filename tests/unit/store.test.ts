import assert from "node:assert";
import { describe, it } from "node:test";
import { ContentStore } from "../../src/store.js";

describe("store", () => {
	it("indexing markdown creates expected chunk and code chunk counts", () => {
		const store = new ContentStore(":memory:");
		try {
			const markdown = `
# Intro
This is intro text.

## Code
\`\`\`js
console.log("hello");
\`\`\`

## Wrap Up
Final notes.
`.trim();

			const result = store.index(markdown, "guide.md");
			assert.strictEqual(result.totalChunks, 3);
			assert.strictEqual(result.codeChunks, 1);
		} finally {
			store.close();
		}
	});

	it("search finds indexed content and returns empty for non-matches", () => {
		const store = new ContentStore(":memory:");
		try {
			store.index("Context compression supports semantic search and indexing.", "notes");
			const found = store.search("semantic");
			const missing = store.search("nonexistent-keyword-xyz");

			assert.ok(found.results.length > 0);
			assert.strictEqual(missing.results.length, 0);
		} finally {
			store.close();
		}
	});

	it("search returns results for slight misspellings", () => {
		const store = new ContentStore(":memory:");
		try {
			store.index("JavaScript runtime behavior and tooling details.", "runtime");
			const result = store.search("javscript");
			assert.ok(result.results.length > 0);
		} finally {
			store.close();
		}
	});

	it("getDistinctiveTerms returns strings and excludes stopwords", () => {
		const store = new ContentStore(":memory:");
		try {
			const markdown = `
# One
the quasar_token appears here

# Two
quasar_token appears again in this section

# Three
just filler text only

# Four
quasar_token and sigma_index are both present

# Five
more filler content
`.trim();

			store.index(markdown, "terms.md");
			const terms = store.getDistinctiveTerms();

			assert.ok(Array.isArray(terms));
			assert.ok(terms.every((term) => typeof term === "string"));
			assert.ok(terms.includes("quasar_token"));
			assert.ok(!terms.includes("the"));
		} finally {
			store.close();
		}
	});

	it("getStats reports source and chunk totals after indexing", () => {
		const store = new ContentStore(":memory:");
		try {
			store.index("first content block", "a.txt");
			store.index("second content block", "b.txt");

			const stats = store.getStats();
			assert.strictEqual(stats.totalSources, 2);
			assert.strictEqual(stats.totalChunks, 2);
			assert.ok(stats.vocabularySize > 0);
		} finally {
			store.close();
		}
	});
});
