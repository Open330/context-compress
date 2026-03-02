import { getConfig } from "./config.js";

export function debug(...args: unknown[]): void {
	if (getConfig().debug) {
		process.stderr.write(`[context-compress] ${args.map(String).join(" ")}\n`);
	}
}

export function warn(...args: unknown[]): void {
	process.stderr.write(`[context-compress WARN] ${args.map(String).join(" ")}\n`);
}

export function error(...args: unknown[]): void {
	process.stderr.write(`[context-compress ERROR] ${args.map(String).join(" ")}\n`);
}
