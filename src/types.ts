export type Language =
	| "javascript"
	| "typescript"
	| "python"
	| "shell"
	| "ruby"
	| "go"
	| "rust"
	| "php"
	| "perl"
	| "r"
	| "elixir";

export const ALL_LANGUAGES: readonly Language[] = [
	"javascript",
	"typescript",
	"python",
	"shell",
	"ruby",
	"go",
	"rust",
	"php",
	"perl",
	"r",
	"elixir",
] as const;

export interface ExecOptions {
	language: Language;
	code: string;
	timeout?: number;
	intent?: string;
	maxOutputBytes?: number;
	/**
	 * Force a specific runtime binary instead of the fastest detected one.
	 * Used by the fetch tool, whose DNS-rebinding defense depends on socket
	 * pinning that Bun's `node:http` shim silently ignores. Execution fails
	 * closed if the required runtime is not installed.
	 */
	requireRuntime?: string;
}

export interface ExecFileOptions extends ExecOptions {
	filePath: string;
}

export interface ExecResult {
	/**
	 * Executor-capped stdout before lossy command, format, deduplication, and
	 * response-truncation filters. Index-backed tools use this searchable copy
	 * while `stdout` remains compact enough to return to the caller.
	 */
	indexableStdout: string;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	truncated: boolean;
	killed: boolean;
	networkBytes?: number;
}

export interface IndexResult {
	sourceId: number;
	label: string;
	totalChunks: number;
	codeChunks: number;
}

export interface SearchOptions {
	/** Substring-matched against a source label. Matches every past call with that label. */
	source?: string;
	limit?: number;
	/**
	 * Exact source ids to search. Use this instead of `source` when a caller must
	 * see only the content it indexed itself — a label filter cannot distinguish
	 * two invocations of the same tool. An empty array matches nothing.
	 */
	sourceIds?: readonly number[];
}

export interface SearchResult {
	query: string;
	results: SearchHit[];
	corrected?: string;
}

export interface SearchHit {
	title: string;
	snippet: string;
	source: string;
	score: number;
}

export interface StoreStats {
	totalSources: number;
	totalChunks: number;
	vocabularySize: number;
	hasTrigramTable: boolean;
}

export interface Chunk {
	title: string;
	content: string;
	hasCode: boolean;
}

export interface SessionStats {
	calls: Record<string, number>;
	bytesReturned: Record<string, number>;
	bytesIndexed: number;
	bytesSandboxed: number;
	sessionStart: number;
}

export interface CumulativeStats {
	totalBytesSaved: number;
	totalBytesProcessed: number;
	totalCalls: number;
	totalSessions: number;
	firstSeen: string; // ISO date
	lastSeen: string;
	perCommand: Record<string, { calls: number }>;
}
