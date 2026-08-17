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
		queries: {
			safeParse(value: unknown): { success: boolean };
		};
	};
}

type SearchToolHandler = (args: {
	queries: string[];
	source?: string;
	limit: number;
}) => Promise<{ content: Array<{ type: string; text: string }> }>;

function registerForTest(
	searchLimit = 3,
	overrides: {
		searchMaxBytes?: number;
		snippet?: string;
		searchReduceAfter?: number;
		searchBlockAfter?: number;
		searchWindowMs?: number;
	} = {},
): {
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
			searchWindowMs: overrides.searchWindowMs ?? 60_000,
			searchReduceAfter: overrides.searchReduceAfter ?? 100,
			searchBlockAfter: overrides.searchBlockAfter ?? 101,
			searchMaxBytes: overrides.searchMaxBytes ?? 40_960,
		},
		store: {
			search(query: string, searchOptions?: { limit?: number }) {
				const limit = searchOptions?.limit ?? 3;
				seenLimits.push(limit);
				return {
					query,
					results: Array.from({ length: limit }, (_, index) => ({
						title: `result ${index + 1}`,
						snippet: overrides.snippet ?? "snippet",
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

	it("rejects a pathological query count in the input schema", () => {
		const schema = registerForTest().options.inputSchema.queries;
		assert.strictEqual(schema.safeParse(Array(16).fill("q")).success, true);
		assert.strictEqual(schema.safeParse(Array(17).fill("q")).success, false);
	});
});

describe("search tool throttle", () => {
	it("recovers after the window instead of latching, and gives actionable advice", async () => {
		// Blocked attempts used to be counted before the check, so a caller retrying
		// faster than the window never fell back under the limit. The refusal also
		// advised batch_execute, which rejects an empty `commands` array.
		const { handler } = registerForTest(3, { searchBlockAfter: 2, searchWindowMs: 50 });

		await handler({ queries: ["a"], limit: 1 });
		await handler({ queries: ["b"], limit: 1 });
		const blocked = await handler({ queries: ["c"], limit: 1 });
		assert.match(blocked.content[0].text, /Too many search calls/);
		assert.match(blocked.content[0].text, /Retry in \d+s/, "must say how long to wait");
		assert.match(blocked.content[0].text, /ONE call/, "must give a remedy that validates");

		// Hammering while blocked must not extend the block.
		for (let i = 0; i < 5; i++) await handler({ queries: ["d"], limit: 1 });

		await new Promise((resolve) => setTimeout(resolve, 80));
		const recovered = await handler({ queries: ["e"], limit: 1 });
		assert.doesNotMatch(
			recovered.content[0].text,
			/Too many search calls/,
			"the throttle must lift once the window has passed",
		);
	});
});

describe("search tool response byte budget", () => {
	it("never exceeds searchMaxBytes and marks what it dropped", async () => {
		// Ten queries each returning a 2 KiB snippet against a 1 KiB budget: the
		// pre-check-then-append loop used to emit the first oversized block whole.
		const { handler } = registerForTest(3, {
			searchMaxBytes: 1_024,
			snippet: "x".repeat(2_048),
		});
		const text = (await handler({ queries: Array.from({ length: 10 }, (_, i) => `q${i}`), limit: 3 }))
			.content[0].text;

		assert.ok(
			Buffer.byteLength(text, "utf8") <= 1_024,
			`response was ${Buffer.byteLength(text, "utf8")} bytes, budget is 1024`,
		);
		assert.match(text, /omitted|truncated/, "dropping content must be stated, not silent");
	});

	it("counts bytes, not characters, for multi-byte snippets", async () => {
		// "가" is 3 UTF-8 bytes; a character-counted budget passes here and ships ~3x.
		const { handler } = registerForTest(3, {
			searchMaxBytes: 900,
			snippet: "가".repeat(600),
		});
		const text = (await handler({ queries: ["q1", "q2", "q3"], limit: 3 })).content[0].text;

		assert.ok(
			Buffer.byteLength(text, "utf8") <= 900,
			`response was ${Buffer.byteLength(text, "utf8")} bytes, budget is 900`,
		);
		assert.ok(!text.includes("�"), "byte truncation must not split a multi-byte character");
	});

	it("keeps the rate-limit notice inside the budget", async () => {
		const { handler } = registerForTest(3, {
			searchMaxBytes: 700,
			snippet: "y".repeat(1_024),
			searchReduceAfter: 0,
		});
		const text = (await handler({ queries: ["q1", "q2"], limit: 3 })).content[0].text;

		assert.ok(Buffer.byteLength(text, "utf8") <= 700);
		assert.match(text, /Search rate limited/);
	});
});
