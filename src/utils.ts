/**
 * Shared utility functions extracted for testability.
 */

/** Detect potential prompt injection patterns in content */
export function detectInjectionPatterns(content: string): string[] {
	const warnings: string[] = [];
	const patterns = [
		{ re: /ignore\s+(all\s+)?previous\s+instructions/i, label: "instruction override" },
		{ re: /you\s+are\s+now\s+/i, label: "role reassignment" },
		{
			re: /(?:^|\n)\s*system\s*:\s*(?:you are|you're|as an? )/im,
			label: "system prompt injection",
		},
		{ re: /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>/i, label: "chat template injection" },
		{ re: /\n\n(?:Human|Assistant):/m, label: "chat delimiter injection" },
		{ re: /reveal\s+(your|the)\s+(system|secret|confidential)/i, label: "data exfiltration" },
		{ re: /act\s+as\s+(if\s+you\s+are|a)\s+/i, label: "role manipulation" },
	];
	for (const { re, label } of patterns) {
		if (re.test(content)) {
			warnings.push(label);
		}
	}
	return warnings;
}

/** Run an array of async task factories with bounded concurrency. */
export async function limitConcurrency<T>(
	tasks: (() => Promise<T>)[],
	limit: number,
): Promise<PromiseSettledResult<T>[]> {
	const results: PromiseSettledResult<T>[] = new Array(tasks.length);
	let nextIndex = 0;

	async function runNext(): Promise<void> {
		while (nextIndex < tasks.length) {
			const index = nextIndex++;
			try {
				const value = await tasks[index]();
				results[index] = { status: "fulfilled", value };
			} catch (reason) {
				results[index] = { status: "rejected", reason };
			}
		}
	}

	const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
	await Promise.all(workers);
	return results;
}

/** Format a byte count as a human-readable string. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
