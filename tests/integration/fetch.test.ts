import assert from "node:assert";
import dns from "node:dns";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, resetConfig } from "../../src/config.js";
import { SubprocessExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime/index.js";
import { SessionTracker } from "../../src/stats.js";
import { ContentStore } from "../../src/store.js";
import type { ToolContext } from "../../src/tools/context.js";
import { registerFetchAndIndexTool } from "../../src/tools/fetch-and-index.js";
import type { ExecResult } from "../../src/types.js";
import { buildFetchCode } from "../../src/util/fetch-code.js";
import { htmlToMarkdownSnippet } from "../../src/util/html-to-markdown.js";
import { createIntentFilter } from "../../src/util/intent-filter.js";

const ORIGINAL_HOME = process.env.HOME;

function isolateConfigHome(): void {
	process.env.HOME = `/tmp/context-compress-home-${process.pid}-${Date.now()}`;
}

// Use the SAME conversion snippet the production fetch tool uses, so this test
// exercises the real pipeline and the two can never drift.
function buildHtmlToMarkdownCode(html: string): string {
	return `const html = ${JSON.stringify(html)};\n${htmlToMarkdownSnippet()}`;
}

type FetchHandler = (args: {
	url: string;
	source?: string;
}) => Promise<{ content: Array<{ type: string; text: string }> }>;

function captureFetchHandler(ctx: ToolContext): FetchHandler {
	let handler: FetchHandler | undefined;
	const server = {
		registerTool(_name: unknown, _definition: unknown, callback: FetchHandler) {
			handler = callback;
		},
	} as unknown as McpServer;
	registerFetchAndIndexTool(server, ctx);
	assert.ok(handler, "fetch handler must be registered");
	return handler;
}

describe("integration: fetch conversion workflow", () => {
	beforeEach(() => {
		resetConfig();
		delete process.env.CONTEXT_COMPRESS_PASSTHROUGH_ENV;
		isolateConfigHome();
	});

	afterEach(() => {
		resetConfig();
		if (ORIGINAL_HOME === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = ORIGINAL_HOME;
		}
	});

	it(
		"converts sample HTML to markdown, strips script/style, converts links, then indexes and searches",
		{ timeout: 20_000 },
		async (t) => {
			const config = loadConfig();
			const runtimes = await detectRuntimes();
			if (!runtimes.has("javascript")) {
				t.skip("javascript runtime not detected");
				return;
			}

			const executor = new SubprocessExecutor(runtimes, config);
			const store = new ContentStore(":memory:");

			try {
				const html = `
<!doctype html>
<html>
  <head>
    <style>body{color:red}</style>
    <script>console.log("ignore me")</script>
  </head>
  <body>
    <h1>Main Title</h1>
    <p>Welcome to <a href="https://example.com/docs">Docs</a>.</p>
    <h2>Details</h2>
    <p>More text here.</p>
  </body>
</html>
`.trim();

				const result = await executor.execute({
					language: "javascript",
					code: buildHtmlToMarkdownCode(html),
					timeout: 10_000,
				});

				assert.strictEqual(result.exitCode, 0);
				const markdown = result.indexableStdout.trim();
				assert.match(markdown, /# Main Title/);
				assert.match(markdown, /\[Docs\]\(https:\/\/example\.com\/docs\)/);
				assert.ok(!markdown.includes("console.log"));
				assert.ok(!markdown.includes("color:red"));
				assert.ok(!markdown.includes("<script"));
				assert.ok(!markdown.includes("<style"));

				store.index(markdown, "fetch:sample");
				assert.ok(store.search("Main Title").results.length > 0);
				assert.ok(store.search("Docs").results.length > 0);
			} finally {
				store.close();
			}
		},
	);

	it("pins the validated IP and forces the Node runtime when executing the fetch", async () => {
		// Both guarantees were unprotected: deleting `buildFetchCode(url, resolvedIp)`
		// and `requireRuntime: "node"` left the whole suite green, because the only
		// test touching this handler discarded the executor's options. That reopens
		// DNS rebinding (a second lookup can move) and lets the snippet run under
		// Bun, whose node:http shim silently ignores connection pinning.
		const config = loadConfig();
		const store = new ContentStore(":memory:");
		const tracker = new SessionTracker();
		const seen: Array<{ code: string; requireRuntime?: string }> = [];
		const executor = {
			execute: async (opts: { code: string; requireRuntime?: string }) => {
				seen.push({ code: opts.code, requireRuntime: opts.requireRuntime });
				return {
					indexableStdout: "# Page\n\nbody text",
					stdout: "# Page\n\nbody text",
					stderr: "",
					exitCode: 0,
					truncated: false,
					killed: false,
				} satisfies ExecResult;
			},
		} as unknown as SubprocessExecutor;
		const ctx: ToolContext = {
			config,
			store,
			tracker,
			executor,
			projectDir: process.cwd(),
			bunDetected: false,
			dbFallback: false,
			withExecutionLimit: (fn) => fn(),
			applyIntentFilter: createIntentFilter({ config, store, tracker }),
		};

		const lookup = mock.method(dns.promises, "lookup", async () => ({
			address: "93.184.216.34",
			family: 4 as const,
		}));
		try {
			await captureFetchHandler(ctx)({ url: "https://example.com/page" });

			assert.strictEqual(seen.length, 1, "the handler must execute the snippet once");
			const [call] = seen;
			assert.strictEqual(
				call.requireRuntime,
				"node",
				"the fetch snippet must be pinned to Node — Bun ignores connection pinning",
			);
			assert.ok(
				call.code.includes('"93.184.216.34"'),
				"the resolved IP must be pinned into the generated snippet",
			);
			assert.ok(
				call.code.includes("createConnection"),
				"pinning must happen at the connection layer",
			);
			// The URL hostname has to survive for TLS SNI and certificate validation.
			assert.ok(call.code.includes('"https://example.com/page"'));
			assert.ok(!call.code.includes("https://93.184.216.34"));
		} finally {
			lookup.mock.restore();
			store.close();
		}
	});

	it("indexes pre-filter fetch content while previewing compressed stdout", async () => {
		const config = loadConfig();
		const store = new ContentStore(":memory:");
		const tracker = new SessionTracker();
		const sentinel = "rpfhiddenfetchsentinel";
		const result: ExecResult = {
			indexableStdout: `# Visible\n\npreview only\n\n## Hidden\n\n${sentinel} remains searchable`,
			stdout: "# Visible\n\npreview only",
			stderr: "",
			exitCode: 0,
			truncated: true,
			killed: false,
			networkBytes: 128,
		};
		const executor = {
			execute: async () => result,
		} as unknown as SubprocessExecutor;
		const ctx: ToolContext = {
			config,
			store,
			tracker,
			executor,
			projectDir: process.cwd(),
			bunDetected: false,
			dbFallback: false,
			withExecutionLimit: (fn) => fn(),
			applyIntentFilter: createIntentFilter({ config, store, tracker }),
		};

		try {
			const response = await captureFetchHandler(ctx)({
				// A public raw IP avoids ambient DNS/network dependence; the executor
				// is injected, so this test exercises only the production tool flow.
				url: "http://8.8.8.8/",
				source: "fetch:retention-test",
			});
			const text = response.content[0].text;
			assert.ok(!text.includes(sentinel), "preview must use compressed stdout");
			assert.ok(store.search(sentinel).results.length > 0, "hidden fetch content is searchable");
		} finally {
			store.close();
		}
	});
});

/**
 * These execute the generated fetch snippet for real, exactly as the fetch tool
 * does (`requireRuntime: "node"`). String assertions on buildFetchCode() output
 * cannot catch a runtime that accepts the pinning hook and then ignores it —
 * which is what Bun does to both `lookup` and `createConnection`.
 *
 * The URL hostname deliberately does not resolve, so the request can only
 * succeed when the socket is genuinely pinned. Using `localhost` here would pass
 * even with pinning completely broken, which is how the Bun bug slipped through.
 */
const UNRESOLVABLE_HOST = "pinning-target.invalid.example";

describe("integration: pinned fetch over the real runtime", () => {
	beforeEach(() => {
		resetConfig();
		delete process.env.CONTEXT_COMPRESS_PASSTHROUGH_ENV;
		isolateConfigHome();
	});

	afterEach(() => {
		resetConfig();
		if (ORIGINAL_HOME === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = ORIGINAL_HOME;
		}
	});

	it("fetches through an IP-pinned socket while the URL keeps its hostname", async (t) => {
		const config = loadConfig();
		const runtimes = detectRuntimes();
		if (!runtimes.has("javascript")) {
			t.skip("javascript runtime not detected");
			return;
		}

		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<html><body><h1>Pinned OK</h1></body></html>");
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as AddressInfo).port;

		const executor = new SubprocessExecutor(runtimes, config);
		try {
			const result = await executor.execute({
				language: "javascript",
				code: buildFetchCode(`http://${UNRESOLVABLE_HOST}:${port}/`, "127.0.0.1"),
				timeout: 15_000,
				requireRuntime: "node",
			});
			assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
			assert.match(result.stdout, /# Pinned OK/);
			assert.ok((result.networkBytes ?? 0) > 0, "transferred bytes must reach the network counter");
		} finally {
			executor.shutdown();
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	it("blocks redirects instead of following them", async (t) => {
		const config = loadConfig();
		const runtimes = detectRuntimes();
		if (!runtimes.has("javascript")) {
			t.skip("javascript runtime not detected");
			return;
		}

		const server = createServer((_req, res) => {
			res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
			res.end();
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as AddressInfo).port;

		const executor = new SubprocessExecutor(runtimes, config);
		try {
			const result = await executor.execute({
				language: "javascript",
				code: buildFetchCode(`http://${UNRESOLVABLE_HOST}:${port}/`, "127.0.0.1"),
				timeout: 15_000,
				requireRuntime: "node",
			});
			assert.notStrictEqual(result.exitCode, 0);
			assert.match(result.stderr, /Redirect blocked/);
			assert.ok(!result.stdout.includes("meta-data"));
		} finally {
			executor.shutdown();
			await new Promise<void>((r) => server.close(() => r()));
		}
	});
});
