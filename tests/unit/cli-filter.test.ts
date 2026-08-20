import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { runFilter, runWrap } from "../../src/cli/filter.js";

/** Capture what a CLI entry point writes to stderr while running it. */
async function captureStderr(run: () => Promise<number>): Promise<{ code: number; stderr: string }> {
	const original = process.stderr.write.bind(process.stderr);
	let stderr = "";
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
		return true;
	}) as typeof process.stderr.write;
	try {
		return { code: await run(), stderr };
	} finally {
		process.stderr.write = original;
	}
}

describe("filter/wrap option validation", () => {
	it("rejects an invalid --mode instead of silently using balanced", async () => {
		for (const args of [
			["--mode", "agressive"],
			["--mode", "BALANCED"],
			["--mode", "fast"],
		]) {
			const filter = await captureStderr(() => runFilter(args));
			assert.strictEqual(filter.code, 2, `filter ${args[1]}`);
			assert.match(filter.stderr, /invalid --mode/);
			assert.match(filter.stderr, /conservative\|balanced\|aggressive\|auto/);

			const wrap = await captureStderr(() => runWrap([...args, "echo", "hi"]));
			assert.strictEqual(wrap.code, 2, `wrap ${args[1]}`);
			assert.match(wrap.stderr, /invalid --mode/);
		}
	});

	it("rejects a missing --mode value", async () => {
		const filter = await captureStderr(() => runFilter(["--mode"]));
		assert.strictEqual(filter.code, 2);
		assert.match(filter.stderr, /--mode requires a value/);

		const followedByFlag = await captureStderr(() => runWrap(["--mode", "--stream", "echo", "hi"]));
		assert.strictEqual(followedByFlag.code, 2);
		assert.match(followedByFlag.stderr, /--mode requires a value/);
	});

	it("rejects a missing --cmd value", async () => {
		const result = await captureStderr(() => runFilter(["--cmd"]));
		assert.strictEqual(result.code, 2);
		assert.match(result.stderr, /--cmd requires a value/);
	});

	it("rejects unknown filter arguments instead of ignoring them", async () => {
		const result = await captureStderr(() => runFilter(["--modee", "aggressive"]));
		assert.strictEqual(result.code, 2);
		assert.match(result.stderr, /unexpected argument "--modee"/);
	});

	it("rejects an unknown wrap option instead of running it as a command", async () => {
		// The old parser joined unknown flags into the command line, so this reached
		// the shell as `--moode aggressive echo hi`.
		const result = await captureStderr(() => runWrap(["--moode", "aggressive", "echo", "hi"]));
		assert.strictEqual(result.code, 2);
		assert.match(result.stderr, /unknown option "--moode"/);
		assert.match(result.stderr, /Usage: context-compress wrap/);
	});

	it("requires a command for wrap", async () => {
		for (const args of [[], ["--stream"], ["--mode", "balanced"], ["--"]]) {
			const result = await captureStderr(() => runWrap(args));
			assert.strictEqual(result.code, 2, JSON.stringify(args));
			assert.match(result.stderr, /a command is required/);
		}
	});

	it("passes the child's own flags through untouched", async () => {
		// Flags after the command belong to the child, both with and without `--`.
		const withSeparator = await captureStderr(() =>
			runWrap(["--mode", "conservative", "--", "echo", "--not-our-flag"]),
		);
		assert.strictEqual(withSeparator.code, 0);

		const withoutSeparator = await captureStderr(() =>
			runWrap(["--mode", "conservative", "echo", "--also-not-ours"]),
		);
		assert.strictEqual(withoutSeparator.code, 0);
	});

	it("warns but keeps working for an invalid environment mode", async () => {
		const original = process.env.CONTEXT_COMPRESS_MODE;
		process.env.CONTEXT_COMPRESS_MODE = "nonsense";
		try {
			const result = await captureStderr(() => runWrap(["echo", "env-mode"]));
			assert.strictEqual(result.code, 0, "ambient config must not fail the command");
			assert.match(result.stderr, /ignoring invalid CONTEXT_COMPRESS_MODE="nonsense"/);
		} finally {
			if (original === undefined) delete process.env.CONTEXT_COMPRESS_MODE;
			else process.env.CONTEXT_COMPRESS_MODE = original;
		}
	});

	it("accepts every documented mode", async () => {
		for (const mode of ["conservative", "balanced", "aggressive"]) {
			const result = await captureStderr(() => runWrap(["--mode", mode, "echo", "ok"]));
			assert.strictEqual(result.code, 0, mode);
			assert.strictEqual(result.stderr, "", mode);
		}
	});
});

describe("runWrap buffered capture", () => {
	it("stops capturing at the cap without killing the command or faking its exit code", () => {
		// `hardCapBytes` is the MCP server's memory guard, where a tool response is
		// held in RAM. `wrap` is transparent passthrough of the user's own command,
		// and applying the guard by killing the process tree reported a 46.8MB build
		// that exited 0 as exit 1, with its final `ALL-TESTS-PASSED` line missing and
		// any work after the cap never run.
		const childScript = [
			"process.stdout.write('o'.repeat(4096))",
			"process.stderr.write('e'.repeat(4096))",
			"process.stdout.write('\\nBUILD-SUCCEEDED\\n')",
			"process.exit(0)",
		].join(";");
		const wrapArgs = [
			"--mode",
			"conservative",
			"--",
			JSON.stringify(process.execPath),
			"-e",
			JSON.stringify(childScript),
		];
		const helperScript = [
			'import { runWrap } from "./src/cli/filter.ts"',
			`process.exitCode = await runWrap(${JSON.stringify(wrapArgs)}, { captureCapBytes: 512 })`,
		].join(";");

		const result = spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", helperScript],
			{ encoding: "utf-8", cwd: process.cwd(), timeout: 10_000 },
		);

		assert.strictEqual(result.error, undefined);
		assert.strictEqual(result.status, 0, "the command succeeded; the cap is our limit, not its outcome");
		// The verdict is the last line, so a cap that only keeps a head loses the
		// one line the caller needs.
		assert.match(result.stdout, /BUILD-SUCCEEDED/, "the tail of a capped stream must survive");
		// Retention stays bounded: a head and a rolling tail, each within the cap.
		const markerStart = result.stderr.indexOf("context-compress wrap:");
		assert.notStrictEqual(markerStart, -1);
		// Retention is a head plus a rolling tail per stream, each bounded by the
		// cap — well under the 8KB the child wrote.
		const retained =
			Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr.slice(0, markerStart));
		assert.ok(retained <= 512 * 4 + 512, `retention stayed bounded (${retained} bytes)`);
		assert.ok(retained < 8192, `retention is well under what the child wrote (${retained} bytes)`);
		assert.match(result.stderr, /exceeded the 512B capture limit/);
		assert.match(result.stderr, /ran to completion/);
		assert.match(result.stderr, /--stream/);
		assert.match(result.stderr, /CONTEXT_COMPRESS_HARD_CAP_BYTES/);
	});
});
