import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadConfig, resolveProjectDir } from "../config.js";
import { SubprocessExecutor } from "../executor.js";
import { detectRuntimes, getRuntimeSummary, hasBun } from "../runtime/index.js";
import { describeNativeAbiFailure } from "../util/native-abi.js";
import { getVersion } from "../util/version.js";
import { isForeignHookCommand, isOwnedHookCommand, runnerScriptPath } from "./hook-ownership.js";
import { resolvePaths } from "./setup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSettings(): Record<string, unknown> | null {
	try {
		const path = resolve(homedir(), ".claude", "settings.json");
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * Whether a store directory can actually be written to. The leaf is created on
 * first use, so a missing directory is fine as long as the nearest existing
 * ancestor is writable — but an existing, unwritable path is not.
 */
function isWritableTarget(dir: string): boolean {
	let probe = dir;
	for (;;) {
		if (existsSync(probe)) {
			try {
				accessSync(probe, constants.W_OK);
				return true;
			} catch {
				return false;
			}
		}
		const parent = dirname(probe);
		if (parent === probe) return false;
		probe = parent;
	}
}

/**
 * Report whether the content store is durable. Returns the warning count.
 *
 * Split out of doctor() because that function already exceeds the cognitive
 * complexity budget; inlining another branch made a flagged function worse.
 */
function reportIndexPersistence(): number {
	try {
		const { persistDb, dbDir } = loadConfig();
		if (persistDb) {
			const dir = dbDir ?? join(resolveProjectDir(), ".context-compress");
			// createServer falls back to ":memory:" when the DB cannot be opened, so a
			// configured-but-unwritable dbDir is silently non-persistent at runtime.
			if (!isWritableTarget(dir)) {
				console.log(`  [WARN] Index dir is not writable: ${dir}`);
				console.log("         The store falls back to :memory: — persistence is off.");
				return 1;
			}
			console.log(`  [PASS] Index persisted at ${join(dir, "store.db")}`);
			return 0;
		}
		console.log("  [WARN] Index is in-memory — search() cannot reach anything indexed");
		console.log("         before this process started, and cumulative stats are never");
		console.log("         written. Compression still works; retrieval does not persist.");
		console.log("         Enable: CONTEXT_COMPRESS_PERSIST_DB=1 (or set dbDir).");
		return 1;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`  [WARN] Index persistence: could not read config — ${msg}`);
		return 1;
	}
}

