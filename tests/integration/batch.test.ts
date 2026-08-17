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
				return;
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

	it("bounds pathological command and query counts in the input schema", () => {
		let options: {
			inputSchema: {
				commands: { safeParse(value: unknown): { success: boolean } };
				queries: { safeParse(value: unknown): { success: boolean } };
			};
		} | undefined;
		const server = {
			registerTool(_name: unknown, registered: typeof options) {
				options = registered;
			},
		} as unknown as McpServer;
		registerBatchExecuteTool(server, {} as ToolContext);
		assert.ok(options);

		const command = { label: "l", command: "c" };
		assert.strictEqual(options.inputSchema.commands.safeParse([]).success, false);
		assert.strictEqual(
			options.inputSchema.commands.safeParse(Array(32).fill(command)).success,
			true,
		);
		assert.strictEqual(
			options.inputSchema.commands.safeParse(Array(33).fill(command)).success,
			false,
		);
		assert.strictEqual(options.inputSchema.queries.safeParse(Array(16).fill("q")).success, true);
		assert.strictEqual(options.inputSchema.queries.safeParse(Array(17).fill("q")).success, false);
	});

	it("indexes each command as it settles instead of after the whole batch", async () => {
		// The second command blocks until the first corpus has been indexed. If
		// indexing only ran after every command settled — the shape that pinned
		// every capped output in memory at once — this deadlocks.
		const config = loadConfig();
		const store = new ContentStore(":memory:");
		const tracker = new SessionTracker();
		let releaseSecond: () => void = () => {};
		const firstIndexed = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const indexOrder: string[] = [];
		const spiedStore = {
			index(content: string, label: string) {
				const result = store.index(content, label);
				if (content.includes("firstcorpus")) {
					indexOrder.push("first");
					releaseSecond();
				} else {
					indexOrder.push("second");
				}
				return result;
			},
			search: store.search.bind(store),
			getDistinctiveTerms: store.getDistinctiveTerms.bind(store),
		} as unknown as ContentStore;

		const executor = {
			execute: async ({ code }: { code: string }) => {
				if (code === "second") {
					await Promise.race([
						firstIndexed,
						new Promise((_, reject) =>
							setTimeout(
								() => reject(new Error("first corpus was not indexed before the batch settled")),
								3_000,
							),
						),
					]);
				}
				return {
					indexableStdout: code === "second" ? "secondcorpus body" : "firstcorpus body",
					stdout: `${code} summary`,
					stderr: "",
					exitCode: 0,
					truncated: false,
					killed: false,
				} satisfies ExecResult;
			},
		} as unknown as SubprocessExecutor;

		const ctx: ToolContext = {
			config,
			store: spiedStore,
			tracker,
			executor,
			projectDir: process.cwd(),
			bunDetected: false,
			dbFallback: false,
			withExecutionLimit: (fn) => fn(),
			applyIntentFilter: createIntentFilter({ config, store, tracker }),
		};

		try {
			const response = await captureBatchHandler(ctx)({
				commands: [
					{ label: "Alpha", command: "first" },
					{ label: "Beta", command: "second" },
				],
				queries: ["firstcorpus"],
				timeout: 1_000,
			});
			assert.deepStrictEqual(indexOrder, ["first", "second"]);
			// Response order stays positional even though Beta finished last.
			const text = response.content[0].text;
			assert.ok(
				text.indexOf("**Alpha**") < text.indexOf("**Beta**"),
				"inventory must stay in request order",
			);
		} finally {
			store.close();
		}
	});

	it("does not return an earlier batch's output as a current-batch result", async () => {
		const config = loadConfig();
		const store = new ContentStore(":memory:");
		const tracker = new SessionTracker();
		const executor = {
			execute: async ({ code }: { code: string }) =>
				({
					indexableStdout: code,
					stdout: code,
					stderr: "",
					exitCode: 0,
					truncated: false,
					killed: false,
				}) satisfies ExecResult,
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
			await handler({
				commands: [{ label: "First call", command: "rpffirstcallsentinel" }],
				queries: ["rpffirstcallsentinel"],
				timeout: 1_000,
			});
			const second = await handler({
				commands: [{ label: "Second call", command: "rpfsecondcallsentinel" }],
				queries: ["rpffirstcallsentinel"],
				timeout: 1_000,
			});
			const text = second.content[0].text;

			// The first call's sentinel is still indexed and still reachable, but it
			// must never be presented as output of this batch.
			assert.ok(store.search("rpffirstcallsentinel").results.length > 0);
			if (text.includes("rpffirstcallsentinel---") || /--- \[batch_execute\]/.test(text)) {
				assert.match(
					text,
					/no match in this batch/,
					"a store-wide fallback hit must be labelled as such",
				);
			}
		} finally {
			store.close();
		}
	});

	it("keeps the whole batch response inside batchMaxBytes", async () => {
		const config = { ...loadConfig(), batchMaxBytes: 1_024 };
		const store = new ContentStore(":memory:");
		const tracker = new SessionTracker();
		const executor = {
			execute: async () =>
				({
					indexableStdout: `budgetprobe ${"z".repeat(4_096)}`,
					stdout: "summary",
					stderr: "",
					exitCode: 0,
					truncated: false,
					killed: false,
				}) satisfies ExecResult,
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
			const response = await captureBatchHandler(ctx)({
				commands: Array.from({ length: 6 }, (_, i) => ({
					label: `Command ${i}`,
					command: `c${i}`,
				})),
				queries: Array.from({ length: 8 }, () => "budgetprobe"),
				timeout: 1_000,
			});
			const bytes = Buffer.byteLength(response.content[0].text, "utf8");
			assert.ok(bytes <= 1_024, `response was ${bytes} bytes, budget is 1024`);
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
