import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(join(root, path), "utf-8")) as T;
}

describe("plugin manifests", () => {
	it("keeps Codex plugin metadata valid and aligned with package version", () => {
		const pkg = readJson<{ version: string }>("package.json");
		const manifest = readJson<{
			name: string;
			version: string;
			skills: string;
			mcpServers: string;
			hooks?: unknown;
			interface: { defaultPrompt: string[]; capabilities: string[] };
		}>(".codex-plugin/plugin.json");

		assert.strictEqual(manifest.name, "context-compress");
		assert.strictEqual(manifest.version, pkg.version);
		assert.strictEqual(manifest.skills, "./skills/");
		assert.strictEqual(manifest.mcpServers, "./.mcp.json");
		assert.strictEqual(manifest.hooks, undefined, "Codex manifest must not declare hooks");
		assert.ok(manifest.interface.defaultPrompt.length > 0);
		assert.ok(manifest.interface.capabilities.includes("MCP"));
	});

	it("declares a local MCP server companion file", () => {
		const mcp = readJson<{
			mcpServers: Record<string, { command: string; args: string[]; cwd?: string }>;
		}>(".mcp.json");

		assert.strictEqual(mcp.mcpServers["context-compress"].command, "node");
		assert.deepStrictEqual(mcp.mcpServers["context-compress"].args, ["./dist/index.js"]);
	});

	it("resolves the Claude plugin MCP server against the plugin root", () => {
		// A relative path resolves against the session's working directory, not the
		// plugin directory, so a plugin install used to launch
		// `node ./dist/index.js` from the user's project and fail with
		// "Cannot find module". `${CLAUDE_PLUGIN_ROOT}` is the documented mechanism,
		// and it is only set for plugin-provided servers — which is why this is
		// declared inline here rather than shared with the project-scope .mcp.json.
		const manifest = readJson<{
			mcpServers: Record<string, { type?: string; command: string; args: string[]; cwd?: string }>;
		}>(".claude-plugin/plugin.json");
		const server = manifest.mcpServers["context-compress"];

		assert.ok(server, "the Claude plugin must declare its MCP server");
		assert.strictEqual(server.type, "stdio");
		assert.strictEqual(server.command, "node");
		assert.deepStrictEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"]);
		assert.strictEqual(server.cwd, undefined, "cwd is not a supported MCP server field");

		for (const arg of server.args) {
			assert.doesNotMatch(arg, /^\.\.?\//, "a plugin path must not be session-relative");
		}
	});

	it("keeps Claude plugin hooks separate from the Codex manifest", () => {
		const manifest = readJson<{
			name: string;
			hooks: string;
			mcpServers: unknown;
			skills: string;
		}>(".claude-plugin/plugin.json");

		assert.strictEqual(manifest.name, "context-compress");
		assert.strictEqual(manifest.hooks, "./hooks/claude-codex-hooks.json");
		assert.strictEqual(manifest.skills, "./skills/");
		// The server is declared inline (see the plugin-root resolution test) rather
		// than pointing at the shared .mcp.json, which cannot expand a plugin path.
		assert.strictEqual(typeof manifest.mcpServers, "object");
		assert.ok(existsSync(join(root, "hooks/claude-codex-hooks.json")));
	});

	it("ships exactly one PreToolUse hook manifest", () => {
		// `hooks/hooks.json` is the path plugin hosts auto-discover by convention.
		// Keeping it alongside the explicitly declared `hooks/claude-codex-hooks.json`
		// registers the same PreToolUse hook twice — every Bash/Read/Grep call would
		// spawn the hook process twice and emit two conflicting decisions.
		assert.ok(
			!existsSync(join(root, "hooks/hooks.json")),
			"hooks/hooks.json would double-register the PreToolUse hook",
		);
	});

	it("Claude hook config enables transparent Bash compression", () => {
		const hooks = readJson<{
			hooks: {
				PreToolUse: Array<{
					matcher: string;
					hooks: Array<{ command: string; commandWindows: string; timeout: number }>;
				}>;
			};
		}>("hooks/claude-codex-hooks.json");

		const entry = hooks.hooks.PreToolUse[0];
		const command = entry.hooks[0].command;
		const commandWindows = entry.hooks[0].commandWindows;

		assert.match(entry.matcher, /Bash/);
		assert.match(command, /CONTEXT_COMPRESS_FILTER_BASH=1/);
		assert.match(command, /CONTEXT_COMPRESS_BIN=.*dist\/cli\/index\.js/);
		assert.match(command, /hooks\/pretooluse\.mjs/);
		assert.match(commandWindows, /\$env:CONTEXT_COMPRESS_FILTER_BASH='1'/);
		assert.match(
			commandWindows,
			/\$env:CONTEXT_COMPRESS_BIN="node `"\$env:CLAUDE_PLUGIN_ROOT\\dist\\cli\\index\.js`""/,
		);
		assert.doesNotMatch(commandWindows, /CONTEXT_COMPRESS_BIN='context-compress'/);
		assert.match(commandWindows, /node "\$env:CLAUDE_PLUGIN_ROOT\\hooks\\pretooluse\.mjs"/);
		assert.strictEqual(entry.hooks[0].timeout, 5);
	});

	it("PreToolUse routing used by the plugin actually rewrites large Bash output commands", () => {
		const hookPath = join(root, "src/hooks/pretooluse.ts");
		const output = execFileSync("node", ["--import", "tsx", hookPath], {
			input: JSON.stringify({
				tool_name: "Bash",
				tool_input: { command: "git log -10" },
			}),
			env: {
				...process.env,
				CONTEXT_COMPRESS_FILTER_BASH: "1",
				CONTEXT_COMPRESS_BIN: `node ${join(root, "dist/cli/index.js")}`,
				CONTEXT_COMPRESS_MODE: "balanced",
			},
			encoding: "utf-8",
		});

		const parsed = JSON.parse(output) as {
			hookSpecificOutput: { updatedInput?: { command?: string } };
		};
		const rewritten = parsed.hookSpecificOutput.updatedInput?.command ?? "";

		assert.match(rewritten, /^node .*dist\/cli\/index\.js wrap --mode balanced 'git log -10'$/);
	});

	it("keeps the packaged Windows CLI path quoted when rewriting Bash commands", () => {
		const hookPath = join(root, "src/hooks/pretooluse.ts");
		const pluginRoot = "C:\\Users\\Jane Doe\\.claude\\plugins\\context-compress";
		const packagedBin = `node "${pluginRoot}\\dist\\cli\\index.js"`;
		const output = execFileSync("node", ["--import", "tsx", hookPath], {
			input: JSON.stringify({
				tool_name: "Bash",
				tool_input: { command: "git log -10" },
			}),
			env: {
				...process.env,
				CONTEXT_COMPRESS_FILTER_BASH: "1",
				CONTEXT_COMPRESS_BIN: packagedBin,
				CONTEXT_COMPRESS_MODE: "balanced",
			},
			encoding: "utf-8",
		});

		const parsed = JSON.parse(output) as {
			hookSpecificOutput: { updatedInput?: { command?: string } };
		};

		assert.strictEqual(
			parsed.hookSpecificOutput.updatedInput?.command,
			`node '${pluginRoot}\\dist\\cli\\index.js' wrap --mode balanced 'git log -10'`,
		);
	});

	it("package distribution includes plugin, hook, skill, and benchmark assets", () => {
		const pkg = readJson<{ files: string[] }>("package.json");

		for (const required of [
			".codex-plugin/",
			".claude-plugin/",
			".mcp.json",
			"hooks/",
			"skills/",
			"docs/",
		]) {
			assert.ok(pkg.files.includes(required), `package.json files must include ${required}`);
		}
	});

	it("audit skill and agentic benchmark are discoverable by plugin hosts", () => {
		const audit = readFileSync(join(root, "skills/context-compress-audit/SKILL.md"), "utf-8");
		const auditUi = readFileSync(
			join(root, "skills/context-compress-audit/agents/openai.yaml"),
			"utf-8",
		);
		const benchmark = readFileSync(join(root, "docs/agentic-benchmark.md"), "utf-8");
		const readme = readFileSync(join(root, "README.md"), "utf-8");

		assert.match(audit, /^---\nname: context-compress-audit/m);
		assert.match(audit, /raw tool output/i);
		assert.match(auditUi, /Use \$context-compress-audit/);
		assert.match(benchmark, /`baseline`\s*\|\s*No context-compress MCP/);
		assert.match(benchmark, /hook-balanced/);
		assert.match(benchmark, /Disable user\/global plugin sources/);
		assert.match(readme, /Large tool output stays searchable/);
		assert.match(readme, /Plugin Support/);
		assert.match(readme, /Agentic Benchmark Plan/);
	});
});
