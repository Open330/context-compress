import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig, resetConfig } from "../../src/config.js";
import { smartTruncate } from "../../src/executor.js";
import { SessionTracker } from "../../src/stats.js";
import { assembleBudgetedResponse } from "../../src/util/byte-budget.js";
import { buildFetchCode } from "../../src/util/fetch-code.js";

const FETCH = "curl";

describe("the fetch hook stops at the command, not inside its arguments", () => {
	// A wrapper's operand left the scan open, so `sudo apt install <fetch tool>`
	// and `timeout 5 npm ls <fetch tool>` were denied with advice that does not
	// apply to them. Blocking a package install is worse than the risk it averts.
	const decide = (command: string): "deny" | "allow" => {
		const r = spawnSync(process.execPath, ["--import", "tsx", "src/hooks/pretooluse.ts"], {
			input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
			encoding: "utf-8",
			cwd: process.cwd(),
			timeout: 20_000,
		});
		// Mapping "no deny in stdout" to "allow" makes every allow-case pass on a
		// hook that crashed before deciding anything. Prove it ran.
		assert.strictEqual(r.status, 0, `hook exited ${r.status}: ${r.stderr.slice(0, 300)}`);
		assert.doesNotThrow(
			() => JSON.parse(r.stdout || "{}"),
			`hook emitted non-JSON: ${r.stdout.slice(0, 200)}`,
		);
		return r.stdout.includes('"deny"') ? "deny" : "allow";
	};

	const cases: Array<[string, "deny" | "allow"]> = [
		[`sudo apt install ${FETCH}`, "allow"],
		[`sudo apt-get install -y ${FETCH}`, "allow"],
		[`timeout 5 npm ls ${FETCH}`, "allow"],
		[`${FETCH} https://example.com`, "deny"],
		[`timeout 10 ${FETCH} http://x`, "deny"],
		[`sudo -u nobody ${FETCH} http://x`, "deny"],
		[`xargs -n1 ${FETCH}`, "deny"],
		[`env FOO=1 ${FETCH} http://x`, "deny"],
		// A wrapper can take several operands, and a flag can take a value. Consuming
		// exactly one operand allowed all four of these — real invocations.
		[`sudo -u nobody -g wheel ${FETCH} http://x`, "deny"],
		[`timeout -k 5 10 ${FETCH} http://x`, "deny"],
		[`nice -n 19 ionice -c3 ${FETCH} http://x`, "deny"],
		[`xargs -a f -n 1 -P 4 ${FETCH}`, "deny"],
		[`nohup ${FETCH} http://x`, "deny"],
		[`stdbuf -o0 ${FETCH} http://x`, "deny"],
		["timeout 30 make test", "allow"],
		[`docker run alpine apt add ${FETCH}`, "allow"],
		[`sudo systemctl restart ${FETCH}-daemon`, "allow"],
	];

	for (const [command, expected] of cases) {
		it(`${expected}s: ${command}`, () => {
			assert.strictEqual(decide(command), expected);
		});
	}
});

