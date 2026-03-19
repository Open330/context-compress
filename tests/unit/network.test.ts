import assert from "node:assert";
import dns from "node:dns";
import { describe, it, mock } from "node:test";
import { isPrivateHost, resolveAndValidate } from "../../src/network.js";

describe("isPrivateHost", () => {
	it("blocks localhost", () => {
		assert.strictEqual(isPrivateHost("localhost"), true);
	});

	it("blocks 127.0.0.1", () => {
		assert.strictEqual(isPrivateHost("127.0.0.1"), true);
	});

	it("blocks 127.x.x.x range", () => {
		assert.strictEqual(isPrivateHost("127.255.0.1"), true);
	});

	it("blocks ::1", () => {
		assert.strictEqual(isPrivateHost("::1"), true);
	});

	it("blocks IPv6 unspecified address (::)", () => {
		assert.strictEqual(isPrivateHost("::"), true);
		assert.strictEqual(isPrivateHost("0:0:0:0:0:0:0:0"), true);
	});

	it("blocks 0.0.0.0", () => {
		assert.strictEqual(isPrivateHost("0.0.0.0"), true);
	});

	it("blocks 0.0.0.0/8 'this network' range", () => {
		assert.strictEqual(isPrivateHost("0.1.2.3"), true);
		assert.strictEqual(isPrivateHost("0.0.0.1"), true);
	});

	it("blocks 10.x.x.x", () => {
		assert.strictEqual(isPrivateHost("10.0.0.1"), true);
		assert.strictEqual(isPrivateHost("10.255.255.255"), true);
	});

	it("blocks 172.16-31.x.x range", () => {
		assert.strictEqual(isPrivateHost("172.16.0.1"), true);
		assert.strictEqual(isPrivateHost("172.20.5.10"), true);
		assert.strictEqual(isPrivateHost("172.31.255.255"), true);
	});

	it("allows 172.15.x.x and 172.32.x.x (outside private range)", () => {
		assert.strictEqual(isPrivateHost("172.15.0.1"), false);
		assert.strictEqual(isPrivateHost("172.32.0.1"), false);
	});

	it("blocks 192.168.x.x", () => {
		assert.strictEqual(isPrivateHost("192.168.0.1"), true);
		assert.strictEqual(isPrivateHost("192.168.255.255"), true);
	});

	it("blocks 169.254.x.x link-local", () => {
		assert.strictEqual(isPrivateHost("169.254.1.1"), true);
	});

	it("blocks carrier-grade NAT 100.64/10", () => {
		assert.strictEqual(isPrivateHost("100.64.0.1"), true);
		assert.strictEqual(isPrivateHost("100.127.255.255"), true);
	});

	it("allows 100.63.x.x and 100.128.x.x (outside CGNAT)", () => {
		assert.strictEqual(isPrivateHost("100.63.0.1"), false);
		assert.strictEqual(isPrivateHost("100.128.0.1"), false);
	});

	it("blocks IPv6-mapped IPv4", () => {
		assert.strictEqual(isPrivateHost("::ffff:127.0.0.1"), true);
		assert.strictEqual(isPrivateHost("::ffff:10.0.0.1"), true);
		assert.strictEqual(isPrivateHost("::ffff:192.168.1.1"), true);
	});

	it("blocks IPv6 link-local fe80::", () => {
		assert.strictEqual(isPrivateHost("fe80::1"), true);
	});

	it("blocks IPv6 ULA fd00::", () => {
		assert.strictEqual(isPrivateHost("fd00::1"), true);
		assert.strictEqual(isPrivateHost("fc00::1"), true);
	});

	it("blocks bracket-wrapped [::1]", () => {
		assert.strictEqual(isPrivateHost("[::1]"), true);
	});

	it("allows public IPs", () => {
		assert.strictEqual(isPrivateHost("8.8.8.8"), false);
		assert.strictEqual(isPrivateHost("1.1.1.1"), false);
		assert.strictEqual(isPrivateHost("93.184.216.34"), false);
	});

	it("allows public hostnames", () => {
		assert.strictEqual(isPrivateHost("example.com"), false);
		assert.strictEqual(isPrivateHost("api.github.com"), false);
	});
});

describe("resolveAndValidate", () => {
	it("allows URLs with public resolved IPs", async () => {
		const lookup = mock.method(dns.promises, "lookup", async () => ({
			address: "93.184.216.34",
			family: 4,
		}));
		const result = await resolveAndValidate("https://example.com/page");
		assert.deepStrictEqual(result, { url: "https://example.com/page", resolvedIp: "93.184.216.34" });
		lookup.mock.restore();
	});

	it("blocks hostnames that resolve to 127.0.0.1 (DNS rebinding)", async () => {
		const lookup = mock.method(dns.promises, "lookup", async () => ({
			address: "127.0.0.1",
			family: 4,
		}));
		await assert.rejects(
			() => resolveAndValidate("https://evil.com/steal"),
			(err: Error) => {
				assert.ok(err.message.includes("Blocked"));
				assert.ok(err.message.includes("127.0.0.1"));
				return true;
			},
		);
		lookup.mock.restore();
	});

	it("blocks hostnames that resolve to private IPv4 (10.x)", async () => {
		const lookup = mock.method(dns.promises, "lookup", async () => ({
			address: "10.0.0.1",
			family: 4,
		}));
		await assert.rejects(
			() => resolveAndValidate("https://evil.com"),
			(err: Error) => {
				assert.ok(err.message.includes("Blocked"));
				assert.ok(err.message.includes("10.0.0.1"));
				return true;
			},
		);
		lookup.mock.restore();
	});

	it("blocks hostnames that resolve to private IPv6 (::1)", async () => {
		const lookup = mock.method(
			dns.promises,
			"lookup",
			async (_hostname: string, opts: { family: number }) => {
				if (opts.family === 4) {
					throw new Error("ENOTFOUND");
				}
				return { address: "::1", family: 6 };
			},
		);
		await assert.rejects(
			() => resolveAndValidate("https://evil.com"),
			(err: Error) => {
				assert.ok(err.message.includes("Blocked"));
				assert.ok(err.message.includes("::1"));
				return true;
			},
		);
		lookup.mock.restore();
	});

	it("blocks raw private IPv4 addresses without DNS lookup", async () => {
		await assert.rejects(
			() => resolveAndValidate("https://127.0.0.1/admin"),
			(err: Error) => {
				assert.ok(err.message.includes("Blocked"));
				return true;
			},
		);
	});

	it("allows raw public IPv4 addresses", async () => {
		const result = await resolveAndValidate("https://8.8.8.8/dns");
		assert.deepStrictEqual(result, { url: "https://8.8.8.8/dns", resolvedIp: null });
	});

	it("rejects when DNS resolution fails for both families (fail-closed)", async () => {
		const lookup = mock.method(dns.promises, "lookup", async () => {
			throw new Error("ENOTFOUND");
		});
		await assert.rejects(
			() => resolveAndValidate("https://nonexistent.example.com"),
			(err: Error) => {
				assert.ok(err.message.includes("DNS resolution failed"));
				return true;
			},
		);
		lookup.mock.restore();
	});
});
