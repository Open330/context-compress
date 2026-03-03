/**
 * SSRF protection: detect private/internal hostnames.
 */
export function isPrivateHost(hostname: string): boolean {
	// Strip brackets from IPv6 literals like [::1]
	const h = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	const lower = h.toLowerCase();

	// Localhost variants
	if (lower === "localhost" || lower === "0.0.0.0") return true;

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

	// IPv6 mapped IPv4: ::ffff:127.0.0.1, ::ffff:10.*, etc.
	const mappedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mappedMatch) return isPrivateHost(mappedMatch[1]);

	// IPv6 link-local: fe80::/10
	if (/^fe[89ab]/i.test(h)) return true;

	// IPv6 ULA: fc00::/7 (fc* and fd*)
	if (/^f[cd]/i.test(h)) return true;

	return false;
}