describe("a fetched page is decoded with its declared charset", () => {
	it("does not hard-code UTF-8", async () => {
		// Every page was decoded as UTF-8, so any other encoding became replacement
		// characters — permanently, since the corrupted text is what gets indexed
		// and returned. Asserting that the generated source mentions TextDecoder is
		// not enough: the first version of this test matched the word inside a
		// COMMENT and stayed green with the decode itself removed. Run it instead.
		const { createServer } = await import("node:http");
		const { SubprocessExecutor } = await import("../../src/executor.js");
		const { detectRuntimes } = await import("../../src/runtime/index.js");
		const runtimes = await detectRuntimes();
		if (!runtimes.has("javascript")) return;

		const body = Buffer.from("<html><body><p>Preis auf der Straße</p></body></html>", "latin1");
		const server = createServer((_req, res) => {
			res.setHeader("content-type", "text/html; charset=ISO-8859-1");
			res.end(body);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;

		const executor = new SubprocessExecutor(runtimes, loadConfig());
		try {
			const result = await executor.execute({
				language: "javascript",
				code: buildFetchCode(`http://127.0.0.1:${port}/`, "127.0.0.1"),
				timeout: 30_000,
			});
			assert.ok(
				result.stdout.includes("Straße"),
				`charset ignored: ${result.stdout.slice(0, 200)}`,
			);
			assert.ok(!result.stdout.includes("\uFFFD"), "the page was decoded as the wrong charset");
		} finally {
			executor.shutdown();
			server.close();
		}
	});
});

describe("wrap reports the capture cap honestly", () => {
	it("does not claim a signal-killed command ran to completion", () => {
		const script = [
			"process.stdout.write('o'.repeat(4096))",
			"process.kill(process.pid, 'SIGKILL')",
		].join(";");
		const wrapArgs = [
			"--mode",
			"conservative",
			"--",
			JSON.stringify(process.execPath),
			"-e",
			JSON.stringify(script),
		];
		const helper = [
			'import { runWrap } from "./src/cli/filter.ts"',
			`process.exitCode = await runWrap(${JSON.stringify(wrapArgs)}, { captureCapBytes: 512 })`,
		].join(";");
		const r = spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", helper],
			{
				encoding: "utf-8",
				cwd: process.cwd(),
				timeout: 20_000,
			},
		);
		assert.ok(!r.stderr.includes("ran to completion"), "a SIGKILLed command was called complete");
		assert.match(r.stderr, /SIGKILL/, "the signal was suppressed");
	});

	it("reads a shell's 128+N exit as the signal it stands for", () => {
		// The test above only caught this on macOS. `spawn(shell: true)` means the
		// watched process is /bin/sh: macOS's re-raises the signal, so Node reports
		// signal="SIGKILL", while Linux's dash exits 128+N and Node reports
		// signal=null. Measured with the same script — darwin {code: null, signal:
		// "SIGKILL"}, node:22-slim and node:24-slim both {code: 137, signal: null}.
		// So every Linux run of the wrap said a killed command "ran to completion".
		// Exiting 137 directly reproduces that shape on any platform.
		const script = ["process.stdout.write('o'.repeat(4096))", "process.exit(137)"].join(";");
		const wrapArgs = [
			"--mode",
			"conservative",
			"--",
			JSON.stringify(process.execPath),
			"-e",
			JSON.stringify(script),
		];
		const helper = [
			'import { runWrap } from "./src/cli/filter.ts"',
			`process.exitCode = await runWrap(${JSON.stringify(wrapArgs)}, { captureCapBytes: 512 })`,
		].join(";");
		const r = spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", helper],
			{ encoding: "utf-8", cwd: process.cwd(), timeout: 20_000 },
		);
		assert.ok(
			!r.stderr.includes("ran to completion"),
			`a command that exited 137 was called complete: ${r.stderr}`,
		);
		assert.match(r.stderr, /SIGKILL/, "128+9 was not reported as SIGKILL");
	});
});

