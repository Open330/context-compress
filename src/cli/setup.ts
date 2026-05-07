import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectRuntimes, getRuntimeSummary, hasBun } from "../runtime/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SetupOptions {
	auto: boolean;
	filterBash: boolean;
}

interface ClaudeSettings {
	hooks?: Record<
		string,
		Array<{ matcher?: string; hooks?: Array<{ command?: string; type?: string }> }>
	>;
	mcpServers?: Record<string, { command: string; args: string[] }>;
	env?: Record<string, string>;
	[k: string]: unknown;
}

/**
 * Resolve the absolute paths the hook + MCP server need. We support two layouts:
 *   - Installed npm package: dist/cli/setup.js → ../index.js, ../../hooks/pretooluse.mjs
 *   - Dev (tsx): src/cli/setup.ts → ../index.js (built) or fall back to src/index.ts
 */
function resolvePaths(): { serverEntry: string; hookEntry: string; binPath: string } {
	const distServer = resolve(__dirname, "..", "index.js");
	const distHook = resolve(__dirname, "..", "..", "hooks", "pretooluse.mjs");
	const distCli = resolve(__dirname, "index.js");
	const srcHook = resolve(__dirname, "..", "hooks", "pretooluse.ts");
	const srcCli = resolve(__dirname, "index.ts");

	const serverEntry = existsSync(distServer) ? distServer : resolve(__dirname, "..", "index.ts");
	const hookEntry = existsSync(distHook) ? distHook : srcHook;
	const binPath = existsSync(distCli) ? distCli : srcCli;
	return { serverEntry, hookEntry, binPath };
}

function isBuiltJs(p: string): boolean {
	return p.endsWith(".js") || p.endsWith(".mjs");
}

function readSettings(path: string): ClaudeSettings {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as ClaudeSettings;
	} catch {
		return {};
	}
}

function writeSettings(path: string, settings: ClaudeSettings): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

/** Add or replace context-compress entries in settings.json. Returns list of changes made. */
export function applyAutoConfig(
	settings: ClaudeSettings,
	paths: { serverEntry: string; hookEntry: string; binPath: string },
	filterBash: boolean,
): string[] {
	const changes: string[] = [];

	// 1. MCP server registration
	const serverCmd = isBuiltJs(paths.serverEntry) ? "node" : "tsx";
	const serverArgs = [paths.serverEntry];
	settings.mcpServers ??= {};
	const existing = settings.mcpServers["context-compress"];
	if (
		!existing ||
		existing.command !== serverCmd ||
		JSON.stringify(existing.args) !== JSON.stringify(serverArgs)
	) {
		settings.mcpServers["context-compress"] = { command: serverCmd, args: serverArgs };
		changes.push(`Registered MCP server (${serverCmd} ${paths.serverEntry})`);
	}

	// 2. PreToolUse hook
	settings.hooks ??= {};
	settings.hooks.PreToolUse ??= [];
	const hookCmd = isBuiltJs(paths.hookEntry) ? `node ${paths.hookEntry}` : `tsx ${paths.hookEntry}`;
	const hookEntries = settings.hooks.PreToolUse;
	const alreadyInstalled = hookEntries.some((entry) =>
		entry.hooks?.some((h) => h.command?.includes("pretooluse")),
	);
	if (!alreadyInstalled) {
		hookEntries.push({
			matcher: "Bash|Read|Grep|WebFetch|Task",
			hooks: [{ type: "command", command: hookCmd }],
		});
		changes.push(`Installed PreToolUse hook (${hookCmd})`);
	}

	// 3. Bash filter mode (opt-in, but on by default with --auto)
	if (filterBash) {
		settings.env ??= {};
		if (settings.env.CONTEXT_COMPRESS_FILTER_BASH !== "1") {
			settings.env.CONTEXT_COMPRESS_FILTER_BASH = "1";
			changes.push("Enabled CONTEXT_COMPRESS_FILTER_BASH=1 (transparent Bash compression)");
		}
		// Pin CONTEXT_COMPRESS_BIN so the hook knows where to find the wrap command.
		const binCmd = isBuiltJs(paths.binPath) ? `node ${paths.binPath}` : `tsx ${paths.binPath}`;
		if (settings.env.CONTEXT_COMPRESS_BIN !== binCmd) {
			settings.env.CONTEXT_COMPRESS_BIN = binCmd;
			changes.push(`Set CONTEXT_COMPRESS_BIN to ${binCmd}`);
		}
	}

	return changes;
}

function showRuntimes(): void {
	console.log("  Detecting runtimes...");
}

async function showRuntimeReport(): Promise<void> {
	showRuntimes();
	const runtimes = await detectRuntimes();
	console.log(`  Found ${runtimes.size} languages:\n`);
	console.log(getRuntimeSummary(runtimes));
	console.log();

	if (hasBun(runtimes)) {
		console.log("  Bun detected — JS/TS will run at maximum speed.\n");
	} else {
		console.log("  Bun not found — JS/TS will use Node.js (install Bun for 3-5x speed).\n");
	}

	const optional = ["python", "ruby", "go", "rust", "php", "perl", "r", "elixir"] as const;
	const missing = optional.filter((lang) => !runtimes.has(lang));
	if (missing.length > 0) {
		console.log(`  Optional runtimes not found: ${missing.join(", ")}`);
		console.log("  Install them to enable additional language support.\n");
	}
}

function showInstructions(serverEntry: string): void {
	console.log("  To add to Claude Code, run:");
	console.log(`    claude mcp add context-compress -- node ${serverEntry}\n`);
	console.log("  Or use --auto to do everything automatically:");
	console.log("    context-compress setup --auto\n");
}

export async function setup(args: string[] = []): Promise<void> {
	const opts: SetupOptions = {
		auto: args.includes("--auto"),
		filterBash: !args.includes("--no-filter-bash"),
	};

	console.log("\n  context-compress setup\n");

	await showRuntimeReport();

	const paths = resolvePaths();

	if (!opts.auto) {
		showInstructions(paths.serverEntry);
		console.log("  Setup complete!\n");
		return;
	}

	// --auto: write settings.json directly
	const settingsPath = resolve(homedir(), ".claude", "settings.json");
	console.log(`  Writing config to ${settingsPath}...`);
	const settings = readSettings(settingsPath);
	const changes = applyAutoConfig(settings, paths, opts.filterBash);

	if (changes.length === 0) {
		console.log("  Already configured. No changes made.\n");
	} else {
		writeSettings(settingsPath, settings);
		console.log();
		for (const c of changes) console.log(`  + ${c}`);
		console.log();
	}

	console.log("  Setup complete! Restart Claude Code to load the new configuration.");
	console.log(
		opts.filterBash
			? "  Bash output for git/npm/cargo/test/find/docker/kubectl/... will be auto-compressed.\n"
			: "  Tip: pass --filter-bash on next setup to enable transparent Bash compression.\n",
	);
}
