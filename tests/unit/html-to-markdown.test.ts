import assert from "node:assert";
import { describe, it } from "node:test";
import { htmlToMarkdownSnippet } from "../../src/util/html-to-markdown.js";

/**
 * The conversion snippet is the only rendering surface this package ships: it
 * turns arbitrary fetched HTML into the markdown that becomes both model context
 * and store input. It was previously exercised only through a runtime-guarded
 * integration test that asserted five substrings.
 *
 * The snippet is pure synchronous JS with no `require`, so it runs directly here
 * with a capturing console — no subprocess, no runtime detection, no new
 * dependency.
 */
function render(html: string): string {
	let out = "";
	const capture = { log: (value: string) => { out = value; } };
	new Function("html", "console", htmlToMarkdownSnippet())(html, capture);
	return out;
}

describe("htmlToMarkdown: structure", () => {
	it("converts headings h1-h4", () => {
		assert.strictEqual(render("<h1>One</h1>"), "# One");
		assert.strictEqual(render("<h2>Two</h2>"), "## Two");
		assert.strictEqual(render("<h3>Three</h3>"), "### Three");
		assert.strictEqual(render("<h4>Four</h4>"), "#### Four");
	});

	it("keeps markers when the tag content spans lines", () => {
		// Pretty-printed HTML puts the text on its own line. Without the dotAll
		// flag these patterns never matched, so every heading and bullet silently
		// lost its marker — on real pages, which are almost always pretty-printed.
		assert.strictEqual(render("<h1>\n  Getting Started\n</h1>"), "# Getting Started");
		assert.strictEqual(render("<h2>\n\tConfiguration\n</h2>"), "## Configuration");
		assert.strictEqual(render("<ul>\n <li>\n  first\n </li>\n</ul>"), "- first");
	});

	it("converts list items", () => {
		assert.strictEqual(render("<ul><li>one</li><li>two</li></ul>"), "- one\n- two");
	});

	it("converts code blocks with and without an inner code tag", () => {
		assert.match(render("<pre><code>const x = 1;</code></pre>"), /```\nconst x = 1;\n```/);
		assert.match(render("<pre>plain\nblock</pre>"), /```\nplain\nblock\n```/);
		assert.strictEqual(render("<p>use <code>npm i</code></p>"), "use `npm i`");
	});

	it("strips script, style, nav, header, and footer", () => {
		const out = render(
			"<script>secret()</script><style>body{color:red}</style>" +
				"<nav>NAV</nav><header>HEAD</header><p>keep this</p><footer>FOOT</footer>",
		);
		assert.strictEqual(out, "keep this");
	});

	it("collapses runs of blank lines", () => {
		assert.ok(!/\n{3,}/.test(render("<p>a</p><p>b</p><p>c</p>")));
	});
});

describe("htmlToMarkdown: links", () => {
	it("keeps the target regardless of how the attribute is quoted", () => {
		// Only double quotes were accepted, so a single-quoted href silently lost
		// the URL and the reader was left with bare link text.
		assert.strictEqual(render('<a href="https://e.com">E</a>'), "[E](https://e.com)");
		assert.strictEqual(render("<a href='https://e.com'>E</a>"), "[E](https://e.com)");
		assert.strictEqual(render("<a href=https://e.com>E</a>"), "[E](https://e.com)");
	});

	it("handles attributes before href", () => {
		assert.strictEqual(
			render('<a class="c" href="https://e.com">E</a>'),
			"[E](https://e.com)",
		);
	});
});

describe("htmlToMarkdown: entities", () => {
	it("decodes ampersand last so nothing is double-decoded", () => {
		// `&amp;lt;` must become `&lt;`, not `<`.
		assert.strictEqual(render("<p>&amp;lt;script&amp;gt;</p>"), "&lt;script&gt;");
	});

	it("decodes named and numeric entities", () => {
		assert.strictEqual(render("<p>a&nbsp;b</p>"), "a b");
		assert.strictEqual(render("<p>&#65;&#x42;</p>"), "AB");
		assert.strictEqual(render("<p>a &lt; b &gt; c</p>"), "a < b > c");
	});

	it("drops out-of-range codepoints instead of throwing", () => {
		// String.fromCodePoint throws a RangeError past 0x10FFFF, which would abort
		// the whole conversion for one malformed entity on the page.
		assert.doesNotThrow(() => render("<p>&#1114112;&#0;</p>"));
		assert.strictEqual(render("<p>x&#1114112;&#0;y</p>"), "xy");
	});
});
