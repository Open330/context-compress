import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SessionTracker } from "../../src/stats.js";
import { ContentStore } from "../../src/store.js";
import type { ToolContext } from "../../src/tools/context.js";
import { registerExecuteTool } from "../../src/tools/execute.js";
import type { ExecResult } from "../../src/types.js";
import { assembleBudgetedResponse } from "../../src/util/byte-budget.js";

type Handler = (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function handlerFor(exec: Partial<ExecResult>, filter?: (o: string) => string): Handler {
	let handler: Handler | undefined;
	const server = {
		registerTool(_n: unknown, _o: unknown, h: Handler) {
			handler = h;
		},
	} as unknown as McpServer;
	const result: ExecResult = {
		stdout: "",
		indexableStdout: "",
		stderr: "",
		exitCode: 0,
		truncated: false,
		killed: false,
		...exec,
	};
	const ctx = {
		config: { maxOutputBytes: 102_400, intentSearchThreshold: 5_000 },
		executor: { execute: async () => result },
		tracker: { trackCall() {}, trackSandboxed() {} },
		projectDir: process.cwd(),
		withExecutionLimit: (fn: () => unknown) => fn(),
		applyIntentFilter: filter ?? ((o: string) => o),
		bunDetected: false,
	} as unknown as ToolContext;
	registerExecuteTool(server, ctx);
	assert.ok(handler);
	return handler;
}

describe("a failing run's diagnostic survives a full budget", () => {
	it("reserves the STDERR block instead of clamping it off the end", async () => {
		// The executor expands stdout to fill maxOutputBytes, and the STDERR block is
		// appended after it. truncateToBytes keeps the head, so the diagnostic sat
		// entirely inside the bytes that got cut: 4,609 bytes of stderr survived as
		// 150, without the last error line. A failing build returns nothing useful.
		const stderr = Array.from(
			{ length: 60 },
			(_, i) => `ERROR in ./src/app${i}.ts:42:7  TS2345: not assignable`,
		).join("\n");

		for (const stdoutBytes of [102_240, 90_000, 50_000]) {
			const stdout = "o".repeat(stdoutBytes);
			const text = (
				await handlerFor({ stdout, indexableStdout: stdout, stderr, exitCode: 1 })({
					language: "shell",
					code: "build",
					timeout: 1_000,
				})
			).content[0].text;

			assert.ok(Buffer.byteLength(text) <= 102_400, `budget exceeded at ${stdoutBytes}`);
			assert.ok(text.includes("app0.ts"), `first error lost at ${stdoutBytes}`);
			assert.ok(text.includes("app59.ts"), `last error lost at ${stdoutBytes}`);
			assert.match(text, /Status: failed/, `status lost at ${stdoutBytes}`);
		}
	});
});

describe("intent never enlarges the response", () => {
	it("keeps the curated response when the summary would be bigger", async () => {
		// The filter's threshold sees the raw corpus, so a chatty command whose
		// curated response was already small got swapped for a summary rebuilt from
		// the noise the command filter had just removed: a 227-byte `npm test`
		// rollup with no PASS lines came back as 2,798 bytes with 45 of them.
		const curated = "Tests: 2 failed, 400 passed";
		const raw = `${Array.from({ length: 400 }, (_, i) => `PASS widget${i}.test.ts`).join("\n")}\n${curated}`;
		const bigSummary = `Indexed 23 sections.\n${"PASS widget1.test.ts\n".repeat(200)}`;

		const text = (
			await handlerFor(
				{ stdout: curated, indexableStdout: raw },
				() => bigSummary,
			)({
				language: "shell",
				code: "npm test",
				timeout: 1_000,
				intent: "which tests failed",
			})
		).content[0].text;

		assert.ok(text.includes(curated), "the curated response was discarded");
		assert.ok(
			Buffer.byteLength(text) <= Buffer.byteLength(curated) + 200,
			`asking a question enlarged the response to ${Buffer.byteLength(text)} bytes`,
		);
	});

	it("still uses the summary when there is no response to preserve", async () => {
		// An empty response copy is not an answer, so the summary is the only
		// account of what was indexed.
		const text = (
			await handlerFor(
				{ stdout: "", indexableStdout: "x".repeat(50_000) },
				() => "indexed summary",
			)({ language: "shell", code: "run", timeout: 1_000, intent: "what happened" })
		).content[0].text;
		assert.match(text, /indexed summary/);
	});
});

describe("a block bigger than the budget is clipped, not dropped", () => {
	it("returns the answer rather than only an omission note", () => {
		// Block size is driven by caller-supplied labels and titles, neither bounded.
		const out = assembleBudgetedResponse({
			blocks: ["ANSWER-TEXT ".repeat(5_000)],
			limit: 40_960,
			omissionNote: (n) => `\n\n_(${n} of 1 query blocks omitted)_`,
		});
		assert.ok(out.includes("ANSWER-TEXT"), "the only matching block vanished");
		assert.ok(Buffer.byteLength(out) <= 40_960, "budget exceeded");
		assert.ok(Buffer.byteLength(out) > 40_960 * 0.9, `only ${Buffer.byteLength(out)} bytes used`);
	});
});

describe("vocabulary keeps learning once it is full", () => {
	it("evicts the oldest words instead of refusing new ones", () => {
		// Returning early once the table was full made it a first-come set whenever
		// stale-word pruning had nothing to free — the normal state for a large
		// retention window. Measured at maxIndexedSources 500 over 700 sources:
		// vocabulary pinned at 10,000 and the newest source was fully indexed but
		// unknown to fuzzy correction, which answered a typo with no correction.
		const store = new ContentStore({ dbPath: ":memory:", maxIndexedSources: 500 });
		try {
			for (let n = 0; n < 700; n++) {
				const words = Array.from({ length: 200 }, (_, i) => `w${n}x${i}`).join(" ");
				store.index(`uniqueterm${n}marker ${words}`, `src-${n}`);
			}
			const newest = store.search("uniqueterm699markre");
			assert.strictEqual(newest.corrected, "uniqueterm699marker", "the newest source is unknown");
			assert.ok(newest.results.length > 0, "a typo of the newest content found nothing");
		} finally {
			store.close();
		}
	});
});

describe("a repository cannot redirect the database out of the project", () => {
	it("refuses a symlinked persistent database path", () => {
		// dbDir and persistDb are user-scope-only so an untrusted repo cannot choose
		// where the full uncompressed output of every command is written. The default
		// destination is inside the project and both mkdir and the sqlite open follow
		// symlinks, so a committed symlink reached the same result with no config.
		const root = mkdtempSync(join(tmpdir(), "cc-symlink-"));
		try {
			const project = join(root, "repo");
			mkdirSync(join(project, ".context-compress"), { recursive: true });
			symlinkSync(join(root, "outside.db"), join(project, ".context-compress", "store.db"));
			assert.throws(
				() => new ContentStore({ persistDb: true, dbDir: join(project, ".context-compress") }),
				/refusing symlinked database path/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("a project-controlled stats file cannot break the stats tool", () => {
	it("treats any unexpected shape as absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "cc-stats-"));
		try {
			const file = join(dir, "stats.json");
			const base = { totalBytesSaved: 0, totalBytesProcessed: 0, totalCalls: 0, totalSessions: 0 };
			const shapes = [
				JSON.stringify({ ...base, firstSeen: "2020-01-01T00:00:00Z", lastSeen: "x" }),
				JSON.stringify({ ...base, firstSeen: 123, lastSeen: "x", perCommand: {} }),
				JSON.stringify({ ...base, firstSeen: "a", lastSeen: "b", perCommand: "nope" }),
				"null",
				"[]",
				"not json at all",
			];
			for (const shape of shapes) {
				writeFileSync(file, shape);
				const tracker = new SessionTracker(file);
				tracker.trackCall("execute", 100);
				assert.doesNotThrow(() => tracker.saveCumulative(), `saveCumulative on ${shape}`);
				assert.doesNotThrow(() => tracker.formatReport(), `formatReport on ${shape}`);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
