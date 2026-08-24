import { htmlToMarkdownSnippet } from "./html-to-markdown.js";
import { getVersion } from "./version.js";

/** HTTP status codes that carry a Location we would have to follow. */
const REDIRECT_CODES = [301, 302, 303, 307, 308];

/**
 * Build a self-contained JS snippet that fetches a URL, converts HTML→markdown,
 * and prints the result. Runs inside the sandbox subprocess.
 *
 * DNS-rebinding defense: when `resolvedIp` is provided, the socket is opened
 * directly against that pre-validated IP via `createConnection`, while the URL
 * (and therefore the Host header, TLS SNI, and certificate check) keeps the
 * original hostname.
 *
 * Two earlier approaches failed here, so don't "simplify" this back:
 *   1. Rewriting the URL hostname to the IP broke every HTTPS handshake —
 *      certificates are issued for hostnames, not IPs.
 *   2. `options.lookup` works on Node but not on Bun: Bun's `node:http` shim
 *      calls the hook and then ignores the address it returns, so every pinned
 *      request died with ECONNREFUSED.
 *
 * Bun ignores `createConnection` too — it never calls the hook and resolves DNS
 * itself, which looks like success while the pin is inert. There is no
 * connection-pinning hook that works under Bun's http shim, so callers MUST run
 * this snippet with `requireRuntime: "node"` (see tools/fetch-and-index.ts).
 * Bun is otherwise the first JS runtime candidate.
 *
 * Redirects are rejected rather than followed: a redirect target has not been
 * validated by resolveAndValidate, so following it would reopen SSRF.
 */
export function buildFetchCode(url: string, resolvedIp?: string | null): string {
	const parsed = new URL(url);
	const isHttps = parsed.protocol === "https:";
	const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;
	// URL.hostname keeps IPv6 literals bracketed; net/tls want them bare.
	const servername = parsed.hostname.replace(/^\[|\]$/g, "");

	const pinning = resolvedIp
		? `// Pin the socket to the IP already validated by resolveAndValidate, but let
// the Host header / TLS SNI / cert check keep using the original hostname.
// Requires the Node runtime — read the docblock in fetch-code.ts before changing.
const __net = require(${JSON.stringify(isHttps ? "node:tls" : "node:net")});
options.createConnection = () =>
    __net.connect({
        host: ${JSON.stringify(resolvedIp)},
        port: ${port},${
					isHttps
						? `
        servername: ${JSON.stringify(servername)},`
						: ""
				}
    });
// Set Host explicitly: a custom createConnection makes Node bypass the protocol
// agent, so it derives the header from defaultPort 80 and sends
// "example.com:80" for an https:// URL, which strict virtual hosts reject.
// URL.host is already the correct value (port only when non-default).
options.headers = { Host: ${JSON.stringify(parsed.host)} };`
		: "";

	const fetchSetup = `
const url = ${JSON.stringify(parsed.toString())};
const http = require(${JSON.stringify(isHttps ? "node:https" : "node:http")});
const options = {};
// Without this a gzip/deflate body is decoded as text: raw DEFLATE bytes became
// 23 replacement characters and were indexed that way. Nothing here inflates, so
// ask the server not to compress. The pinning block below replaces
// options.headers wholesale, so these are merged after it.
// Node sends no User-Agent of its own, and this snippet is pinned to the Node
// runtime (see the docblock above), so requests went out without one. Hosts that
// require the header reject that: api.github.com answers
// "Request forbidden by administrative rules. Please make sure your request has
// a User-Agent header" with a 403. Bun's http shim supplies a default, which is
// why the same URL succeeded through execute() and failed here.
const __defaultHeaders = {
    "accept-encoding": "identity",
    "user-agent": ${JSON.stringify(`context-compress/${getVersion("unknown")}`)},
};
${pinning}
options.headers = Object.assign({}, options.headers, __defaultHeaders);
const resp = await new Promise((resolve, reject) => {
    const req = http.get(url, options, resolve);
    req.on("error", reject);
});
if (${JSON.stringify(REDIRECT_CODES)}.includes(resp.statusCode)) {
    console.error("Redirect blocked (SSRF protection): " + resp.statusCode + " -> " + (resp.headers.location || "?"));
    process.exit(1);
}
if (resp.statusCode !== 200) {
    // The body is where the server says WHY. Dropping it reported a bare
    // "HTTP 403" for a missing User-Agent, whose body named the header outright
    // — an hour of bisecting for a message that was already on the wire.
    // Bounded: an error page must not become the error message.
    let __errBody = "";
    try {
        for await (const chunk of resp) {
            __errBody += chunk.toString("utf8");
            if (__errBody.length > 2048) break;
        }
    } catch {}
    // Escaped twice on purpose: this is a template literal, so a single
    // backslash reaches the generated snippet as /s+/g and deletes every run of
    // the letter s ("message" came back as "me age").
    __errBody = __errBody.replace(/\\s+/g, " ").trim().slice(0, 300);
    console.error("HTTP " + resp.statusCode + (__errBody ? ": " + __errBody : ""));
    process.exit(1);
}
const cl = resp.headers["content-length"];
if (cl && parseInt(cl, 10) > 10 * 1024 * 1024) {
    console.error("Response too large: " + cl + " bytes"); process.exit(1);
}
const __chunks = [];
let bodyBytes = 0;
for await (const chunk of resp) {
    bodyBytes += chunk.length;
    if (bodyBytes > 10 * 1024 * 1024) {
        console.error("Response body too large"); process.exit(1);
    }
    __chunks.push(chunk);
}
// Feed the executor's network-bytes counter. The old code went through global
// fetch, which the executor patches; a raw http.get is invisible to it, so
// report the transferred size explicitly.
if (typeof __cm_net === "number") __cm_net += bodyBytes;
const __body = Buffer.concat(__chunks);
// Decoding every page as UTF-8 turned any other encoding into replacement
// characters — permanently, because the corrupted text is what gets indexed and
// returned. Honour the Content-Type charset, then a <meta charset> in the head,
// and fall back to UTF-8. Node ships full ICU, so TextDecoder handles the
// legacy encodings without a new dependency.
const __ce = String(resp.headers["content-encoding"] || "").toLowerCase();
if (__ce && __ce !== "identity") {
    console.error("Compressed response not supported: content-encoding " + __ce);
    process.exit(1);
}
let __enc = "utf-8";
const __ctMatch = /charset\\s*=\\s*["']?([\\w.:-]+)/i.exec(String(resp.headers["content-type"] || ""));
if (__ctMatch) {
    __enc = __ctMatch[1].toLowerCase();
} else {
    const __meta = /<meta[^>]+charset\\s*=\\s*["']?([\\w.:-]+)/i.exec(__body.subarray(0, 4096).toString("latin1"));
    if (__meta) __enc = __meta[1].toLowerCase();
}
let html;
try {
    html = new TextDecoder(__enc).decode(__body);
} catch {
    html = __body.toString("utf8");
}`;

	return `${fetchSetup}\n${htmlToMarkdownSnippet()}`;
}
