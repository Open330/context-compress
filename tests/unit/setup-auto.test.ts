import assert from "node:assert";
import { describe, it } from "node:test";
import { applyAutoConfig } from "../../src/cli/setup.js";

const PATHS = {
	serverEntry: "/abs/path/to/dist/index.js",
	hookEntry: "/abs/path/to/hooks/pretooluse.mjs",
	binPath: "/abs/path/to/dist/cli/index.js",
};

describe("applyAutoConfig", () => {
	it("adds MCP server, hook, and filter-bash env on a clean settings file", () => {
		const settings: Record<string, unknown> = {};
		const changes = applyAutoConfig(settings, PATHS, true);

		// 4 changes: MCP server + hook + FILTER_BASH=1 + BIN path
		assert.strictEqual(changes.length, 4);
		const s = settings as {
			mcpServers: Record<string, { command: string; args: string[] }>;
			hooks: { PreToolUse: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
			env: Record<string, string>;
		};
		assert.strictEqual(s.mcpServers["context-compress"].command, "node");
		assert.deepStrictEqual(s.mcpServers["context-compress"].args, [PATHS.serverEntry]);
		assert.strictEqual(s.hooks.PreToolUse.length, 1);
		assert.match(s.hooks.PreToolUse[0].hooks?.[0].command ?? "", /pretooluse\.mjs/);
		assert.strictEqual(s.env.CONTEXT_COMPRESS_FILTER_BASH, "1");
		assert.match(s.env.CONTEXT_COMPRESS_BIN ?? "", /cli\/index\.js$/);
	});

	it("is idempotent — second run yields no changes", () => {
		const settings: Record<string, unknown> = {};
		const first = applyAutoConfig(settings, PATHS, true);
		const second = applyAutoConfig(settings, PATHS, true);
		assert.ok(first.length > 0);
		assert.strictEqual(second.length, 0);
	});

	it("preserves existing unrelated user settings", () => {
		const settings: Record<string, unknown> = {
			theme: "dark",
			model: "claude-opus-4-7",
			env: { MY_FLAG: "1" },
			mcpServers: { "other-tool": { command: "x", args: [] } },
		};
		applyAutoConfig(settings, PATHS, true);
		const s = settings as {
			theme: string;
			model: string;
			env: Record<string, string>;
			mcpServers: Record<string, unknown>;
		};
		assert.strictEqual(s.theme, "dark");
		assert.strictEqual(s.model, "claude-opus-4-7");
		assert.strictEqual(s.env.MY_FLAG, "1", "unrelated env vars must survive");
		assert.ok(s.mcpServers["other-tool"], "unrelated MCP servers must survive");
		assert.ok(s.mcpServers["context-compress"], "ours must be added");
	});

	it("does not duplicate the hook when one already exists from a prior install", () => {
		const settings: Record<string, unknown> = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: "node /old/path/pretooluse.mjs" }],
					},
				],
			},
		};
		applyAutoConfig(settings, PATHS, true);
		const s = settings as {
			hooks: { PreToolUse: Array<unknown> };
		};
		assert.strictEqual(s.hooks.PreToolUse.length, 1, "should not add a duplicate");
	});

	it("skips env writes when filterBash is false", () => {
		const settings: Record<string, unknown> = {};
		applyAutoConfig(settings, PATHS, false);
		const s = settings as { env?: Record<string, string> };
		assert.ok(
			s.env === undefined || s.env.CONTEXT_COMPRESS_FILTER_BASH === undefined,
			"filter-bash should not be set when disabled",
		);
	});

	it("uses tsx when given .ts source paths (dev mode)", () => {
		const devPaths = {
			serverEntry: "/repo/src/index.ts",
			hookEntry: "/repo/src/hooks/pretooluse.ts",
			binPath: "/repo/src/cli/index.ts",
		};
		const settings: Record<string, unknown> = {};
		applyAutoConfig(settings, devPaths, true);
		const s = settings as {
			mcpServers: Record<string, { command: string }>;
			hooks: { PreToolUse: Array<{ hooks?: Array<{ command?: string }> }> };
			env: Record<string, string>;
		};
		assert.strictEqual(s.mcpServers["context-compress"].command, "tsx");
		assert.match(s.hooks.PreToolUse[0].hooks?.[0].command ?? "", /^tsx /);
		assert.match(s.env.CONTEXT_COMPRESS_BIN ?? "", /^tsx /);
	});

	it("rewrites MCP server entry when the path changes (e.g., after reinstall)", () => {
		const settings: Record<string, unknown> = {
			mcpServers: {
				"context-compress": { command: "node", args: ["/old/path/index.js"] },
			},
		};
		const changes = applyAutoConfig(settings, PATHS, false);
		const s = settings as {
			mcpServers: Record<string, { args: string[] }>;
		};
		assert.deepStrictEqual(s.mcpServers["context-compress"].args, [PATHS.serverEntry]);
		assert.ok(changes.some((c) => c.includes("Registered MCP server")));
	});
});
