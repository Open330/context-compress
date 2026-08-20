import type { ExecResult } from "../types.js";
import { truncateToBytes } from "./byte-budget.js";

/** Closed status vocabulary shared by every tool that reports an execution. */
export type ExecutionStatus = "completed" | "failed" | "killed" | "unknown";

export function getExecutionStatus(result: ExecResult): ExecutionStatus {
	if (result.killed) return "killed";
	if (result.exitCode === 0) return "completed";
	if (result.exitCode === null) return "unknown";
	return "failed";
}

/** True when nothing about the run needs explaining to the caller. */
export function isCleanSuccess(result: ExecResult): boolean {
	return result.exitCode === 0 && !result.killed && !result.truncated;
}

/**
 * A one-line footer for any run that was not a clean success, or `null` when it
 * was. Without it a command that exits nonzero with no output is byte-identical
 * to a successful one, so a caller cannot tell a passing check from a broken
 * one. Clean runs get nothing appended, keeping the happy path compact.
 */
export function formatExecStatusFooter(result: ExecResult): string | null {
	if (isCleanSuccess(result)) return null;

	const parts = [
		`Status: ${getExecutionStatus(result)}`,
		`exit ${result.exitCode === null ? "unknown" : result.exitCode}`,
	];
	if (result.killed) parts.push("killed (timeout or output cap)");
	if (result.truncated) parts.push("output truncated at the executor cap");
	return `\n\n[${parts.join(" · ")}]`;
}

/**
 * Attach the status footer to a tool response. An empty body becomes an explicit
 * "(no output)" so a failed run never renders as a blank success.
 */
export function withExecStatus(output: string, result: ExecResult): string {
	const footer = formatExecStatusFooter(result);
	if (footer === null) return output;
	return `${output.trim() === "" ? "(no output)" : output}${footer}`;
}

/**
 * Assemble a tool response — body, then the STDERR block, then the status
 * footer — inside `budget`.
 *
 * The pieces have to be budgeted, not concatenated and clamped. `truncateToBytes`
 * keeps the head, and the executor has already expanded stdout to fill the whole
 * budget, so a failing build's diagnostic sat entirely in the bytes that got cut:
 * measured, 4,609 bytes of stderr survived as 150, with the last error line gone.
 * The footer had the same problem and was fixed the same way.
 *
 * stderr is capped at half of what the footer leaves, so a chatty stderr cannot
 * hide stdout either.
 */
export function assembleExecResponse(
	body: string,
	stderrBlock: string,
	result: ExecResult,
	budget: number,
): string {
	const footer = formatExecStatusFooter(result);
	const room = Math.max(0, budget - (footer === null ? 0 : Buffer.byteLength(footer)));
	// Reserve half for stderr so a chatty stderr cannot hide stdout, but reserve it
	// only against what the body actually uses. Clamping stderr to half
	// unconditionally threw away half the budget on a command that writes only to
	// stderr — measured, a stderr-only failure returned 51,214 of 102,400 bytes.
	const stderrReserve = Math.min(Buffer.byteLength(stderrBlock), Math.floor(room / 2));
	const bodyText = truncateToBytes(body, Math.max(0, room - stderrReserve));
	const stderrText = truncateToBytes(
		stderrBlock,
		Math.max(0, room - Buffer.byteLength(bodyText)),
	);
	const combined = bodyText + stderrText;
	return footer === null ? combined : withExecStatus(combined, result);
}
