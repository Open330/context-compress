#!/usr/bin/env node
/**
 * context-compress CLI
 *
 * Usage:
 *   context-compress                    → Start MCP server (stdio)
 *   context-compress setup              → Interactive setup (prints instructions)
 *   context-compress setup --auto       → One-line setup: write ~/.claude/settings.json
 *   context-compress init --auto        → Alias for setup --auto
 *   context-compress doctor             → Diagnose issues
 *   context-compress uninstall          → Clean removal
 *   context-compress filter [--cmd '<orig>']   → stdin → compressed → stdout
 *   context-compress wrap <cmd>         → run cmd, compress its stdout, exit with cmd's code
 */

// better-sqlite3 declares `engines: {node: ">=22"}` but npm only warns, and on an
// older runtime the native binding segfaults with no diagnostic at all. Fail with
// a sentence the user can act on instead.
const MIN_NODE_MAJOR = 22;
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (Number.isFinite(nodeMajor) && nodeMajor < MIN_NODE_MAJOR) {
	console.error(
		`context-compress requires Node >= ${MIN_NODE_MAJOR} (running ${process.version}).\n` +
			"Node 18 and 20 are both past end-of-life; the SQLite binding crashes on them.\n" +
			"Upgrade Node, or pin context-compress@2026.7.0.",
	);
	process.exit(1);
}

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

if (command === "setup" || command === "init") {
	const { setup } = await import("./setup.js");
	await setup(rest);
} else if (command === "doctor") {
	const { doctor } = await import("./doctor.js");
	const code = await doctor();
	process.exit(code);
} else if (command === "uninstall") {
	const { uninstall } = await import("./uninstall.js");
	await uninstall();
} else if (command === "filter") {
	const { runFilter } = await import("./filter.js");
	process.exit(await runFilter(rest));
} else if (command === "wrap") {
	const { runWrap } = await import("./filter.js");
	process.exit(await runWrap(rest));
} else {
	// Default: start MCP server
	await import("../index.js");
}
