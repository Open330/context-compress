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
		const r = applyCommandFilter(
			"git status",
			'On branch main\n  (use "git push" to publish)\nnothing to commit',
		);
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
		const stdout =
			"remote: Counting objects: 100\nremote: Compressing objects: 50\nTo github.com:repo.git\nabc123..def456 main -> main";
		const r = filterGit("git push", stdout);
		assert.strictEqual(r.filtered, true);
		assert.ok(!r.output.includes("remote:"));
		assert.ok(r.output.includes("abc123"));
	});

	it("strips clone progress lines", () => {
		const stdout =
			"Cloning into 'repo'...\nremote: Counting objects: 100\nremote: Total 100\nReceiving objects: 100%\nResolving deltas: 100%\nDone.";
		const r = filterGit("git clone https://github.com/x/y", stdout);
		assert.strictEqual(r.filtered, true);
		assert.ok(!r.output.includes("remote:"));
		assert.ok(!r.output.includes("Receiving"));
		assert.ok(r.output.includes("Done."));
	});

	it("strips git status hint lines", () => {
		const stdout =
			'On branch main\nChanges not staged for commit:\n  (use "git add <file>..." to update)\n\tmodified:   foo.ts\n';
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
		const stdout =
			"npm warn deprecated package@1.0.0\nnpm notice \nadded 100 packages in 5s\n\nrun `npm fund` for details";
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

	it("states how many lines it dropped", () => {
		// This filter runs in the DEFAULT mode and drops everything that is not a
		// summary line, while `execute` tells the model it is receiving stdout. A
		// console.log the caller added to inspect something disappeared silently, so
		// the caller concluded the statement never ran.
		const stdout = [
			"PASS src/db.test.ts",
			"  ● Console",
			"    console.log",
			"      resolved DB URL = postgres://app@db-staging:5432/app",
			"ℹ tests 3",
			"ℹ pass 3",
			"ℹ fail 0",
		].join("\n");

		const r = filterTestOutput(stdout);

		assert.ok(!r.output.includes("db-staging"), "non-summary content is still dropped");
		assert.match(r.output, /\[\+\d+ lines omitted/, "the drop must be stated, not silent");
		assert.match(r.output, /search\(\)/, "the marker must say how to recover the content");
	});

	it("adds no marker when nothing was dropped", () => {
		const stdout = "ℹ tests 3\nℹ pass 3\nℹ fail 0";
		assert.doesNotMatch(filterTestOutput(stdout).output, /lines omitted/);
	});

	it("routes a package manager's test script to the test filter", () => {
		// `npm test` matched the package-manager branch first, so test output was
		// filtered as though it were an install: install/audit counts kept, test
		// summaries not. README advertises this exact command as a 99% reduction.
		const stdout =
			"PASS src/a.test.ts\n  ✓ test 1 (2ms)\n  ✓ test 2 (1ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0";

		for (const command of ["npm test", "npm t", "npm run test", "yarn test", "pnpm run test", "bun test"]) {
			const r = applyCommandFilter(command, stdout, "balanced");
			assert.strictEqual(r.filtered, true, command);
			assert.ok(!r.output.includes("✓ test 1"), `${command}: per-test lines should collapse`);
			assert.ok(r.output.includes("pass 2"), `${command}: the rollup must survive`);
		}
	});

	it("never returns empty output for non-empty input", () => {
		// Aggressive filters keep only summary-shaped lines, so a run whose output
		// matches none of them collapsed to "" — the caller could not tell success
		// from failure. Reproduced with both of these before the floor was added.
		const cases: Array<[command: string, stdout: string]> = [
			["npm install", "up to date in 431ms"],
			["npm install nope", "npm error code E404\nnpm error 404 Not Found - GET https://x/nope"],
			["npm ls", "no dependencies"],
			["df -h", "some unusual df output"],
			["ps aux", "unexpected ps output"],
			["du -sh .", "weird du output"],
			["grep -r needle .", "unusual grep output"],
		];

		for (const [command, stdout] of cases) {
			const r = applyCommandFilter(command, stdout, "aggressive");
			assert.notStrictEqual(r.output.trim(), "", `${command} returned empty output`);
		}
	});

	it("keeps npm 10 lowercase error lines in aggressive mode", () => {
		// The branch already stripped npm 10's lowercase `npm warn`/`npm notice`, but
		// only kept the npm 9 uppercase `npm ERR`, so errors were dropped.
		const stdout = [
			"npm warn deprecated foo@1.0.0",
			"npm error code ERESOLVE",
			"npm error ERESOLVE unable to resolve dependency tree",
			"added 3 packages",
		].join("\n");

		const r = applyCommandFilter("npm install", stdout, "aggressive");

		assert.ok(r.output.includes("npm error code ERESOLVE"), "errors must survive");
		assert.ok(!r.output.includes("npm warn deprecated"), "warnings are still noise");
		assert.ok(r.output.includes("added 3 packages"));
	});

	it("still treats an install as an install", () => {
		const r = applyCommandFilter(
			"npm install",
			"added 120 packages, and audited 300 packages in 4s\nfound 0 vulnerabilities",
			"balanced",
		);
		assert.ok(r.output.includes("added 120 packages"));
		assert.ok(!r.output.includes("lines omitted"), "install output must not use the test filter");
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

	it("drops PASS-per-file lines from summary when failures exist", () => {
		const passLines: string[] = [];
		for (let i = 0; i < 50; i++) passLines.push(`PASS src/foo${i}.test.ts`);
		const stdout = [
			...passLines,
			"FAIL src/bug.test.ts",
			"  ✗ regression",
			"    AssertionError: nope",
			"",
			"ℹ tests 51",
			"ℹ pass 50",
			"ℹ fail 1",
		].join("\n");
		const r = filterTestOutput(stdout);
		assert.strictEqual(r.filtered, true);
		// The single FAIL is fine; the 50 PASS lines should be gone.
		const passCount = (r.output.match(/^PASS\s/gm) ?? []).length;
		assert.strictEqual(passCount, 0, "PASS-per-file lines should be dropped");
		assert.ok(r.output.includes("regression"));
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
		const stdout =
			"Downloading crate1 v1.0.0\nDownloading crate2 v2.0.0\nCompiling 1 of 10\nCompiling 2 of 10\nBlocking waiting for file lock\nFinished release [optimized] in 30s";
		const r = filterBuildOutput("cargo build --release", stdout);
		assert.strictEqual(r.filtered, true);
		assert.ok(!r.output.includes("Downloading"));
		assert.ok(!r.output.includes("Compiling"));
		assert.ok(r.output.includes("Finished"));
	});

	it("strips cargo 'Compiling crate v1.2.3' style lines", () => {
		const stdout =
			"   Compiling serde v1.0.193\n   Compiling tokio v1.35.1\n   Checking my-app v0.1.0\n    Finished `release` profile [optimized] in 12.4s";
		const r = filterBuildOutput("cargo build --release", stdout);
		assert.strictEqual(r.filtered, true);
		assert.ok(!r.output.includes("Compiling serde"));
		assert.ok(!r.output.includes("Compiling tokio"));
		assert.ok(!r.output.includes("Checking my-app"));
		assert.ok(r.output.includes("Finished"));
	});
});

describe("filterContainerOutput", () => {
	it("strips docker build layer progress", () => {
		const stdout =
			"Sending build context to Docker daemon  10MB\nStep 1/5 : FROM node:18\n ---> abc123\nStep 2/5 : COPY . .\nSuccessfully built def456";
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

	it("passes small kubectl output through", () => {
		const stdout =
			"NAMESPACE     NAME      READY   STATUS    RESTARTS   AGE\ndefault       pod-a     1/1     Running   0          3d";
		const r = filterContainerOutput("kubectl get pods", stdout);
		assert.strictEqual(r.filtered, false);
	});

	it("summarizes large kubectl get by namespace+status, keeping non-healthy rows verbatim", () => {
		const header =
			"NAMESPACE     NAME                                READY   STATUS    RESTARTS   AGE";
		const rows: string[] = [];
		for (let i = 0; i < 60; i++) {
			const ns = ["default", "kube-system"][i % 2];
			const status = i % 7 === 0 ? "Pending" : "Running";
			rows.push(
				`${ns.padEnd(13)} pod-${i.toString().padEnd(34)}  1/1     ${status.padEnd(9)} 0          ${i}d`,
			);
		}
		const stdout = [header, ...rows].join("\n");
		const r = filterContainerOutput("kubectl get pods -A", stdout);
		assert.strictEqual(r.filtered, true);
		assert.ok(r.output.includes("non-healthy kept verbatim"));
		assert.ok(r.output.includes("Running"));
		assert.ok(r.output.includes("pod-0"), "Pending pod name must survive");
		assert.ok(r.output.length < stdout.length / 2, "should be at least 2x smaller");
	});

	it("passes kubectl describe through untouched (key-value text, not a table)", () => {
		const lines: string[] = [];
		for (let i = 0; i < 40; i++) lines.push(`Key${i}:        value-${i}`);
		const stdout = lines.join("\n");
		const r = filterContainerOutput("kubectl describe pod my-pod", stdout);
		assert.strictEqual(r.filtered, false);
		assert.strictEqual(r.output, stdout);
	});
});

describe("filterFileList", () => {
	it("returns unfiltered for short output", () => {
		const stdout = "file1.ts\nfile2.ts\nfile3.ts";
		const r = filterFileList("ls", stdout);
		assert.strictEqual(r.filtered, false);
	});

	it("summarizes large find output by directory, keeping first entries verbatim in balanced", () => {
		const lines: string[] = [];
		for (let i = 0; i < 60; i++) {
			lines.push(`src/dir${i % 10}/file${i}.ts`);
		}
		const r = filterFileList("find . -name '*.ts'", lines.join("\n"));
		assert.strictEqual(r.filtered, true);
		assert.ok(r.output.includes("entries"));
		assert.ok(r.output.includes("src/dir0/file0.ts"), "first entries kept verbatim");
		assert.ok(r.output.includes("remainder by directory"));
	});

	it("aggressive find summarizes all entries to per-directory counts", () => {
		const lines: string[] = [];
		for (let i = 0; i < 60; i++) {
			lines.push(`src/dir${i % 10}/file${i}.ts`);
		}
		const r = filterFileList("find . -name '*.ts'", lines.join("\n"), "aggressive");
		assert.strictEqual(r.filtered, true);
		assert.ok(r.output.includes("files found"));
		assert.ok(!r.output.includes("file0.ts"), "aggressive drops individual names");
	});
});
describe("command dispatch safety", () => {
	it("does NOT route 'cat latest.log' to the test-output filter", () => {
		const stdout = "line one\nline two\nline three\nline four\nline five\nline six";
		const r = applyCommandFilter("cat latest.log", stdout, "balanced");
		assert.strictEqual(r.output, stdout, "log content must pass through untouched");
	});

	it("does NOT route 'ls test-results/' to the test-output filter", () => {
		const stdout = "a.xml\nb.xml\nc.xml";
		const r = applyCommandFilter("ls test-results/", stdout, "balanced");
		assert.strictEqual(r.output, stdout);
	});

	it("still routes real test runners to the test filter", () => {
		const passing = "1 passing (10ms)";
		const r = applyCommandFilter("npx vitest run", passing, "balanced");
		assert.ok(r.filtered, "vitest via npx should be detected");
		const r2 = applyCommandFilter("go test ./...", passing, "balanced");
		assert.ok(r2.filtered, "go test should be detected");
	});
});

describe("git log passthrough", () => {
	it("aggressive mode passes --format/--graph/patch output through", () => {
		const graph = "* abc1234 feat: x\n* def5678 fix: y";
		const r = applyCommandFilter("git log --graph --oneline-all", graph, "aggressive");
		assert.strictEqual(r.output, graph);

		const patch = "commit abc\nAuthor: A\n\n    subj\n\ndiff --git a/f b/f\n+added line";
		const r2 = applyCommandFilter("git log -p", patch, "aggressive");
		assert.ok(r2.output.includes("+added line"), "patch content must survive");
	});

	it("aggressive git log never returns empty output for non-empty input", () => {
		const weird = "some non-standard git log output\nwithout commit headers";
		const r = applyCommandFilter("git log", weird, "aggressive");
		assert.strictEqual(r.output, weird);
	});
});

describe("kubectl get without a STATUS column", () => {
	it("keeps row content instead of folding everything into one count", () => {
		const header = "NAME              TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)    AGE";
		const rows = Array.from(
			{ length: 40 },
			(_, i) => `svc-${i}          ClusterIP   10.0.0.${i}      <none>        80/TCP     3d`,
		);
		const r = filterContainerOutput("kubectl get svc -A", [header, ...rows].join("\n"));
		assert.ok(r.output.includes("svc-0"), "names must survive");
		assert.ok(r.output.includes("10.0.0.5"), "addresses must survive");
		assert.ok(r.output.includes("20 more rows"));
	});

	it("passes -o json through untouched", () => {
		const json = ["{", '  "apiVersion": "v1",', ...Array(40).fill('  "x": 1,'), "}"].join("\n");
		const r = filterContainerOutput("kubectl get pods -o json", json);
		assert.strictEqual(r.filtered, false);
		assert.strictEqual(r.output, json);
	});
});

describe("grep -r without -n", () => {
	it("keeps file names for path:content matches", () => {
		const stdout = "src/a.ts:const x = 1;\nsrc/b.ts:const x = 2;";
		const r = applyCommandFilter("grep -r 'const x' src/", stdout, "aggressive");
		assert.ok(r.output.includes("src/a.ts"), "file name must survive");
		assert.ok(r.output.includes("src/b.ts"), "file name must survive");
	});
});

describe("grep on colon-heavy content", () => {
	it("does not mistake a log timestamp for a file:line prefix", () => {
		const stdout = "2024-01-01 12:30:15 ERROR boom\n2024-01-01 12:30:16 ERROR again";
		const r = applyCommandFilter("grep ERROR app.log", stdout, "aggressive");
		assert.ok(r.output.includes("12:30:15 ERROR boom"), "message must stay intact");
		assert.ok(!r.output.includes("L30:"), "must not invent a line number");
	});

	it("still parses real path:line:content hits", () => {
		const stdout = "src/a.ts:12:const x = 1;\nsrc/a.ts:30:const y = 2;";
		const r = applyCommandFilter("grep -rn 'const' src/", stdout, "aggressive");
		assert.ok(r.output.includes("src/a.ts (2)"));
		assert.ok(r.output.includes("L12:"));
		assert.ok(r.output.includes("L30:"));
	});
});
