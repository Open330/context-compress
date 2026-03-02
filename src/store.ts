import Database from "better-sqlite3";
import { readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debug, warn } from "./logger.js";
import { extractSnippet } from "./snippet.js";
import type { Chunk, IndexResult, SearchHit, SearchResult, StoreStats } from "./types.js";

const MAX_VOCABULARY = 10_000;

const STOPWORDS = new Set([
	"the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
	"her", "was", "one", "our", "out", "has", "his", "how", "its", "may",
	"new", "now", "old", "see", "way", "who", "did", "get", "got", "let",
	"say", "she", "too", "use", "will", "with", "this", "that", "from",
	"they", "been", "have", "many", "some", "them", "than", "each", "make",
	"like", "just", "over", "such", "take", "into", "year", "your", "good",
	"could", "would", "about", "which", "their", "there", "other", "after",
	"should", "through", "also", "more", "most", "only", "very", "when",
	"what", "then", "these", "those", "being", "does", "done", "both",
	"same", "still", "while", "where", "here", "were", "much",
	"update", "updates", "updated", "deps", "dev", "tests", "test",
	"add", "added", "fix", "fixed", "run", "running", "using",
]);

const HEADING_RE = /^(#{1,4})\s+(.+)$/;
const SEPARATOR_RE = /^[-_*]{3,}\s*$/;
const FENCE_RE = /^`{3,}/;
const FTS_SPECIAL_RE = /['"(){}[\]*:^~]/g;
const FTS_OPERATORS_RE = /\b(AND|OR|NOT|NEAR)\b/gi;
const WORD_SPLIT_RE = /[^\p{L}\p{N}_-]+/u;

/**
 * Sanitize user query for FTS5 MATCH.
 * Removes special characters and wraps words in quotes with OR.
 */
function sanitizeQuery(raw: string): string {
	let q = raw.replace(FTS_SPECIAL_RE, " ").replace(FTS_OPERATORS_RE, " ").trim();
	const words = q
		.split(/\s+/)
		.filter((w) => w.length >= 2)
		.map((w) => `"${w}"`);
	return words.length > 0 ? words.join(" OR ") : '""';
}

/** Classic Levenshtein distance with O(n) space */
function levenshtein(a: string, b: string): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	let curr = new Array<number>(b.length + 1);

	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}

	return prev[b.length];
}

export class ContentStore {
	private db: Database.Database;
	private hasTrigramTable = false;

	constructor(dbPath?: string) {
		const path = dbPath ?? join(tmpdir(), `context-compress-${process.pid}.db`);
		this.db = new Database(path);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("synchronous = NORMAL");
		this.initSchema();
	}

	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS sources (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				label TEXT NOT NULL,
				chunk_count INTEGER NOT NULL DEFAULT 0,
				code_chunk_count INTEGER NOT NULL DEFAULT 0,
				indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
			);

			CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
				title,
				content,
				source_id UNINDEXED,
				content_type UNINDEXED,
				tokenize='porter unicode61'
			);

			CREATE TABLE IF NOT EXISTS vocabulary (
				word TEXT PRIMARY KEY
			);
		`);
	}

	/** Lazily create trigram table only when porter search returns 0 results */
	private ensureTrigramTable(): void {
		if (this.hasTrigramTable) return;
		debug("Creating trigram FTS5 table (lazy)");

		this.db.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
				title,
				content,
				source_id UNINDEXED,
				content_type UNINDEXED,
				tokenize='trigram'
			);
		`);

		// Backfill from existing chunks
		const rows = this.db
			.prepare("SELECT title, content, source_id, content_type FROM chunks")
			.all() as Array<{ title: string; content: string; source_id: number; content_type: string }>;

		const insert = this.db.prepare(
			"INSERT INTO chunks_trigram (title, content, source_id, content_type) VALUES (?, ?, ?, ?)",
		);
		const tx = this.db.transaction(() => {
			for (const row of rows) {
				insert.run(row.title, row.content, row.source_id, row.content_type);
			}
		});
		tx();

		this.hasTrigramTable = true;
	}

	/**
	 * Index content into the store.
	 */
	index(content: string, label: string): IndexResult {
		const isMarkdown =
			HEADING_RE.test(content) || content.includes("```") || content.includes("---");
		const chunks = isMarkdown ? chunkMarkdown(content) : chunkPlainText(content);

		const insertSource = this.db.prepare(
			"INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?, ?, ?)",
		);
		const insertChunk = this.db.prepare(
			"INSERT INTO chunks (title, content, source_id, content_type) VALUES (?, ?, ?, ?)",
		);
		const insertTrigram = this.hasTrigramTable
			? this.db.prepare(
					"INSERT INTO chunks_trigram (title, content, source_id, content_type) VALUES (?, ?, ?, ?)",
				)
			: null;

		let codeChunks = 0;

		const tx = this.db.transaction(() => {
			const sourceInfo = insertSource.run(label, chunks.length, 0);
			const sourceId = sourceInfo.lastInsertRowid as number;

			for (const chunk of chunks) {
				const contentType = chunk.hasCode ? "code" : "text";
				if (chunk.hasCode) codeChunks++;
				insertChunk.run(chunk.title, chunk.content, sourceId, contentType);
				insertTrigram?.run(chunk.title, chunk.content, sourceId, contentType);
			}

			// Update code chunk count
			this.db.prepare("UPDATE sources SET code_chunk_count = ? WHERE id = ?").run(
				codeChunks,
				sourceId,
			);

			// Update vocabulary
			this.updateVocabulary(content);

			return sourceId;
		});

		const sourceId = tx() as number;

		return {
			sourceId,
			label,
			totalChunks: chunks.length,
			codeChunks,
		};
	}

	/**
	 * Three-layer search: Porter → Trigram (lazy) → Fuzzy correction.
	 */
	search(query: string, options?: { source?: string; limit?: number }): SearchResult {
		const limit = options?.limit ?? 3;
		const sanitized = sanitizeQuery(query);

		// Layer 1: Porter stemming search
		let hits = this.porterSearch(sanitized, options?.source, limit);

		if (hits.length > 0) {
			return { query, results: hits };
		}

		// Layer 2: Trigram search (lazy table creation)
		this.ensureTrigramTable();
		hits = this.trigramSearch(sanitized, options?.source, limit);

		if (hits.length > 0) {
			return { query, results: hits };
		}

		// Layer 3: Fuzzy correction
		const corrected = this.fuzzyCorrect(query);
		if (corrected && corrected !== query) {
			const correctedSanitized = sanitizeQuery(corrected);
			hits = this.porterSearch(correctedSanitized, options?.source, limit);
			if (hits.length > 0) {
				return { query, results: hits, corrected };
			}
		}

		return { query, results: [] };
	}

	private porterSearch(sanitized: string, source: string | undefined, limit: number): SearchHit[] {
		const sourceFilter = source
			? "AND sources.label LIKE '%' || ? || '%'"
			: "";
		const params: (string | number)[] = [sanitized];
		if (source) params.push(source);
		params.push(limit);

		const sql = `
			SELECT
				chunks.title,
				chunks.content,
				chunks.content_type,
				sources.label,
				bm25(chunks, 2.0, 1.0) AS rank,
				highlight(chunks, 1, char(2), char(3)) AS highlighted
			FROM chunks
			JOIN sources ON sources.id = chunks.source_id
			WHERE chunks MATCH ? ${sourceFilter}
			ORDER BY rank
			LIMIT ?
		`;

		try {
			const rows = this.db.prepare(sql).all(...params) as Array<{
				title: string;
				content: string;
				label: string;
				rank: number;
				highlighted: string;
			}>;

			return rows.map((row) => ({
				title: row.title,
				snippet: extractSnippet(row.highlighted),
				source: row.label,
				score: Math.abs(row.rank),
			}));
		} catch (e) {
			debug("Porter search error:", e);
			return [];
		}
	}

	private trigramSearch(sanitized: string, source: string | undefined, limit: number): SearchHit[] {
		const sourceFilter = source
			? "AND sources.label LIKE '%' || ? || '%'"
			: "";
		const params: (string | number)[] = [sanitized];
		if (source) params.push(source);
		params.push(limit);

		const sql = `
			SELECT
				chunks_trigram.title,
				chunks_trigram.content,
				chunks_trigram.content_type,
				sources.label,
				bm25(chunks_trigram, 2.0, 1.0) AS rank,
				highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted
			FROM chunks_trigram
			JOIN sources ON sources.id = chunks_trigram.source_id
			WHERE chunks_trigram MATCH ? ${sourceFilter}
			ORDER BY rank
			LIMIT ?
		`;

		try {
			const rows = this.db.prepare(sql).all(...params) as Array<{
				title: string;
				content: string;
				label: string;
				rank: number;
				highlighted: string;
			}>;

			return rows.map((row) => ({
				title: row.title,
				snippet: extractSnippet(row.highlighted),
				source: row.label,
				score: Math.abs(row.rank),
			}));
		} catch (e) {
			debug("Trigram search error:", e);
			return [];
		}
	}

	/**
	 * Fuzzy correction using vocabulary + Levenshtein distance.
	 */
	private fuzzyCorrect(query: string): string | null {
		const words = query.split(/\s+/).filter((w) => w.length >= 3);
		if (words.length === 0) return null;

		const corrected: string[] = [];
		let anyChanged = false;

		for (const word of words) {
			const maxDist = word.length <= 4 ? 1 : word.length <= 12 ? 2 : 3;
			const minLen = word.length - maxDist;
			const maxLen = word.length + maxDist;

			const candidates = this.db
				.prepare("SELECT word FROM vocabulary WHERE length(word) BETWEEN ? AND ?")
				.all(minLen, maxLen) as Array<{ word: string }>;

			let bestWord = word;
			let bestDist = maxDist + 1;

			for (const { word: candidate } of candidates) {
				const dist = levenshtein(word.toLowerCase(), candidate.toLowerCase());
				if (dist < bestDist && dist <= maxDist) {
					bestDist = dist;
					bestWord = candidate;
				}
			}

			if (bestWord !== word) anyChanged = true;
			corrected.push(bestWord);
		}

		return anyChanged ? corrected.join(" ") : null;
	}

	/**
	 * Update vocabulary table from content (bounded to MAX_VOCABULARY).
	 */
	private updateVocabulary(content: string): void {
		const currentCount = (
			this.db.prepare("SELECT COUNT(*) as cnt FROM vocabulary").get() as { cnt: number }
		).cnt;

		if (currentCount >= MAX_VOCABULARY) return;

		const words = content.split(WORD_SPLIT_RE).filter(
			(w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()),
		);

		const unique = new Set(words.map((w) => w.toLowerCase()));
		const insert = this.db.prepare("INSERT OR IGNORE INTO vocabulary (word) VALUES (?)");

		let added = 0;
		for (const word of unique) {
			if (currentCount + added >= MAX_VOCABULARY) break;
			insert.run(word);
			added++;
		}
	}

	/**
	 * Get distinctive terms for search hint.
	 */
	getDistinctiveTerms(sourceId?: number): string[] {
		const totalChunks = (
			this.db
				.prepare(
					sourceId
						? "SELECT COUNT(*) as cnt FROM chunks WHERE source_id = ?"
						: "SELECT COUNT(*) as cnt FROM chunks",
				)
				.get(...(sourceId ? [sourceId] : [])) as { cnt: number }
		).cnt;

		if (totalChunks === 0) return [];

		const filter = sourceId ? " WHERE source_id = ?" : "";
		const stmt = this.db.prepare(`SELECT content FROM chunks${filter}`);
		const rows = (sourceId ? stmt.all(sourceId) : stmt.all()) as Array<{ content: string }>;

		// Count document frequency per word
		const docFreq = new Map<string, number>();

		for (const row of rows) {
			const words = new Set(
				row.content
					.split(WORD_SPLIT_RE)
					.filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()))
					.map((w) => w.toLowerCase()),
			);
			for (const word of words) {
				docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
			}
		}

		const minAppearances = 2;
		const maxAppearances = Math.max(3, Math.ceil(totalChunks * 0.4));

		const scored: Array<{ word: string; score: number }> = [];

		for (const [word, freq] of docFreq) {
			if (freq < minAppearances || freq > maxAppearances) continue;

			const idf = Math.log(totalChunks / freq);
			const lengthBonus = Math.min(word.length / 20, 0.5);
			const identifierBonus = word.includes("_") ? 1.5 : word.length >= 12 ? 0.8 : 0;
			const score = idf + lengthBonus + identifierBonus;

			scored.push({ word, score });
		}

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, 40).map((s) => s.word);
	}

	/**
	 * Get store statistics.
	 */
	getStats(): StoreStats {
		const sources = (
			this.db.prepare("SELECT COUNT(*) as cnt FROM sources").get() as { cnt: number }
		).cnt;
		const chunks = (
			this.db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number }
		).cnt;
		const vocab = (
			this.db.prepare("SELECT COUNT(*) as cnt FROM vocabulary").get() as { cnt: number }
		).cnt;

		return {
			totalSources: sources,
			totalChunks: chunks,
			vocabularySize: vocab,
			hasTrigramTable: this.hasTrigramTable,
		};
	}

	close(): void {
		this.db.close();
	}
}

