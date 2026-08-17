import type { ExecResult } from "../types.js";

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
