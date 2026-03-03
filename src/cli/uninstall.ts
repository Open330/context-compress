import { readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export async function uninstall(): Promise<void> {
	console.log("\n  context-compress uninstall\n");
	const changes: string[] = [];

	// 1. Remove hooks from settings.json
	console.log("  Removing hooks from settings.json...");
	const settingsPath = resolve(homedir(), ".claude", "settings.json");
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		const hooks = settings.hooks as Record<string, unknown[]> | undefined;
		if (hooks?.PreToolUse && Array.isArray(hooks.PreToolUse)) {
			const before = hooks.PreToolUse.length;
			hooks.PreToolUse = (hooks.PreToolUse as Array<Record<string, unknown>>).filter((entry) => {
				const entryHooks = entry.hooks as Array<{ command?: string }> | undefined;
				return !entryHooks?.some(
					(h) => h.command?.includes("context-compress") || h.command?.includes("pretooluse.mjs"),
				);
			});
			if (hooks.PreToolUse.length === 0) {
				// biome-ignore lint/performance/noDelete: removing key from JSON object
				delete hooks.PreToolUse;
			}
			if (hooks.PreToolUse === undefined || hooks.PreToolUse.length < before) {
				settings.hooks = hooks;
				writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
				changes.push("Removed PreToolUse hooks from settings.json");
			}
		}
	} catch {
		console.log("  Could not modify settings.json (may not exist)");
	}

	// 2. Remove MCP server registration
	console.log("  Removing MCP server registration...");
	try {
		const mcpPath = resolve(homedir(), ".claude", "settings.json");
		const settings = JSON.parse(readFileSync(mcpPath, "utf-8"));
		const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
		if (mcpServers && "context-compress" in mcpServers) {
			mcpServers["context-compress"] = undefined;
			writeFileSync(mcpPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
			changes.push("Removed context-compress MCP server from settings");
		}
	} catch {
		// May not exist
	}

	// Also check project-level .mcp.json
	try {
		const cwd = process.cwd();
		const mcpJson = resolve(cwd, ".mcp.json");
		const mcp = JSON.parse(readFileSync(mcpJson, "utf-8"));
		const servers = mcp.mcpServers as Record<string, unknown> | undefined;
		if (servers && "context-compress" in servers) {
			servers["context-compress"] = undefined;
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
