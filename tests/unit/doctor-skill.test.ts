import assert from "node:assert";
import { execSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";

const root = process.cwd();
const skill = readFileSync(join(root, "skills/doctor/SKILL.md"), "utf-8");
const command = skill.match(/code: "([^"]+)"/)?.[1];
const tempRoot = mkdtempSync(join(tmpdir(), "cc-doctor-skill-"));
const binDir = join(tempRoot, "bin");
const isolatedCwd = join(tempRoot, "work");

after(() => rmSync(tempRoot, { recursive: true, force: true }));

describe("doctor skill", () => {
	it("uses the published CLI instead of a package-relative path", () => {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
			bin: Record<string, string>;
		};

		assert.strictEqual(command, "context-compress doctor");
		assert.strictEqual(pkg.bin["context-compress"], "dist/cli/index.js");
		assert.doesNotMatch(skill, /node\s+(?:\.\/)?dist\/cli\/index\.js/);
	});

	it("resolves the exact command from an unrelated working directory", () => {
		if (!command) throw new Error("doctor skill command is missing");

		mkdirSync(binDir);
		mkdirSync(isolatedCwd);

		if (process.platform === "win32") {
			writeFileSync(join(binDir, "context-compress.cmd"), "@if \"%1\"==\"doctor\" exit /b 0\r\n@exit /b 1\r\n");
		} else {
			const shim = join(binDir, "context-compress");
			writeFileSync(shim, "#!/bin/sh\n[ \"$1\" = doctor ]\n");
			chmodSync(shim, 0o755);
		}

		execSync(command, {
			cwd: isolatedCwd,
			env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
			stdio: "pipe",
		});
	});
});
