#!/usr/bin/env node
/**
 * context-compress lite CLI — only the filter/wrap commands.
 *
 * No MCP server, no SQLite, no better-sqlite3 native bindings. Designed to
 * be compiled into a single static binary via `bun build --compile` for
 * RTK-style "curl | sh" install — covers the transparent shell-filter
 * use case without any Node.js or npm install.
 *
 * Usage:
 *   cc-lite filter [--cmd '<orig>']        Read stdin → compressed → stdout.
 *   cc-lite wrap [--stream] <cmd...>       Run cmd, compress its stdout.
 */

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

async function main(): Promise<number> {
	if (command === "filter") {
		const { runFilter } = await import("./filter.js");
		return await runFilter(rest);
	}
	if (command === "wrap") {
		const { runWrap } = await import("./filter.js");
		return await runWrap(rest);
	}
	if (command === "--help" || command === "-h" || !command) {
		process.stderr.write(
			"context-compress lite CLI\n\n" +
				"  filter [--cmd '<orig>']        stdin → compressed → stdout\n" +
				"  wrap [--stream] <cmd...>       run cmd, compress stdout, propagate exit code\n",
		);
		return command ? 0 : 2;
	}
	process.stderr.write(`Unknown command: ${command}\n`);
	return 2;
}

main().then((code) => process.exit(code));
