import {
	copyFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isOwnedHookCommand, removeOwnedEnv } from "./hook-ownership.js";
import { resolvePaths } from "./setup.js";

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

	// Symmetry with setup --auto, which writes both of these keys.
	removeOwnedEnv(settings.env, changes);

	if (changes.length > 0) {
		copyFileSync(settingsPath, `${settingsPath}.bak`);
		writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
	}
	return changes;
}

export async function uninstall(): Promise<void> {
	console.log("\n  context-compress uninstall\n");
	const changes: string[] = [];

	// 1. Remove our hook, MCP registration, and env keys in one settings write.
	console.log("  Removing configuration from settings.json...");
	const settingsPath = resolve(homedir(), ".claude", "settings.json");
	try {
		changes.push(...removeFromSettings(settingsPath));
	} catch (err) {
		// Fail closed: a half-understood settings file is never rewritten.
		console.log(
			`  Could not modify settings.json (${err instanceof Error ? err.message : String(err)})`,
		);
	}

	// Also check project-level .mcp.json
	try {
		const cwd = process.cwd();
		const mcpJson = resolve(cwd, ".mcp.json");
		const mcp = JSON.parse(readFileSync(mcpJson, "utf-8"));
		const servers = mcp.mcpServers as Record<string, unknown> | undefined;
		if (servers && "context-compress" in servers) {
			delete servers["context-compress"];
			writeFileSync(mcpJson, `${JSON.stringify(mcp, null, 2)}\n`, "utf-8");
			changes.push("Removed context-compress from .mcp.json");
		}
	} catch {
		// May not exist
	}

	// 3. Clean stale databases
	console.log("  Cleaning stale databases...");
	const dir = tmpdir();
	try {
		const files = readdirSync(dir);
		let cleaned = 0;
		for (const file of files) {
			if (file.startsWith("context-compress-") && file.endsWith(".db")) {
				for (const suffix of ["", "-wal", "-shm"]) {
					try {
						unlinkSync(join(dir, file + suffix));
					} catch {
						// Ignore
					}
				}
				cleaned++;
			}
		}
		if (cleaned > 0) {
			changes.push(`Cleaned ${cleaned} database file(s)`);
		}
	} catch {
		// Ignore
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

	console.log("\n  Uninstall complete. Restart Claude Code to apply changes.\n");
}
