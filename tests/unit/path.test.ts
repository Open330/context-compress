import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isWithinProject } from "../../src/util/path.js";

describe("isWithinProject", () => {
	let projectDir: string;
	let outsideDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "cc-project-"));
		outsideDir = mkdtempSync(join(tmpdir(), "cc-outside-"));
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(outsideDir, { recursive: true, force: true });
	});

	it("accepts the project root itself", () => {
		assert.strictEqual(isWithinProject(projectDir, projectDir), true);
	});

	it("accepts a file inside the project", () => {
		const file = join(projectDir, "foo.txt");
		writeFileSync(file, "hi");
		assert.strictEqual(isWithinProject(file, projectDir), true);
	});

	it("accepts a nested path inside the project", () => {
		const subDir = join(projectDir, "sub", "deep");
		mkdirSync(subDir, { recursive: true });
		const file = join(subDir, "x.txt");
		writeFileSync(file, "hi");
		assert.strictEqual(isWithinProject(file, projectDir), true);
	});

	it("rejects a path outside the project", () => {
		const file = join(outsideDir, "leak.txt");
		writeFileSync(file, "secret");
		assert.strictEqual(isWithinProject(file, projectDir), false);
	});

	it("rejects ../-traversal that escapes the project", () => {
		const escape = resolve(projectDir, "..", "neighbor", "secret.txt");
		assert.strictEqual(isWithinProject(escape, projectDir), false);
	});

	it("rejects a sibling directory whose name is a prefix of the project's name", () => {
		// projectDir = /tmp/cc-project-XXX, sibling = /tmp/cc-project-XXX-evil
		const sibling = `${projectDir}-evil`;
		mkdirSync(sibling);
		try {
			assert.strictEqual(isWithinProject(sibling, projectDir), false);
		} finally {
			rmSync(sibling, { recursive: true, force: true });
		}
	});

	it("rejects a symlink that points outside the project", () => {
		const target = join(outsideDir, "target.txt");
		writeFileSync(target, "outside content");
		const link = join(projectDir, "link-to-outside");
		symlinkSync(target, link);
		assert.strictEqual(isWithinProject(link, projectDir), false);
	});

	it("falls back to string check for paths that don't exist yet", () => {
		const ghost = join(projectDir, "does-not-exist", "yet.txt");
		assert.strictEqual(isWithinProject(ghost, projectDir), true);
	});

	it("rejects non-existent paths outside the project", () => {
		const ghost = join(outsideDir, "phantom.txt");
		assert.strictEqual(isWithinProject(ghost, projectDir), false);
	});
});
