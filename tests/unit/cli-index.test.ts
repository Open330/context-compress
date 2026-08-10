import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(root, "src/cli/index.ts");

function runCli(args: string[]) {
	return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
		cwd: root,
		encoding: "utf-8",
		timeout: 5_000,
	});
}

describe("context-compress CLI dispatch", () => {
	for (const flag of ["--help", "-h"]) {
		it(`${flag} prints useful help and exits successfully`, () => {
			const result = runCli([flag]);

			assert.strictEqual(result.error, undefined);
			assert.strictEqual(result.status, 0);
			assert.strictEqual(result.stderr, "");
			assert.match(result.stdout, /Usage: context-compress \[command\]/);
			assert.match(result.stdout, /Run without a command to start the MCP server/);
			assert.match(result.stdout, /setup \[--auto\]/);
			assert.match(result.stdout, /doctor/);
			assert.match(result.stdout, /filter \[options\]/);
			assert.match(result.stdout, /wrap <cmd>/);
		});
	}

	for (const flag of ["--version", "-v"]) {
		it(`${flag} prints the package version and exits successfully`, () => {
			const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
				version: string;
			};
			const result = runCli([flag]);

			assert.strictEqual(result.error, undefined);
			assert.strictEqual(result.status, 0);
			assert.strictEqual(result.stderr, "");
			assert.strictEqual(result.stdout.trim(), packageJson.version);
		});
	}

	it("reports an unknown command without starting the MCP server", () => {
		const result = runCli(["frobnicate"]);

		assert.strictEqual(result.error, undefined);
		assert.strictEqual(result.status, 2);
		assert.strictEqual(result.stdout, "");
		assert.match(result.stderr, /Unknown command: frobnicate/);
		assert.match(result.stderr, /Commands:/);
		assert.match(result.stderr, /setup \[--auto\]/);
		assert.match(result.stderr, /doctor/);
		assert.match(result.stderr, /filter \[options\]/);
		assert.match(result.stderr, /wrap <cmd>/);
		assert.match(result.stderr, /--help/);
	});
});
