import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { resolveProjectDir } from "./config.js";
import { debug } from "./logger.js";
import { extractSnippet } from "./snippet.js";
import type {
	Chunk,
	IndexResult,
	SearchHit,
	SearchOptions,
	SearchResult,
	StoreStats,
} from "./types.js";
import { detectInjectionPatterns } from "./utils.js";

const MAX_VOCABULARY = 10_000;
/** Prune only once the overshoot reaches this, to amortize the FTS5 scans. */
const PRUNE_BATCH = 25;
/** Bytes of chunk text tokenized per getDistinctiveTerms call. */
const TERM_SAMPLE_BYTES = 256 * 1024;

const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"are",
	"but",
	"not",
	"you",
	"all",
	"can",
	"had",
	"her",
	"was",
	"one",
	"our",
	"out",
	"has",
	"his",
	"how",
	"its",
	"may",
	"now",
	"old",
	"see",
	"way",
	"who",
	"did",
	"say",
	"she",
	"too",
	"will",
	"with",
	"this",
	"that",
	"from",
	"they",
	"been",
	"have",
	"many",
	"some",
	"them",
	"than",
	"each",
	"like",
	"just",
	"over",
	"such",
	"take",
	"into",
	"year",
	"your",
	"good",
	"could",
	"would",
	"about",
	"which",
	"their",
	"there",
	"other",
	"after",
	"should",
	"through",
	"also",
	"more",
	"most",
	"only",
	"very",
	"when",
	"what",
	"then",
	"these",
	"those",
	"being",
	"does",
	"done",
	"both",
	"same",
	"still",
	"while",
	"where",
	"here",
	"were",
	"much",
]);

// `m` matters: without it `^`/`$` anchor to the whole string, so
// HEADING_RE.test() on multi-line content was always false and the markdown
// decision below fell through to a bare `includes("---")`.
const HEADING_RE = /^(#{1,4})\s+(.+)$/m;
const SEPARATOR_RE = /^[-_*]{3,}\s*$/;
/** A real horizontal rule on its own line — unlike a `--- a/path` diff header. */
const HORIZONTAL_RULE_RE = /^[-_*]{3,}\s*$/m;
const FENCE_BLOCK_RE = /^`{3,}/m;
/**
 * Hard ceiling on one indexed chunk.
 *
 * FTS5 `highlight()` is superlinear in row size: a single 10.9 MB chunk measured
 * 204 s per search, versus 6.6 ms for the same content chunked normally. Any
 * chunker output is split to this bound before insertion.
 */
const MAX_CHUNK_CHARS = 8_192;

const FENCE_RE = /^`{3,}/;
const FTS_SPECIAL_RE = /['"(){}[\]*:^~]/g;
const FTS_OPERATORS_RE = /\b(AND|OR|NOT|NEAR)\b/gi;
const WORD_SPLIT_RE = /[^\p{L}\p{N}_-]+/u;

/** Split any oversized chunk so no single row can make search pathological. */
function boundChunkSize(chunks: Chunk[]): Chunk[] {
	if (chunks.every((chunk) => chunk.content.length <= MAX_CHUNK_CHARS)) return chunks;

	const bounded: Chunk[] = [];
	for (const chunk of chunks) {
		if (chunk.content.length <= MAX_CHUNK_CHARS) {
			bounded.push(chunk);
			continue;
		}
		for (let offset = 0; offset < chunk.content.length; offset += MAX_CHUNK_CHARS) {
			bounded.push({
				...chunk,
				content: chunk.content.slice(offset, offset + MAX_CHUNK_CHARS),
			});
		}
	}
	return bounded;
}

/**
 * Sanitize user query for FTS5 MATCH.
 * Removes special characters and wraps words in quotes with OR.
 */
function sanitizeQuery(raw: string): string {
	const q = raw.replace(FTS_SPECIAL_RE, " ").replace(FTS_OPERATORS_RE, " ").trim();
	const words = q
		.split(/\s+/)
		.filter((w) => w.length >= 2)
		.map((w) => `"${w}"`);
	return words.length > 0 ? words.join(" OR ") : "";
}

/** Classic Levenshtein distance with O(n) space and optional early-exit */
function levenshtein(a: string, b: string, maxDist?: number): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	let curr = new Array<number>(b.length + 1);

	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		let rowMin = curr[0];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
			if (curr[j] < rowMin) rowMin = curr[j];
		}
		if (maxDist !== undefined && rowMin > maxDist) return maxDist + 1;
		[prev, curr] = [curr, prev];
	}

	return prev[b.length];
}

