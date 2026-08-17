import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isOwnedHookCommand, removeOwnedEnv } from "../../src/cli/hook-ownership.js";
import { resolvePaths } from "../../src/cli/setup.js";
import { removeFromSettings } from "../../src/cli/uninstall.js";

const dirs: string[] = [];

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function settingsFile(contents: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "cc-uninstall-"));
	dirs.push(dir);
	const path = join(dir, "settings.json");
	writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, "utf-8");
	return path;
}

function read(path: string): {
	hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
	mcpServers?: Record<string, unknown>;
	env?: Record<string, string>;
	permissions?: unknown;
} {
	return JSON.parse(readFileSync(path, "utf-8"));
}

const OWN_HOOK = resolvePaths().hookEntry;

describe("uninstall settings cleanup", () => {
	it("removes only the owned hook and keeps sibling hooks in the same entry", () => {
		// The old filter dropped the whole entry when any command mentioned
		// pretooluse.mjs, taking the sibling hook with it.
		const path = settingsFile({
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{ type: "command", command: `node ${OWN_HOOK}` },
							{ type: "command", command: "node /other/tool/audit.mjs" },
						],
					},
				],
			},
		});

		const changes = removeFromSettings(path);
		const result = read(path);

		assert.ok(changes.some((change) => change.includes("PreToolUse hook")));
		assert.strictEqual(result.hooks?.PreToolUse?.length, 1, "the entry must survive");
		assert.deepStrictEqual(result.hooks?.PreToolUse?.[0].hooks, [
			{ type: "command", command: "node /other/tool/audit.mjs" },
		]);
	});

	it("never deletes another tool's identically named pretooluse hook", () => {
		const foreign = {
			matcher: "Bash",
			hooks: [{ type: "command", command: "node /other/tool/pretooluse.mjs" }],
		};
		const path = settingsFile({ hooks: { PreToolUse: [foreign] } });

		const changes = removeFromSettings(path);

		assert.deepStrictEqual(changes, [], "nothing of ours was present");
		assert.deepStrictEqual(read(path).hooks?.PreToolUse, [foreign]);
	});

	it("drops the PreToolUse key only when nothing is left", () => {
		const path = settingsFile({
			hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: `node ${OWN_HOOK}` }] }] },
		});

		removeFromSettings(path);
		const result = read(path);
		assert.strictEqual(result.hooks?.PreToolUse, undefined);
	});

	it("removes the owned env keys and preserves unrelated ones", () => {
		const path = settingsFile({
			env: {
				CONTEXT_COMPRESS_FILTER_BASH: "1",
				CONTEXT_COMPRESS_BIN: "node /x/cli/index.js",
				MY_OWN_FLAG: "keep",
			},
		});

		const changes = removeFromSettings(path);
		const result = read(path);

		assert.ok(changes.includes("Removed CONTEXT_COMPRESS_FILTER_BASH"));
		assert.ok(changes.includes("Removed CONTEXT_COMPRESS_BIN"));
		assert.deepStrictEqual(result.env, { MY_OWN_FLAG: "keep" });
	});

	it("removes the MCP registration and leaves other servers alone", () => {
		const path = settingsFile({
			mcpServers: {
				"context-compress": { command: "node", args: ["/x/index.js"] },
				"other-tool": { command: "y", args: [] },
			},
		});

		removeFromSettings(path);
		const result = read(path);

		assert.ok(!("context-compress" in (result.mcpServers ?? {})));
		assert.ok(result.mcpServers?.["other-tool"]);
	});

	it("preserves unrelated top-level settings and backs the file up", () => {
		const path = settingsFile({
			permissions: { allow: ["Bash(npm test)"] },
			env: { CONTEXT_COMPRESS_FILTER_BASH: "1" },
		});

		removeFromSettings(path);

		assert.deepStrictEqual(read(path).permissions, { allow: ["Bash(npm test)"] });
		assert.ok(readFileSync(`${path}.bak`, "utf-8").includes("CONTEXT_COMPRESS_FILTER_BASH"));
	});

	it("is idempotent and does not rewrite a file with nothing of ours", () => {
		const path = settingsFile({ theme: "dark" });
		const before = readFileSync(path, "utf-8");

		assert.deepStrictEqual(removeFromSettings(path), []);
		assert.strictEqual(readFileSync(path, "utf-8"), before, "an untouched file stays byte-identical");
	});

	it("throws rather than rewriting a settings file it cannot parse", () => {
		const dir = mkdtempSync(join(tmpdir(), "cc-uninstall-bad-"));
		dirs.push(dir);
		const path = join(dir, "settings.json");
		writeFileSync(path, "{ not json", "utf-8");

		assert.throws(() => removeFromSettings(path));
		assert.strictEqual(readFileSync(path, "utf-8"), "{ not json");
	});

	it("returns nothing when the settings file is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "cc-uninstall-missing-"));
		dirs.push(dir);
		assert.deepStrictEqual(removeFromSettings(join(dir, "settings.json")), []);
	});
});

describe("hook ownership is symmetric between setup and uninstall", () => {
	it("agrees on which commands are ours", () => {
		const owned = [
			`node ${OWN_HOOK}`,
			`node '${OWN_HOOK}'`,
			"node /usr/local/lib/node_modules/context-compress/hooks/pretooluse.mjs",
			"tsx /home/dev/context-compress/src/hooks/pretooluse.ts",
			"node '/Users/me/My Apps/context-compress/hooks/pretooluse.mjs'",
			"context-compress hook",
			"/usr/local/bin/context-compress hook",
		];
		const notOwned = [
			"node /other/tool/pretooluse.mjs",
			"tsx /somewhere/else/pretooluse.ts",
			"node /other/tool-pretooluse.mjs",
			"node /some/path/other.mjs",
			"echo hello",
			"",
			undefined,
		];

		for (const command of owned) {
			assert.strictEqual(isOwnedHookCommand(command, OWN_HOOK), true, `owned: ${command}`);
		}
		for (const command of notOwned) {
			assert.strictEqual(isOwnedHookCommand(command, OWN_HOOK), false, `not owned: ${command}`);
		}
	});

	it("removes exactly the env keys setup writes", () => {
		const env = { CONTEXT_COMPRESS_FILTER_BASH: "1", CONTEXT_COMPRESS_BIN: "x", OTHER: "y" };
		const changes: string[] = [];
		removeOwnedEnv(env, changes);
		assert.deepStrictEqual(env, { OTHER: "y" });
		assert.strictEqual(changes.length, 2);

		// Idempotent: a second pass reports nothing.
		const again: string[] = [];
		removeOwnedEnv(env, again);
		assert.deepStrictEqual(again, []);
	});
});
