import dns from "node:dns";
import { isIP } from "node:net";

interface IpLiteral {
	address: string;
	bytes: number[];
	family: 4 | 6;
	scoped: boolean;
}

interface IpRange {
	bytes: number[];
	prefixLength: number;
}

const NON_GLOBAL_IPV4_RANGES: IpRange[] = [
	{ bytes: [0], prefixLength: 8 },
	{ bytes: [10], prefixLength: 8 },
	{ bytes: [100, 64], prefixLength: 10 },
	{ bytes: [127], prefixLength: 8 },
	{ bytes: [169, 254], prefixLength: 16 },
	{ bytes: [172, 16], prefixLength: 12 },
	{ bytes: [192, 0, 0], prefixLength: 24 },
	{ bytes: [192, 0, 2], prefixLength: 24 },
	{ bytes: [192, 88, 99], prefixLength: 24 },
	{ bytes: [192, 168], prefixLength: 16 },
	{ bytes: [198, 18], prefixLength: 15 },
	{ bytes: [198, 51, 100], prefixLength: 24 },
	{ bytes: [203, 0, 113], prefixLength: 24 },
	{ bytes: [224], prefixLength: 4 },
	{ bytes: [240], prefixLength: 4 },
];

const NON_GLOBAL_IPV6_RANGES: IpRange[] = [
	{ bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], prefixLength: 96 },
	{ bytes: [0x01, 0x00, 0, 0, 0, 0, 0, 0], prefixLength: 64 },
	{ bytes: [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], prefixLength: 48 },
	{ bytes: [0x20, 0x01, 0x00, 0x02, 0, 0], prefixLength: 48 },
	{ bytes: [0x20, 0x01, 0x00, 0x10], prefixLength: 28 },
	{ bytes: [0x20, 0x01, 0x00, 0x20], prefixLength: 28 },
	{ bytes: [0x20, 0x01, 0x0d, 0xb8], prefixLength: 32 },
	{ bytes: [0x3f, 0xff, 0], prefixLength: 20 },
	{ bytes: [0x5f, 0x00], prefixLength: 16 },
	{ bytes: [0xfc], prefixLength: 7 },
	{ bytes: [0xfe, 0x80], prefixLength: 10 },
	{ bytes: [0xfe, 0xc0], prefixLength: 10 },
	{ bytes: [0xff], prefixLength: 8 },
];

function matchesRange(address: number[], range: IpRange): boolean {
	const completeBytes = Math.floor(range.prefixLength / 8);
	for (let index = 0; index < completeBytes; index += 1) {
		if (address[index] !== range.bytes[index]) return false;
	}

	const remainingBits = range.prefixLength % 8;
	if (remainingBits === 0) return true;

	const mask = (0xff << (8 - remainingBits)) & 0xff;
	return (address[completeBytes] & mask) === (range.bytes[completeBytes] & mask);
}

function ipv6Bytes(address: string): number[] {
	const [left = "", right = ""] = address.split("::");
	const leftGroups = left === "" ? [] : left.split(":");
	const rightGroups = right === "" ? [] : right.split(":");
	const omittedGroups = address.includes("::") ? 8 - leftGroups.length - rightGroups.length : 0;
	const groups = [
		...leftGroups,
		...Array.from({ length: omittedGroups }, () => "0"),
		...rightGroups,
	];

	return groups.flatMap((group) => {
		const value = Number.parseInt(group, 16);
		return [value >> 8, value & 0xff];
	});
}

