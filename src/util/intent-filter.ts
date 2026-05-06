import type { Config } from "../config.js";
import type { SessionTracker } from "../stats.js";
import type { ContentStore } from "../store.js";
import { compactLabel } from "./label.js";

interface IntentFilterDeps {
	config: Config;
	store: ContentStore;
	tracker: SessionTracker;
}

/**
 * Index large output and return a compact summary keyed to `intent`.
 * For small output (<= config.intentSearchThreshold bytes), returns the
 * original output unchanged so callers don't pay for trivial filtering.
 */
export function createIntentFilter(deps: IntentFilterDeps) {
	const { config, store, tracker } = deps;

	return function applyIntentFilter(output: string, intent: string, sourceLabel: string): string {
		if (Buffer.byteLength(output) <= config.intentSearchThreshold) return output;

		const indexed = store.index(output, sourceLabel);
		tracker.trackIndexed(Buffer.byteLength(output));

		const searchResults = store.search(intent, { limit: 3 });
		const terms = store.getDistinctiveTerms(indexed.sourceId);

		let filtered = `Indexed ${indexed.totalChunks} sections from ${sourceLabel}.\n`;
		filtered += `${searchResults.results.length} sections matched "${intent}":\n\n`;
		for (const hit of searchResults.results) {
			filtered += `  - **${hit.title}**: ${hit.snippet.slice(0, 200)}\n`;
		}
		if (terms.length > 0 && config.compressionLevel !== "ultra") {
			filtered += `\nSearchable terms: ${terms.join(", ")}\n`;
		}
		filtered += "\nUse search(queries: [...]) to retrieve full content of any section.";
		return compactLabel(filtered, config.compressionLevel);
	};
}

export type ApplyIntentFilter = ReturnType<typeof createIntentFilter>;
