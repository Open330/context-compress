import dns from "node:dns";

/**
 * SSRF protection: detect private/internal hostnames.
 */
export function isPrivateHost(hostname: string): boolean {
	// Strip brackets from IPv6 literals like [::1]
	const h = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	const lower = h.toLowerCase();

	// Localhost variants
	if (lower === "localhost" || lower === "0.0.0.0") return true;

	// IPv4 "this network" range: 0.0.0.0/8
	if (/^0\./.test(h)) return true;

	// IPv4 loopback: 127.0.0.0/8
	if (/^127\./.test(h)) return true;

	// IPv4 private ranges
	if (/^10\./.test(h)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
	if (/^192\.168\./.test(h)) return true;

	// IPv4 link-local: 169.254.0.0/16
	if (/^169\.254\./.test(h)) return true;

	// Carrier-grade NAT: 100.64.0.0/10 (100.64-127.*)
	if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;

	// IPv6 loopback
	if (lower === "::1") return true;

	// IPv6 unspecified address
	if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;

	// IPv6 mapped IPv4: ::ffff:127.0.0.1, ::ffff:10.*, etc.
	const mappedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mappedMatch) return isPrivateHost(mappedMatch[1]);

	// IPv6 link-local: fe80::/10
	if (/^fe[89ab]/i.test(h)) return true;

	// IPv6 ULA: fc00::/7 (fc* and fd*)
	if (/^f[cd]/i.test(h)) return true;

	return false;
}

/**
 * DNS rebinding protection: resolve hostname to IP and validate it is not private.
 * This prevents attackers from using DNS to resolve a public hostname to a private IP.
 * Throws an error if the resolved IP is private.
 */
export async function resolveAndValidate(
	url: string,
): Promise<{ url: string; resolvedIp: string | null }> {
	const parsed = new URL(url);
	const hostname = parsed.hostname;

	// Skip DNS resolution for raw IP addresses — isPrivateHost already handles them
	if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
		if (isPrivateHost(hostname)) {
			throw new Error(`Blocked: resolved IP ${hostname} is a private/internal address`);
		}
		return { url, resolvedIp: null };
	}

	let resolvedIp: string | null = null;
	let v4Error = false;
	let v6Error = false;

	// Resolve IPv4 and IPv6 in parallel
	const [v4Result, v6Result] = await Promise.allSettled([
		dns.promises.lookup(hostname, { family: 4 }),
		dns.promises.lookup(hostname, { family: 6 }),
	]);

	// Process v4
	if (v4Result.status === "fulfilled") {
		if (isPrivateHost(v4Result.value.address)) {
			throw new Error(`Blocked: ${hostname} resolved to private IP ${v4Result.value.address}`);
		}
		resolvedIp = v4Result.value.address;
	} else {
		v4Error = true;
	}

	// Process v6
	if (v6Result.status === "fulfilled") {
		if (isPrivateHost(v6Result.value.address)) {
			throw new Error(`Blocked: ${hostname} resolved to private IPv6 ${v6Result.value.address}`);
		}
		if (!resolvedIp) resolvedIp = v6Result.value.address;
	} else {
		v6Error = true;
	}

	// If BOTH resolutions failed (not blocked, just DNS errors), fail closed
	if (v4Error && v6Error) {
		throw new Error(`DNS resolution failed for ${hostname}: unable to verify host safety`);
	}

	return { url, resolvedIp };
}
