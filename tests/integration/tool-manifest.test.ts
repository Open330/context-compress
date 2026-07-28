import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, resetConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

const ORIGINAL_HOME = process.env.HOME;

const EXPECTED_TOOLS = [
	"execute",
	"execute_file",
	"index",
	"search",
	"fetch_and_index",
	"batch_execute",
	"stats",
	"discover",
] as const;

/** Tools that must never be advertised as safe reads — they run arbitrary code. */
const CODE_EXECUTING_TOOLS = new Set(["execute", "execute_file", "batch_execute"]);
/** Tools that must never be advertised as reaching the network. */
const LOCAL_ONLY_TOOLS = new Set(["index", "search", "stats", "discover"]);

async function connect() {
	resetConfig();
	const config = loadConfig();
	const instance = await createServer(config);
	const client = new Client({ name: "tool-manifest-test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([
		instance.server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return { client, instance };
}

describe("integration: advertised tool manifest", () => {
	beforeEach(() => {
		resetConfig();
		process.env.HOME = `/tmp/context-compress-home-${process.pid}-${Date.now()}`;
	});

	afterEach(() => {
		resetConfig();
		if (ORIGINAL_HOME === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = ORIGINAL_HOME;
		}
	});

	it("advertises every tool with a title, description, and behavior annotations", async () => {
		const { client, instance } = await connect();
		try {
			const { tools } = await client.listTools();
			const byName = new Map(tools.map((tool) => [tool.name, tool]));

			assert.deepStrictEqual(
				[...byName.keys()].sort(),
				[...EXPECTED_TOOLS].sort(),
				"advertised tool set drifted from the documented eight",
			);

			for (const name of EXPECTED_TOOLS) {
				const tool = byName.get(name);
				assert.ok(tool, `${name} must be registered`);
				// `title` and `annotations` only reach the client through
				// registerTool(); the deprecated tool() overloads drop them.
				assert.ok(tool.title, `${name} must advertise a human-readable title`);
				assert.ok(tool.description, `${name} must advertise a description`);
				assert.ok(tool.annotations, `${name} must advertise behavior annotations`);

				const { readOnlyHint, destructiveHint, openWorldHint } = tool.annotations;
				assert.strictEqual(
					typeof readOnlyHint,
					"boolean",
					`${name} must declare readOnlyHint`,
				);
				assert.strictEqual(
					typeof destructiveHint,
					"boolean",
					`${name} must declare destructiveHint`,
				);
				assert.strictEqual(
					typeof openWorldHint,
					"boolean",
					`${name} must declare openWorldHint`,
				);

				if (CODE_EXECUTING_TOOLS.has(name)) {
					assert.strictEqual(readOnlyHint, false, `${name} runs arbitrary code`);
					assert.strictEqual(destructiveHint, true, `${name} runs arbitrary code`);
					assert.strictEqual(openWorldHint, true, `${name} runs arbitrary code`);
				}
				if (LOCAL_ONLY_TOOLS.has(name)) {
					assert.strictEqual(openWorldHint, false, `${name} never touches the network`);
				}
			}
		} finally {
			await client.close();
			instance.shutdown();
		}
	});

	it("keeps responses text-only so structured duplicates cannot double token cost", async () => {
		const { client, instance } = await connect();
		try {
			const { tools } = await client.listTools();
			for (const tool of tools) {
				// An outputSchema obliges the server to send structuredContent AND a
				// serialized text copy for backwards compatibility — the same payload
				// billed twice, which defeats the point of this server.
				assert.strictEqual(
					tool.outputSchema,
					undefined,
					`${tool.name} must not declare an outputSchema`,
				);
			}

			const result = await client.callTool({ name: "stats", arguments: {} });
			assert.strictEqual(
				(result as { structuredContent?: unknown }).structuredContent,
				undefined,
			);
			const content = (result as { content: Array<{ type: string; text?: string }> }).content;
			assert.strictEqual(content[0].type, "text");
			assert.match(content[0].text ?? "", /[Ss]ession/);
		} finally {
			await client.close();
			instance.shutdown();
		}
	});
});