export class ContentStore {
	private db: Database.Database;
	/** 0 disables pruning. */
	private maxSources = 0;
	private ephemeralDir: string | null = null;
	private hasTrigramTable = false;
	private closed = false;

	// Cached prepared statements (initialized in initSchema, always available after constructor)
	private insertSourceStmt!: Database.Statement;
	private insertChunkStmt!: Database.Statement;
	private vocabCountStmt!: Database.Statement;
	private vocabInsertStmt!: Database.Statement;

	// Cache for getDistinctiveTerms — keyed by sourceId, with "_all" for the global
	// query. index() only appends a new source, so per-source entries stay valid and
	// only the store-wide entry is invalidated.
	private distinctiveTermsCache = new Map<number | "_all", string[]>();

	constructor(
		options?:
			| string
			| { dbPath?: string; persistDb?: boolean; dbDir?: string | null; maxIndexedSources?: number },
	) {
		let path: string;
		if (typeof options === "string") {
			// Backward-compatible: accept a plain DB path string
			path = options;
		} else if (options?.persistDb || options?.dbDir) {
			const dir = options.dbDir ?? join(resolveProjectDir(), ".context-compress");
			mkdirSync(dir, { recursive: true });
			path = join(dir, "store.db");
			debug("Using persistent DB at", path);
		} else {
			const explicitPath = typeof options === "object" ? options?.dbPath : undefined;
			if (explicitPath !== undefined) {
				path = explicitPath;
			} else {
				this.ephemeralDir = mkdtempSync(join(tmpdir(), "context-compress-store-"));
				chmodSync(this.ephemeralDir, 0o700);
				path = join(this.ephemeralDir, "store.db");
			}
		}
		if (typeof options === "object" && options?.maxIndexedSources !== undefined) {
			this.maxSources = options.maxIndexedSources;
		}
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
				indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
				injection_warnings TEXT NOT NULL DEFAULT ''
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

		// Older databases predate the column. Add it only when it is genuinely
		// missing: a bare catch also swallowed SQLITE_BUSY from a concurrent
		// opener, after which prepare() failed and the server silently fell back
		// to an in-memory store for the whole session.
		const columns = this.db.prepare("PRAGMA table_info(sources)").all() as Array<{ name: string }>;
		if (!columns.some((column) => column.name === "injection_warnings")) {
			this.db.exec("ALTER TABLE sources ADD COLUMN injection_warnings TEXT NOT NULL DEFAULT ''");
		}

		this.hasTrigramTable =
			this.db
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunks_trigram'")
				.get() !== undefined;

		// Cache prepared statements
		this.insertSourceStmt = this.db.prepare(
			"INSERT INTO sources (label, chunk_count, code_chunk_count, injection_warnings) VALUES (?, ?, ?, ?)",
		);
		this.insertChunkStmt = this.db.prepare(
			"INSERT INTO chunks (title, content, source_id, content_type) VALUES (?, ?, ?, ?)",
		);
		this.vocabCountStmt = this.db.prepare("SELECT COUNT(*) as cnt FROM vocabulary");
		this.vocabInsertStmt = this.db.prepare("INSERT OR IGNORE INTO vocabulary (word) VALUES (?)");
	}

	/**
	 * Re-read whether the trigram table exists rather than trusting the flag
	 * captured at construction. Another process on the same persistent database
	 * can create it at any time; a stale `false` skipped this connection's
	 * trigram writes and then re-backfilled the whole corpus, doubling it.
	 */
	private trigramTableExists(): boolean {
		if (this.hasTrigramTable) return true;
		this.hasTrigramTable =
			this.db
				.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunks_trigram'")
				.get() !== undefined;
		return this.hasTrigramTable;
	}

