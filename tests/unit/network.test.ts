import assert from "node:assert";
import dns from "node:dns";
import { afterEach, describe, it, mock } from "node:test";
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

	it("blocks IPv6-mapped IPv4 in hex form (::ffff:HHHH:HHHH)", () => {
		// 7f00:0001 = 127.0.0.1
		assert.strictEqual(isPrivateHost("::ffff:7f00:1"), true);
		assert.strictEqual(isPrivateHost("::ffff:7f00:0001"), true);
		// 0a00:0001 = 10.0.0.1
		assert.strictEqual(isPrivateHost("::ffff:a00:1"), true);
		// c0a8:0101 = 192.168.1.1
		assert.strictEqual(isPrivateHost("::ffff:c0a8:101"), true);
		// a9fe:0101 = 169.254.1.1 (link-local)
		assert.strictEqual(isPrivateHost("::ffff:a9fe:101"), true);
	});

	it("allows public IPv4 in hex-mapped IPv6 form", () => {
		// 0808:0808 = 8.8.8.8
		assert.strictEqual(isPrivateHost("::ffff:808:808"), false);
		// 0101:0101 = 1.1.1.1
		assert.strictEqual(isPrivateHost("::ffff:101:101"), false);
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

	it("blocks non-global special-use ranges", () => {
		const addresses = [
			"192.0.0.0",
			"192.0.0.255",
			"198.18.0.1",
			"198.19.255.255",
			"224.0.0.1",
			"239.255.255.255",
			"240.0.0.1",
			"255.255.255.255",
			"ff02::1",
			"ffff::1",
			"fec0::1",
			"feff::1",
		];

		for (const address of addresses) {
			assert.strictEqual(isPrivateHost(address), true, `${address} should be blocked`);
		}
	});

	it("normalizes alternate IP literal forms before classification", () => {
		const cases: Array<[address: string, expected: boolean]> = [
			["2130706433", true],
			["0x7f000001", true],
			["0177.0.0.1", true],
			["0:0:0:0:0:ffff:7f00:1", true],
			["[FEc0:0000:0000:0000:0000:0000:0000:0001]", true],
			["0x08080808", false],
			["0:0:0:0:0:ffff:808:808", false],
		];

		for (const [address, expected] of cases) {
			assert.strictEqual(isPrivateHost(address), expected, address);
		}
	});

	it("blocks NAT64 literals whose embedded IPv4 destination is non-global", () => {
		// A NAT64 gateway forwards 64:ff9b::/96 to the IPv4 address in the low 32
		// bits, so these reach loopback, link-local metadata, and RFC 1918 hosts.
		const cases: Array<[address: string, expected: boolean]> = [
			["64:ff9b::7f00:1", true], // 127.0.0.1
			["64:ff9b::a9fe:a9fe", true], // 169.254.169.254 (cloud metadata)
			["64:ff9b::a00:1", true], // 10.0.0.1
			["64:ff9b::c0a8:1", true], // 192.168.0.1
			["64:ff9b::ac10:1", true], // 172.16.0.1
			["64:ff9b::", true], // 0.0.0.0
			["[64:ff9b::7f00:1]", true],
			["64:ff9b::808:808", false], // 8.8.8.8 stays reachable
			["64:ff9b:1::7f00:1", true], // 64:ff9b:1::/48 local-use, blocked wholesale
			["64:ff9b::1:7f00:1", true], // unassigned inside 64:ff9b::/32, rejected conservatively
			["65:ff9b::808:808", false], // adjacent /32 is ordinary global space
		];

		for (const [address, expected] of cases) {
			assert.strictEqual(isPrivateHost(address), expected, address);
		}
	});

	it("allows global addresses adjacent to blocked special-use ranges", () => {
		const addresses = [
			"192.0.1.1",
			"198.17.255.255",
			"198.20.0.1",
			"223.255.255.254",
			"2001:4860:4860::8888",
		];

		for (const address of addresses) {
			assert.strictEqual(isPrivateHost(address), false, `${address} should be allowed`);
		}
	});
});

