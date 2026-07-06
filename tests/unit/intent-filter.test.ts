import assert from "node:assert";
import { describe, it } from "node:test";
import { type Config, loadConfig, resetConfig } from "../../src/config.js";
import { SessionTracker } from "../../src/stats.js";
import { ContentStore } from "../../src/store.js";
import { createIntentFilter } from "../../src/util/intent-filter.js";

function makeFilter(overrides: Partial<Config> = {}) {
	resetConfig();
	const config = { ...loadConfig(), ...overrides };
	const store = new ContentStore(":memory:");
	const tracker = new SessionTracker();
	const applyIntentFilter = createIntentFilter({ config, store, tracker });
	return { applyIntentFilter, store, config };
}

/** Build a large markdown doc with many titled sections so indexing has work. */
function bigDoc(): string {
	const sections = Array.from(
		{ length: 30 },
		(_, i) =>
			`## Section ${i}\n${"lorem ipsum dolor sit amet ".repeat(20)}\nkeyword_${i} details here.\n`,
	);
	// A section that clearly matches the intent "timeout".
	sections.push(
		`## Networking\nThe request failed with a timeout after 30s connecting to the upstream service. Retry with backoff.\n`,
	);
	return `# Report\n\n${sections.join("\n")}`;
}

describe("intent filter (query-conditioned)", () => {
	it("returns small output unchanged", () => {
		const { applyIntentFilter, store } = makeFilter({ intentSearchThreshold: 5_000 });
		try {
			const out = applyIntentFilter("short output", "cmd", "src");
			assert.equal(out, "short output");
		} finally {
			store.close();
		}
	});

	it("inlines query-ranked content and stays within the byte budget", () => {
		const { applyIntentFilter, store } = makeFilter({
			intentSearchThreshold: 1_000,
			intentBudgetBytes: 1_200,
		});
		try {
			const doc = bigDoc();
			const out = applyIntentFilter(doc, "timeout", "execute:shell");
			assert.ok(out.includes("Indexed"), "reports indexing");
			assert.ok(out.includes("timeout"), "surfaces the matching section content");
			assert.ok(out.includes("Use search(queries: [...])"), "keeps the search affordance");
			// Compression achieved: summary far smaller than the source doc.
			assert.ok(out.length < doc.length, "summary is smaller than input");
		} finally {
			store.close();
		}
	});

	it("surfaces error/warning lines verbatim as a safety net", () => {
		const { applyIntentFilter, store } = makeFilter({
			intentSearchThreshold: 1_000,
			intentBudgetBytes: 1_200,
		});
		try {
			const doc = `${bigDoc()}\nFATAL: database connection refused on host db-primary\n`;
			const out = applyIntentFilter(doc, "section 3", "execute:shell");
			assert.ok(
				out.includes("FATAL: database connection refused on host db-primary"),
				"error line must survive even when the intent points elsewhere",
			);
			assert.ok(out.includes("error/warning line"), "labels the error section");
		} finally {
			store.close();
		}
	});

	it("respects a zero budget by listing titles only", () => {
		const { applyIntentFilter, store } = makeFilter({
			intentSearchThreshold: 1_000,
			intentBudgetBytes: 0,
		});
		try {
			const out = applyIntentFilter(bigDoc(), "timeout", "execute:shell");
			assert.ok(out.includes("(search to view)"), "falls back to title-only listing");
		} finally {
			store.close();
		}
	});
});