export async function doctor(): Promise<number> {
	console.log("\n  context-compress doctor\n");
	let criticalFails = 0;
	// Warnings are not failures, but reporting "All checks passed" while a warning
	// is on screen made the summary contradict the report — and a CI script reading
	// only the exit code could not tell a configured install from an unconfigured one.
	let warnings = 0;

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

	/** The hook path settings.json actually points at, when one is configured. */
	let configuredHookPath: string | null = null;

	// 3. Hooks
	console.log("\n  Checking hooks...");
	const settings = readSettings();
	if (settings) {
		const hooks = settings.hooks as Record<string, unknown[]> | undefined;
		const preToolUse = hooks?.PreToolUse as
			| Array<{ hooks?: Array<{ command?: string }> }>
			| undefined;
		// Use the same ownership rule as setup and uninstall. Matching only the
		// `pretooluse.mjs` basename reported PASS when the configured hook belonged
		// to a different tool, and WARN right after a successful dev-mode setup,
		// whose hook is `pretooluse.ts`.
		const ownHookPath = resolvePaths().hookEntry;
		const commands = (preToolUse ?? []).flatMap((entry) =>
			(entry.hooks ?? []).map((hook) => hook.command),
		);
		const ownedCommand = commands.find((command) => isOwnedHookCommand(command, ownHookPath));
		if (ownedCommand) {
			console.log("  [PASS] PreToolUse hook configured");
			// The path that will actually run, which is not necessarily the copy this
			// binary was loaded from. Any change of global prefix — an nvm version
			// bump, a reinstall to a different root — leaves settings.json pointing at
			// a path that no longer exists, and checking the bundled copy reported
			// "Hook script exists / integrity verified / All checks passed" anyway.
			configuredHookPath = runnerScriptPath(ownedCommand);
		} else {
			warnings++;
			console.log("  [WARN] PreToolUse hook not found — run setup to configure");
			const foreign = commands.filter((command) => isForeignHookCommand(command, ownHookPath));
			for (const command of foreign) {
				console.log(`         (an unrelated pretooluse hook is configured: ${command})`);
			}
		}
	} else {
		warnings++;
		console.log("  [WARN] Could not read ~/.claude/settings.json");
	}

	// 4. Hook script + integrity — of the configured path when there is one.
	const hookPath = configuredHookPath ?? resolve(__dirname, "..", "..", "hooks", "pretooluse.mjs");
	try {
		accessSync(hookPath, constants.R_OK);
		console.log("  [PASS] Hook script exists");

		// SHA-256 integrity check
		const hookContent = readFileSync(hookPath);
		const hash = createHash("sha256").update(hookContent).digest("hex");
		// Next to whichever script is being verified, not next to this binary.
		const checksumPath = `${hookPath.replace(/\.(mjs|ts)$/, "")}.sha256`;
		try {
			const expectedHash = readFileSync(checksumPath, "utf-8").trim();
			if (hash === expectedHash) {
				console.log(`  [PASS] Hook integrity: SHA-256 verified (${hash.slice(0, 12)}...)`);
			} else {
				warnings++;
				console.log("  [WARN] Hook integrity: SHA-256 MISMATCH");
				console.log(`         Expected: ${expectedHash.slice(0, 16)}...`);
				console.log(`         Got:      ${hash.slice(0, 16)}...`);
				console.log("         Hook may have been modified. Rebuild with: npm run build:hooks");
			}
		} catch {
			// No checksum file yet — show hash for reference
			console.log(
				`  [INFO] Hook SHA-256: ${hash.slice(0, 12)}... (no checksum file to verify against)`,
			);
		}
	} catch {
		warnings++;
		console.log(`  [WARN] Hook script not found at ${hookPath}`);
	}

	// 5. FTS5 / better-sqlite3
	console.log("\n  Checking FTS5...");
	try {
		const db = new Database(":memory:");
		db.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
		db.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
		const row = db.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as
			| {
					content: string;
			  }
			| undefined;
		db.close();
		if (row?.content === "hello world") {
			console.log("  [PASS] FTS5 / better-sqlite3 works");
		} else {
			criticalFails++;
			console.log("  [FAIL] FTS5 returned unexpected result");
		}
	} catch (err) {
		criticalFails++;
		// An ABI mismatch arrives here as Node's own text, which names two numbers
		// and nothing the user can act on. doctor is the command whose whole job is
		// to say what to do about it.
		const abi = describeNativeAbiFailure(err);
		if (abi) {
			console.log(`  [FAIL] FTS5: the SQLite binding could not load.\n`);
			for (const line of abi.split("\n")) console.log(`  ${line}`);
		} else {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`  [FAIL] FTS5: ${msg}`);
		}
	}

	// 6. Index persistence — the FTS5 check above proves the capability exists, not
	// that anything is kept. With the default persistDb=false the store opens at
	// ":memory:", so search() only ever sees what this process indexed and the
	// cumulative stats file is never written. Both look identical to a healthy
	// install until you restart, and doctor previously reported "All checks passed".
	console.log("\n  Checking index persistence...");
	warnings += reportIndexPersistence();

	// 7. Version
	const version = getVersion("unknown");
	console.log(`\n  Version: v${version}`);

	// Summary
	console.log();
	if (criticalFails > 0) {
		console.log(`  ${criticalFails} critical issue(s) found.\n`);
		return 1;
	}
	if (warnings > 0) {
		console.log(`  ${warnings} warning(s) — see above. No critical issues.\n`);
		return 0;
	}
	console.log("  All checks passed.\n");
	return 0;
}
