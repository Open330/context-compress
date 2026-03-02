import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectRuntimes, getRuntimeSummary, hasBun } from "../runtime/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function setup(): Promise<void> {
	console.log("\n  context-compress setup\n");

	// Step 1: Detect runtimes
	console.log("  Detecting runtimes...");
	const runtimes = await detectRuntimes();
	console.log(`  Found ${runtimes.size} languages:\n`);
	console.log(getRuntimeSummary(runtimes));
	console.log();

	// Step 2: Check Bun
	if (hasBun(runtimes)) {
		console.log("  Bun detected — JS/TS will run at maximum speed.\n");
	} else {
		console.log("  Bun not found — JS/TS will use Node.js (install Bun for 3-5x speed).\n");
	}

	// Step 3: Missing optional runtimes
	const all = [
		"python",
		"ruby",
		"go",
		"rust",
		"php",
		"perl",
		"r",
		"elixir",
	] as const;
	const missing = all.filter((lang) => !runtimes.has(lang));
	if (missing.length > 0) {
		console.log(`  Optional runtimes not found: ${missing.join(", ")}`);
		console.log("  Install them to enable additional language support.\n");
	}

	// Step 4: Show installation instructions
	const serverPath = resolve(__dirname, "..", "index.js");
	console.log("  To add to Claude Code, run:");
	console.log(`    claude mcp add context-compress -- node ${serverPath}\n`);

	console.log("  Or add to .mcp.json:");
	console.log(
		JSON.stringify(
			{
				mcpServers: {
					"context-compress": {
						command: "node",
						args: [serverPath],
					},
				},
			},
			null,
			4,
		),
	);

	console.log("\n  Setup complete!\n");
}
