import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupStaleDbs } from "../../src/store.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(root, "src/cli/index.ts");
const dirs: string[] = [];

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the CLI with an isolated HOME *and* cwd.
 *
 * cwd isolation is not optional: `uninstall` rewrites `$PWD/.mcp.json`, so
 * running it from the repository root edits the repository — which is exactly
 * what happened the first time this file ran.
 */
function runCli(args: string[], home?: string, envOverrides: Record<string, string> = {}) {
	const homeDir = home ?? mkdtempSync(join(tmpdir(), "cc-cli-home-"));
	if (!home) dirs.push(homeDir);
	const workDir = mkdtempSync(join(tmpdir(), "cc-cli-cwd-"));
	dirs.push(workDir);
	// tsx is resolved by absolute path: a bare `tsx` specifier resolves against the
	// working directory, which is deliberately not the repository here.
	const tsxLoader = join(root, "node_modules/tsx/dist/loader.mjs");
	return spawnSync(process.execPath, ["--import", tsxLoader, cliPath, ...args], {
		cwd: workDir,
		encoding: "utf-8",
		timeout: 30_000,
		env: { ...process.env, HOME: homeDir, ...envOverrides },
	});
}

function homeWithSettings(settings: unknown): string {
	const homeDir = mkdtempSync(join(tmpdir(), "cc-cli-home-"));
	dirs.push(homeDir);
	mkdirSync(join(homeDir, ".claude"), { recursive: true });
	writeFileSync(
		join(homeDir, ".claude", "settings.json"),
		typeof settings === "string" ? settings : JSON.stringify(settings, null, 2),
		"utf-8",
	);
	return homeDir;
}

describe("setup argument validation", () => {
	it("rejects an unknown option instead of silently doing nothing", () => {
		// `setup --Auto` printed the runtime report, configured nothing, and exited 0.
		const result = runCli(["setup", "--Auto"]);

		assert.strictEqual(result.status, 2);
		assert.match(result.stderr, /unknown option "--Auto"/);
		assert.match(result.stderr, /Usage: context-compress setup/);
	});

	it("accepts the documented options", () => {
		const result = runCli(["setup", "--no-filter-bash"]);
		assert.strictEqual(result.status, 0, result.stderr);
	});
});

describe("uninstall exit code", () => {
	it("reports failure when settings.json cannot be parsed", () => {
		// It used to print "Uninstall complete." and exit 0 while the hook was still
		// installed, so a dotfiles or CI script saw success.
		const home = homeWithSettings("{ not valid json");
		const result = runCli(["uninstall"], home);

		assert.strictEqual(result.status, 1);
		assert.match(result.stderr, /Uninstall incomplete/);
		assert.ok(!result.stdout.includes("Uninstall complete."));
	});

	it("succeeds when there is nothing to remove", () => {
		const result = runCli(["uninstall"], homeWithSettings({ theme: "dark" }));
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /Uninstall complete/);
	});

	it("does not fail merely because the `claude` CLI is absent", () => {
		// CI has no `claude` on PATH, so unregisterMcpServer returned "unavailable"
		// and uninstall exited 1 with nothing actually left behind — and blamed
		// settings.json, which had been rewritten fine. Any host that never had
		// Claude Code (CI, a container, a build image) could not uninstall cleanly.
		const nodeDir = dirname(process.execPath);
		const result = runCli(["uninstall"], homeWithSettings({ theme: "dark" }), {
			PATH: `${nodeDir}:/usr/bin:/bin`,
		});

		assert.strictEqual(result.status, 0, result.stderr);
		assert.ok(
			!result.stderr.includes("settings.json could not be modified"),
			`blamed settings.json for an MCP-registration problem: ${result.stderr}`,
		);
	});
});

describe("doctor hook ownership", () => {
	it("does not report a foreign pretooluse hook as ours", () => {
		// doctor matched the `pretooluse.mjs` basename, so another tool's hook made
		// it print PASS while context-compress was not configured at all.
		const home = homeWithSettings({
			hooks: {
				PreToolUse: [
					{ matcher: "Bash", hooks: [{ type: "command", command: "node /other/tool/pretooluse.mjs" }] },
				],
			},
		});

		const result = runCli(["doctor"], home);

		assert.match(result.stdout, /\[WARN\] PreToolUse hook not found/);
		assert.match(result.stdout, /unrelated pretooluse hook is configured/);
		assert.ok(!result.stdout.includes("[PASS] PreToolUse hook configured"));
	});

	it("recognizes a hook installed under this package", () => {
		const home = homeWithSettings({
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash|Read|Grep|WebFetch|Task",
						hooks: [
							{
								type: "command",
								command: "node /usr/local/lib/node_modules/context-compress/hooks/pretooluse.mjs",
							},
						],
					},
				],
			},
		});

		const result = runCli(["doctor"], home);
		assert.match(result.stdout, /\[PASS\] PreToolUse hook configured/);
	});

	it("does not claim all checks passed while a warning is on screen", () => {
		const result = runCli(["doctor"], homeWithSettings({ theme: "dark" }));
		assert.match(result.stdout, /warning\(s\) — see above/);
		assert.ok(!result.stdout.includes("All checks passed."));
	});
});

describe("cleanupStaleDbs", () => {
	it("removes aged store/exec directories and leaves fresh ones alone", () => {
		// The old pattern looked for `context-compress-<pid>.db` files, which nothing
		// creates since the store moved to private random directories — so it always
		// returned 0 while real leftovers accumulated.
		const stale = mkdtempSync(join(tmpdir(), "context-compress-store-"));
		const staleExec = mkdtempSync(join(tmpdir(), "context-compress-exec-"));
		const fresh = mkdtempSync(join(tmpdir(), "context-compress-store-"));
		const unrelated = mkdtempSync(join(tmpdir(), "some-other-tool-"));
		dirs.push(fresh, unrelated);

		writeFileSync(join(stale, "store.db"), "x");
		const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
		// Age the CONTENTS too. A directory's mtime changes only when an entry is
		// added or removed, which sqlite writes never do, so age is now taken from
		// the newest file inside — otherwise a busy peer server's store looked
		// abandoned after an hour and was deleted out from under it.
		utimesSync(join(stale, "store.db"), old, old);
		utimesSync(stale, old, old);
		utimesSync(staleExec, old, old);

		const cleaned = cleanupStaleDbs();

		assert.ok(cleaned >= 2, `expected the aged directories to be swept, cleaned ${cleaned}`);
		assert.ok(!existsSync(stale), "an aged store directory must be removed");
		assert.ok(!existsSync(staleExec), "an aged exec directory must be removed");
		assert.ok(existsSync(fresh), "a fresh directory may still be in use");
		assert.ok(existsSync(unrelated), "another tool's temp directory must be untouched");
	});
});