	/** Lazily create trigram table only when porter search returns 0 results */
	private ensureTrigramTable(): void {
		if (this.trigramTableExists()) return;
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

		// Backfill from existing chunks in bounded batches so a large store
		// doesn't build one giant transaction / temp B-tree in a single statement.
		// Page by rowid (robust to non-contiguous rowids).
		const BATCH = 5_000;
		const backfill = this.db.prepare(
			"INSERT INTO chunks_trigram (title, content, source_id, content_type) " +
				"SELECT title, content, source_id, content_type FROM chunks " +
				"WHERE rowid > ? ORDER BY rowid LIMIT ?",
		);
		const windowMaxStmt = this.db.prepare(
			"SELECT MAX(rowid) AS maxRowid FROM (SELECT rowid FROM chunks WHERE rowid > ? ORDER BY rowid LIMIT ?)",
		);
		let lastRowid = 0;
		for (;;) {
			const window = windowMaxStmt.get(lastRowid, BATCH) as { maxRowid: number | null };
			if (window.maxRowid == null) break;
			backfill.run(lastRowid, BATCH);
			lastRowid = window.maxRowid;
		}

		this.hasTrigramTable = true;
	}

	/**
	 * Index content into the store.
	 */
	index(content: string, label: string): IndexResult {
		// `includes("---")` matched every git diff header (`--- a/path`) and most
		// YAML, routing them to the heading-based chunker, which found no headings
		// and emitted the whole document as one chunk.
		const isMarkdown =
			HEADING_RE.test(content) || FENCE_BLOCK_RE.test(content) || HORIZONTAL_RULE_RE.test(content);
		const chunks = boundChunkSize(isMarkdown ? chunkMarkdown(content) : chunkPlainText(content));
		// Detect ONCE, here, so every replay path inherits the result. Running it
		// only in fetch_and_index meant search, batch_execute, and the intent filter
		// all replayed flagged content unlabelled, and `index` and command output
		// were never scanned at all.
		const injectionWarnings = detectInjectionPatterns(content);

		const insertSource = this.insertSourceStmt;
		const insertChunk = this.insertChunkStmt;
		const insertTrigram = this.trigramTableExists()
			? this.db.prepare(
					"INSERT INTO chunks_trigram (title, content, source_id, content_type) VALUES (?, ?, ?, ?)",
				)
			: null;

		let codeChunks = 0;

		const tx = this.db.transaction(() => {
			const sourceInfo = insertSource.run(label, chunks.length, 0, injectionWarnings.join(", "));
			const sourceId = sourceInfo.lastInsertRowid as number;

			for (const chunk of chunks) {
				const contentType = chunk.hasCode ? "code" : "text";
				if (chunk.hasCode) codeChunks++;
				insertChunk.run(chunk.title, chunk.content, sourceId, contentType);
				insertTrigram?.run(chunk.title, chunk.content, sourceId, contentType);
			}

			// Update code chunk count
			this.db
				.prepare("UPDATE sources SET code_chunk_count = ? WHERE id = ?")
				.run(codeChunks, sourceId);

			// Update vocabulary
			this.updateVocabulary(content);

			return sourceId;
		});

		const sourceId = tx() as number;

		this.pruneOldSources();

		// Only the store-wide entry changes: indexing appends a NEW source, so an
		// existing per-source result stays correct. Clearing everything meant
		// batch_execute re-scanned for every command it had already looked up.
		this.distinctiveTermsCache.delete("_all");

		return {
			sourceId,
			label,
			totalChunks: chunks.length,
			codeChunks,
			injectionWarnings: injectionWarnings.length > 0 ? injectionWarnings : undefined,
		};
	}

