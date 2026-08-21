import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { SubprocessExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime/index.js";
import { assembleBudgetedResponse } from "../../src/util/byte-budget.js";
import { buildFetchCode } from "../../src/util/fetch-code.js";

describe("wrap's capture accounting and decoding", () => {
	/** Runs `wrap` on a child that writes `bytes` to stdout, capped at `cap`. */
	function wrapChild(script: string, cap: number): { stdout: string; stderr: string } {
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
			`process.exitCode = await runWrap(${JSON.stringify(wrapArgs)}, { captureCapBytes: ${cap} })`,
		].join(";");
		const r = spawnSync(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", helper],
			{
				encoding: "utf-8",
				cwd: process.cwd(),
				timeout: 60_000,
				maxBuffer: 256 * 1024 * 1024,
			},
		);
		assert.strictEqual(r.error, undefined);
		return { stdout: r.stdout, stderr: r.stderr };
	}

	it("reports how much it actually dropped", () => {
		// The count mixed a global counter with one stream's ring and never counted
		// an eviction, so 1MB, 10MB and 100MB of loss all reported "64.0KB" — wrong
		// by up to 1,600x on the number whose only job is to say what is missing.
		// Keep the whole assembled response under maxOutputBytes so the marker — which
		// sits between the head and the rolling tail — is not itself truncated away.
		const cap = 4096;
		const written = 300_000;
		const { stdout } = wrapChild(`process.stdout.write("x".repeat(${written}))`, cap);
		const marker = /not captured — ([\d.]+)KB past/.exec(stdout);
		assert.ok(marker, `no capture marker in the response: ${stdout.slice(0, 300)}`);
		const reportedBytes = Number(marker[1]) * 1024;
		// Everything past the cap, minus the rolling tail the ring keeps.
		const expected = written - cap * 2;
		assert.ok(
			Math.abs(reportedBytes - expected) < expected * 0.05,
			`reported ${reportedBytes} bytes where roughly ${expected} were dropped`,
		);
	});

	it("does not mark a stream that lost nothing", () => {
		// `capped` is global but the sinks are per-stream, so the stream that never
		// overflowed had "not captured — 0B past the limit" spliced into intact
		// output.
		const { stdout, stderr } = wrapChild(
			`process.stderr.write("e".repeat(200000)); process.stdout.write("intact stdout")`,
			4096,
		);
		assert.ok(stdout.includes("intact stdout"), "the small stream was mangled");
		assert.ok(!stdout.includes("not captured"), "a stream that lost nothing was marked");
		assert.ok(!/not captured — 0B/.test(stderr), "reported a zero-byte loss");
	});

	it("never splits a character at the cap boundary", () => {
		// The tail decode had a continuation-byte guard; the head decode did not, so
		// 2 of 3 cap offsets emitted a replacement character into the response.
		for (const offset of [0, 1, 2, 3]) {
			const { stdout } = wrapChild(
				`process.stdout.write("A".repeat(${1024 - offset}) + "\\u{1F600}".repeat(200))`,
				1024,
			);
			assert.ok(!stdout.includes("�"), `offset ${offset} split a character`);
		}
	});
});

describe("conservative mode still respects the response cap", () => {
	it("bounds output it declines to filter", async () => {
		// Conservative means "do not FILTER", not "do not bound". Returning early
		// skipped the cap entirely: 8MB of stdout came back as 8,388,609 bytes
		// against a 102,400-byte budget — on the one mode a caller picks when they
		// want the output intact, which is exactly when it is largest.
		const { compressOutput } = await import("../../src/cli/filter.js");
		const out = compressOutput("x".repeat(8 * 1024 * 1024), "cat big.log", "conservative", 102_400);
		assert.ok(
			Buffer.byteLength(out) <= 102_400,
			`conservative returned ${Buffer.byteLength(out)} bytes against a 102400 budget`,
		);
		assert.ok(Buffer.byteLength(out) > 500, "the response collapsed to markers");
	});
});

describe("the intent snippet budget is measured in bytes", () => {
	it("does not overshoot on multi-byte text", async () => {
		// clip() checked Buffer.byteLength and then sliced CHARACTERS, overshooting
		// by 2.71x on CJK at the `ultra` default of 500 bytes — the setting a caller
		// picks precisely to keep responses small.
		const { ContentStore } = await import("../../src/store.js");
		const { SessionTracker } = await import("../../src/stats.js");
		const { createIntentFilter } = await import("../../src/util/intent-filter.js");

		for (const [label, unit] of [
			["CJK", "한"],
			["emoji", "😀"],
			["ascii", "a"],
		] as const) {
			const store = new ContentStore({ dbPath: ":memory:" });
			try {
				const config = { ...loadConfig(), intentBudgetBytes: 500, intentSearchThreshold: 100 };
				const filter = createIntentFilter({
					config,
					store,
					tracker: new SessionTracker(),
				});
				// Sections long enough that a snippet actually reaches the per-hit cap —
				// with short sections clip never fires and the test proves nothing.
				const corpus = Array.from(
					{ length: 60 },
					(_, i) => `## Section ${i}\n\n${unit.repeat(200)} needle ${unit.repeat(200)}`,
				).join("\n\n");
				const out = filter(corpus, "needle", "execute:shell");
				// The budget governs inlined snippets; the header, error block and footer
				// are extra. A byte budget sliced by CHARACTERS overshot 2.71x.
				// Measured: 848 bytes for every script with the byte-safe helper; the
				// character-slicing version returns 1,156 for CJK. The bound has to sit
				// between them or it certifies the overshoot.
				assert.ok(
					Buffer.byteLength(out) < 1_000,
					`${label}: ${Buffer.byteLength(out)} bytes against a 500-byte snippet budget`,
				);
			} finally {
				store.close();
			}
		}
	});
});

