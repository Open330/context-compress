#!/usr/bin/env node
/**
 * context-compress CLI
 *
 * Usage:
 *   context-compress              → Start MCP server (stdio)
 *   context-compress setup        → Interactive setup
 *   context-compress doctor       → Diagnose issues
 *   context-compress uninstall    → Clean removal
 *   context-compress filter [--cmd '<orig>']  → stdin → compressed → stdout
 *   context-compress wrap <cmd>   → run cmd, compress its stdout, exit with cmd's code
 */

const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1);

if (command === "setup") {
	const { setup } = await import("./setup.js");
	await setup();
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
