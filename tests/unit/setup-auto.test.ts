import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	applyAutoConfig,
	findForeignHookCommands,
	readSettings,
	registerMcpServer,
} from "../../src/cli/setup.js";

const PATHS = {
	serverEntry: "/abs/path/to/dist/index.js",
	hookEntry: "/abs/path/to/hooks/pretooluse.mjs",
	binPath: "/abs/path/to/dist/cli/index.js",
};

describe("applyAutoConfig", () => {
	it("adds the hook and filter-bash env on a clean settings file", () => {
		const settings: Record<string, unknown> = {};
		const changes = applyAutoConfig(settings, PATHS, true);

		// 3 changes: hook + FILTER_BASH=1 + BIN path. MCP registration is NOT one of
		// them: `mcpServers` is not a settings.json key, so writing it registered
		// nothing. It goes through `claude mcp add` (see registerMcpServer).
		assert.strictEqual(changes.length, 3);
		const s = settings as {
			mcpServers?: Record<string, unknown>;
			hooks: { PreToolUse: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
			env: Record<string, string>;
		};
		assert.strictEqual(s.mcpServers, undefined, "must not write an ignored settings key");
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
		assert.ok(
			!("context-compress" in s.mcpServers),
			"ours is registered via `claude mcp add`, not written here",
		);
	});

	it("repairs a stale context-compress hook in place", () => {
		// A previous install of *this* package, at a different path.
		const settings: Record<string, unknown> = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{
								type: "command",
								command: "node /usr/local/lib/node_modules/context-compress/hooks/pretooluse.mjs",
							},
						],
					},
				],
			},
		};
		const changes = applyAutoConfig(settings, PATHS, true);
		const s = settings as {
			hooks: {
				PreToolUse: Array<{
					matcher?: string;
					hooks?: Array<{ type?: string; command?: string }>;
				}>;
			};
		};
		assert.strictEqual(s.hooks.PreToolUse.length, 1, "should not add a duplicate");
		assert.deepStrictEqual(s.hooks.PreToolUse[0], {
			matcher: "Bash|Read|Grep|WebFetch|Task",
			hooks: [{ type: "command", command: `node ${PATHS.hookEntry}` }],
		});
		assert.ok(changes.some((change) => change.includes("Updated PreToolUse hook")));
	});

	it("never claims a pretooluse hook it cannot prove is its own", () => {
		// `/old/path/pretooluse.mjs` is indistinguishable from another tool's hook.
		// Overwriting it destroyed third-party configuration, so it is preserved and
		// reported; leaving a stale duplicate behind is the recoverable failure.
		const foreign = {
			matcher: "Bash",
			hooks: [{ type: "command", command: "node /old/path/pretooluse.mjs" }],
		};
		const settings: Record<string, unknown> = { hooks: { PreToolUse: [foreign] } };

		const reported = findForeignHookCommands(settings, PATHS.hookEntry);
		applyAutoConfig(settings, PATHS, true);

		const s = settings as {
			hooks: { PreToolUse: Array<{ hooks?: Array<{ command?: string }> }> };
		};
		assert.deepStrictEqual(reported, ["node /old/path/pretooluse.mjs"]);
		assert.strictEqual(s.hooks.PreToolUse.length, 2, "ours is appended beside theirs");
		assert.strictEqual(
			s.hooks.PreToolUse[0].hooks?.[0].command,
			"node /old/path/pretooluse.mjs",
			"the unrecognized hook must be byte-identical afterwards",
		);
	});

	it("quotes generated command paths that contain spaces", () => {
		const spaced = {
			serverEntry: "/Users/me/My Apps/context-compress/dist/index.js",
			hookEntry: "/Users/me/My Apps/context-compress/hooks/pretooluse.mjs",
			binPath: "/Users/me/My Apps/context-compress/dist/cli/index.js",
		};
		const settings: Record<string, unknown> = {};
		applyAutoConfig(settings, spaced, true);
		const s = settings as {
			hooks: { PreToolUse: Array<{ hooks?: Array<{ command?: string }> }> };
			env: Record<string, string>;
		};

		// Unquoted, the shell sees "node /Users/me/My" and the hook never runs.
		assert.strictEqual(
			s.hooks.PreToolUse[0].hooks?.[0].command,
			`node '${spaced.hookEntry}'`,
		);
		assert.strictEqual(s.env.CONTEXT_COMPRESS_BIN, `node '${spaced.binPath}'`);
	});

	it("still recognizes its own quoted hook as current", () => {
		const spaced = {
			serverEntry: "/Users/me/My Apps/context-compress/dist/index.js",
			hookEntry: "/Users/me/My Apps/context-compress/hooks/pretooluse.mjs",
			binPath: "/Users/me/My Apps/context-compress/dist/cli/index.js",
		};
		const settings: Record<string, unknown> = {};
		applyAutoConfig(settings, spaced, true);
		const second = applyAutoConfig(settings, spaced, true);
		assert.deepStrictEqual(second, [], "a quoted hook must not be reinstalled every run");
	});

	it("preserves an unrelated pretooluse command and appends the owned hook", () => {
		const unrelated = {
			matcher: "Bash",
			hooks: [{ type: "command", command: "node /other/tool-pretooluse.mjs" }],
		};
		const settings: Record<string, unknown> = {
			hooks: { PreToolUse: [unrelated] },
		};

		applyAutoConfig(settings, PATHS, false);
		const s = settings as {
			hooks: {
				PreToolUse: Array<{
					matcher?: string;
					hooks?: Array<{ type?: string; command?: string }>;
				}>;
			};
		};
		assert.strictEqual(s.hooks.PreToolUse.length, 2);
		assert.deepStrictEqual(s.hooks.PreToolUse[0], unrelated);
		assert.deepStrictEqual(s.hooks.PreToolUse[1], {
			matcher: "Bash|Read|Grep|WebFetch|Task",
			hooks: [{ type: "command", command: `node ${PATHS.hookEntry}` }],
		});
	});

	it("recognizes the exact current hook without changes or duplicates", () => {
		const settings: Record<string, unknown> = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash|Read|Grep|WebFetch|Task",
						hooks: [{ type: "command", command: `node ${PATHS.hookEntry}` }],
					},
				],
			},
		};

		const changes = applyAutoConfig(settings, PATHS, false);
		const s = settings as { hooks: { PreToolUse: Array<unknown> } };
		assert.deepStrictEqual(changes, []);
		assert.strictEqual(s.hooks.PreToolUse.length, 1);
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

	it("removes only filter-bash env keys when transitioning to disabled", () => {
		const settings: Record<string, unknown> = {};
		applyAutoConfig(settings, PATHS, true);
		const s = settings as { env: Record<string, string> };
		s.env.UNRELATED_FLAG = "preserved";

		const changes = applyAutoConfig(settings, PATHS, false);

		assert.deepStrictEqual(s.env, { UNRELATED_FLAG: "preserved" });
		assert.ok(changes.includes("Removed CONTEXT_COMPRESS_FILTER_BASH"));
		assert.ok(changes.includes("Removed CONTEXT_COMPRESS_BIN"));
	});

	it("is idempotent when filter-bash env keys are already absent", () => {
		const settings: Record<string, unknown> = {
			env: { UNRELATED_FLAG: "preserved" },
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash|Read|Grep|WebFetch|Task",
						hooks: [{ type: "command", command: `node ${PATHS.hookEntry}` }],
					},
				],
			},
		};

		assert.deepStrictEqual(applyAutoConfig(settings, PATHS, false), []);
		assert.deepStrictEqual(settings.env, { UNRELATED_FLAG: "preserved" });
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
			hooks: { PreToolUse: Array<{ hooks?: Array<{ command?: string }> }> };
			env: Record<string, string>;
		};
		assert.match(s.hooks.PreToolUse[0].hooks?.[0].command ?? "", /^tsx /);
		assert.match(s.env.CONTEXT_COMPRESS_BIN ?? "", /^tsx /);
	});

	it("cleans up the ineffective MCP entry older versions wrote to settings.json", () => {
		// Earlier versions wrote `mcpServers` here, where Claude Code never reads it.
		// Leaving it behind is confusing, so setup removes exactly our entry.
		const settings: Record<string, unknown> = {
			mcpServers: {
				"context-compress": { command: "node", args: ["/old/path/index.js"] },
				"other-tool": { command: "x", args: [] },
			},
		};
		const changes = applyAutoConfig(settings, PATHS, false);
		const s = settings as { mcpServers: Record<string, unknown> };

		assert.ok(!("context-compress" in s.mcpServers));
		assert.ok(s.mcpServers["other-tool"], "someone else's entry must survive");
		assert.ok(changes.some((c) => c.includes("ineffective settings.json MCP entry")));
	});

	it("drops an emptied mcpServers object rather than leaving a stub", () => {
		const settings: Record<string, unknown> = {
			mcpServers: { "context-compress": { command: "node", args: ["/old/path/index.js"] } },
		};
		applyAutoConfig(settings, PATHS, false);
		assert.strictEqual((settings as { mcpServers?: unknown }).mcpServers, undefined);
	});
});

