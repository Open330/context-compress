import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SubprocessExecutor } from "../executor.js";
import { loadConfig } from "../config.js";
import { detectRuntimes, getRuntimeSummary, hasBun } from "../runtime/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
	try {
		const pkg = JSON.parse(
			readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf-8"),
		);
		return pkg.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

function readSettings(): Record<string, unknown> | null {
	try {
		const path = resolve(homedir(), ".claude", "settings.json");
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

export async function doctor(): Promise<number> {
	console.log("\n  context-compress doctor\n");
	let criticalFails = 0;

	// 1. Runtimes
	console.log("  Detecting runtimes...");
	const runtimes = await detectRuntimes();
	console.log(getRuntimeSummary(runtimes));
	console.log();

	if (hasBun(runtimes)) {
		console.log("  [PASS] Performance: FAST — Bun detected");
	} else {
		console.log("  [WARN] Performance: NORMAL — Using Node.js (install Bun for 3-5x speed)");
	}

	const pct = ((runtimes.size / 11) * 100).toFixed(0);
	if (runtimes.size < 2) {
		criticalFails++;
		console.log(`  [FAIL] Language coverage: ${runtimes.size}/11 (${pct}%)`);
	} else {
		console.log(`  [PASS] Language coverage: ${runtimes.size}/11 (${pct}%)`);
	}

	// 2. Server test
	console.log("\n  Testing server...");
	try {
		const config = loadConfig();
		const executor = new SubprocessExecutor(runtimes, config);
		const result = await executor.execute({
			language: "javascript",
			code: 'console.log("ok");',
			timeout: 5000,
		});
		if (result.exitCode === 0 && result.stdout.trim() === "ok") {
			console.log("  [PASS] Server test: OK");
		} else {
			criticalFails++;
			console.log(`  [FAIL] Server test: exit ${result.exitCode}`);
		}
	} catch (err) {
		criticalFails++;
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`  [FAIL] Server test: ${msg}`);
	}

	// 3. Hooks
	console.log("\n  Checking hooks...");
	const settings = readSettings();
	if (settings) {
		const hooks = settings.hooks as Record<string, unknown[]> | undefined;
		const preToolUse = hooks?.PreToolUse as Array<{ hooks?: Array<{ command?: string }> }> | undefined;
		if (preToolUse?.some((e) => e.hooks?.some((h) => h.command?.includes("pretooluse.mjs")))) {
			console.log("  [PASS] PreToolUse hook configured");
		} else {
			console.log("  [WARN] PreToolUse hook not found — run setup to configure");
		}
	} else {
		console.log("  [WARN] Could not read ~/.claude/settings.json");
	}

	// 4. Hook script
	const hookPath = resolve(__dirname, "..", "..", "hooks", "pretooluse.mjs");
	try {
		accessSync(hookPath, constants.R_OK);
		console.log("  [PASS] Hook script exists");
	} catch {
		console.log(`  [WARN] Hook script not found at ${hookPath}`);
	}

	// 5. FTS5 / better-sqlite3
	console.log("\n  Checking FTS5...");
	try {
		const db = new Database(":memory:");
		db.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
		db.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
		const row = db.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as {
			content: string;
		} | undefined;
		db.close();
		if (row?.content === "hello world") {
			console.log("  [PASS] FTS5 / better-sqlite3 works");
		} else {
			criticalFails++;
			console.log("  [FAIL] FTS5 returned unexpected result");
		}
	} catch (err) {
		criticalFails++;
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`  [FAIL] FTS5: ${msg}`);
	}

	// 6. Version
	const version = getVersion();
	console.log(`\n  Version: v${version}`);

	// Summary
	console.log();
	if (criticalFails > 0) {
		console.log(`  ${criticalFails} critical issue(s) found.\n`);
		return 1;
	}
	console.log("  All checks passed.\n");
	return 0;
}
