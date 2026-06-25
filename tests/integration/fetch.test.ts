import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, resetConfig } from "../../src/config.js";
import { SubprocessExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime/index.js";
import { ContentStore } from "../../src/store.js";
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
