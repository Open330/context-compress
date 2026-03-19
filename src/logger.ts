import { getConfig } from "./config.js";

export function debug(...args: unknown[]): void {
	if (getConfig().debug) {
		process.stderr.write(`[context-compress] ${args.map(String).join(" ")}\n`);
	}
}
