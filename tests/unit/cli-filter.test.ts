import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

describe("runWrap buffered capture", () => {
	it("kills the command and returns an actionable error when the combined cap is exceeded", () => {
		const childScript = "process.stdout.write('o'.repeat(24));process.stderr.write('e'.repeat(24))";
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
			`process.exitCode = await runWrap(${JSON.stringify(wrapArgs)}, { captureCapBytes: 32 })`,
		].join(";");

		const result = spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", helperScript],
			{ encoding: "utf-8", cwd: process.cwd(), timeout: 5_000 },
		);

		assert.strictEqual(result.error, undefined);
		assert.strictEqual(result.status, 1);
		assert.ok(
			Buffer.byteLength(result.stdout) <= 33,
			`retained stdout plus its newline stays bounded (received ${Buffer.byteLength(result.stdout)} bytes)`,
		);
		const markerStart = result.stderr.indexOf("context-compress wrap:");
		assert.notStrictEqual(markerStart, -1);
		const stdoutPayload = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
		const stderrPayload = result.stderr.slice(0, markerStart);
		assert.strictEqual(Buffer.byteLength(stdoutPayload) + Buffer.byteLength(stderrPayload), 32);
		assert.match(result.stderr, /combined stdout\/stderr exceeded the 32B capture limit/);
		assert.match(result.stderr, /--stream/);
		assert.match(result.stderr, /CONTEXT_COMPRESS_HARD_CAP_BYTES/);
	});
});