	/**
	 * Drop the oldest sources past the retention limit.
	 *
	 * Nothing ever deleted from this store, so a persistent project database
	 * accumulated the full uncompressed output of every command in every session
	 * forever — and both getDistinctiveTerms and the trigram table get slower as
	 * it grows. Retention is opt-out (0) rather than absent.
	 */
	private pruneOldSources(): void {
		if (this.maxSources <= 0) return;

		// Prune in batches. `source_id` is UNINDEXED, so each DELETE is a full
		// virtual-table scan; running one per index() once the limit was reached
		// cost 19.5ms -> 83.5ms per index on a 500-source store. Letting a bounded
		// overshoot accumulate amortizes those scans, while a small configured
		// limit still prunes promptly.
		const batch = Math.max(1, Math.min(PRUNE_BATCH, Math.floor(this.maxSources / 10)));
		const excess = this.db
			.prepare("SELECT id FROM sources ORDER BY id DESC LIMIT -1 OFFSET ?")
			.all(this.maxSources) as Array<{ id: number }>;
		if (excess.length < batch) return;

		// One statement for the whole batch. `source_id` is UNINDEXED, so each
		// DELETE is a full virtual-table scan — issuing one per source made the
		// scan count the thing that grew. Measured: 25 individual DELETEs 369.7ms
		// vs a single `IN (...)` 39.6ms. Deferring *when* to prune does not help,
		// because the work per source is unchanged; batching the statement does.
		const ids = excess.map((row) => row.id);
		const placeholders = ids.map(() => "?").join(",");
		const deleteChunks = this.db.prepare(`DELETE FROM chunks WHERE source_id IN (${placeholders})`);
		const deleteTrigram = this.trigramTableExists()
			? this.db.prepare(`DELETE FROM chunks_trigram WHERE source_id IN (${placeholders})`)
			: null;
		const deleteSource = this.db.prepare(`DELETE FROM sources WHERE id IN (${placeholders})`);
		this.db.transaction(() => {
			deleteChunks.run(...ids);
			deleteTrigram?.run(...ids);
			deleteSource.run(...ids);
		})();
		for (const id of ids) this.distinctiveTermsCache.delete(id);
		this.pruneVocabulary();
		debug(`Pruned ${excess.length} source(s) past the ${this.maxSources} retention limit`);
	}

	/**
	 * Drop vocabulary words that no surviving chunk still contains.
	 *
	 * The table is capped at MAX_VOCABULARY and was never pruned, so it became a
	 * one-way first-come set: measured, it saturated after 83 indexed sources —
	 * inside a single busy session — and from then on nothing new was learned.
	 * Layer 3 of search (fuzzy correction) was silently dead for every source
	 * indexed afterwards.
	 */
	private pruneVocabulary(): void {
		const count = (this.vocabCountStmt.get() as { cnt: number }).cnt;
		// Only worth the scan once the table is near its ceiling.
		if (count < MAX_VOCABULARY * 0.9) return;

		const rows = this.db.prepare("SELECT content FROM chunks LIMIT 5000").all() as Array<{
			content: string;
		}>;
		const live = new Set<string>();
		for (const row of rows) {
			for (const word of row.content.split(WORD_SPLIT_RE)) {
				if (word.length >= 3) live.add(word.toLowerCase());
			}
		}
		if (live.size === 0) return;

		const words = this.db.prepare("SELECT word FROM vocabulary").all() as Array<{ word: string }>;
		const stale = words.filter((row) => !live.has(row.word.toLowerCase()));
		if (stale.length === 0) return;

		const remove = this.db.prepare("DELETE FROM vocabulary WHERE word = ?");
		this.db.transaction(() => {
			for (const { word } of stale) remove.run(word);
		})();
		debug(`Pruned ${stale.length} stale vocabulary word(s)`);
	}

	/**
	 * Three-layer search: Porter → Trigram (lazy) → Fuzzy correction.
	 */
	search(query: string, options?: SearchOptions): SearchResult {
		const limit = options?.limit ?? 3;
		const sanitized = sanitizeQuery(query);

		// Empty query after sanitization — return empty results
		if (!sanitized) {
			return { query, results: [] };
		}

		// An explicitly empty id scope selects no sources; without this the
		// `IN ()` branch below would be dropped and the caller would silently
		// get store-wide results instead of none.
		if (options?.sourceIds?.length === 0) {
			return { query, results: [] };
		}

		// Layer 1: Porter stemming search
		let hits = this.porterSearch(sanitized, options, limit);

		if (hits.length > 0) {
			return { query, results: hits };
		}

		// Layer 2: Trigram search (lazy table creation)
		this.ensureTrigramTable();
		hits = this.trigramSearch(sanitized, options, limit);

		if (hits.length > 0) {
			return { query, results: hits };
		}

		// Layer 3: Fuzzy correction
		const corrected = this.fuzzyCorrect(query);
		if (corrected && corrected !== query) {
			const correctedSanitized = sanitizeQuery(corrected);
			if (correctedSanitized) {
				hits = this.porterSearch(correctedSanitized, options, limit);
				if (hits.length > 0) {
					return { query, results: hits, corrected };
				}
			}
		}

		return { query, results: [] };
	}

