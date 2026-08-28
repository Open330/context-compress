import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { describeNativeAbiFailure } from "../../src/util/native-abi.js";

// Verbatim from a real crash: context-compress installed by Homebrew's npm
// (Node 26, ABI 147) and then run by nvm's node (Node 24, ABI 137). Both are
// ordinary installs; neither is misconfigured. Node's own text names two
// numbers, and no package, path, or command that would fix it.
const REAL_MESSAGE =
	"The module '/opt/homebrew/lib/node_modules/context-compress/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
	"was compiled against a different Node.js version using\n" +
	"NODE_MODULE_VERSION 147. This version of Node.js requires\n" +
	"NODE_MODULE_VERSION 137. Please try re-compiling or re-installing\n" +
	"the module (for instance, using `npm rebuild` or `npm install`).";

function realError(): Error & { code: string } {
	const error = new Error(REAL_MESSAGE) as Error & { code: string };
	error.code = "ERR_DLOPEN_FAILED";
	return error;
}

describe("a binding built by another Node is explained, not dumped", () => {
	it("names both sides and a command that fixes it", () => {
		const explained = describeNativeAbiFailure(realError());
		assert.ok(explained !== null, "the real crash was not recognised");

		// The ABI the binding was built for has to survive: it is the only thing
		// distinguishing this from every other load failure.
		assert.match(explained, /147/, `the binding's ABI was dropped:\n${explained}`);
		// And the running side, taken from this process rather than parsed, so the
		// message stays true if Node reworks its wording.
		assert.match(
			explained,
			new RegExp(`ABI ${process.versions.modules}\\b`),
			`the running ABI was dropped:\n${explained}`,
		);
		assert.match(explained, /npm rebuild/, `no command to run:\n${explained}`);
	});

	it("points npm rebuild at the install that actually failed", () => {
		// `npm rebuild better-sqlite3` in whatever directory the user happens to be
		// standing in does nothing. The prefix has to name the package root.
		const explained = describeNativeAbiFailure(realError()) ?? "";
		const prefix = explained.match(/--prefix "([^"]+)"/);
		assert.ok(prefix, `no --prefix in:\n${explained}`);
		assert.match(prefix[1], /context-compress/, prefix[1]);
	});

	it("leaves every other failure alone", () => {
		// Swallowing an unrelated error into this message would hide the real one.
		assert.strictEqual(describeNativeAbiFailure(new Error("boom")), null);
		assert.strictEqual(describeNativeAbiFailure(undefined), null);
		assert.strictEqual(describeNativeAbiFailure(null), null);

		const enoent = new Error("no such file") as Error & { code: string };
		enoent.code = "ENOENT";
		assert.strictEqual(describeNativeAbiFailure(enoent), null);

		// A dlopen failure that is NOT an ABI mismatch — a missing dylib, say —
		// has a different fix, so it must not be given this advice.
		const other = new Error("dlopen(...): symbol not found") as Error & { code: string };
		other.code = "ERR_DLOPEN_FAILED";
		assert.strictEqual(describeNativeAbiFailure(other), null);
	});
});

describe("the CLI catches the failure instead of printing a stack", () => {
	/** Runs the real CLI entry with better-sqlite3's binding refusing to load. */
	function runWithBrokenBinding(args: string[]): string {
		const dir = mkdtempSync(join(tmpdir(), "cc-abi-"));
		const preload = join(dir, "preload.mjs");
		try {
			writeFileSync(
				preload,
				[
					// process.dlopen is where Node itself raises ERR_DLOPEN_FAILED, so
					// failing here reproduces the real thing rather than a stand-in.
					// Match the package directory: better-sqlite3 loads
					// prebuilds/<platform>.node, not a file named better_sqlite3, and it
					// does so lazily on `new Database()` rather than at import.
					"const real = process.dlopen.bind(process)",
					"process.dlopen = function (mod, filename, ...rest) {",
					'  if (String(filename).includes("better-sqlite3")) {',
					`    const e = new Error(${JSON.stringify(REAL_MESSAGE)})`,
					'    e.code = "ERR_DLOPEN_FAILED"',
					"    throw e",
					"  }",
					"  return real(mod, filename, ...rest)",
					"}",
				].join("\n"),
			);
			const r = spawnSync(
				process.execPath,
				["--import", "tsx", "--import", pathToFileURL(preload).href, "src/cli/index.ts", ...args],
				{ encoding: "utf-8", cwd: process.cwd(), timeout: 90_000, input: "" },
			);
			return r.stdout + r.stderr;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("explains it from the top-level handler", () => {
		// Starting the server does not catch anything itself, so this is the bare
		// dispatch path — the one that produced the twelve-frame stack ending in
		// bindings.js that a user actually saw.
		const output = runWithBrokenBinding([]);
		assert.match(output, /built for a different Node/, output.slice(0, 2000));
		assert.ok(
			!/bindings\.js|at Object\.\.node|ERR_DLOPEN_FAILED/.test(output),
			`a raw native stack still reached the user:\n${output.slice(0, 2000)}`,
		);
	});

	it("says the same thing through doctor", () => {
		// doctor catches the failure itself, so the top-level handler never sees it
		// — it printed Node's raw two-number text under a [FAIL] instead.
		const output = runWithBrokenBinding(["doctor"]);
		assert.match(output, /built for a different Node/, output.slice(0, 2000));
		assert.match(output, /npm rebuild/, output.slice(0, 2000));
	});
});
