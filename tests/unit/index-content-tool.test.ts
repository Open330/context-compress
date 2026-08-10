import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/tools/context.js";
import { registerIndexTool } from "../../src/tools/index-content.js";

interface IndexArgs {
	content?: string;
	path?: string;
	source?: string;
}

interface IndexResponse {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}

type IndexHandler = (args: IndexArgs) => Promise<IndexResponse>;

function registerForTest(projectDir: string): {
	handler: IndexHandler;
	inputSchema: { safeParse(value: unknown): { success: boolean } };
	indexed: Array<{ content: string; label: string }>;
} {
	let handler: IndexHandler | undefined;
	let inputSchema: { safeParse(value: unknown): { success: boolean } } | undefined;
	const indexed: Array<{ content: string; label: string }> = [];
	const server = {
		registerTool(
			_name: unknown,
			options: { inputSchema: typeof inputSchema },
			callback: IndexHandler,
		) {
			inputSchema = options.inputSchema;
			handler = callback;
		},
	} as unknown as McpServer;
	const ctx = {
		projectDir,
		store: {
			index(content: string, label: string) {
				indexed.push({ content, label });
				return { totalChunks: 1, codeChunks: 0 };
			},
		},
		tracker: { trackIndexed(): void {}, trackCall(): void {} },
	} as unknown as ToolContext;

	registerIndexTool(server, ctx);
	assert.ok(handler, "index handler must be registered");
	assert.ok(inputSchema, "index input schema must be registered");
	return { handler, inputSchema, indexed };
}

describe("index tool content/path contract", () => {
	it("handles the content-only, path-only, both, and neither cases consistently", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "context-compress-index-tool-"));
		const fixtureName = "fixture.md";
		writeFileSync(join(projectDir, fixtureName), "# From path\n");

		try {
			const { handler, inputSchema, indexed } = registerForTest(projectDir);
			const contentOnly = { content: "", source: "empty input" };
			const pathOnly = { path: fixtureName };
			const both = { content: "", path: fixtureName };
			const neither = {};

			assert.strictEqual(inputSchema.safeParse(contentOnly).success, true);
			assert.strictEqual(inputSchema.safeParse(pathOnly).success, true);
			assert.strictEqual(inputSchema.safeParse(both).success, false);
			assert.strictEqual(inputSchema.safeParse(neither).success, false);

			const bothResponse = await handler(both);
			assert.strictEqual(bothResponse.isError, true);
			assert.strictEqual(bothResponse.content.length, 1);
			assert.match(bothResponse.content[0].text, /exactly one of 'content' or 'path'/i);

			const neitherResponse = await handler(neither);
			assert.strictEqual(neitherResponse.isError, true);
			assert.strictEqual(neitherResponse.content.length, 1);
			assert.match(neitherResponse.content[0].text, /exactly one of 'content' or 'path'/i);
			assert.deepStrictEqual(indexed, []);

			const contentResponse = await handler(contentOnly);
			assert.strictEqual(contentResponse.isError, undefined);
			assert.deepStrictEqual(indexed[0], { content: "", label: "empty input" });

			const pathResponse = await handler(pathOnly);
			assert.strictEqual(pathResponse.isError, undefined);
			assert.deepStrictEqual(indexed[1], {
				content: "# From path\n",
				label: fixtureName,
			});
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});
});