	private ftsSearch(
		table: "chunks" | "chunks_trigram",
		sanitized: string,
		filters: SearchOptions | undefined,
		limit: number,
	): SearchHit[] {
		const source = filters?.source;
		const sourceIds = filters?.sourceIds;
		const sourceFilter = source ? "AND sources.label LIKE '%' || ? || '%'" : "";
		// Exact id scoping for callers that must see only what they just indexed;
		// the label LIKE filter above matches every past call with the same label.
		const idFilter = sourceIds?.length
			? `AND ${table}.source_id IN (${sourceIds.map(() => "?").join(",")})`
			: "";
		const params: (string | number)[] = [sanitized];
		if (source) params.push(source);
		if (sourceIds?.length) params.push(...sourceIds);
		params.push(limit);

		const sql = `
			SELECT
				${table}.title,
				${table}.content,
				${table}.content_type,
				sources.label,
				sources.injection_warnings,
				bm25(${table}, 2.0, 1.0) AS rank,
				highlight(${table}, 1, char(2), char(3)) AS highlighted
			FROM ${table}
			JOIN sources ON sources.id = ${table}.source_id
			WHERE ${table} MATCH ? ${sourceFilter} ${idFilter}
			ORDER BY rank
			LIMIT ?
		`;

		try {
			const rows = this.db.prepare(sql).all(...params) as Array<{
				title: string;
				content: string;
				label: string;
				injection_warnings: string;
				rank: number;
				highlighted: string;
			}>;

			return rows.map((row) => ({
				title: row.title,
				snippet: extractSnippet(row.highlighted),
				source: row.label,
				score: Math.abs(row.rank),
				injectionWarnings: row.injection_warnings
					? row.injection_warnings.split(", ").filter(Boolean)
					: undefined,
			}));
		} catch (e) {
			debug(`FTS search error (${table}):`, e);
			return [];
		}
	}

	private porterSearch(
		sanitized: string,
		filters: SearchOptions | undefined,
		limit: number,
	): SearchHit[] {
		return this.ftsSearch("chunks", sanitized, filters, limit);
	}

	private trigramSearch(
		sanitized: string,
		filters: SearchOptions | undefined,
		limit: number,
	): SearchHit[] {
		return this.ftsSearch("chunks_trigram", sanitized, filters, limit);
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
				.prepare("SELECT word FROM vocabulary WHERE length(word) BETWEEN ? AND ? LIMIT 500")
				.all(minLen, maxLen) as Array<{ word: string }>;

			let bestWord = word;
			let bestDist = maxDist + 1;

			for (const { word: candidate } of candidates) {
				const dist = levenshtein(word.toLowerCase(), candidate.toLowerCase(), maxDist);
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
		const currentCount = (this.vocabCountStmt.get() as { cnt: number }).cnt;

		if (currentCount >= MAX_VOCABULARY) return;

		// Sample first 50KB to avoid processing entire large documents
		const sample = content.length > 51_200 ? content.slice(0, 51_200) : content;
		const words = sample
			.split(WORD_SPLIT_RE)
			.filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()));

		const unique = new Set(words.map((w) => w.toLowerCase()));
		const insert = this.vocabInsertStmt;

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
		const cacheKey: number | "_all" = sourceId ?? "_all";
		const cached = this.distinctiveTermsCache.get(cacheKey);
		if (cached) return cached;

		// `source_id` is UNINDEXED in the FTS5 table, so a filtered COUNT(*) over
		// `chunks` is a full virtual-table scan — measured at 183-377 ms per call on
		// a grown store, and batch_execute makes one call per command. The `sources`
		// row already records the count, so read it from there instead.
		const totalChunks =
			(
				this.db
					.prepare(
						sourceId
							? "SELECT chunk_count as cnt FROM sources WHERE id = ?"
							: "SELECT COUNT(*) as cnt FROM chunks",
					)
					.get(...(sourceId ? [sourceId] : [])) as { cnt: number } | undefined
			)?.cnt ?? 0;

		if (totalChunks === 0) {
			this.distinctiveTermsCache.set(cacheKey, []);
			return [];
		}

