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

describe("balanced mode — git log keeps headers + first 3 body lines", () => {
	const longBody = `commit abcdef1234567890123456789012345678901234
Author: Foo <foo@example.com>
Date:   Tue May 7 12:34:56 2026 +0900

    Subject line of the commit

    Body line 1: explanation
    Body line 2: more detail
    Body line 3: implementation note
    Body line 4: should be omitted
    Body line 5: should be omitted
    Body line 6: should be omitted
    Body line 7: should be omitted

commit fedcba0987654321098765432109876543210987
Author: Bar <bar@example.com>
Date:   Mon May 6 09:00:00 2026 +0900

    Short commit
`;

	it("preserves headers and first 3 body lines, omits the rest", () => {
		const r = applyCommandFilter("git log -10", longBody, "balanced");
		assert.strictEqual(r.filtered, true);
		// Headers always kept
		assert.ok(r.output.includes("commit abcdef"));
		assert.ok(r.output.includes("Author: Foo"));
		assert.ok(r.output.includes("Date:"));
		assert.ok(r.output.includes("Subject line"));
		// First 3 body lines kept
		assert.ok(r.output.includes("Body line 1"));
		assert.ok(r.output.includes("Body line 2"));
		assert.ok(r.output.includes("Body line 3"));
		// Lines 4+ omitted
		assert.ok(!r.output.includes("Body line 4"));
		assert.ok(!r.output.includes("Body line 7"));
		// Omission marker present
		assert.match(r.output, /\[\+\d+\s+lines\s+omitted\]/);
	});

	it("does not annotate commits with body shorter than 3 lines", () => {
		const r = applyCommandFilter("git log -10", longBody, "balanced");
		// Second commit only has subject line (no body), so no omission marker
		// should be added between commits.
		const lines = r.output.split("\n");
		const shortCommitIdx = lines.findIndex((l) => l.includes("Short commit"));
		assert.ok(shortCommitIdx > 0);
		// The next non-empty line after "Short commit" should NOT be an omission marker.
		const after = lines.slice(shortCommitIdx + 1).find((l) => l.trim() !== "");
		if (after) {
			assert.ok(!/\[\+\d+\s+lines\s+omitted\]/.test(after));
		}
	});

	it("--oneline pass-through is unchanged in balanced", () => {
		const oneline = "abcdef1 first\nfedcba0 second";
		const r = applyCommandFilter("git log --oneline -10", oneline, "balanced");
		assert.strictEqual(r.filtered, false);
		assert.strictEqual(r.output, oneline);
	});
});