// ─── Chunking ────────────────────────────────────────────────

/**
 * Chunk markdown by headings, preserving code blocks.
 */
function chunkMarkdown(content: string): Chunk[] {
	const lines = content.split("\n");
	const chunks: Chunk[] = [];
	const headingStack: string[] = [];
	let currentLines: string[] = [];
	let hasCode = false;
	let inFence = false;

	function flush() {
		const text = currentLines.join("\n").trim();
		if (text.length > 0) {
			const title =
				headingStack.length > 0 ? headingStack.join(" > ") : text.slice(0, 80);
			chunks.push({ title, content: text, hasCode });
		}
		currentLines = [];
		hasCode = false;
	}

	for (const line of lines) {
		// Track code fences
		if (FENCE_RE.test(line)) {
			inFence = !inFence;
			hasCode = true;
			currentLines.push(line);
			continue;
		}

		if (inFence) {
			currentLines.push(line);
			continue;
		}

		// Separator line — flush current chunk
		if (SEPARATOR_RE.test(line)) {
			flush();
			continue;
		}

		// Heading detection
		const headingMatch = line.match(HEADING_RE);
		if (headingMatch) {
			flush();
			const level = headingMatch[1].length;
			const text = headingMatch[2].trim();

			// Pop heading stack to correct level
			while (headingStack.length >= level) {
				headingStack.pop();
			}
			headingStack.push(text);

			currentLines.push(line);
			continue;
		}

		currentLines.push(line);
	}

	flush();
	return chunks;
}

