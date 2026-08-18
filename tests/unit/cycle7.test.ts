import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { compressOutput, runWrap } from "../../src/cli/filter.js";
import { loadConfig, resetConfig } from "../../src/config.js";
import { applyCommandFilter, filterTestOutput } from "../../src/filters.js";
import { countErrorLines } from "../../src/format-filter.js";
import { isPrivateHost } from "../../src/network.js";

const dirs: string[] = [];
const ORIGINAL_HOME = process.env.HOME;
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempProject(config: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "cc-c7-"));
	dirs.push(dir);
	writeFileSync(join(dir, ".context-compress.json"), JSON.stringify(config), "utf-8");
	return dir;
}

describe("config: a project file cannot raise the memory guard", () => {
	beforeEach(() => resetConfig());
	afterEach(() => {
		resetConfig();
		if (ORIGINAL_HOME === undefined) delete process.env.HOME;
		else process.env.HOME = ORIGINAL_HOME;
	});

	it("does not let maxOutputBytes drag hardCapBytes up with it", () => {
		// hardCapBytes was user-scope-only, but the sanity clamp raised it UP to
		// maxOutputBytes — which was not — so a repo could restore a 900MB stream
		// cap. Past ~512MB, Buffer.concat().toString() throws RangeError inside the
		// child's close listener and the server's uncaughtException handler exits.
		process.env.HOME = mkdtempSync(join(tmpdir(), "cc-c7-home-"));
		dirs.push(process.env.HOME);
		const cfg = loadConfig(tempProject({ maxOutputBytes: 900_000_000 }));

		assert.ok(cfg.hardCapBytes <= 16 * 1024 * 1024, `capture cap was raised to ${cfg.hardCapBytes}`);
		assert.ok(cfg.maxOutputBytes <= cfg.hardCapBytes, "the budget must not exceed the guard");
	});

	it("clamps a home-set budget down to the capture cap, not the reverse", () => {
		const home = mkdtempSync(join(tmpdir(), "cc-c7-home-"));
		dirs.push(home);
		writeFileSync(
			join(home, ".context-compress.json"),
			JSON.stringify({ hardCapBytes: 50_000, maxOutputBytes: 900_000 }),
			"utf-8",
		);
		process.env.HOME = home;
		const cfg = loadConfig();

		assert.strictEqual(cfg.hardCapBytes, 50_000, "the guard is what the user asked for");
		assert.strictEqual(cfg.maxOutputBytes, 50_000, "the budget is clamped down to it");
	});
});

describe("wrap: the child's flags are the child's", () => {
	it("does not consume a --mode that belongs to the command", async () => {
		// resolveMode scanned the RAW argument array before parseWrapArgs decided
		// where the command begins, so `wrap webpack --mode production` failed with
		// "invalid --mode" and never ran anything — even after `--`.
		for (const args of [
			["echo", "--mode", "production"],
			["--", "echo", "--mode", "production"],
			["echo", "--mode"],
		]) {
			assert.strictEqual(await runWrap(args), 0, JSON.stringify(args));
		}
	});

	it("still validates its own --mode before the command", async () => {
		assert.strictEqual(await runWrap(["--mode", "nonsense", "echo", "hi"]), 2);
		assert.strictEqual(await runWrap(["--mode", "aggressive", "echo", "hi"]), 0);
	});
});

describe("compressOutput enforces the response budget", () => {
	it("caps the CLI/hook path like the executor caps its own", () => {
		// This pipeline reproduced every compression stage except the one that
		// bounds the result, so a wrapped build returned megabytes where the same
		// command through `execute` returned maxOutputBytes with a marker.
		const huge = Array.from({ length: 40_000 }, (_, i) => `src/file${i}.ts:${i}:1 unique note ${i}`).join("\n");
		const out = compressOutput(huge, "make -j8", "balanced", 20_000);

		assert.ok(Buffer.byteLength(out) <= 20_000, `got ${Buffer.byteLength(out)} bytes`);
		assert.match(out, /truncated/, "truncation must be stated");
	});

	it("leaves output under the budget untouched", () => {
		const small = "one line of output\n";
		assert.strictEqual(compressOutput(small, undefined, "balanced", 20_000), small);
	});
});

describe("filters: declining to filter must not suppress the format fallback", () => {
	it("still compresses structured output a command filter passed through", () => {
		// withFloor forced filtered:true, so filters that deliberately declined
		// (filterPs on an unknown header) set commandFiltered and skipped
		// applyFormatFilter — leaving a JSON payload entirely uncompressed.
		const json = JSON.stringify(
			{ rows: Array.from({ length: 60 }, (_, i) => ({ id: i, name: `item-${i}`, note: "padding" })) },
			null,
			2,
		);
		const viaPs = Buffer.byteLength(compressOutput(json, "ps -o pid,command", "aggressive"));
		const viaUnknown = Buffer.byteLength(compressOutput(json, "somecli --json", "aggressive"));

		assert.ok(viaPs < Buffer.byteLength(json) / 2, `ps path did not compress: ${viaPs}`);
		assert.strictEqual(viaPs, viaUnknown, "both paths should reach the format filter");
	});

	it("still falls back to the original when a filter would return nothing", () => {
		const r = applyCommandFilter("npm install", "up to date in 431ms", "aggressive");
		assert.notStrictEqual(r.output.trim(), "");
	});
});

describe("omission marker counts only what was dropped", () => {
	it("adds no marker when nothing was omitted", () => {
		// A trailing newline made split() yield an empty final element, which was
		// counted as a dropped line — telling the model to search for content that
		// does not exist.
		const out = filterTestOutput("Tests:       184 passed, 184 total\n").output;
		assert.doesNotMatch(out, /lines omitted/);
	});

	it("reports a truthful count when content really was dropped", () => {
		const stdout = ["PASS a.test.ts", "  console.log", "    a secret detail", "ℹ tests 3", "ℹ pass 3"].join("\n");
		const out = filterTestOutput(stdout).output;
		const match = /\[\+(\d+) lines omitted/.exec(out);
		assert.ok(match, `expected an omission marker in: ${out}`);
		assert.strictEqual(Number(match[1]), 2, "two non-summary lines were dropped");
	});
});

describe("error counts are the real counts", () => {
	it("reports the total, not the display cap", () => {
		const text = Array.from({ length: 40 }, (_, i) => `error TS2322: mismatch number ${i}`).join("\n");
		const counted = countErrorLines(text, 5);
		assert.strictEqual(counted.lines.length, 5, "still capped for display");
		assert.strictEqual(counted.total, 40, "but the count is truthful");
	});
});

describe("IPv4-translated IPv6 is classified", () => {
	it("blocks ::ffff:0:0/96 addresses embedding a non-global destination", () => {
		// RFC 2765 IPv4-translated: bytes 8-9 are 0xff,0xff, so it matched neither
		// the IPv4-mapped branch nor any IPv6 range.
		assert.strictEqual(isPrivateHost("::ffff:0:7f00:1"), true, "127.0.0.1");
		assert.strictEqual(isPrivateHost("::ffff:0:a9fe:a9fe"), true, "169.254.169.254");
		assert.strictEqual(isPrivateHost("::ffff:0:808:808"), false, "8.8.8.8 stays reachable");
	});
});
