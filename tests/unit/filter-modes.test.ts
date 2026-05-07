import assert from "node:assert";
import { describe, it } from "node:test";
import { applyCommandFilter, parseMode } from "../../src/filters.js";

describe("parseMode", () => {
	it("returns 'balanced' for unset", () => {
		assert.strictEqual(parseMode(undefined), "balanced");
	});
	it("returns 'balanced' for unknown values", () => {
		assert.strictEqual(parseMode("nonsense"), "balanced");
	});
	it("accepts 'aggressive' and 'conservative'", () => {
		assert.strictEqual(parseMode("aggressive"), "aggressive");
		assert.strictEqual(parseMode("conservative"), "conservative");
	});
});

describe("conservative mode", () => {
	it("never applies command-specific filtering", () => {
		const out = "remote: Counting objects: 100\nTo github.com:repo.git\nabc123 main";
		const r = applyCommandFilter("git push origin main", out, "conservative");
		assert.strictEqual(r.filtered, false);
		assert.strictEqual(r.output, out);
	});
});

describe("aggressive mode — git log", () => {
	const sample = `commit abcdef1234567890123456789012345678901234
Author: Foo Bar <foo@example.com>
Date:   Tue May 7 12:34:56 2026 +0900

    Subject line of the commit

    Body line one with details.
    Body line two.

commit fedcba0987654321098765432109876543210987
Author: Other Person <other@example.com>
Date:   Mon May 6 09:00:00 2026 +0900

    Second commit subject

    Detailed body content.
`;

	it("collapses each commit to a single line in aggressive mode", () => {
		const r = applyCommandFilter("git log -10", sample, "aggressive");
		assert.strictEqual(r.filtered, true);
		const lines = r.output.split("\n").filter((l) => l.trim() !== "");
		assert.strictEqual(lines.length, 2);
		assert.match(lines[0], /^abcdef1\s+Subject line of the commit/);
		assert.match(lines[1], /^fedcba0\s+Second commit subject/);
		// Body content should be gone
		assert.ok(!r.output.includes("Body line one"));
		assert.ok(!r.output.includes("Detailed body content"));
	});

	it("does NOT touch git log in balanced mode", () => {
		const r = applyCommandFilter("git log -10", sample, "balanced");
		assert.strictEqual(r.filtered, false);
		assert.ok(r.output.includes("Body line one"));
	});

	it("respects --oneline in aggressive mode (already compact, pass through)", () => {
		const oneline = "abcdef1 Subject line\nfedcba0 Second commit";
		const r = applyCommandFilter("git log --oneline -10", oneline, "aggressive");
		// We don't transform an already-oneline output
		assert.strictEqual(r.filtered, false);
	});
});

describe("aggressive mode — git status", () => {
	const sample =
		"On branch main\nYour branch is up to date with 'origin/main'.\n\nChanges not staged for commit:\n  (use \"git add <file>...\" to update)\n\tmodified:   src/foo.ts\n\tmodified:   src/bar.ts\n\nUntracked files:\n  (use \"git add <file>...\" to include)\n\tnew.ts\n";

	it("uses terse markers (M/A/D) in aggressive mode", () => {
		const r = applyCommandFilter("git status", sample, "aggressive");
		assert.strictEqual(r.filtered, true);
		assert.ok(r.output.includes("M src/foo.ts"));
		assert.ok(r.output.includes("M src/bar.ts"));
		// Hint sections should be gone
		assert.ok(!r.output.includes("Changes not staged for commit"));
		assert.ok(!r.output.includes("Your branch"));
	});

	it("balanced mode keeps section headers", () => {
		const r = applyCommandFilter("git status", sample, "balanced");
		assert.ok(r.output.includes("Changes not staged for commit"));
	});
});

describe("aggressive mode — git diff --stat passes through (already a summary)", () => {
	const stat =
		" foo.ts | 5 +++--\n bar.ts | 3 +++\n 2 files changed, 5 insertions(+), 1 deletion(-)";

	it("does not drop --stat output to nothing", () => {
		const r = applyCommandFilter("git diff --stat", stat, "aggressive");
		assert.strictEqual(r.filtered, false);
		assert.strictEqual(r.output, stat);
	});

	it("--name-only also passes through", () => {
		const names = "foo.ts\nbar.ts\nbaz.ts";
		const r = applyCommandFilter("git diff --name-only HEAD~3", names, "aggressive");
		assert.strictEqual(r.filtered, false);
		assert.strictEqual(r.output, names);
	});
});

describe("aggressive mode — git diff", () => {
	const sample = `diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,5 +1,5 @@
 unchanged context line
 another context
-old line removed
+new line added
 trailing context
`;

	it("strips hunks and context lines in aggressive mode", () => {
		const r = applyCommandFilter("git diff", sample, "aggressive");
		assert.strictEqual(r.filtered, true);
		assert.ok(r.output.includes("@@ foo.ts"));
		assert.ok(r.output.includes("-old line removed"));
		assert.ok(r.output.includes("+new line added"));
		// Context (unchanged) lines and hunk headers should be gone
		assert.ok(!r.output.includes("unchanged context"));
		assert.ok(!r.output.includes("@@ -1"));
		assert.ok(!r.output.includes("index abc"));
	});
});

describe("aggressive mode — ls -la", () => {
	const sample = `total 192
drwxr-xr-x   3 jiun  staff    96 May  7 13:24 .
drwxr-xr-x  10 jiun  staff   320 May  6 14:20 ..
-rw-r--r--   1 jiun  staff  1234 May  7 13:24 file.ts
-rw-r--r--   1 jiun  staff  5120 May  6 14:20 big.ts
drwxr-xr-x   2 jiun  staff    64 May  7 13:24 sub`;

	it("strips perms/owner/date keeping name+size in aggressive", () => {
		const r = applyCommandFilter("ls -la", sample, "aggressive");
		assert.strictEqual(r.filtered, true);
		assert.ok(!r.output.includes("drwxr-xr-x"));
		assert.ok(!r.output.includes("staff"));
		assert.ok(r.output.includes("file.ts"));
		assert.ok(r.output.includes("sub/"));
	});

	it("balanced mode keeps full ls -la output", () => {
		const r = applyCommandFilter("ls -la", sample, "balanced");
		assert.strictEqual(r.filtered, false);
		assert.ok(r.output.includes("drwxr-xr-x"));
	});
});

describe("aggressive mode — grep", () => {
	const sample =
		"src/foo.ts:10:const someValue = 1\nsrc/foo.ts:25:if (someValue > 0) {\nsrc/bar.ts:5:function bar() { return someValue; }\nsrc/foo.ts:42:return someValue * 2";

	it("groups grep matches by file in aggressive mode", () => {
		const r = applyCommandFilter("grep -rn someValue src/", sample, "aggressive");
		assert.strictEqual(r.filtered, true);
		assert.match(r.output, /^src\/foo\.ts \(3\)/m);
		assert.match(r.output, /^src\/bar\.ts \(1\)/m);
		assert.ok(r.output.includes("L10:"));
		assert.ok(r.output.includes("L42:"));
	});

	it("balanced mode passes grep through", () => {
		const r = applyCommandFilter("grep -rn pattern src/", sample, "balanced");
		assert.strictEqual(r.filtered, false);
	});
});