describe("balanced mode — find/ls -R lower threshold", () => {
	it("summarizes a 25-line find result (above the new 20-line balanced floor)", () => {
		const lines: string[] = [];
		for (let i = 0; i < 25; i++) lines.push(`src/dir${i % 5}/file${i}.ts`);
		const stdout = lines.join("\n");
		const r = applyCommandFilter("find src -name '*.ts'", stdout, "balanced");
		// Should now summarize (was previously below the 30-line threshold)
		assert.strictEqual(r.filtered, true);
		assert.ok(r.output.includes("entries"));
		// Balanced keeps real paths — first entries verbatim, only the tail folds.
		assert.ok(r.output.includes("src/dir0/file0.ts"), "keeps first entries verbatim");
		assert.ok(r.output.includes("remainder by directory"));
	});

	it("still leaves a 15-line find result alone", () => {
		const lines: string[] = [];
		for (let i = 0; i < 15; i++) lines.push(`src/dir${i % 3}/file${i}.ts`);
		const r = applyCommandFilter("find src -name '*.ts'", lines.join("\n"), "balanced");
		// Below 20-line floor — passes through.
		assert.strictEqual(r.filtered, false);
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
		'On branch main\nYour branch is up to date with \'origin/main\'.\n\nChanges not staged for commit:\n  (use "git add <file>..." to update)\n\tmodified:   src/foo.ts\n\tmodified:   src/bar.ts\n\nUntracked files:\n  (use "git add <file>..." to include)\n\tnew.ts\n';

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

	it("balanced mode keeps perms/dates but strips universal noise", () => {
		const r = applyCommandFilter("ls -la", sample, "balanced");
		// Permissions and metadata preserved
		assert.ok(r.output.includes("drwxr-xr-x"));
		assert.ok(r.output.includes("staff"));
		// But the "total N" line and . / .. entries are dropped — they're
		// universally useless regardless of fidelity needs.
		assert.ok(!r.output.includes("total 192"));
		assert.ok(!/\s\.\s*$/m.test(r.output), "should drop '.' entry");
		assert.ok(!/\s\.\.\s*$/m.test(r.output), "should drop '..' entry");
	});
});

describe("aggressive mode — ls -laR drops dots and intra-section dirs", () => {
	const sample = `src/:
total 192
drwxr-xr-x   3 jiun  staff   96 May  6 14:20 .
drwxr-xr-x  10 jiun  staff  320 May  6 14:20 ..
-rw-r--r--   1 jiun  staff  1234 May  7 13:24 config.ts
drwxr-xr-x   2 jiun  staff    64 May  7 13:24 cli
drwxr-xr-x   2 jiun  staff    64 May  7 13:24 util

src/cli:
total 64
drwxr-xr-x   2 jiun  staff    64 May  7 13:24 .
drwxr-xr-x   3 jiun  staff    96 May  6 14:20 ..
-rw-r--r--   1 jiun  staff   500 May  7 13:24 doctor.ts
-rw-r--r--   1 jiun  staff   400 May  7 13:24 setup.ts

src/util:
total 32
drwxr-xr-x   2 jiun  staff    64 May  7 13:24 .
drwxr-xr-x   3 jiun  staff    96 May  6 14:20 ..
-rw-r--r--   1 jiun  staff   200 May  7 13:24 path.ts`;

	it("removes . / .. entries entirely", () => {
		const r = applyCommandFilter("ls -laR src/", sample, "aggressive");
		assert.strictEqual(r.filtered, true);
		// No bare "./" or "../" should appear in output
		assert.ok(!/^\.\/$/m.test(r.output), "should not contain ./");
		assert.ok(!/^\.\.\/$/m.test(r.output), "should not contain ../");
	});

	it("keeps section headers but drops redundant intra-section dir entries", () => {
		const r = applyCommandFilter("ls -laR src/", sample, "aggressive");
		// Section headers stay
		assert.ok(r.output.includes("src/:"));
		assert.ok(r.output.includes("src/cli:"));
		assert.ok(r.output.includes("src/util:"));
		// File entries stay
		assert.ok(r.output.includes("config.ts"));
		assert.ok(r.output.includes("doctor.ts"));
		// "cli" and "util" subdirs (listed within src/'s section) are redundant
		// because they get their own headers — should not appear as standalone "cli/" line.
		// Find lines that are exactly "cli/" or "util/" (no path prefix)
		const dropDirs = r.output.split("\n").filter((l) => l === "cli/" || l === "util/");
		assert.strictEqual(dropDirs.length, 0, "intra-section dir entries should be dropped");
	});

	it("compresses meaningfully more than the previous version", () => {
		const r = applyCommandFilter("ls -laR src/", sample, "aggressive");
		// Sample is ~750 bytes; aggressive should land under 250.
		assert.ok(r.output.length < 250, `expected <250B, got ${r.output.length}B`);
	});
});

describe("aggressive mode — df strips pseudo-filesystems", () => {
	const sample = `Filesystem        Size  Used Avail Use% Mounted on
/dev/disk1s1     500G  300G  200G  60% /
tmpfs            8.0G     0  8.0G   0% /tmp
devfs            200K  200K     0 100% /dev
overlay          50G   25G   25G  50% /var/lib/docker
udev             4.0G     0  4.0G   0% /dev
/dev/loop1       100M  50M   50M  50% /snap/test
map auto_home      0     0     0    -  /System/Volumes/Data/home`;

	it("removes tmpfs/devfs/overlay/udev/loop/map entries", () => {
		const r = applyCommandFilter("df -h", sample, "aggressive");
		assert.strictEqual(r.filtered, true);
		assert.ok(r.output.includes("/dev/disk1s1"));
		assert.ok(!r.output.includes("tmpfs"));
		assert.ok(!r.output.includes("devfs"));
		assert.ok(!r.output.includes("overlay"));
		assert.ok(!r.output.includes("udev"));
		assert.ok(!r.output.includes("/dev/loop"));
	});

	it("balanced mode passes df through", () => {
		const r = applyCommandFilter("df -h", sample, "balanced");
		assert.strictEqual(r.filtered, false);
	});
});

describe("aggressive mode — ps aux keeps PID/%CPU/%MEM/CMD only", () => {
	const sample = `USER       PID %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
jiun       100  5.2  1.0   400000  50000   ??  S     1:00PM   0:01.23 node /path/to/app
root         2  0.0  0.0        0      0   ??  S     8:00AM   0:00.01 [kthreadd]
jiun       200 10.5  2.5   800000 100000   ??  R     1:05PM   1:23.45 npm run build
root        50  0.0  0.0        0      0   ??  S     8:00AM   0:00.05 [migration]`;

	it("strips USER/VSZ/RSS/STAT and drops kernel-thread entries", () => {
		const r = applyCommandFilter("ps aux", sample, "aggressive");
		assert.strictEqual(r.filtered, true);
		assert.match(r.output, /^PID\s+%CPU\s+%MEM\s+CMD$/m);
		assert.ok(r.output.includes("100"), "should keep user processes");
		assert.ok(r.output.includes("npm run build"));
		// Kernel threads in [brackets] are dropped
		assert.ok(!r.output.includes("[kthreadd]"));
		assert.ok(!r.output.includes("[migration]"));
		// VSZ / RSS / STAT columns stripped
		assert.ok(!r.output.includes("VSZ"));
		assert.ok(!r.output.includes("RSS"));
	});
});

describe("aggressive mode — npm ls strips tree drawing + dedupes", () => {
	const sample = `my-app@1.0.0 /repo
├── react@18.2.0
├─┬ react-dom@18.2.0
│ └── react@18.2.0 deduped
├─┬ webpack@5.0.0
│ ├── extraneous webpack-cli@4.0.0
│ └── webpack@5.0.0 deduped
└── typescript@5.0.0`;

	it("strips tree-drawing characters", () => {
		const r = applyCommandFilter("npm ls", sample, "aggressive");
		assert.strictEqual(r.filtered, true);
		assert.ok(!/[│├└─┬]/u.test(r.output), "tree-drawing chars should be gone");
	});

	it("removes 'deduped' and 'extraneous' markers", () => {
		const r = applyCommandFilter("npm ls", sample, "aggressive");
		assert.ok(!r.output.includes("deduped"));
		assert.ok(!r.output.includes("extraneous"));
	});

	it("keeps each unique package line", () => {
		const r = applyCommandFilter("npm ls", sample, "aggressive");
		assert.ok(r.output.includes("react@18.2.0"));
		assert.ok(r.output.includes("typescript@5.0.0"));
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
