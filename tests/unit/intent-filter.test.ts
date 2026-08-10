import assert from "node:assert";
import { describe, it } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Config, loadConfig, resetConfig } from "../../src/config.js";
import type { SubprocessExecutor } from "../../src/executor.js";
import { SessionTracker } from "../../src/stats.js";
import { ContentStore } from "../../src/store.js";
import type { ToolContext } from "../../src/tools/context.js";
import { registerExecuteTool } from "../../src/tools/execute.js";
import { registerExecuteFileTool } from "../../src/tools/execute-file.js";
import type { ExecResult } from "../../src/types.js";
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

type ToolHandler = (args: Record<string, unknown>) => Promise<{
	content: Array<{ type: string; text: string }>;
}>;

function captureHandler(
	register: (server: McpServer, ctx: ToolContext) => void,
	ctx: ToolContext,
): ToolHandler {
	let handler: ToolHandler | undefined;
	const server = {
		registerTool(_name: unknown, _definition: unknown, callback: ToolHandler) {
			handler = callback;
		},
	} as unknown as McpServer;
	register(server, ctx);
	assert.ok(handler, "tool handler must be registered");
	return handler;
}

function makeToolContext(result: ExecResult): { ctx: ToolContext; store: ContentStore } {
	resetConfig();
	const config = {
		...loadConfig(),
		intentSearchThreshold: 1_000,
		intentBudgetBytes: 1_200,
	};
	const store = new ContentStore(":memory:");
	const tracker = new SessionTracker();
	const executor = {
		execute: async () => result,
		executeFile: async () => result,
	} as unknown as SubprocessExecutor;
	return {
		store,
		ctx: {
			config,
			store,
			tracker,
			executor,
			projectDir: process.cwd(),
			bunDetected: false,
			dbFallback: false,
			withExecutionLimit: (fn) => fn(),
			applyIntentFilter: createIntentFilter({ config, store, tracker }),
		},
	};
}

function corpusWithHiddenSentinel(sentinel: string): string {
	return `# Visible summary\n\n${"passing checks remain visible. ".repeat(80)}\n\n## Hidden detail\n\n${sentinel} is searchable.`;
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

	it("execute tools index pre-filter stdout while returning a compressed response", async () => {
		const cases = [
			{
				name: "execute",
				register: registerExecuteTool,
				sentinel: "rpfhiddenexecsentinel",
				args: { language: "shell", code: "ignored", intent: "passing checks", timeout: 1_000 },
			},
			{
				name: "execute_file",
				register: registerExecuteFileTool,
				sentinel: "rpfhiddenfilesentinel",
				args: {
					path: "fixture.txt",
					language: "shell",
					code: "ignored",
					intent: "passing checks",
					timeout: 1_000,
				},
			},
		] as const;

		for (const testCase of cases) {
			const result: ExecResult = {
				indexableStdout: corpusWithHiddenSentinel(testCase.sentinel),
				stdout: "Tests: 1 passed",
				stderr: "",
				exitCode: 0,
				truncated: false,
				killed: false,
			};
			const { ctx, store } = makeToolContext(result);
			try {
				const handler = captureHandler(testCase.register, ctx);
				const response = await handler(testCase.args);
				const text = response.content[0].text;
				assert.ok(!text.includes(testCase.sentinel), `${testCase.name} response stays compact`);
				assert.ok(
					store.search(testCase.sentinel).results.length > 0,
					`${testCase.name} indexes content removed from its response`,
				);
			} finally {
				store.close();
			}
		}
	});
});
