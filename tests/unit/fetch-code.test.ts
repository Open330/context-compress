import assert from "node:assert";
import { describe, it } from "node:test";
import { buildFetchCode } from "../../src/util/fetch-code.js";

describe("buildFetchCode", () => {
	it("keeps the original URL hostname (TLS SNI/cert validation must work)", () => {
		const code = buildFetchCode("https://example.com/page", "93.184.216.34");
		assert.ok(code.includes('"https://example.com/page"'));
		assert.ok(!code.includes("https://93.184.216.34"), "must not rewrite URL hostname to IP");
	});

	it("uses the URL as-is when no resolvedIp is provided", () => {
		const code = buildFetchCode("https://example.com/page");
		assert.ok(code.includes('"https://example.com/page"'));
		assert.ok(!code.includes("createConnection"));
	});

	it("pins the socket to resolvedIp via createConnection", () => {
		const code = buildFetchCode("https://example.com/page", "93.184.216.34");
		assert.ok(code.includes("options.createConnection"));
		assert.ok(code.includes('host: "93.184.216.34"'));
		assert.ok(code.includes("port: 443"));
		assert.ok(code.includes('servername: "example.com"'), "SNI keeps the original hostname");
		assert.ok(
			!code.includes("options.lookup ="),
			"options.lookup is silently ignored by Bun — never reintroduce it",
		);
	});

	it("sets the Host header explicitly when pinning", () => {
		// A custom createConnection makes Node bypass the protocol agent, so its
		// derived Host header says ":80" even for https:// URLs.
		assert.ok(
			buildFetchCode("https://example.com/", "203.0.113.10").includes(
				'options.headers = { Host: "example.com" }',
			),
		);
		// Non-default ports belong in the header; default ones must not appear.
		assert.ok(
			buildFetchCode("https://example.com:8443/x", "203.0.113.10").includes(
				'Host: "example.com:8443"',
			),
		);
		assert.ok(
			buildFetchCode("https://[2001:db8::1]/x", "2001:db8::1").includes('Host: "[2001:db8::1]"'),
		);
	});

	it("pins IPv6 addresses unbracketed for tls/net", () => {
		const code = buildFetchCode("https://example.com/", "2606:2800:220:1:248:1893:25c8:1946");
		assert.ok(code.includes('host: "2606:2800:220:1:248:1893:25c8:1946"'));
	});

	it("uses the URL's explicit port when pinning", () => {
		const code = buildFetchCode("https://example.com:8443/x", "203.0.113.10");
		assert.ok(code.includes("port: 8443"));
	});

	it("pins plain http through node:net with no servername", () => {
		const code = buildFetchCode("http://example.com/x", "203.0.113.10");
		assert.ok(code.includes('require("node:net")'));
		assert.ok(code.includes("port: 80"));
		assert.ok(!code.includes("servername"), "SNI is TLS-only");
	});

	it("strips brackets from IPv6 URL hostnames for SNI", () => {
		const code = buildFetchCode("https://[2001:db8::1]/x", "2001:db8::1");
		assert.ok(!code.includes('servername: "[2001:db8::1]"'));
		assert.ok(code.includes('servername: "2001:db8::1"'));
	});

	it("preserves path and query when pinning", () => {
		const code = buildFetchCode("https://api.example.com/v1/users?id=42&q=hello", "203.0.113.10");
		assert.ok(code.includes("/v1/users?id=42&q=hello"));
		assert.ok(code.includes('"203.0.113.10"'));
	});

	it("treats null resolvedIp the same as omitted", () => {
		const codeNull = buildFetchCode("https://example.com/x", null);
		const codeOmitted = buildFetchCode("https://example.com/x");
		assert.strictEqual(codeNull, codeOmitted);
	});

	it("rejects redirects to prevent follow-on SSRF", () => {
		const code = buildFetchCode("https://example.com");
		assert.ok(code.includes("Redirect blocked (SSRF protection)"));
		// Only Location-bearing codes — 304 is not a redirect to follow.
		assert.ok(code.includes("[301,302,303,307,308]"));
	});

	it("enforces 10MB content-length cap and streaming body cap", () => {
		const code = buildFetchCode("https://example.com");
		assert.ok(code.includes("10 * 1024 * 1024"));
		assert.ok(code.includes("content-length"));
		assert.ok(code.includes("bodyBytes"));
	});

	it("reports transferred bytes to the executor's network counter", () => {
		// http.get bypasses the global-fetch interceptor the executor installs,
		// so the snippet must feed __cm_net itself or fetch stats read as zero.
		const code = buildFetchCode("https://example.com");
		assert.ok(code.includes("__cm_net += bodyBytes"));
	});

	it("counts raw bytes, not decoded characters, against the body cap", () => {
		const code = buildFetchCode("https://example.com");
		assert.ok(!code.includes('setEncoding("utf8")'), "must stay on Buffers to count bytes");
		// The body is assembled as a Buffer and decoded once, after the cap check.
		// The decoder itself is charset-driven now, so this asserts the contract
		// (raw bytes counted, one decode at the end) rather than one expression.
		assert.ok(code.includes("Buffer.concat(__chunks)"), "the body must be concatenated as bytes");
		// Asserting the accumulator line stayed green with the whole 10MB guard
		// deleted. Assert the guard itself: the running total, its ceiling, and the
		// exit that enforces it.
		assert.ok(code.includes("bodyBytes += chunk.length"), "the cap must count raw bytes");
		assert.match(code, /if \(bodyBytes > 10 \* 1024 \* 1024\)/, "the streaming cap is missing");
		assert.match(code, /Response body too large/, "the streaming cap does not stop the read");
		assert.match(code, /Response too large/, "the content-length pre-check is missing");
	});

	it("uses node:https for https URLs and node:http for http", () => {
		assert.ok(buildFetchCode("https://example.com").includes('require("node:https")'));
		assert.ok(buildFetchCode("http://example.com").includes('require("node:http")'));
	});

	it("neutralizes URLs containing quotes (no injection into JS literal)", () => {
		// The quote is percent-encoded by new URL() normalization (%22), so the
		// payload cannot break out of the JSON string literal. Any remnant of the
		// payload must exist only inside the `const url = "..."` assignment line.
		const code = buildFetchCode('https://example.com/"; process.exit(0); //');
		assert.ok(code.includes("%22"), "quote is percent-encoded by URL normalization");
		const payloadLines = code.split("\n").filter((l) => l.includes("process.exit(0)"));
		assert.ok(
			payloadLines.every((l) => l.trimStart().startsWith('const url = "')),
			"payload remnant must stay inside the url string literal",
		);
	});

	it("strips <script> and <style> in the emitted converter", () => {
		const code = buildFetchCode("https://example.com");
		assert.ok(code.includes("<script"));
		assert.ok(code.includes("<style"));
	});
});
