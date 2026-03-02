import type { SessionStats } from "./types.js";

export class SessionTracker {
	private stats: SessionStats = {
		calls: {},
		bytesReturned: {},
		bytesIndexed: 0,
		bytesSandboxed: 0,
		sessionStart: Date.now(),
	};

	trackCall(toolName: string, responseBytes: number): void {
		this.stats.calls[toolName] = (this.stats.calls[toolName] ?? 0) + 1;
		this.stats.bytesReturned[toolName] =
			(this.stats.bytesReturned[toolName] ?? 0) + responseBytes;
	}

	trackIndexed(bytes: number): void {
		this.stats.bytesIndexed += bytes;
	}

	trackSandboxed(bytes: number): void {
		this.stats.bytesSandboxed += bytes;
	}

	getSnapshot(): Readonly<SessionStats> {
		return { ...this.stats };
	}

	formatReport(): string {
		const snap = this.stats;
		const elapsed = Date.now() - snap.sessionStart;
		const mins = Math.floor(elapsed / 60_000);
		const secs = Math.floor((elapsed % 60_000) / 1000);

		const totalCalls = Object.values(snap.calls).reduce((a, b) => a + b, 0);
		const totalReturned = Object.values(snap.bytesReturned).reduce((a, b) => a + b, 0);
		const keptOut = snap.bytesIndexed + snap.bytesSandboxed;
		const totalProcessed = keptOut + totalReturned;
		const savingsRatio = totalReturned > 0 ? totalProcessed / totalReturned : 1;
		const reductionPct =
			totalProcessed > 0 ? ((1 - totalReturned / totalProcessed) * 100).toFixed(1) : "0.0";
		const estTokens = Math.round(totalReturned / 4);

		const lines: string[] = [];

		lines.push("## Session Statistics\n");
		lines.push("| Metric | Value |");
		lines.push("|--------|-------|");
		lines.push(`| Session time | ${mins}m ${secs}s |`);
		lines.push(`| Tool calls | ${totalCalls} |`);
		lines.push(`| Total data processed | ${formatBytes(totalProcessed)} |`);
		lines.push(`| Kept in sandbox | ${formatBytes(keptOut)} |`);
		lines.push(`| Context consumed | ${formatBytes(totalReturned)} |`);
		lines.push(`| Est. tokens | ~${estTokens.toLocaleString()} |`);
		lines.push(`| **Savings ratio** | **${savingsRatio.toFixed(1)}x** (${reductionPct}% reduction) |`);

		if (totalCalls > 0) {
			lines.push("\n## Per-Tool Breakdown\n");
			lines.push("| Tool | Calls | Context bytes | Est. tokens |");
			lines.push("|------|-------|--------------|-------------|");

			for (const [name, calls] of Object.entries(snap.calls)) {
				const bytes = snap.bytesReturned[name] ?? 0;
				lines.push(`| ${name} | ${calls} | ${formatBytes(bytes)} | ~${Math.round(bytes / 4).toLocaleString()} |`);
			}
		}

		lines.push(
			`\nContext-compress kept ${formatBytes(keptOut)} out of context (${reductionPct}% savings).`,
		);

		return lines.join("\n");
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
