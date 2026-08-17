import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

	it("reopens the trigram index without duplicate backfill and indexes new chunks", () => {
		const dir = mkdtempSync(join(tmpdir(), "cc-store-"));
		const dbPath = join(dir, "store.db");
		let store: ContentStore | undefined;

		try {
			store = new ContentStore(dbPath);
			store.index("JavaScript runtime behavior and tooling details.", "runtime");
			const initialResults = store.search("javscript", { limit: 10 });
			const initialStats = store.getStats();

			assert.ok(initialResults.results.length > 0);
			assert.strictEqual(initialStats.hasTrigramTable, true);
			store.close();

			store = new ContentStore(dbPath);
			assert.deepStrictEqual(store.getStats(), initialStats);
			assert.strictEqual(
				store.search("javscript", { limit: 10 }).results.length,
				initialResults.results.length,
			);

			store.index("TypeScript compiler optimization and diagnostics.", "compiler");
			assert.ok(store.search("typescrpt", { limit: 10 }).results.length > 0);
			assert.strictEqual(store.getStats().totalChunks, initialStats.totalChunks + 1);
		} finally {
			store?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates default databases in private random directories and removes them on close", {
		skip: process.platform === "win32",
	}, () => {
		const first = new ContentStore();
		const second = new ContentStore();
		const firstPath = (first as unknown as { db: { name: string } }).db.name;
		const secondPath = (second as unknown as { db: { name: string } }).db.name;
		const firstDir = dirname(firstPath);
		const secondDir = dirname(secondPath);

		try {
			assert.strictEqual(basename(firstPath), "store.db");
			assert.notStrictEqual(firstDir, secondDir);
			assert.notStrictEqual(firstPath, join(tmpdir(), `context-compress-${process.pid}.db`));
			assert.strictEqual(statSync(firstDir).mode & 0o777, 0o700);
			assert.strictEqual(statSync(secondDir).mode & 0o777, 0o700);
			assert.ok(existsSync(firstPath));
			assert.ok(existsSync(secondPath));
		} finally {
			first.close();
			second.close();
		}

		assert.strictEqual(existsSync(firstDir), false);
		assert.strictEqual(existsSync(secondDir), false);
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

	it("search with special-character-only query returns empty results", () => {
		const store = new ContentStore(":memory:");
		try {
			store.index("Some regular content to index for searching.", "test-source");
			const result = store.search("***###!!!");
			assert.strictEqual(result.results.length, 0);
		} finally {
			store.close();
		}
	});

	it("search with empty string returns empty results", () => {
		const store = new ContentStore(":memory:");
		try {
			store.index("Some content here.", "test-source");
			const result = store.search("");
			assert.strictEqual(result.results.length, 0);
		} finally {
			store.close();
		}
	});

	it("scopes search to exact source ids", () => {
		const store = new ContentStore(":memory:");
		try {
			const first = store.index("rpfscopedsentinel alpha body", "batch_execute");
			const second = store.index("rpfotherscoped beta body", "batch_execute");

			// Both share a label, so the label filter cannot separate them.
			assert.ok(store.search("rpfscopedsentinel", { source: "batch_execute" }).results.length > 0);

			assert.strictEqual(
				store.search("rpfscopedsentinel", { sourceIds: [second.sourceId] }).results.length,
				0,
				"an id scope must exclude other sources with the same label",
			);
			assert.ok(store.search("rpfscopedsentinel", { sourceIds: [first.sourceId] }).results.length > 0);
			assert.ok(
				store.search("rpfscopedsentinel", { sourceIds: [first.sourceId, second.sourceId] }).results
					.length > 0,
			);
		} finally {
			store.close();
		}
	});

	it("treats an empty source-id scope as matching nothing", () => {
		const store = new ContentStore(":memory:");
		try {
			store.index("rpfemptyscopesentinel body", "batch_execute");
			assert.ok(store.search("rpfemptyscopesentinel").results.length > 0);
			assert.strictEqual(
				store.search("rpfemptyscopesentinel", { sourceIds: [] }).results.length,
				0,
				"an empty scope must not silently widen to the whole store",
			);
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
