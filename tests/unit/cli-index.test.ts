import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(root, "src/cli/index.ts");

function runCli(args: string[]) {
	return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
		cwd: root,
		encoding: "utf-8",
		timeout: 5_000,
	});
}

describe("context-compress CLI dispatch", () => {
	for (const flag of ["--help", "-h"]) {
		it(`${flag} prints useful help and exits successfully`, () => {
			const result = runCli([flag]);

			assert.strictEqual(result.error, undefined);
			assert.strictEqual(result.status, 0);
			assert.strictEqual(result.stderr, "");
			assert.match(result.stdout, /Usage: context-compress \[command\]/);
			assert.match(result.stdout, /Run without a command to start the MCP server/);
			assert.match(result.stdout, /setup \[--auto\]/);
			assert.match(result.stdout, /doctor/);
			assert.match(result.stdout, /filter \[options\]/);
			assert.match(result.stdout, /wrap <cmd>/);
		});
	}

	for (const flag of ["--version", "-v"]) {
		it(`${flag} prints the package version and exits successfully`, () => {
			const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
				version: string;
			};
			const result = runCli([flag]);

			assert.strictEqual(result.error, undefined);
			assert.strictEqual(result.status, 0);
			assert.strictEqual(result.stderr, "");
			assert.strictEqual(result.stdout.trim(), packageJson.version);
		});
	}

	it("starts an MCP server on stdio with no arguments and answers initialize", () => {
		// The no-argument form is the published MCP entry point — every plugin
		// manifest and setup path depends on it — but nothing covered it, so a
		// dispatch change could have broken startup with all tests green.
		const request = `${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "rpf-contract-test", version: "0" },
			},
		})}\n`;

		const result = spawnSync(process.execPath, ["--import", "tsx", cliPath], {
			cwd: root,
			encoding: "utf-8",
			timeout: 20_000,
			input: request,
			// Deterministic offline: no auto mode, no network, isolated config home.
			env: {
				...process.env,
				HOME: join(root, "node_modules/.cache/cc-mcp-contract-home"),
				CONTEXT_COMPRESS_MODE: "conservative",
			},
		});

		assert.strictEqual(result.error, undefined);
		assert.strictEqual(result.signal, null, "server must exit on stdin close, not be killed");
		assert.strictEqual(result.status, 0, `exited ${result.status}: ${result.stderr}`);

		const responses = result.stdout
			.split("\n")
			.filter((line) => line.trim().startsWith("{"))
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const initialize = responses.find((message) => message.id === 1);
		assert.ok(initialize, `no JSON-RPC response for initialize in: ${result.stdout}`);
		assert.strictEqual(initialize.jsonrpc, "2.0");
		assert.strictEqual(initialize.error, undefined);

		const payload = initialize.result as { protocolVersion?: string; serverInfo?: { name?: string } };
		assert.ok(payload, "initialize must return a result");
		assert.ok(payload.protocolVersion, "initialize must negotiate a protocol version");
		assert.ok(payload.serverInfo?.name, "initialize must identify the server");
	});

	it("reports an unknown command without starting the MCP server", () => {
		const result = runCli(["frobnicate"]);

		assert.strictEqual(result.error, undefined);
		assert.strictEqual(result.status, 2);
		assert.strictEqual(result.stdout, "");
		assert.match(result.stderr, /Unknown command: frobnicate/);
		assert.match(result.stderr, /Commands:/);
		assert.match(result.stderr, /setup \[--auto\]/);
		assert.match(result.stderr, /doctor/);
		assert.match(result.stderr, /filter \[options\]/);
		assert.match(result.stderr, /wrap <cmd>/);
		assert.match(result.stderr, /--help/);
	});
});
