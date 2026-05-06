import assert from "node:assert";
import { describe, it } from "node:test";
import {
	applyCommandFilter,
	filterBuildOutput,
	filterContainerOutput,
	filterFileList,
	filterGit,
	filterPackageManager,
	filterTestOutput,
} from "../../src/filters.js";

describe("applyCommandFilter", () => {
	it("routes git commands to filterGit", () => {
		const r = applyCommandFilter("git status", "On branch main\n  (use \"git push\" to publish)\nnothing to commit");
		assert.strictEqual(r.filtered, true);
		assert.ok(!r.output.includes("(use "));
	});

	it("routes npm commands to filterPackageManager", () => {
		const r = applyCommandFilter("npm install", "npm warn deprecated\nadded 100 packages");
		assert.strictEqual(r.filtered, true);
		assert.ok(!r.output.includes("npm warn"));
	});

	it("routes test commands to filterTestOutput", () => {
		const r = applyCommandFilter("npm test", "PASS src/foo.test.ts\nℹ tests 10");
		assert.strictEqual(r.filtered, true);
		assert.ok(r.output.includes("PASS"));
	});

	it("returns unfiltered for unknown commands", () => {
		const input = "some random output";
		const r = applyCommandFilter("custom-cmd --flag", input);
		assert.strictEqual(r.filtered, false);
		assert.strictEqual(r.output, input);
	});
});

describe("filterGit", () => {
	it("strips push progress lines", () => {
		const stdout = "remote: Counting objects: 100\nremote: Compressing objects: 50\nTo github.com:repo.git\nabc123..def456 main -> main";
		const r = filterGit("git push", stdout);
		assert.strictEqual(r.filtered, true);
		assert.ok(!r.output.includes("remote:"));
		assert.ok(r.output.includes("abc123"));
	});

	it("strips clone progress lines", () => {
		const stdout = "Cloning into 'repo'...\nremote: Counting objects: 100\nremote: Total 100\nReceiving objects: 100%\nResolving deltas: 100%\nDone.";
		const r = filterGit("git clone https://github.com/x/y", stdout);
		assert.strictEqual(r.filtered, true);
		assert.ok(!r.output.includes("remote:"));
		assert.ok(!r.output.includes("Receiving"));
		assert.ok(r.output.includes("Done."));
	});

	it("strips git status hint lines", () => {
		const stdout = "On branch main\nChanges not staged for commit:\n  (use \"git add <file>...\" to update)\n\tmodified:   foo.ts\n";
		const r = filterGit("git status", stdout);
		assert.strictEqual(r.filtered, true);
		assert.ok(!r.output.includes("(use "));
		assert.ok(r.output.includes("modified:"));
	});

	it("returns unfiltered for git log", () => {
		const stdout = "abc123 some commit\ndef456 another commit";
		const r = filterGit("git log --oneline", stdout);
		assert.strictEqual(r.filtered, false);
		assert.strictEqual(r.output, stdout);
	});
});

describe("filterPackageManager", () => {
	it("strips npm install noise", () => {
		const stdout = "npm warn deprecated package@1.0.0\nnpm notice \nadded 100 packages in 5s\n\nrun `npm fund` for details";
		const r = filterPackageManager("npm install", stdout);
		assert.strictEqual(r.filtered, true);
		assert.ok(!r.output.includes("npm warn"));
		assert.ok(!r.output.includes("npm fund"));
		assert.ok(r.output.includes("added 100"));
	});

	it("delegates npm test to filterTestOutput", () => {
		const stdout = "PASS src/foo.ts\nℹ tests 5\nℹ pass 5";
		const r = filterPackageManager("npm test", stdout);
		assert.strictEqual(r.filtered, true);
	});

	it("returns unfiltered for npm run arbitrary", () => {
		const stdout = "some output";
		const r = filterPackageManager("npm run build", stdout);
		assert.strictEqual(r.filtered, false);
	});
});

describe("filterTestOutput", () => {
	it("collapses all-pass output to summary only", () => {
		const stdout =
			"PASS src/a.test.ts\n  ✓ test 1 (2ms)\n  ✓ test 2 (1ms)\nPASS src/b.test.ts\n  ✓ test 3 (3ms)\nℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ duration_ms 100";
		const r = filterTestOutput(stdout);
		assert.strictEqual(r.filtered, true);
		assert.ok(!r.output.includes("✓ test 1"));
		assert.ok(r.output.includes("tests 3"));
		assert.ok(r.output.includes("pass 3"));
	});

	it("keeps failure lines and summary", () => {
		const stdout =
			"PASS src/a.test.ts\nFAIL src/b.test.ts\n  ✗ broken test\n    AssertionError: expected 1 to equal 2\nℹ tests 5\nℹ pass 3\nℹ fail 1";
		const r = filterTestOutput(stdout);
		assert.strictEqual(r.filtered, true);
		assert.ok(r.output.includes("FAIL"));
		assert.ok(r.output.includes("broken test"));
		assert.ok(r.output.includes("fail 1"));
	});

	it("returns unfiltered when no summary detected", () => {
		const stdout = "just some raw output\nwith no test markers";
		const r = filterTestOutput(stdout);
		assert.strictEqual(r.filtered, false);
	});
});

describe("filterBuildOutput", () => {
	it("strips cargo download and compile progress", () => {
		const stdout = "Downloading crate1 v1.0.0\nDownloading crate2 v2.0.0\nCompiling 1 of 10\nCompiling 2 of 10\nBlocking waiting for file lock\nFinished release [optimized] in 30s";
		const r = filterBuildOutput("cargo build --release", stdout);
		assert.strictEqual(r.filtered, true);
		assert.ok(!r.output.includes("Downloading"));
		assert.ok(!r.output.includes("Compiling"));
		assert.ok(r.output.includes("Finished"));
	});
});

describe("filterContainerOutput", () => {
	it("strips docker build layer progress", () => {
		const stdout = "Sending build context to Docker daemon  10MB\nStep 1/5 : FROM node:18\n ---> abc123\nStep 2/5 : COPY . .\nSuccessfully built def456";
		const r = filterContainerOutput("docker build -t app .", stdout);
		assert.strictEqual(r.filtered, true);
		assert.ok(!r.output.includes(" ---> "));
		assert.ok(!r.output.includes("Sending build context"));
		assert.ok(r.output.includes("Step 1"));
		assert.ok(r.output.includes("Successfully built"));
	});

	it("returns unfiltered for docker ps", () => {
		const stdout = "CONTAINER ID   IMAGE   STATUS";
		const r = filterContainerOutput("docker ps", stdout);
		assert.strictEqual(r.filtered, false);
	});
});

describe("filterFileList", () => {
	it("returns unfiltered for short output", () => {
		const stdout = "file1.ts\nfile2.ts\nfile3.ts";
		const r = filterFileList("ls", stdout);
		assert.strictEqual(r.filtered, false);
	});

	it("summarizes large find output by directory", () => {
		const lines: string[] = [];
		for (let i = 0; i < 60; i++) {
			lines.push(`src/dir${i % 10}/file${i}.ts`);
		}
		const r = filterFileList("find . -name '*.ts'", lines.join("\n"));
		assert.strictEqual(r.filtered, true);
		assert.ok(r.output.includes("files found"));
	});
});