describe("registerMcpServer", () => {
	type Call = { file: string; args: string[] };

	function runner(
		responses: Array<{ status: number | null; stdout?: string; stderr?: string }>,
		calls: Call[],
	) {
		let i = 0;
		return (file: string, args: string[]) => {
			calls.push({ file, args });
			const r = responses[Math.min(i++, responses.length - 1)];
			return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
		};
	}

	it("registers through `claude mcp add` at user scope", () => {
		const calls: Call[] = [];
		const result = registerMcpServer(
			"/pkg/dist/index.js",
			runner([{ status: 0, stdout: "other-tool: ok" }, { status: 0 }], calls),
		);

		assert.strictEqual(result.status, "registered");
		assert.deepStrictEqual(calls[0].args, ["mcp", "list"]);
		assert.deepStrictEqual(calls[1].args, [
			"mcp",
			"add",
			"context-compress",
			"--scope",
			"user",
			"--",
			"node",
			"/pkg/dist/index.js",
		]);
	});

	it("upserts by removing an existing registration first", () => {
		// `claude mcp add` refuses a name that already exists, so a path change after
		// a reinstall would otherwise fail.
		const calls: Call[] = [];
		const result = registerMcpServer(
			"/pkg/dist/index.js",
			runner([{ status: 0, stdout: "context-compress: connected" }, { status: 0 }, { status: 0 }], calls),
		);

		assert.strictEqual(result.status, "registered");
		assert.deepStrictEqual(calls[1].args, ["mcp", "remove", "context-compress", "--scope", "user"]);
		assert.deepStrictEqual(calls[2].args.slice(0, 3), ["mcp", "add", "context-compress"]);
	});

	it("reports an unavailable CLI with the exact command to run", () => {
		const calls: Call[] = [];
		const result = registerMcpServer("/pkg/dist/index.js", runner([{ status: null }], calls));

		assert.strictEqual(result.status, "unavailable");
		assert.match(result.command, /^claude mcp add context-compress --scope user -- node /);
		assert.strictEqual(calls.length, 1, "must not attempt to add when the CLI is missing");
	});

	it("surfaces the failure reason when add fails", () => {
		const result = registerMcpServer(
			"/pkg/dist/index.js",
			runner([{ status: 0, stdout: "" }, { status: 1, stderr: "boom: refused\nsecond line" }], []),
		);

		assert.strictEqual(result.status, "failed");
		assert.strictEqual(result.detail, "boom: refused");
	});

	it("uses tsx for a TypeScript entry point", () => {
		const calls: Call[] = [];
		registerMcpServer("/repo/src/index.ts", runner([{ status: 0 }, { status: 0 }], calls));
		assert.deepStrictEqual(calls[1].args.slice(-2), ["tsx", "/repo/src/index.ts"]);
	});
});

describe("readSettings", () => {
	const dir = mkdtempSync(join(tmpdir(), "cc-setup-test-"));
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("returns {} when the settings file does not exist", () => {
		assert.deepStrictEqual(readSettings(join(dir, "nope.json")), {});
	});

	it("parses a valid settings file", () => {
		const p = join(dir, "valid.json");
		writeFileSync(p, JSON.stringify({ theme: "dark", env: { A: "1" } }));
		assert.deepStrictEqual(readSettings(p), { theme: "dark", env: { A: "1" } });
	});

	it("throws on malformed JSON instead of returning {} (fail closed — protects existing settings)", () => {
		const p = join(dir, "broken.json");
		writeFileSync(p, '{ "hooks": { "PreToolUse": [ },'); // truncated/invalid
		assert.throws(() => readSettings(p), /cannot parse/);
	});
});
