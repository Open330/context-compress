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
}

export interface ExecFileOptions extends ExecOptions {
	filePath: string;
}

export interface ExecResult {
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