describe("the intent summary never costs more than it saves", () => {
	it("counts stderr as part of the response it must not enlarge", async () => {
		// Testing stdout alone treated a failing command that writes only to stderr
		// as having nothing to preserve, so a 1,897-byte answer carrying every error
		// line was replaced by 12,028 bytes carrying none of them.
		const { registerExecuteTool } = await import("../../src/tools/execute.js");
		const stderr = Array.from(
			{ length: 40 },
			(_, i) => `ERROR src/mod${i}.ts: cannot resolve`,
		).join("\n");
		type H = (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
		let handler: H | undefined;
		const server = {
			registerTool(_n: unknown, _o: unknown, h: H) {
				handler = h;
			},
		};
		const ctx = {
			config: { maxOutputBytes: 102_400, intentSearchThreshold: 5_000 },
			executor: {
				execute: async () => ({
					stdout: "",
					indexableStdout: "x".repeat(50_000),
					stderr,
					exitCode: 1,
					truncated: false,
					killed: false,
				}),
			},
			tracker: { trackCall() {}, trackSandboxed() {} },
			projectDir: process.cwd(),
			withExecutionLimit: (fn: () => unknown) => fn(),
			applyIntentFilter: () => "S".repeat(12_000),
			bunDetected: false,
		};
		// biome-ignore lint/suspicious/noExplicitAny: minimal stand-ins for two collaborators
		registerExecuteTool(server as any, ctx as any);
		assert.ok(handler);
		const text = (await handler({ language: "shell", code: "b", timeout: 1_000, intent: "why" }))
			.content[0].text;
		assert.ok(text.includes("mod39"), "the diagnostic was replaced by a bigger summary");
	});
});

describe("a stderr-only failure may use the whole budget", () => {
	it("does not reserve half the budget for a body that is empty", async () => {
		const { assembleExecResponse } = await import("../../src/util/exec-status.js");
		const out = assembleExecResponse(
			"",
			`\n\nSTDERR:\n${"E".repeat(200_000)}`,
			{
				stdout: "",
				indexableStdout: "",
				stderr: "E",
				exitCode: 1,
				truncated: false,
				killed: false,
			},
			102_400,
		);
		assert.ok(Buffer.byteLength(out) <= 102_400, "budget exceeded");
		assert.ok(
			Buffer.byteLength(out) > 102_400 * 0.9,
			`only ${Buffer.byteLength(out)} of 102400 bytes used`,
		);
	});
});

describe("an unfittable block is clipped wherever it appears", () => {
	it("clips a block that can never fit, not only the first one", () => {
		// `search` maps one block per query, so an oversized block in position 2
		// returned 41 bytes and none of the answer — the original defect, one slot
		// over.
		const out = assembleBudgetedResponse({
			blocks: ["small block answer\n", "ANSWER-TEXT ".repeat(5_000)],
			limit: 40_960,
			omissionNote: (n) => `\n\n_(${n} omitted)_`,
		});
		assert.ok(out.includes("ANSWER-TEXT"), "the answer vanished from position 2");
		assert.ok(out.includes("small block answer"), "the first block was displaced");
		assert.ok(Buffer.byteLength(out) <= 40_960, "budget exceeded");
	});
});

describe("a corrupt stats entry cannot poison the file", () => {
	it("drops entries whose call count is not a number", () => {
		// A string `calls` turned `+= delta` into concatenation, so the file grew a
		// value like "many1111" and the report rendered "9.53e+301MB" — written back
		// to disk on every save.
		const dir = mkdtempSync(join(tmpdir(), "cc-stats2-"));
		try {
			const file = join(dir, "stats.json");
			writeFileSync(
				file,
				JSON.stringify({
					totalBytesSaved: 0,
					totalBytesProcessed: 0,
					totalCalls: 0,
					totalSessions: 0,
					firstSeen: "2020-01-01T00:00:00Z",
					lastSeen: "2020-01-01T00:00:00Z",
					perCommand: { execute: { calls: "many" } },
				}),
			);
			const tracker = new SessionTracker(file);
			tracker.trackCall("execute", 100);
			tracker.saveCumulative();
			const saved = tracker.loadCumulative();
			assert.strictEqual(typeof saved?.perCommand?.execute?.calls, "number");
			assert.ok(!tracker.formatReport().includes("e+"), "the report rendered a poisoned number");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("hardCapBytes has the floor the budget claims", () => {
	it("cannot be set below the minimum response budget", () => {
		const previous = process.env.CONTEXT_COMPRESS_HARD_CAP_BYTES;
		try {
			for (const value of ["5", "100", "162"]) {
				process.env.CONTEXT_COMPRESS_HARD_CAP_BYTES = value;
				resetConfig();
				const config = loadConfig();
				// Without the floor the budget was clamped straight back down and any
				// effective budget of 11..162 bytes returned markers with no content.
				assert.ok(config.hardCapBytes >= 1024, `hardCapBytes ${config.hardCapBytes} at ${value}`);
				assert.ok(config.maxOutputBytes >= 1024, `maxOutputBytes ${config.maxOutputBytes}`);
				assert.ok(
					Buffer.byteLength(smartTruncate(`${"x".repeat(100_000)}\n`, config.maxOutputBytes)) > 500,
					"the response is markers only",
				);
			}
		} finally {
			if (previous === undefined) delete process.env.CONTEXT_COMPRESS_HARD_CAP_BYTES;
			else process.env.CONTEXT_COMPRESS_HARD_CAP_BYTES = previous;
			resetConfig();
		}
	});
});

describe("a live peer's store is not swept as stale", () => {
	it("ages a store directory by its newest file, not the directory mtime", async () => {
		// A directory mtime changes only when an entry is added or removed, which
		// sqlite writes never do, so an hour-old-but-busy store looked abandoned.
		const { cleanupStaleDbs } = await import("../../src/store.js");
		const dir = join(tmpdir(), `context-compress-store-${process.pid}-alive`);
		mkdirSync(dir, { recursive: true });
		try {
			const db = join(dir, "store.db");
			writeFileSync(db, "recent activity");
			const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
			utimesSync(dir, old, old);
			cleanupStaleDbs();
			assert.doesNotThrow(() => writeFileSync(db, "still here"), "a live store was deleted");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("wrap normalizes stderr the way execute does", () => {
	it("strips ANSI, groups repeats, and holds stderr to the response budget", () => {
		// `wrap` compressed stdout and wrote stderr back untouched: no ANSI strip,
		// no grouping, and never counted against maxOutputBytes. Claude Code's Bash
		// tool returns stderr to the model, so those bytes are context, not a
		// terminal — and `setup --auto` makes this the path most callers get.
		// Measured before the fix: execute returned 102,400 bytes with no escape
		// sequences, wrap returned 4,020,042 with 60,000 of them.
		const child = [
			"for (let i = 0; i < 60000; i++)",
			"process.stderr.write('\\x1b[31mE' + i + '\\x1b[0m: cannot resolve symbol qz' + i + '\\n')",
		].join(" ");
		const wrapArgs = [
			"--mode",
			"conservative",
			"--",
			JSON.stringify(process.execPath),
			"-e",
			JSON.stringify(child),
		];
		const helper = [
			'import { runWrap } from "./src/cli/filter.ts"',
			`process.exitCode = await runWrap(${JSON.stringify(wrapArgs)})`,
		].join(";");

		const r = spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", helper],
			{
				encoding: "utf-8",
				cwd: process.cwd(),
				timeout: 60_000,
				maxBuffer: 64 * 1024 * 1024,
			},
		);

		assert.strictEqual(r.error, undefined);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the escapes are gone
		assert.ok(!/\x1b\[/.test(r.stderr), "ANSI escape sequences reached the response");
		const budget = loadConfig().maxOutputBytes;
		assert.ok(
			Buffer.byteLength(r.stderr) <= budget * 2,
			`stderr was not budgeted: ${Buffer.byteLength(r.stderr)} bytes against a ${budget} budget`,
		);
	});
});

describe("fuzzy correction only offers words a search can reach", () => {
	it("does not hand the correction to a pruned source's word", async () => {
		// `vocabulary` has no source_id, so retention pruning leaves the words of
		// deleted sources behind. Taking the single strict minimum handed the
		// correction to whichever tied word was inserted first — always the older,
		// already-deleted one — and porterSearch then found nothing, so the search
		// reported nothing for content that was still fully indexed.
		const { ContentStore } = await import("../../src/store.js");
		const build = (withDeadSource: boolean) => {
			const store = new ContentStore({ dbPath: ":memory:", maxIndexedSources: 2 });
			if (withDeadSource) {
				store.index("deployment notes zebracornxx dead payload", "dead");
				for (let i = 0; i < 4; i++) store.index(`filler content number ${i} deployment`, `f${i}`);
			}
			store.index("deployment notes zebracornyy live payload", "live");
			return store;
		};

		for (const withDeadSource of [false, true]) {
			const store = build(withDeadSource);
			try {
				const result = store.search("zebracornzz");
				assert.strictEqual(
					result.results.length,
					1,
					`pruned vocabulary changed the answer (withDeadSource=${withDeadSource})`,
				);
				assert.strictEqual(result.corrected, "zebracornyy");
			} finally {
				store.close();
			}
		}
	});
});