describe("a clipped block does not starve the blocks behind it", () => {
	it("charges what the clip costs, and skips a clip not worth making", () => {
		// Charging the whole limit starved every later block: a 50KB block clipped
		// into 32 bytes displaced a 13-byte block that would have fit.
		const out = assembleBudgetedResponse({
			// Two shapes matter: a clip with room to spare, and a clip not worth making
			// at all. Only the first reaches the accounting.
			blocks: ["F".repeat(1_000), "Z".repeat(50_000), "late-but-tiny"],
			limit: 10_000,
			omissionNote: (n) => `\n\n_(${n} omitted)_`,
		});
		assert.ok(out.includes("late-but-tiny"), "a block that fit was displaced by a clip");
		assert.ok(out.includes("ZZZZ"), "the unfittable block was dropped instead of clipped");
		assert.ok(Buffer.byteLength(out) <= 10_000, "budget exceeded");

		// When the budget is nearly spent a clip buys a marker and costs the block
		// behind it, so it is skipped entirely.
		const spent = assembleBudgetedResponse({
			blocks: ["F".repeat(9_900), "Z".repeat(50_000), "late-but-tiny"],
			limit: 10_000,
			omissionNote: (n) => `\n\n_(${n} omitted)_`,
		});
		assert.ok(spent.includes("late-but-tiny"), "a pointless clip displaced a block that fit");
	});
});

describe("fetch decodes what the server actually sent", () => {
	async function fetchThrough(
		contentType: string,
		body: Buffer,
		headers: Record<string, string> = {},
	): Promise<{ text: string; exitCode: number | null }> {
		const server = createServer((_req, res) => {
			res.setHeader("content-type", contentType);
			for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
			res.end(body);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		const executor = new SubprocessExecutor(await detectRuntimes(), loadConfig());
		try {
			const r = await executor.execute({
				language: "javascript",
				code: buildFetchCode(`http://127.0.0.1:${port}/`, "127.0.0.1"),
				timeout: 30_000,
			});
			return { text: r.stdout + r.stderr, exitCode: r.exitCode };
		} finally {
			executor.shutdown();
			server.close();
		}
	}

	const html = "<html><body><p>Preis auf der Straße</p></body></html>";

	it("accepts whitespace and quoting around the charset parameter", async () => {
		const runtimes = await detectRuntimes();
		if (!runtimes.has("javascript")) return;
		for (const contentType of [
			"text/html; charset = ISO-8859-1",
			'text/html; CHARSET="ISO-8859-1"',
			"text/html;charset=iso-8859-1",
		]) {
			const { text } = await fetchThrough(contentType, Buffer.from(html, "latin1"));
			assert.ok(text.includes("Straße"), `charset ignored for: ${contentType}`);
			assert.ok(!text.includes("�"), `mojibake for: ${contentType}`);
		}
	});

	it("falls back rather than throwing on an unknown charset label", async () => {
		const runtimes = await detectRuntimes();
		if (!runtimes.has("javascript")) return;
		const { text, exitCode } = await fetchThrough(
			"text/html; charset=not-a-real-charset",
			Buffer.from(html, "utf8"),
		);
		assert.strictEqual(exitCode, 0, "an unknown charset label must not fail the fetch");
		assert.ok(text.includes("Straße"), "the UTF-8 fallback did not run");
	});

	it("refuses a compressed body rather than indexing the compressed bytes", async () => {
		const runtimes = await detectRuntimes();
		if (!runtimes.has("javascript")) return;
		const { gzipSync } = await import("node:zlib");
		const { text } = await fetchThrough(
			"text/html; charset=utf-8",
			gzipSync(Buffer.from(html, "utf8")),
			{ "content-encoding": "gzip" },
		);
		// Nothing here inflates, so raw DEFLATE bytes were decoded as text and
		// indexed as 23 replacement characters.
		assert.ok(text.includes("Compressed response"), "a gzip body was decoded as text");
		assert.ok(!text.includes("�"), "compressed bytes reached the response");
	});
});
