import assert from "node:assert";
import { describe, it } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/tools/context.js";
import { registerSearchTool } from "../../src/tools/search.js";

interface SearchToolOptions {
	inputSchema: {
		limit: {
			safeParse(value: unknown): { success: boolean };
		};
	};
}

type SearchToolHandler = (args: {
	queries: string[];
	source?: string;
	limit: number;
}) => Promise<{ content: Array<{ type: string; text: string }> }>;

function registerForTest(searchLimit = 3): {
	options: SearchToolOptions;
	handler: SearchToolHandler;
	seenLimits: number[];
} {
	let options: SearchToolOptions | undefined;
	let handler: SearchToolHandler | undefined;
	const seenLimits: number[] = [];

	const server = {
		registerTool(
			_name: string,
			registeredOptions: SearchToolOptions,
			registeredHandler: SearchToolHandler,
		): void {
			options = registeredOptions;
			handler = registeredHandler;
		},
	} as unknown as McpServer;

	const ctx = {
		config: {
			searchLimit,
			searchWindowMs: 60_000,
			searchReduceAfter: 100,
			searchBlockAfter: 101,
			searchMaxBytes: 40_960,
		},
		store: {
			search(query: string, searchOptions?: { limit?: number }) {
				const limit = searchOptions?.limit ?? 3;
				seenLimits.push(limit);
				return {
					query,
					results: Array.from({ length: limit }, (_, index) => ({
						title: `result ${index + 1}`,
						snippet: "snippet",
						source: "test",
						score: 1,
					})),
				};
			},
		},
		tracker: { trackCall(): void {} },
	} as unknown as ToolContext;

	registerSearchTool(server, ctx);
	assert.ok(options);
	assert.ok(handler);
	return { options, handler, seenLimits };
}

describe("search tool limit", () => {
	it("rejects non-positive and fractional limits in the input schema", () => {
		const { options } = registerForTest();
		const schema = options.inputSchema.limit;

		for (const invalid of [-1, 0, 1.5]) {
			assert.strictEqual(schema.safeParse(invalid).success, false, `${invalid} must be rejected`);
		}
		assert.strictEqual(schema.safeParse(1).success, true);
	});

	it("defensively clamps direct handler limits to the configured range", async () => {
		const low = registerForTest(4);
		await low.handler({ queries: ["low"], limit: 0 });
		assert.deepStrictEqual(low.seenLimits, [1]);

		const high = registerForTest(4);
		const response = await high.handler({ queries: ["high"], limit: 99 });
		assert.deepStrictEqual(high.seenLimits, [4]);
		assert.strictEqual(response.content[0].text.match(/^### result /gm)?.length, 4);
	});
});
