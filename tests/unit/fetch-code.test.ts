import assert from "node:assert";
import { describe, it } from "node:test";
import { buildFetchCode } from "../../src/util/fetch-code.js";

describe("buildFetchCode", () => {
	it("uses the URL as-is when no resolvedIp is provided", () => {
		const code = buildFetchCode("https://example.com/page");
		assert.ok(code.includes('"https://example.com/page"'));
		assert.ok(!code.includes("'Host':"));
	});

	it("pins the connection to resolvedIp and preserves Host header", () => {
		const code = buildFetchCode("https://example.com/page", "93.184.216.34");
		assert.ok(code.includes("93.184.216.34"));
		assert.ok(code.includes("'Host':"));
		assert.ok(code.includes('"example.com"'));
	});

	it("preserves path and query when pinning", () => {
		const code = buildFetchCode(
			"https://api.example.com/v1/users?id=42&q=hello",
			"203.0.113.10",
		);
		assert.ok(code.includes("/v1/users?id=42&q=hello"));
		assert.ok(code.includes("203.0.113.10"));
	});

	it("preserves non-default port when pinning", () => {
		const code = buildFetchCode("https://example.com:8443/api", "203.0.113.10");
		assert.ok(code.includes(":8443"));
		assert.ok(code.includes('"example.com:8443"'), "Host header should keep original port");
	});

	it("treats null resolvedIp the same as omitted", () => {
		const codeNull = buildFetchCode("https://example.com/x", null);
		const codeOmitted = buildFetchCode("https://example.com/x");
		assert.strictEqual(codeNull, codeOmitted);
	});

	it("emits redirect: 'error' to prevent follow-on SSRF via redirect", () => {
		const code = buildFetchCode("https://example.com");
		assert.ok(code.includes("redirect: 'error'"));
	});

	it("enforces 10MB content-length cap", () => {
		const code = buildFetchCode("https://example.com");
		assert.ok(code.includes("10 * 1024 * 1024"));
		assert.ok(code.includes("content-length"));
	});

	it("escapes URLs containing quotes via JSON.stringify (no injection into JS literal)", () => {
		// Double quotes in the URL must not break out of the string literal in the emitted code.
		const code = buildFetchCode('https://example.com/"; process.exit(0); //');
		// Whatever appears in the URL must remain inside a JSON string — it must not produce
		// a bare process.exit(0) statement at top level.
		assert.ok(!/^\s*process\.exit/m.test(code));
		// And the dangerous content should be present only in escaped form inside a string.
		assert.ok(code.includes('\\"'));
	});

	it("works with IPv6 hostnames in resolvedIp (URL handles bracket wrapping)", () => {
		const code = buildFetchCode("https://example.com/", "2606:2800:220:1:248:1893:25c8:1946");
		// The hostname setter brackets IPv6 automatically when toString is called.
		assert.ok(code.includes("[2606:2800:220:1:248:1893:25c8:1946]"));
		assert.ok(code.includes('"example.com"'), "Host header preserves original");
	});

	it("strips <script> and <style> in the emitted converter", () => {
		const code = buildFetchCode("https://example.com");
		assert.ok(code.includes("<script"));
		assert.ok(code.includes("<style"));
	});
});
