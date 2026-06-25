/**
 * Single source of truth for the HTML→markdown conversion snippet.
 *
 * Returns a dependency-free JS snippet that assumes a `html` string variable is
 * already in scope, converts it to markdown, and `console.log`s the result.
 * Shared by the fetch tool (which runs it inside the sandbox subprocess) and its
 * tests, so the two copies can never drift.
 *
 * NOTE: This is a regex pipeline, not a full HTML parser — a real parser cannot
 * be used because the snippet must run in the dependency-free sandbox. To bound
 * worst-case backtracking, callers MUST size-limit `html` before running this
 * (see `buildFetchCode`, which caps at 10MB). All patterns use bounded character
 * classes (`[^>]`, `[^"]`) or lazy quantifiers separated by required literals,
 * so none exhibit catastrophic (exponential) backtracking.
 */
export function htmlToMarkdownSnippet(): string {
	return `
// Strip unwanted tags
let md = html
  .replace(/<script[^>]*>[\\s\\S]*?<\\/script>/gi, "")
  .replace(/<style[^>]*>[\\s\\S]*?<\\/style>/gi, "")
  .replace(/<nav[^>]*>[\\s\\S]*?<\\/nav>/gi, "")
  .replace(/<header[^>]*>[\\s\\S]*?<\\/header>/gi, "")
  .replace(/<footer[^>]*>[\\s\\S]*?<\\/footer>/gi, "");

// Convert headings
md = md.replace(/<h1[^>]*>(.*?)<\\/h1>/gi, "# $1\\n");
md = md.replace(/<h2[^>]*>(.*?)<\\/h2>/gi, "## $1\\n");
md = md.replace(/<h3[^>]*>(.*?)<\\/h3>/gi, "### $1\\n");
md = md.replace(/<h4[^>]*>(.*?)<\\/h4>/gi, "#### $1\\n");

// Convert code blocks
md = md.replace(/<pre[^>]*><code[^>]*>(.*?)<\\/code><\\/pre>/gis, "\`\`\`\\n$1\\n\`\`\`\\n");
md = md.replace(/<code[^>]*>(.*?)<\\/code>/gi, "\`$1\`");

// Convert links
md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\\/a>/gi, "[$2]($1)");

// Convert lists
md = md.replace(/<li[^>]*>(.*?)<\\/li>/gi, "- $1\\n");

// Convert paragraphs
md = md.replace(/<p[^>]*>(.*?)<\\/p>/gis, "$1\\n\\n");
md = md.replace(/<br\\s*\\/?>/gi, "\\n");

// Strip remaining tags
md = md.replace(/<[^>]+>/g, "");

// Decode entities (&amp; LAST so we don't double-decode)
md = md.replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&apos;/g, "'")
  .replace(/&nbsp;/g, " ")
  .replace(/&#(\\d+);/g, (_, n) => { const c = parseInt(n, 10); return c > 0 && c <= 0x10FFFF ? String.fromCodePoint(c) : ''; })
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { const c = parseInt(h, 16); return c > 0 && c <= 0x10FFFF ? String.fromCodePoint(c) : ''; })
  .replace(/&amp;/g, "&");

// Clean whitespace
md = md.replace(/\\n{3,}/g, "\\n\\n").trim();

console.log(md);
`;
}
