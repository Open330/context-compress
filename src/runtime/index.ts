import { exec } from "node:child_process";
import { promisify } from "node:util";
import { debug } from "../logger.js";
import type { Language } from "../types.js";
import type { LanguagePlugin } from "./plugin.js";

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

const execAsync = promisify(exec);

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

async function commandExists(cmd: string): Promise<boolean> {
	const checkCmd =
		process.platform === "win32" ? `where ${cmd} 2>nul` : `command -v ${cmd} 2>/dev/null`;
	try {
		await execAsync(checkCmd, { timeout: 3000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Detect all available runtimes in parallel (~40ms vs ~250ms sequential).
 */
export async function detectRuntimes(): Promise<RuntimeMap> {
	const map: RuntimeMap = new Map();

	// Build detection tasks for all plugins in parallel
	const tasks = ALL_PLUGINS.map(async (plugin) => {
		for (const candidate of plugin.runtimeCandidates) {
			if (await commandExists(candidate)) {
				return { plugin, runtime: candidate };
			}
		}
		return null;
	});

	const results = await Promise.all(tasks);

	for (const result of results) {
		if (result) {
			map.set(result.plugin.language, result);
			debug(`Detected ${result.plugin.language}: ${result.runtime}`);
		}
	}

	return map;
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

export { ALL_PLUGINS };
export type { LanguagePlugin } from "./plugin.js";
