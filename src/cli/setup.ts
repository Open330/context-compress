import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectRuntimes, getRuntimeSummary, hasBun } from "../runtime/index.js";
import {
	buildRunnerCommand,
	isForeignHookCommand,
	isOwnedHookCommand,
	removeOwnedEnv,
	shellQuotePath,
} from "./hook-ownership.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SetupOptions {
	auto: boolean;
	filterBash: boolean;
}

interface ClaudeHook {
	command?: string;
	type?: string;
}

interface ClaudeHookEntry {
	matcher?: string;
	hooks?: ClaudeHook[];
}

interface ClaudeSettings {
	hooks?: Record<string, ClaudeHookEntry[]>;
	mcpServers?: Record<string, { command: string; args: string[] }>;
	env?: Record<string, string>;
	[k: string]: unknown;
}

const PRE_TOOL_USE_MATCHER = "Bash|Read|Grep|WebFetch|Task";

function configurePreToolUseHook(
	hookEntries: ClaudeHookEntry[],
	hookCmd: string,
	ownHookPath: string,
): "Installed" | "Updated" | undefined {
	const currentHook = hookEntries.some(
		(entry) =>
			entry.matcher === PRE_TOOL_USE_MATCHER &&
			entry.hooks?.some((hook) => hook.type === "command" && hook.command === hookCmd),
	);
	if (currentHook) return undefined;

	// Only a hook this package wrote may be rewritten in place; an unrelated
	// tool's identically named pretooluse hook must be left alone.
	const staleEntry = hookEntries.find((entry) =>
		entry.hooks?.some((hook) => isOwnedHookCommand(hook.command, ownHookPath)),
	);
	const staleHook = staleEntry?.hooks?.find((hook) =>
		isOwnedHookCommand(hook.command, ownHookPath),
	);
	if (staleEntry && staleHook) {
		staleEntry.matcher = PRE_TOOL_USE_MATCHER;
		staleHook.type = "command";
		staleHook.command = hookCmd;
		return "Updated";
	}

	hookEntries.push({
		matcher: PRE_TOOL_USE_MATCHER,
		hooks: [{ type: "command", command: hookCmd }],
	});
	return "Installed";
}

/**
 * Resolve the absolute paths the hook + MCP server need. We support two layouts:
 *   - Installed npm package: dist/cli/setup.js → ../index.js, ../../hooks/pretooluse.mjs
 *   - Dev (tsx): src/cli/setup.ts → ../index.js (built) or fall back to src/index.ts
 */
