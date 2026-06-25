import { getConfig } from "./config.js";

// When set, this takes precedence over the global config singleton. Lets the
// entrypoint inject the resolved debug flag (`configureLogger(config.debug)`)
// instead of the logger reaching back into the config singleton on every call.
let debugOverride: boolean | null = null;

/** Inject the debug flag, decoupling the logger from the config singleton. */
export function configureLogger(debugEnabled: boolean): void {
	debugOverride = debugEnabled;
}

/** Reset injected state (used by tests). */
export function resetLogger(): void {
	debugOverride = null;
}

export function debug(...args: unknown[]): void {
	const enabled = debugOverride ?? getConfig().debug;
	if (enabled) {
		process.stderr.write(`[context-compress] ${args.map(String).join(" ")}\n`);
	}
}
