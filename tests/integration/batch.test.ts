import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, resetConfig } from "../../src/config.js";
import { SubprocessExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime/index.js";
import { SessionTracker } from "../../src/stats.js";
import { ContentStore } from "../../src/store.js";
import { registerBatchExecuteTool } from "../../src/tools/batch-execute.js";
import type { ToolContext } from "../../src/tools/context.js";
import type { ExecResult } from "../../src/types.js";
import { createIntentFilter } from "../../src/util/intent-filter.js";

const ORIGINAL_HOME = process.env.HOME;

function isolateConfigHome(): void {
	process.env.HOME = `/tmp/context-compress-home-${process.pid}-${Date.now()}`;
}

type BatchHandler = (args: {
	commands: Array<{ label: string; command: string }>;
	queries: string[];
	timeout: number;
}) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function captureBatchHandler(ctx: ToolContext): BatchHandler {
	let handler: BatchHandler | undefined;
	const server = {
		registerTool(_name: unknown, _definition: unknown, callback: BatchHandler) {
			handler = callback;
		},
	} as unknown as McpServer;
	registerBatchExecuteTool(server, ctx);
	assert.ok(handler, "batch handler must be registered");
	return handler;
}

function batchCorpus(sentinel: string): string {
	return `# Visible\n\nvisible batch summary\n${"ordinary batch padding line\n".repeat(3_000)}\n## Hidden\n\n${sentinel}`;
}

describe("integration: batch execute flow", () => {
	beforeEach(() => {
		resetConfig();
		isolateConfigHome();
		delete process.env.CONTEXT_COMPRESS_PASSTHROUGH_ENV;
	});

	afterEach(() => {
		resetConfig();
		if (ORIGINAL_HOME === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = ORIGINAL_HOME;
		}
	});

	it(
		"runs multiple shell commands, indexes combined output, and searches each section",
		{ timeout: 20_000 },
		async (t) => {
			const config = loadConfig();
			const runtimes = await detectRuntimes();
			if (!runtimes.has("shell")) {
				t.skip("shell runtime not detected");
			}

			const executor = new SubprocessExecutor(runtimes, config);
			const store = new ContentStore(":memory:");

			try {
				const commands = [
					'echo "section1"',
					'echo "section2"',
					'echo "section3"',
				];

				const results = await Promise.all(
					commands.map((code) =>
						executor.execute({ language: "shell", code, timeout: 10_000 }),
					),
				);

				for (const result of results) {
					assert.strictEqual(result.exitCode, 0);
				}

				const combined = results
					.map(
						(result, index) =>
							`## section${index + 1}\n\n${result.stdout.trim()}\n`,
					)
					.join("\n");

				store.index(combined, "batch_execute");

				assert.ok(store.search("section1").results.length > 0);
				assert.ok(store.search("section2").results.length > 0);
				assert.ok(store.search("section3").results.length > 0);
			} finally {
				store.close();
			}
		},
	);

	it("indexes content beyond per-command and combined response budgets", async () => {
		const config = { ...loadConfig(), batchMaxBytes: 2_000 };
		const store = new ContentStore(":memory:");
		const tracker = new SessionTracker();
		const outputs = new Map<string, ExecResult>([
			[
				"first",
				{
					indexableStdout: batchCorpus("rpfhiddenpercommandsentinel"),
					stdout: "visible first summary",
					stderr: "",
					exitCode: 0,
					truncated: true,
					killed: false,
				},
			],
			[
				"second",
				{
					indexableStdout: batchCorpus("rpfhiddencombinedsentinel"),
					stdout: "visible second summary",
					stderr: "",
					exitCode: null,
					truncated: true,
					killed: true,
				},
			],
		]);
		const executor = {
			execute: async ({ code }: { code: string }) => {
				const result = outputs.get(code);
				assert.ok(result, `missing fake result for ${code}`);
				return result;
			},
		} as unknown as SubprocessExecutor;
		const ctx: ToolContext = {
			config,
			store,
			tracker,
			executor,
			projectDir: process.cwd(),
			bunDetected: false,
			dbFallback: false,
			withExecutionLimit: (fn) => fn(),
			applyIntentFilter: createIntentFilter({ config, store, tracker }),
		};

		try {
			const handler = captureBatchHandler(ctx);
			const response = await handler({
				commands: [
					{ label: "First command", command: "first" },
					{ label: "Second command", command: "second" },
				],
				queries: ["visible batch summary"],
				timeout: 1_000,
			});
			const text = response.content[0].text;
			assert.match(text, /\*\*First command\*\*: 1 lines — truncated \(exit 0\)/);
			assert.match(
				text,
				/\*\*Second command\*\*: 1 lines — killed, truncated \(exit unknown\)/,
			);
			assert.ok(!text.includes("rpfhiddenpercommandsentinel"));
			assert.ok(!text.includes("rpfhiddencombinedsentinel"));
			assert.ok(store.search("rpfhiddenpercommandsentinel").results.length > 0);
			assert.ok(store.search("rpfhiddencombinedsentinel").results.length > 0);
			assert.ok(
				Buffer.byteLength(text) < config.batchMaxBytes + 4_096,
				"indexed corpus size must not expand the public response budget",
			);
		} finally {
			store.close();
		}
	});

	it("keeps mixed results and indexes stderr diagnostics for nonzero exits", async () => {
		const config = loadConfig();
		const store = new ContentStore(":memory:");
		const tracker = new SessionTracker();
		const outputs = new Map<string, ExecResult>([
			[
				"success",
				{
					indexableStdout: "rpfsuccessfulbatchsentinel",
					stdout: "rpfsuccessfulbatchsentinel",
					stderr: "",
					exitCode: 0,
					truncated: false,
					killed: false,
				},
			],
			[
				"failure",
				{
					indexableStdout: "",
					stdout: "",
					stderr: "rpfstderrfailurediagnostic",
					exitCode: 7,
					truncated: false,
					killed: false,
				},
			],
		]);
		const executor = {
			execute: async ({ code }: { code: string }) => {
				const result = outputs.get(code);
				assert.ok(result, `missing fake result for ${code}`);
				return result;
			},
		} as unknown as SubprocessExecutor;
		const ctx: ToolContext = {
			config,
			store,
			tracker,
			executor,
			projectDir: process.cwd(),
			bunDetected: false,
			dbFallback: false,
			withExecutionLimit: (fn) => fn(),
			applyIntentFilter: createIntentFilter({ config, store, tracker }),
		};

		try {
			const handler = captureBatchHandler(ctx);
			const response = await handler({
				commands: [
					{ label: "Successful command", command: "success" },
					{ label: "Failed command", command: "failure" },
				],
				queries: ["rpfsuccessfulbatchsentinel", "rpfstderrfailurediagnostic"],
				timeout: 1_000,
			});
			const text = response.content[0].text;
			assert.strictEqual(response.isError, undefined);
			assert.match(text, /\*\*Successful command\*\*: 1 lines/);
			assert.match(text, /\*\*Failed command\*\*: 1 lines — failed \(exit 7\)/);
			assert.match(text, /rpfsuccessfulbatchsentinel/);
			assert.match(text, /rpfstderrfailurediagnostic/);
			assert.ok(store.search("Status failed").results.length > 0);
			assert.ok(store.search("Exit code 7").results.length > 0);
			assert.ok(store.search("rpfstderrfailurediagnostic").results.length > 0);
		} finally {
			store.close();
		}
	});
});