export function resolvePaths(): { serverEntry: string; hookEntry: string; binPath: string } {
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

/** Exported for tests. Throws on malformed JSON instead of returning {} (fail closed). */
export function readSettings(path: string): ClaudeSettings {
	if (!existsSync(path)) return {};
	const raw = readFileSync(path, "utf-8");
	try {
		return JSON.parse(raw) as ClaudeSettings;
	} catch (err) {
		// Fail closed: returning {} here would silently destroy the user's
		// existing hooks/MCP servers/permissions on the next write.
		throw new Error(
			`cannot parse ${path}: ${err instanceof Error ? err.message : String(err)}. ` +
				"Fix the file (or move it aside) and re-run setup. No changes were made.",
		);
	}
}

function writeSettings(path: string, settings: ClaudeSettings): void {
	mkdirSync(dirname(path), { recursive: true });
	// Back up before overwriting so a bad write is recoverable.
	if (existsSync(path)) {
		copyFileSync(path, `${path}.bak`);
	}
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

/** Result of registering the MCP server through the supported Claude Code path. */
export interface McpRegistration {
	status: "registered" | "unavailable" | "failed";
	/** The exact command a user can run themselves. */
	command: string;
	detail: string;
}

type CommandRunner = (
	file: string,
	args: string[],
) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: CommandRunner = (file, args) => {
	const result = spawnSync(file, args, { encoding: "utf-8", timeout: 30_000 });
	return {
		status: result.error ? null : result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
};

/**
 * Register the MCP server with Claude Code.
 *
 * Writing `mcpServers` into settings.json does nothing — the key is ignored —
 * so registration goes through `claude mcp add`, which owns ~/.claude.json and
 * cannot race Claude Code's own writes to it. Re-registering upserts, because
 * `add` refuses a name that already exists.
 */
export function registerMcpServer(
	serverEntry: string,
	run: CommandRunner = defaultRunner,
): McpRegistration {
	const runner = isBuiltJs(serverEntry) ? "node" : "tsx";
	const addArgs = ["mcp", "add", "context-compress", "--scope", "user", "--", runner, serverEntry];
	const command = `claude ${addArgs.map((arg) => shellQuotePath(arg)).join(" ")}`;

	const listed = run("claude", ["mcp", "list"]);
	if (listed.status === null) {
		return {
			status: "unavailable",
			command,
			detail: "the `claude` CLI is not on PATH",
		};
	}
	if (listed.stdout.includes("context-compress")) {
		// Ignore failure: absence is the desired precondition either way.
		run("claude", ["mcp", "remove", "context-compress", "--scope", "user"]);
	}

	const added = run("claude", addArgs);
	if (added.status !== 0) {
		return {
			status: "failed",
			command,
			detail: (added.stderr || added.stdout).trim().split("\n")[0] || "unknown error",
		};
	}
	return { status: "registered", command, detail: `${runner} ${serverEntry}` };
}

/**
 * PreToolUse hook commands that look like a pretooluse hook but are not ours.
 *
 * Reported, never touched. Exported for tests and for the setup summary.
 */
export function findForeignHookCommands(settings: ClaudeSettings, ownHookPath: string): string[] {
	return (settings.hooks?.PreToolUse ?? []).flatMap((entry) =>
		(entry.hooks ?? [])
			.map((hook) => hook.command)
			.filter((command): command is string => isForeignHookCommand(command, ownHookPath)),
	);
}

/** Add or replace context-compress entries in settings.json. Returns list of changes made. */
export function applyAutoConfig(
	settings: ClaudeSettings,
	paths: { serverEntry: string; hookEntry: string; binPath: string },
	filterBash: boolean,
): string[] {
	const changes: string[] = [];

	// MCP registration is deliberately NOT written here. `mcpServers` is not a
	// recognized key in settings.json — Claude Code reads MCP config from
	// ~/.claude.json (user/local scope) or a project .mcp.json — so writing it
	// here registered nothing while the hook below still blocked WebFetch and
	// curl in favour of tools that never appeared. See registerMcpServer().
	if (settings.mcpServers && "context-compress" in settings.mcpServers) {
		delete settings.mcpServers["context-compress"];
		if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
		changes.push("Removed the ineffective settings.json MCP entry written by older versions");
	}

	// 2. PreToolUse hook
	settings.hooks ??= {};
	settings.hooks.PreToolUse ??= [];
	const hookCmd = buildRunnerCommand(isBuiltJs(paths.hookEntry) ? "node" : "tsx", paths.hookEntry);
	const hookEntries = settings.hooks.PreToolUse;
	const hookChange = configurePreToolUseHook(hookEntries, hookCmd, paths.hookEntry);
	if (hookChange) changes.push(`${hookChange} PreToolUse hook (${hookCmd})`);

	// 3. Bash filter mode (opt-in, but on by default with --auto)
	if (filterBash) {
		settings.env ??= {};
		if (settings.env.CONTEXT_COMPRESS_FILTER_BASH !== "1") {
			settings.env.CONTEXT_COMPRESS_FILTER_BASH = "1";
			changes.push("Enabled CONTEXT_COMPRESS_FILTER_BASH=1 (transparent Bash compression)");
		}
		// Pin CONTEXT_COMPRESS_BIN so the hook knows where to find the wrap command.
		const binCmd = buildRunnerCommand(isBuiltJs(paths.binPath) ? "node" : "tsx", paths.binPath);
		if (settings.env.CONTEXT_COMPRESS_BIN !== binCmd) {
			settings.env.CONTEXT_COMPRESS_BIN = binCmd;
			changes.push(`Set CONTEXT_COMPRESS_BIN to ${binCmd}`);
		}
	} else {
		removeOwnedEnv(settings.env, changes);
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
	console.log(`    claude mcp add context-compress -- node ${shellQuotePath(serverEntry)}\n`);
	console.log("  Or use --auto to do everything automatically:");
	console.log("    context-compress setup --auto\n");
}

export async function setup(args: string[] = []): Promise<void> {
	// Unknown arguments used to be ignored, so `setup --Auto` printed the runtime
	// report, configured nothing, and exited 0 with no indication. filter/wrap
	// already reject unknown options; setup was the unfinished edge of that work.
	const KNOWN_FLAGS = new Set(["--auto", "--no-filter-bash", "--filter-bash"]);
	const unknown = args.filter((arg) => !KNOWN_FLAGS.has(arg));
	if (unknown.length > 0) {
		console.error(
			`context-compress setup: unknown option "${unknown[0]}"\n` +
				`Usage: context-compress setup [--auto] [--no-filter-bash]`,
		);
		process.exitCode = 2;
		return;
	}

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

	// Register the MCP server BEFORE installing the hook. The hook denies WebFetch
	// and curl and points the agent at mcp__context-compress__* tools, so
	// installing it without working tools leaves the agent strictly worse off than
	// before setup ran.
	console.log("  Registering MCP server with Claude Code...");
	const registration = registerMcpServer(paths.serverEntry);
	if (registration.status !== "registered") {
		console.error(`\n  Setup aborted: could not register the MCP server (${registration.detail}).`);
		console.error("  The PreToolUse hook was NOT installed, because it denies WebFetch and curl");
		console.error("  in favour of the MCP tools — installing it now would leave you with neither.");
		console.error(`\n  Run this, then re-run setup --auto:\n    ${registration.command}\n`);
		process.exitCode = 1;
		return;
	}
	console.log(`  + Registered MCP server (${registration.detail})`);

	// --auto: write settings.json directly
	const settingsPath = resolve(homedir(), ".claude", "settings.json");
	console.log(`  Writing config to ${settingsPath}...`);
	let settings: ClaudeSettings;
	try {
		settings = readSettings(settingsPath);
	} catch (err) {
		console.error(`\n  Setup aborted: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
		return;
	}
	const foreign = findForeignHookCommands(settings, paths.hookEntry);
	const changes = applyAutoConfig(settings, paths, opts.filterBash);

	for (const command of foreign) {
		console.log(`\n  Note: left an unrecognized PreToolUse hook untouched: ${command}`);
		console.log("        If that was an older context-compress install, remove it manually.");
	}

	if (changes.length === 0) {
		console.log("  Already configured. No changes made.\n");
	} else {
		writeSettings(settingsPath, settings);
		console.log();
		for (const c of changes) console.log(`  + ${c}`);
		console.log(`  Backup saved to ${settingsPath}.bak`);
		console.log();
	}

	console.log("  Setup complete! Restart Claude Code to load the new configuration.");
	console.log(
		opts.filterBash
			? "  Bash output for git/npm/cargo/test/find/docker/kubectl/... will be auto-compressed.\n"
			: "  Tip: pass --filter-bash on next setup to enable transparent Bash compression.\n",
	);
}