/**
 * Chunk plain text with blank-line splitting or fixed-size fallback.
 */
function chunkPlainText(content: string, linesPerChunk = 20, overlap = 2): Chunk[] {
	const lines = content.split("\n");

	// Strategy 1: Blank-line splitting (for naturally-sectioned output)
	const sections = content.split(/\n\s*\n/);
	if (
		sections.length >= 3 &&
		sections.length <= 200 &&
		sections.every((s) => s.length < 5120)
	) {
		return sections
			.map((section) => {
				const trimmed = section.trim();
				if (!trimmed) return null;
				return {
					title: trimmed.split("\n")[0].slice(0, 80),
					content: trimmed,
					hasCode: FENCE_RE.test(trimmed),
				};
			})
			.filter(Boolean) as Chunk[];
	}

	// Strategy 2: Single chunk for small content
	if (lines.length <= linesPerChunk) {
		return [{ title: "Output", content: content.trim(), hasCode: false }];
	}

	// Strategy 3: Fixed-size overlapping chunks
	const chunks: Chunk[] = [];
	const step = Math.max(linesPerChunk - overlap, 1);

	for (let i = 0; i < lines.length; i += step) {
		const slice = lines.slice(i, i + linesPerChunk);
		const text = slice.join("\n").trim();
		if (!text) continue;

		const title = slice[0].trim().slice(0, 80) || `Lines ${i + 1}-${i + slice.length}`;
		chunks.push({ title, content: text, hasCode: false });
	}

	return chunks;
}

// ─── Stale DB cleanup ────────────────────────────────────────

/**
 * Clean up stale database files from previous sessions.
 */
export function cleanupStaleDbs(): number {
	const dir = tmpdir();
	let cleaned = 0;

	try {
		const files = readdirSync(dir);
		const dbPattern = /^context-compress-(\d+)\.db$/;

		for (const file of files) {
			const match = file.match(dbPattern);
			if (!match) continue;

			const pid = parseInt(match[1], 10);
			if (pid === process.pid) continue;

			// Check if process is still alive
			try {
				process.kill(pid, 0);
				// Process exists — skip
			} catch {
				// Process is dead — clean up
				const basePath = join(dir, file);
				for (const suffix of ["", "-wal", "-shm"]) {
					try {
						unlinkSync(basePath + suffix);
					} catch {
						// Ignore
					}
				}
				cleaned++;
			}
		}
	} catch (e) {
		debug("Stale DB cleanup error:", e);
	}

	if (cleaned > 0) debug(`Cleaned ${cleaned} stale database(s)`);
	return cleaned;
}
