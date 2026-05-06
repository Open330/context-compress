/**
 * Build a self-contained JS snippet that fetches a URL, converts HTML→markdown,
 * and prints the result. Runs inside the sandbox subprocess.
 *
 * When `resolvedIp` is provided, the URL is rewritten to connect to that IP
 * with the original Host header preserved — defeats DNS rebinding (TOCTOU)
 * between the validation step and the actual fetch.
 */
export function buildFetchCode(url: string, resolvedIp?: string | null): string {
	let fetchSetup: string;
	if (resolvedIp) {
		const pinnedUrl = new URL(url);
		const originalHost = pinnedUrl.host;
		// URL.hostname setter requires IPv6 literals to be bracketed; raw forms
		// like "2001:db8::1" parse incorrectly (the first ":" is treated as a
		// port delimiter). Detect IPv6 by colon-presence and wrap.
		const hostnameValue =
			resolvedIp.includes(":") && !resolvedIp.startsWith("[") ? `[${resolvedIp}]` : resolvedIp;
		pinnedUrl.hostname = hostnameValue;
		fetchSetup = `
const url = ${JSON.stringify(pinnedUrl.toString())};
const resp = await fetch(url, { headers: { 'Host': ${JSON.stringify(originalHost)} }, redirect: 'error' });`;
	} else {
		fetchSetup = `
const url = ${JSON.stringify(url)};
const resp = await fetch(url, { redirect: 'error' });`;
	}
	return `${fetchSetup}
if (!resp.ok) { console.error("HTTP " + resp.status); process.exit(1); }
const cl = resp.headers.get('content-length');
if (cl && parseInt(cl, 10) > 10 * 1024 * 1024) {
    console.error("Response too large: " + cl + " bytes"); process.exit(1);
}
const html = await resp.text();
if (html.length > 10 * 1024 * 1024) {
    console.error("Response body too large: " + html.length + " chars"); process.exit(1);
}

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

// Decode entities
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