		const filter = sourceId ? " WHERE source_id = ?" : "";
		const stmt = this.db.prepare(`SELECT content FROM chunks${filter} LIMIT 500`);
		const rows = (sourceId ? stmt.all(sourceId) : stmt.all()) as Array<{ content: string }>;

		// Bound the tokenization work. 500 rows x MAX_CHUNK_CHARS is up to 4MB of
		// regex splitting per call, and batch_execute makes one call per command.
		// Distinctive terms are a discovery hint, so a sample is enough.
		let sampled = 0;
		const sample: string[] = [];
		for (const row of rows) {
			if (sampled >= TERM_SAMPLE_BYTES) break;
			sample.push(row.content);
			sampled += row.content.length;
		}

		// Count document frequency per word
		const docFreq = new Map<string, number>();

		for (const content of sample) {
			const words = new Set(
				content
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
		const terms = scored.slice(0, 40).map((s) => s.word);
		this.distinctiveTermsCache.set(cacheKey, terms);
		return terms;
	}

	/**
	 * List all indexed sources with metadata.
	 */
	listSources(): Array<{
		id: number;
		label: string;
		chunkCount: number;
		codeChunks: number;
		indexedAt: string;
	}> {
		const rows = this.db
			.prepare(
				"SELECT id, label, chunk_count, code_chunk_count, indexed_at FROM sources ORDER BY indexed_at DESC",
			)
			.all() as Array<{
			id: number;
			label: string;
			chunk_count: number;
			code_chunk_count: number;
			indexed_at: string;
		}>;
		return rows.map((row) => ({
			id: row.id,
			label: row.label,
			chunkCount: row.chunk_count,
			codeChunks: row.code_chunk_count,
			indexedAt: row.indexed_at,
		}));
	}

	/**
	 * Get store statistics.
	 */
	getStats(): StoreStats {
		const sources = (
			this.db.prepare("SELECT COUNT(*) as cnt FROM sources").get() as { cnt: number }
		).cnt;
		const chunks = (this.db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number })
			.cnt;
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
		if (this.closed) return;
		this.closed = true;
		try {
			this.db.close();
		} finally {
			this.removeEphemeralDb();
		}
	}

	private removeEphemeralDb(): void {
		const dir = this.ephemeralDir;
		if (!dir) return;
		this.ephemeralDir = null;

		const dbPath = join(dir, "store.db");
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				unlinkSync(dbPath + suffix);
			} catch {
				// SQLite may remove sidecars while closing.
			}
		}

		try {
			rmdirSync(dir);
		} catch (error) {
			debug("Ephemeral DB cleanup error:", error);
		}
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
			const title = headingStack.length > 0 ? headingStack.join(" > ") : text.slice(0, 80);
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

	if (inFence) {
		debug("Warning: unclosed code fence detected during markdown chunking");
		hasCode = true;
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
	if (sections.length >= 3 && sections.length <= 200 && sections.every((s) => s.length < 5120)) {
		return sections
			.map((section) => {
				const trimmed = section.trim();
				if (!trimmed) return null;
				return {
					title: trimmed.split("\n")[0].slice(0, 80),
					content: trimmed,
					hasCode: /`{3,}/.test(trimmed),
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

	// These are the prefixes this package actually creates: `mkdtemp` directories,
	// not `context-compress-<pid>.db` files. The old pattern matched a filename
	// nothing has produced since the store moved to private random directories,
	// so this function always returned 0 while leftovers accumulated.
	const STALE_DIR_PREFIXES = ["context-compress-store-", "context-compress-exec-"];
	// Only sweep directories that have been untouched for a while, since a live
	// peer server's ephemeral store is indistinguishable from an abandoned one.
	const MIN_AGE_MS = 60 * 60 * 1000;
	const now = Date.now();

	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (!STALE_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;

			const path = join(dir, entry.name);
			try {
				if (now - statSync(path).mtimeMs < MIN_AGE_MS) continue;
				rmSync(path, { recursive: true, force: true });
				cleaned++;
			} catch (e) {
				// Another process may own or have just removed it; leave it alone.
				debug("Stale dir cleanup skipped:", entry.name, e);
			}
		}
	} catch (e) {
		debug("Stale DB cleanup error:", e);
	}

	if (cleaned > 0) debug(`Cleaned ${cleaned} stale store/exec directory(ies)`);
	return cleaned;
}
