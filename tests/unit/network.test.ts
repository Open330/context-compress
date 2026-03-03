import assert from "node:assert";
import { describe, it } from "node:test";
import { isPrivateHost } from "../../src/network.js";

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

	it("blocks 0.0.0.0", () => {
		assert.strictEqual(isPrivateHost("0.0.0.0"), true);
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
