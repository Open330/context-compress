#!/usr/bin/env node
/**
 * context-compress CLI
 *
 * Usage:
 *   context-compress          → Start MCP server (stdio)
 *   context-compress setup    → Interactive setup
 *   context-compress doctor   → Diagnose issues
 *   context-compress uninstall → Clean removal
 */

const args = process.argv.slice(2);
const command = args[0];

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
} else {
	// Default: start MCP server
	await import("../index.js");
}
