import assert from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, resetConfig } from "../../src/config.js";
import { SubprocessExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime/index.js";
import { ContentStore } from "../../src/store.js";
import { buildFetchCode } from "../../src/util/fetch-code.js";
import { htmlToMarkdownSnippet } from "../../src/util/html-to-markdown.js";

const ORIGINAL_HOME = process.env.HOME;

function isolateConfigHome(): void {
	process.env.HOME = `/tmp/context-compress-home-${process.pid}-${Date.now()}`;
}

// Use the SAME conversion snippet the production fetch tool uses, so this test
// exercises the real pipeline and the two can never drift.
function buildHtmlToMarkdownCode(html: string): string {
	return `const html = ${JSON.stringify(html)};\n${htmlToMarkdownSnippet()}`;
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
				const markdown = result.stdout.trim();
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
