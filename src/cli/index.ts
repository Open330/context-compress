#!/usr/bin/env node
/**
 * context-compress CLI
 *
 * Usage:
 *   context-compress                    → Start MCP server (stdio)
 *   context-compress --help             → Show command help
 *   context-compress --version          → Show the installed version
 *   context-compress setup              → Interactive setup (prints instructions)
 *   context-compress setup --auto       → One-line setup: write ~/.claude/settings.json
 *   context-compress init --auto        → Alias for setup --auto
 *   context-compress doctor             → Diagnose issues
 *   context-compress uninstall          → Clean removal
 *   context-compress filter [--cmd '<orig>']   → stdin → compressed → stdout
 *   context-compress wrap <cmd>         → run cmd, compress its stdout, exit with cmd's code
 */

import { getVersion } from "../util/version.js";

const HELP_TEXT = `Usage: context-compress [command]

Run without a command to start the MCP server on stdio.

Commands:
  setup [--auto]       Configure context-compress (init is an alias)
  doctor               Diagnose installation and configuration issues
  uninstall            Remove context-compress configuration
  filter [options]     Read stdin, compress it, and write to stdout
  wrap <cmd>           Run a command and compress its stdout

Options:
  -h, --help           Show this help
  -v, --version        Show the installed version`;

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

if (command === undefined) {
	// Starting the MCP server is intentionally reserved for the no-argument form.
	await import("../index.js");
} else if (command === "--help" || command === "-h") {
	console.log(HELP_TEXT);
} else if (command === "--version" || command === "-v") {
	console.log(getVersion("unknown"));
} else if (command === "setup" || command === "init") {
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
	console.error(`Unknown command: ${command}\n\n${HELP_TEXT}`);
	process.exit(2);
}
