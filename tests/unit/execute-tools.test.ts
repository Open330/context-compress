import assert from "node:assert";
import { describe, it } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../../src/tools/context.js";
import { registerExecuteFileTool } from "../../src/tools/execute-file.js";
import { registerExecuteTool } from "../../src/tools/execute.js";
import type { ExecResult } from "../../src/types.js";

type Handler = (args: Record<string, unknown>) => Promise<{
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}>;

function result(overrides: Partial<ExecResult> = {}): ExecResult {
	return {
		indexableStdout: "",
		stdout: "",
		stderr: "",
		exitCode: 0,
		truncated: false,
		killed: false,
		...overrides,
	};
}

function register(
	kind: "execute" | "execute_file",
	exec: ExecResult,
): { handler: Handler; calls: number[] } {
	let handler: Handler | undefined;
	const calls: number[] = [];
	const server = {
		registerTool(_name: unknown, _options: unknown, registered: Handler) {
			handler = registered;
		},
	} as unknown as McpServer;

	const ctx = {
		executor: {
			execute: async () => exec,
			executeFile: async () => exec,
		},
		tracker: {
			trackCall(_name: string, bytes: number) {
				calls.push(bytes);
			},
			trackSandboxed() {},
		},
		projectDir: process.cwd(),
		withExecutionLimit: (fn: () => unknown) => fn(),
		applyIntentFilter: (output: string) => output,
		bunDetected: false,
	} as unknown as ToolContext;

	if (kind === "execute") registerExecuteTool(server, ctx);
	else registerExecuteFileTool(server, ctx);
	assert.ok(handler);
	return { handler, calls };
}

const executeArgs = { language: "shell", code: "run", timeout: 1_000 };
const fileArgs = { path: "package.json", language: "shell", code: "run", timeout: 1_000 };

describe("execute status reporting", () => {
	it("leaves a clean success untouched", async () => {
		const { handler } = register("execute", result({ stdout: "all good", indexableStdout: "all good" }));
		const text = (await handler(executeArgs)).content[0].text;
		assert.strictEqual(text, "all good");
	});

	it("distinguishes a nonzero exit from an empty success", async () => {
		// The original defect: both returned "" and read as success.
		const ok = (await register("execute", result()).handler(executeArgs)).content[0].text;
		const bad = (await register("execute", result({ exitCode: 7 })).handler(executeArgs)).content[0]
			.text;

		assert.notStrictEqual(ok, bad);
		assert.match(bad, /exit 7/);
		assert.match(bad, /Status: failed/);
		assert.match(bad, /\(no output\)/);
	});

	it("keeps stderr and adds the status footer for a failing run", async () => {
		const { handler } = register(
			"execute",
			result({ exitCode: 2, stderr: "boom detail", stdout: "partial", indexableStdout: "partial" }),
		);
		const text = (await handler(executeArgs)).content[0].text;
		assert.match(text, /partial/);
		assert.match(text, /STDERR:\nboom detail/);
		assert.match(text, /Status: failed · exit 2/);
	});

	it("reports a killed run and its unknown exit code", async () => {
		const { handler } = register("execute", result({ exitCode: null, killed: true }));
		const text = (await handler(executeArgs)).content[0].text;
		assert.match(text, /Status: killed/);
		assert.match(text, /exit unknown/);
		assert.match(text, /killed \(timeout or output cap\)/);
	});

	it("reports executor output capping even when the command succeeded", async () => {
		const { handler } = register(
			"execute",
			result({ stdout: "head", indexableStdout: "head", truncated: true }),
		);
		const text = (await handler(executeArgs)).content[0].text;
		assert.match(text, /output truncated at the executor cap/);
		assert.match(text, /Status: completed/);
	});

	it("counts the footer in the tracked response size", async () => {
		const { handler, calls } = register("execute", result({ exitCode: 7 }));
		const text = (await handler(executeArgs)).content[0].text;
		assert.deepStrictEqual(calls, [Buffer.byteLength(text, "utf8")]);
	});

	it("survives the intent filter", async () => {
		// The footer is appended after intent filtering, so an indexed/filtered
		// response still carries the exit status.
		let handler: Handler | undefined;
		const server = {
			registerTool(_n: unknown, _o: unknown, registered: Handler) {
				handler = registered;
			},
		} as unknown as McpServer;
		const ctx = {
			executor: { execute: async () => result({ exitCode: 9, indexableStdout: "raw corpus" }) },
			tracker: { trackCall() {}, trackSandboxed() {} },
			projectDir: process.cwd(),
			withExecutionLimit: (fn: () => unknown) => fn(),
			applyIntentFilter: () => "indexed summary",
			bunDetected: false,
		} as unknown as ToolContext;
		registerExecuteTool(server, ctx);
		assert.ok(handler);

		const text = (await handler({ ...executeArgs, intent: "find it" })).content[0].text;
		assert.match(text, /indexed summary/);
		assert.match(text, /exit 9/);
	});
});

describe("timeout input bounds", () => {
	function timeoutSchema(kind: "execute" | "execute_file"): {
		safeParse(value: unknown): { success: boolean };
	} {
		let options: { inputSchema: { timeout: { safeParse(v: unknown): { success: boolean } } } } | undefined;
		const server = {
			registerTool(_name: unknown, registered: typeof options) {
				options = registered;
			},
		} as unknown as McpServer;
		if (kind === "execute") registerExecuteTool(server, {} as ToolContext);
		else registerExecuteFileTool(server, {} as ToolContext);
		assert.ok(options);
		return options.inputSchema.timeout;
	}

	it("rejects values that would pin an execution slot indefinitely", () => {
		// The executor's timer is the only thing that kills a runaway process, so an
		// unvalidated timeout let eight calls exhaust MAX_CONCURRENT_EXECUTIONS and
		// make every later execution in the session fail.
		for (const kind of ["execute", "execute_file"] as const) {
			const schema = timeoutSchema(kind);
			assert.strictEqual(schema.safeParse(2_147_483_647).success, false, `${kind}: 24.8 days`);
			assert.strictEqual(schema.safeParse(0).success, false, `${kind}: zero`);
			assert.strictEqual(schema.safeParse(-1).success, false, `${kind}: negative`);
			assert.strictEqual(schema.safeParse(1.5).success, false, `${kind}: fractional`);
			assert.strictEqual(schema.safeParse(30_000).success, true, `${kind}: ordinary value`);
			assert.strictEqual(schema.safeParse(600_000).success, true, `${kind}: the ceiling`);
			assert.strictEqual(schema.safeParse(600_001).success, false, `${kind}: past the ceiling`);
		}
	});
});

describe("execute_file status reporting", () => {
	it("leaves a clean success untouched", async () => {
		const { handler } = register("execute_file", result({ stdout: "ok", indexableStdout: "ok" }));
		assert.strictEqual((await handler(fileArgs)).content[0].text, "ok");
	});

	it("distinguishes a nonzero exit from an empty success", async () => {
		const ok = (await register("execute_file", result()).handler(fileArgs)).content[0].text;
		const bad = (await register("execute_file", result({ exitCode: 7 })).handler(fileArgs)).content[0]
			.text;

		assert.notStrictEqual(ok, bad);
		assert.match(bad, /Status: failed · exit 7/);
		assert.match(bad, /\(no output\)/);
	});

	it("reports a killed file run", async () => {
		const { handler } = register("execute_file", result({ exitCode: null, killed: true }));
		assert.match((await handler(fileArgs)).content[0].text, /Status: killed/);
	});
});
