import { accessSync, constants } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { debug } from "../logger.js";
import type { Language } from "../types.js";
// Import all language plugins
import { elixirPlugin } from "./languages/elixir.js";
import { goPlugin } from "./languages/go.js";
import { javascriptPlugin } from "./languages/javascript.js";
import { perlPlugin } from "./languages/perl.js";
import { phpPlugin } from "./languages/php.js";
import { pythonPlugin } from "./languages/python.js";
import { rPlugin } from "./languages/r.js";
import { rubyPlugin } from "./languages/ruby.js";
import { rustPlugin } from "./languages/rust.js";
import { shellPlugin } from "./languages/shell.js";
import { typescriptPlugin } from "./languages/typescript.js";
import type { LanguagePlugin } from "./plugin.js";

const ALL_PLUGINS: LanguagePlugin[] = [
	javascriptPlugin,
	typescriptPlugin,
	pythonPlugin,
	shellPlugin,
	rubyPlugin,
	goPlugin,
	rustPlugin,
	phpPlugin,
	perlPlugin,
	rPlugin,
	elixirPlugin,
];

export type RuntimeMap = Map<Language, { plugin: LanguagePlugin; runtime: string }>;

const PATH_DIRS = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
const WIN_EXTS = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);

/**
 * Check whether an executable is on PATH by scanning the filesystem directly.
 *
 * This replaces the previous shell-based `command -v ${cmd}` / `where ${cmd}`,
 * which both interpolated `cmd` into a shell string and spawned one shell per
 * candidate (~19 processes across all plugins). Scanning PATH with `accessSync`
 * spawns nothing and never touches a shell, eliminating both the injection
 * surface and the process-spawn overhead.
 */
function commandExists(cmd: string): boolean {
	// Names with a path separator are resolved relative to cwd, not PATH.
	if (cmd.includes("/") || cmd.includes("\\")) {
		return isExecutable(cmd);
	}
	const exts = process.platform === "win32" ? WIN_EXTS : [""];
	for (const dir of PATH_DIRS) {
		for (const ext of exts) {
			if (isExecutable(join(dir, cmd + ext))) return true;
		}
	}
	return false;
}

function isExecutable(filePath: string): boolean {
	try {
		// On Windows the executable bit is not meaningful; existence is enough.
		accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Detect all available runtimes by scanning PATH (no subprocesses spawned).
 */
export function detectRuntimes(): RuntimeMap {
	const map: RuntimeMap = new Map();

	for (const plugin of ALL_PLUGINS) {
		for (const candidate of plugin.runtimeCandidates) {
			if (commandExists(candidate)) {
				map.set(plugin.language, { plugin, runtime: candidate });
				debug(`Detected ${plugin.language}: ${candidate}`);
				break;
			}
		}
	}

	return map;
}

/**
 * Resolve one specific runtime binary by name, or null when it isn't installed.
 *
 * Used when a caller cannot accept the fastest available runtime (see
 * ExecOptions.requireRuntime). The currently-running binary is checked first: it
 * is frequently the exact one asked for and may live outside PATH (nvm shims,
 * packaged installs).
 */
export function findRuntimeBinary(name: string): string | null {
	const self = basename(process.execPath).replace(/\.exe$/i, "");
	if (self === name) return process.execPath;
	return commandExists(name) ? name : null;
}

/**
 * Get a human-readable summary of detected runtimes.
 */
export function getRuntimeSummary(runtimes: RuntimeMap): string {
	const lines: string[] = [];
	for (const [lang, { runtime }] of runtimes) {
		lines.push(`  ${lang}: ${runtime}`);
	}
	return lines.join("\n");
}

/**
 * Check if Bun is available (for display in tool descriptions).
 */
export function hasBun(runtimes: RuntimeMap): boolean {
	const js = runtimes.get("javascript");
	return js?.runtime === "bun";
}

export type { LanguagePlugin } from "./plugin.js";
export { ALL_PLUGINS };