function normalizeIpLiteral(hostname: string): IpLiteral | null {
	const unwrapped =
		hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	const scopeIndex = unwrapped.indexOf("%");
	const addressWithoutScope = scopeIndex === -1 ? unwrapped : unwrapped.slice(0, scopeIndex);

	if (isIP(unwrapped) === 6 || (scopeIndex !== -1 && isIP(addressWithoutScope) === 6)) {
		const normalized = new URL(`http://[${addressWithoutScope}]/`).hostname.slice(1, -1);
		return {
			address: normalized,
			bytes: ipv6Bytes(normalized),
			family: 6,
			scoped: scopeIndex !== -1,
		};
	}

	if (isIP(unwrapped) === 4) {
		return {
			address: unwrapped,
			bytes: unwrapped.split(".").map(Number),
			family: 4,
			scoped: false,
		};
	}

	// The URL parser canonicalizes legacy IPv4 forms such as 2130706433 and 0x7f000001.
	if (/^[0-9a-fx.]+$/i.test(unwrapped)) {
		try {
			const normalized = new URL(`http://${unwrapped}/`).hostname;
			if (isIP(normalized) === 4) {
				return {
					address: normalized,
					bytes: normalized.split(".").map(Number),
					family: 4,
					scoped: false,
				};
			}
		} catch {
			// Not an IP literal; hostnames are checked after DNS resolution.
		}
	}

	return null;
}

function isNonGlobalIp(ip: IpLiteral): boolean {
	if (ip.scoped) return true;

	if (ip.family === 4) {
		return NON_GLOBAL_IPV4_RANGES.some((range) => matchesRange(ip.bytes, range));
	}

	const isIpv4Mapped =
		ip.bytes.slice(0, 10).every((byte) => byte === 0) &&
		ip.bytes[10] === 0xff &&
		ip.bytes[11] === 0xff;
	if (isIpv4Mapped) {
		return NON_GLOBAL_IPV4_RANGES.some((range) => matchesRange(ip.bytes.slice(12), range));
	}

	return NON_GLOBAL_IPV6_RANGES.some((range) => matchesRange(ip.bytes, range));
}

/**
 * SSRF protection: detect local and non-global IP addresses or hostnames.
 */
export function isPrivateHost(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	if (lower === "localhost") return true;

	const ip = normalizeIpLiteral(hostname);
	return ip !== null && isNonGlobalIp(ip);
}

function validateResolvedIp(hostname: string, address: string, label: string): string {
	const ip = normalizeIpLiteral(address);
	if (!ip) {
		throw new Error(`Blocked: ${hostname} returned an invalid ${label} address`);
	}
	if (isNonGlobalIp(ip)) {
		throw new Error(`Blocked: ${hostname} resolved to non-global ${label} ${ip.address}`);
	}
	return ip.address;
}

/**
 * DNS rebinding protection: resolve a hostname, reject non-global answers, and return
 * one canonical address that callers can pin the connection to.
 */
export async function resolveAndValidate(
	url: string,
): Promise<{ url: string; resolvedIp: string | null }> {
	const parsed = new URL(url);
	const hostname = parsed.hostname;
	const rawIp = normalizeIpLiteral(hostname);

	if (rawIp) {
		if (isNonGlobalIp(rawIp)) {
			throw new Error(`Blocked: resolved IP ${rawIp.address} is a private/internal address`);
		}
		return { url, resolvedIp: null };
	}

	let resolvedIp: string | null = null;
	let v4Error = false;
	let v6Error = false;

	const [v4Result, v6Result] = await Promise.allSettled([
		dns.promises.lookup(hostname, { family: 4 }),
		dns.promises.lookup(hostname, { family: 6 }),
	]);

	if (v4Result.status === "fulfilled") {
		resolvedIp = validateResolvedIp(hostname, v4Result.value.address, "IP");
	} else {
		v4Error = true;
	}

	if (v6Result.status === "fulfilled") {
		const normalizedV6 = validateResolvedIp(hostname, v6Result.value.address, "IPv6");
		if (!resolvedIp) resolvedIp = normalizedV6;
	} else {
		v6Error = true;
	}

	if (v4Error && v6Error) {
		throw new Error(`DNS resolution failed for ${hostname}: unable to verify host safety`);
	}

	return { url, resolvedIp };
}
