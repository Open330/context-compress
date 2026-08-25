import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { cleanupStaleDbs } from "../store.js";
import { isOwnedHookCommand, removeOwnedEnv } from "./hook-ownership.js";
import { resolvePaths, unregisterMcpServer } from "./setup.js";

interface HookEntry {
	matcher?: string;
	hooks?: Array<{ command?: string; type?: string }>;
}

interface Settings {
	hooks?: Record<string, HookEntry[]>;
	mcpServers?: Record<string, unknown>;
	env?: Record<string, string>;
	[key: string]: unknown;
}

/**
 * Delete our hooks from every PreToolUse entry, in place.
 *
 * An entry is dropped only once it holds no hooks at all, so a hook we share an
 * entry with survives. Returns how many hooks were removed.
 */
function removeOwnedHooks(settings: Settings, ownHookPath: string): number {
	const entries = settings.hooks?.PreToolUse;
	if (!Array.isArray(entries)) return 0;

	let removed = 0;
	for (const entry of entries) {
		if (!Array.isArray(entry.hooks)) continue;
		const kept = entry.hooks.filter((hook) => !isOwnedHookCommand(hook.command, ownHookPath));
		removed += entry.hooks.length - kept.length;
		entry.hooks = kept;
	}
	if (removed === 0 || !settings.hooks) return removed;

	const surviving = entries.filter((entry) => (entry.hooks?.length ?? 0) > 0);
	if (surviving.length > 0) {
		settings.hooks.PreToolUse = surviving;
		return removed;
	}
	delete settings.hooks.PreToolUse;
	if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
	return removed;
}

/**
 * Remove only what setup wrote: our hook, our MCP registration, and our env keys.
 *
 * The previous implementation dropped every PreToolUse *entry* whose command
 * merely mentioned `pretooluse.mjs`, which deleted an unrelated tool's hook and
 * any sibling hooks sharing that entry. Removal is now per-hook and
 * ownership-checked, and an entry survives unless it has no hooks left.
 *
 * Exported for tests.
 */
export function removeFromSettings(settingsPath: string): string[] {
	const changes: string[] = [];
	if (!existsSync(settingsPath)) return changes;

	const raw = readFileSync(settingsPath, "utf-8");
	// Throws on malformed JSON rather than rewriting a file we cannot parse.
	const settings = JSON.parse(raw) as Settings;
	const ownHookPath = resolvePaths().hookEntry;

	const removedHooks = removeOwnedHooks(settings, ownHookPath);
	if (removedHooks > 0) changes.push(`Removed ${removedHooks} PreToolUse hook(s)`);

	if (settings.mcpServers && "context-compress" in settings.mcpServers) {
		delete settings.mcpServers["context-compress"];
		changes.push("Removed context-compress MCP server");
	}

	// Symmetry with setup --auto, which writes both of these keys. An emptied
	// `env` object is dropped so the round trip is an exact identity.
	if (removeOwnedEnv(settings.env, changes)) delete settings.env;

	if (changes.length > 0) {
		copyFileSync(settingsPath, `${settingsPath}.bak`);
		writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
	}
	return changes;
}

/**
 * Remove the user-scope MCP registration through the same path setup used.
 * Returns false when the removal was attempted and could not be completed.
 */
function removeMcpRegistration(changes: string[]): boolean {
	console.log("  Removing MCP server registration...");
	const result = unregisterMcpServer();
	if (result.status === "removed") {
		changes.push("Removed the user-scope MCP registration");
		return true;
	}
	if (result.status === "absent") return true;
	if (result.status === "unavailable") {
		// Not a failure. Without the CLI there is no registration this command could
		// have created, and an environment that never had Claude Code — CI, a
		// container, a build image — could otherwise never uninstall cleanly: the
		// exit code was 1 with nothing actually left behind. Still say what to run
		// if a registration does survive somewhere.
		console.error(
			`  Skipped the MCP registration (${result.detail}).\n` +
				"  If one exists, remove it with: claude mcp remove context-compress --scope user",
		);
		return true;
	}
	console.error(
		`  Could not remove the MCP registration (${result.detail}).\n` +
			"  Run: claude mcp remove context-compress --scope user",
	);
	return false;
}

export async function uninstall(): Promise<void> {
	console.log("\n  context-compress uninstall\n");
	const changes: string[] = [];

	// 1. Remove our hook, MCP registration, and env keys in one settings write.
	console.log("  Removing configuration from settings.json...");
	const settingsPath = resolve(homedir(), ".claude", "settings.json");
	// Collected so the summary can name the step that failed. It used to report
	// "settings.json could not be modified" for every failure, including one that
	// came from the MCP registration while settings.json had been rewritten fine.
	const failures: string[] = [];
	try {
		changes.push(...removeFromSettings(settingsPath));
	} catch (err) {
		// Fail closed: a half-understood settings file is never rewritten. Report it
		// through the exit code too — printing "Uninstall complete." and exiting 0
		// while the hook is still installed misleads a dotfiles or CI script.
		failures.push("settings.json could not be modified, so the hook may still be installed");
		console.error(
			`  Could not modify settings.json (${err instanceof Error ? err.message : String(err)})`,
		);
	}

	if (!removeMcpRegistration(changes)) {
		failures.push("the MCP registration could not be removed");
	}

	// Project-level .mcp.json in the CURRENT directory.
	//
	// This edits whatever directory the command happens to run in, which is a
	// surprise: running `uninstall` from an unrelated checkout rewrote that
	// project's config with no mention of the file. It is now reported by path
	// before writing, and skipped entirely unless the entry is actually ours.
	try {
		const mcpJson = resolve(process.cwd(), ".mcp.json");
		const mcp = JSON.parse(readFileSync(mcpJson, "utf-8"));
		const servers = mcp.mcpServers as Record<string, unknown> | undefined;
		if (servers && "context-compress" in servers) {
			delete servers["context-compress"];
			copyFileSync(mcpJson, `${mcpJson}.bak`);
			writeFileSync(mcpJson, `${JSON.stringify(mcp, null, 2)}\n`, "utf-8");
			changes.push(`Removed context-compress from ${mcpJson} (backup: ${mcpJson}.bak)`);
		}
	} catch {
		// May not exist, or is not ours to touch.
	}

	// 3. Clean leftover temp directories.
	// The old predicate looked for `context-compress-*.db` FILES, which nothing has
	// created since the store moved to private random directories — so this step
	// always reported nothing while the real leftovers accumulated.
	console.log("  Cleaning leftover temp directories...");
	try {
		const cleaned = cleanupStaleDbs();
		if (cleaned > 0) changes.push(`Cleaned ${cleaned} leftover temp directory(ies)`);
	} catch {
		// Best effort: another process may own them.
	}

	// Summary
	console.log();
	if (changes.length > 0) {
		for (const change of changes) {
			console.log(`  + ${change}`);
		}
	} else {
		console.log("  Nothing to clean up.");
	}

	if (failures.length > 0) {
		console.error(`\n  Uninstall incomplete: ${failures.join("; ")}.\n`);
		process.exitCode = 1;
		return;
	}

	console.log("\n  Uninstall complete. Restart Claude Code to apply changes.\n");
}