describe("resolveAndValidate", () => {
	// Every dns.promises.lookup replacement is undone here. Restoring only on the
	// success path let a failing assertion leak a mock into the next test.
	afterEach(() => {
		mock.restoreAll();
	});

	it("allows URLs with public resolved IPs", async () => {
		const lookup = mock.method(dns.promises, "lookup", async () => ({
			address: "93.184.216.34",
			family: 4,
		}));
		const result = await resolveAndValidate("https://example.com/page");
		assert.deepStrictEqual(result, {
			url: "https://example.com/page",
			resolvedIp: "93.184.216.34",
		});
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

	it("blocks raw special-use IP literals without DNS lookup", async () => {
		const lookup = mock.method(dns.promises, "lookup", async () => {
			throw new Error("raw IPs must not use DNS");
		});
		const urls = [
			"https://192.0.0.1/",
			"https://198.18.0.1/",
			"https://224.0.0.1/",
			"https://240.0.0.1/",
			"https://[ff02::1]/",
			"https://[fec0::1]/",
			"https://2130706433/",
		];

		for (const url of urls) {
			await assert.rejects(() => resolveAndValidate(url), /Blocked/);
		}
		assert.strictEqual(lookup.mock.callCount(), 0);
	});

	it("blocks special-use IPv4 and IPv6 DNS answers", async () => {
		const cases: Array<[address: string, family: 4 | 6]> = [
			["192.0.0.1", 4],
			["198.18.0.1", 4],
			["224.0.0.1", 4],
			["240.0.0.1", 4],
			["ff02::1", 6],
			["fec0::1", 6],
		];

		for (const [address, family] of cases) {
			const lookup = mock.method(
				dns.promises,
				"lookup",
				async (_hostname: string, opts: { family: number }) => {
					if (opts.family !== family) throw new Error("ENOTFOUND");
					return { address, family };
				},
			);
			await assert.rejects(
				() => resolveAndValidate("https://evil.example/"),
				(err: Error) => err.message.includes("Blocked") && err.message.includes(address),
			);
		}
	});

	it("normalizes a public IPv6 DNS answer for connection pinning", async () => {
		mock.method(
			dns.promises,
			"lookup",
			async (_hostname: string, opts: { family: number }) => {
				if (opts.family === 4) throw new Error("ENOTFOUND");
				return { address: "2606:2800:0220:0001:0248:1893:25c8:1946", family: 6 };
			},
		);
		const result = await resolveAndValidate("https://example.com/page");
		assert.deepStrictEqual(result, {
			url: "https://example.com/page",
			resolvedIp: "2606:2800:220:1:248:1893:25c8:1946",
		});
	});

	it("rejects when DNS resolution fails for both families (fail-closed)", async () => {
		mock.method(dns.promises, "lookup", async () => {
			throw new Error("ENOTFOUND");
		});
		await assert.rejects(
			() => resolveAndValidate("https://nonexistent.example.com"),
			(err: Error) => {
				assert.ok(err.message.includes("DNS resolution failed"));
				return true;
			},
		);
	});

	it("blocks a NAT64 DNS answer whose embedded IPv4 destination is non-global", async () => {
		mock.method(
			dns.promises,
			"lookup",
			async (_hostname: string, opts: { family: number }) => {
				if (opts.family === 4) throw new Error("ENOTFOUND");
				return { address: "64:ff9b::a9fe:a9fe", family: 6 };
			},
		);
		await assert.rejects(
			() => resolveAndValidate("https://evil.example/"),
			(err: Error) => err.message.includes("Blocked") && err.message.includes("64:ff9b::a9fe:a9fe"),
		);
	});

	it("restores the DNS mock even when an assertion fails", async () => {
		// Guards the leak this suite used to have: a mock installed by a failing
		// test stayed installed for every later test in the file.
		const sentinel = mock.method(dns.promises, "lookup", async () => ({
			address: "203.0.113.9",
			family: 4 as const,
		}));
		await assert.rejects(() => resolveAndValidate("https://leak.example/"), /Blocked/);
		assert.ok(sentinel.mock.callCount() > 0);
	});
});
