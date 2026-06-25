import { htmlToMarkdownSnippet } from "./html-to-markdown.js";

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
${htmlToMarkdownSnippet()}`;
}
