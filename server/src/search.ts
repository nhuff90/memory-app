import { searchTerms } from "../../shared/text.js";
import type { Category } from "../../shared/types.js";
import type { DB } from "./db.js";
import type { Embedder } from "./embed.js";
import type { MemoryChange, MemoryStore } from "./memories.js";

/** Reciprocal rank fusion constant: dampens the gap between the top few ranks. */
const RRF_K = 60;
/** Notes containing the typed words should outrank notes that only seem related. */
const MEANING_WEIGHT = 0.9;
const CANDIDATES = 60;
/** Lowest cosine similarity a meaning match may have. Tuned with `npm run eval`. */
export const MIN_SIMILARITY = 0.57;
/**
 * For the "Already saved" panel: notes sharing a word with the draft need RELATED_SIMILARITY, notes sharing
 * none need STRICT_SIMILARITY, and every note shown must be within RELATED_MARGIN of the closest one.
 */
export const RELATED_SIMILARITY = 0.6;
export const STRICT_SIMILARITY = 0.8;
export const RELATED_MARGIN = 0.06;
/** A newer note gains at most this much, which settles near-ties without overriding relevance. */
const RECENCY_WEIGHT = 0.0012;
const RECENCY_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SearchOptions {
  pinned?: boolean;
  /** Related retrieval excludes its source before either search's candidate limit. */
  excludeId?: number;
  limit?: number;
  category?: Category | null;
  includeArchived?: boolean;
  /** Only close matches: used while typing a new memory to show what's already saved. */
  strict?: boolean;
  minSimilarity?: number;
  strictSimilarity?: number;
  relatedMargin?: number;
}

export interface SearchHit {
  id: number;
  score: number;
  keywordRank: number | null;
  similarity: number | null;
}

/** An FTS5 query matching any term, each as a prefix so results appear while a word is half typed. */
export function matchQuery(terms: string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', "")}"*`).join(" OR ");
}

/**
 * Meaning vectors come from the note's own words, or from its photo captions when it has no text. Auto-tags are
 * matched as keywords only: in the eval, mixing them into the vector blurred close matches without finding
 * anything new.
 */
export function embeddingText(memory: { body: string; captions: string | null }): string {
  return memory.body.trim() || (memory.captions ?? "").trim();
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** All note vectors, held in memory. A plain loop over a few thousand 384-number vectors takes milliseconds. */
export class VectorIndex {
  private readonly ids: number[] = [];
  private readonly vectors: Float32Array[] = [];
  private readonly positions = new Map<number, number>();

  get size(): number {
    return this.ids.length;
  }

  has(id: number): boolean {
    return this.positions.has(id);
  }

  set(id: number, vector: Float32Array): void {
    const position = this.positions.get(id);
    if (position !== undefined) {
      this.vectors[position] = vector;
      return;
    }
    this.positions.set(id, this.ids.length);
    this.ids.push(id);
    this.vectors.push(vector);
  }

  delete(id: number): void {
    const position = this.positions.get(id);
    if (position === undefined) return;
    const lastIndex = this.ids.length - 1;
    const lastId = this.ids[lastIndex]!;
    this.ids[position] = lastId;
    this.vectors[position] = this.vectors[lastIndex]!;
    this.positions.set(lastId, position);
    this.ids.pop();
    this.vectors.pop();
    this.positions.delete(id);
  }

  nearest(query: Float32Array, limit: number, minSimilarity: number, eligible?: ReadonlySet<number>): { id: number; similarity: number }[] {
    const hits: { id: number; similarity: number }[] = [];
    for (let i = 0; i < this.ids.length; i++) {
      if (eligible && !eligible.has(this.ids[i]!)) continue;
      const similarity = dot(query, this.vectors[i]!);
      if (similarity >= minSimilarity) hits.push({ id: this.ids[i]!, similarity });
    }
    return hits.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }
}

interface CandidateRow {
  id: number;
  category: string | null;
  archived_at: number | null;
  created_at: number;
}

/** Keyword search (SQLite FTS5) and meaning search (embeddings), merged into one ranked list. */
export class SearchIndex {
  readonly vectors = new VectorIndex();

  constructor(
    private readonly db: DB,
    private readonly embedder: Embedder,
    private readonly now: () => number = Date.now,
    private readonly log: (message: string, error?: unknown) => void = console.error,
  ) {}

  /** Subscribes to memory changes so new and edited notes are searchable by meaning right away. */
  attach(store: MemoryStore): void {
    store.onChange((change: MemoryChange) => {
      if (change.kind === "deleted") {
        this.vectors.delete(change.id);
        return;
      }
      if (
        change.kind === "created" ||
        change.kind === "captioned" ||
        (change.kind === "updated" && change.bodyChanged) ||
        (change.kind === "photo-removed" && change.captionsChanged)
      ) {
        return this.reindex(change.id);
      }
    });
  }

  /** Loads stored vectors, then embeds any note that has none for the current model. */
  async init(): Promise<number> {
    const stored = this.db.prepare(`SELECT memory_id, vector FROM embeddings WHERE model = ?`).all(this.embedder.model) as {
      memory_id: number;
      vector: Buffer;
    }[];
    for (const row of stored) {
      const bytes = row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength);
      this.vectors.set(row.memory_id, new Float32Array(bytes as ArrayBuffer));
    }
    const missing = this.db
      .prepare(
        `SELECT id FROM memories WHERE id NOT IN (SELECT memory_id FROM embeddings WHERE model = ?) ORDER BY id`,
      )
      .all(this.embedder.model) as { id: number }[];
    await this.reindexMany(missing.map((row) => row.id));
    return missing.length;
  }

  async reindex(id: number): Promise<void> {
    await this.reindexMany([id]);
  }

  async reindexMany(ids: number[]): Promise<void> {
    const select = this.db.prepare(`SELECT id, body, captions FROM memories WHERE id = ?`);
    const rows: { id: number; text: string }[] = [];
    for (const id of ids) {
      const row = select.get(id) as { id: number; body: string; captions: string | null } | undefined;
      if (row) rows.push({ id: row.id, text: embeddingText(row) });
    }
    const embeddable = rows.filter((row) => row.text);
    const vectors = await this.embedder.embedDocuments(embeddable.map((row) => row.text));
    const upsert = this.db.prepare(
      `INSERT INTO embeddings (memory_id, model, vector)
       SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?)
       ON CONFLICT (memory_id) DO UPDATE SET model = excluded.model, vector = excluded.vector`,
    );
    this.db.transaction(() => {
      embeddable.forEach((row, index) => {
        const vector = vectors[index]!;
        const bytes = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
        // The note may have been deleted while its vector was being computed.
        if (upsert.run(row.id, this.embedder.model, bytes, row.id).changes > 0) this.vectors.set(row.id, vector);
      });
    })();
    for (const row of rows) if (!row.text) this.vectors.delete(row.id);
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const text = query.trim().slice(0, 500);
    if (!text) return [];
    const limit = options.limit ?? 30;
    const minSimilarity = options.minSimilarity ?? (options.strict ? RELATED_SIMILARITY : MIN_SIMILARITY);

    const keyword = this.keywordMatches(searchTerms(text), options);
    const { matches: meaning, closest } = await this.meaningMatches(text, minSimilarity, options);
    const similarityById = new Map(meaning.map((hit) => [hit.id, hit.similarity]));

    const fused = new Map<number, SearchHit & { createdAt: number }>();
    const add = (id: number, rank: number, createdAt: number, source: "keyword" | "meaning") => {
      const hit = fused.get(id) ?? {
        id,
        score: 0,
        keywordRank: null,
        similarity: similarityById.get(id) ?? null,
        createdAt,
      };
      hit.score += (source === "keyword" ? 1 : MEANING_WEIGHT) / (RRF_K + rank);
      if (source === "keyword") hit.keywordRank = rank;
      fused.set(id, hit);
    };
    keyword.forEach((row, index) => add(row.id, index + 1, row.created_at, "keyword"));
    meaning.forEach((row, index) => add(row.id, index + 1, row.createdAt, "meaning"));

    const now = this.now();
    let hits = [...fused.values()].map((hit) => ({
      ...hit,
      score: hit.score + RECENCY_WEIGHT * Math.exp(-Math.max(0, now - hit.createdAt) / DAY_MS / RECENCY_DAYS),
    }));
    if (options.strict) {
      const strictSimilarity = options.strictSimilarity ?? STRICT_SIMILARITY;
      hits = hits.filter(
        (hit) =>
          (hit.similarity ?? 0) >= strictSimilarity ||
          (hit.keywordRank !== null && (hit.similarity ?? 0) >= minSimilarity),
      );
      // Outdated notes count here: once the note a draft repeats is retired, weaker matches shouldn't step up.
      const best = Math.max(closest, ...hits.map((hit) => hit.similarity ?? 0));
      const margin = options.relatedMargin ?? RELATED_MARGIN;
      hits = hits.filter((hit) => (hit.similarity ?? 0) >= best - margin);
    }
    return hits
      .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(({ createdAt: _createdAt, ...hit }) => hit);
  }

  async related(store: MemoryStore, id: number) {
    const source = store.require(id);
    // Bound both query size and token count. Punctuation/stopword-only text can fall back to metadata.
    const sources = [source.body, source.photos.map((photo) => photo.caption ?? "").join(" "), source.customKeywords.join(" ")];
    const terms = sources.map((text) => searchTerms(text.slice(0, 2000)).slice(0, 24)).find((words) => words.length);
    if (!terms) return [];
    const hits = await this.search(terms.join(" ").slice(0, 500), { excludeId: id, limit: 3 });
    return store.getMany(hits.map((hit) => hit.id));
  }

  private keywordMatches(terms: string[], options: SearchOptions): CandidateRow[] {
    if (terms.length === 0) return [];
    return this.db
      .prepare(
        `SELECT m.id, m.category, m.archived_at, m.created_at
         FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ?
           AND (? = 1 OR m.archived_at IS NULL)
           AND (? IS NULL OR m.category = ?)
           AND (? = 0 OR m.pinned = 1)
           AND (? IS NULL OR m.id != ?)
         ORDER BY bm25(memories_fts, 1.0, 0.5, 0.5, 0.5), m.created_at DESC
         LIMIT ?`,
      )
      .all(matchQuery(terms), options.includeArchived ? 1 : 0, options.category ?? null, options.category ?? null,
        options.pinned ? 1 : 0, options.excludeId ?? null, options.excludeId ?? null, CANDIDATES) as CandidateRow[];
  }

  private async meaningMatches(
    text: string,
    minSimilarity: number,
    options: SearchOptions,
  ): Promise<{ matches: { id: number; similarity: number; createdAt: number }[]; closest: number }> {
    const none = { matches: [], closest: 0 };
    if (this.vectors.size === 0) return none;
    let queryVector: Float32Array;
    try {
      queryVector = await this.embedder.embedQuery(text);
    } catch (error) {
      this.log("Meaning search is unavailable; using keyword search only", error);
      return none;
    }
    let eligible: Set<number> | undefined;
    if (options.pinned || options.excludeId !== undefined) {
      const rows = this.db.prepare(`SELECT id FROM memories
        WHERE (? = 0 OR pinned = 1) AND (? IS NULL OR id != ?)
          AND (? = 1 OR archived_at IS NULL) AND (? IS NULL OR category = ?)`)
        .all(options.pinned ? 1 : 0, options.excludeId ?? null, options.excludeId ?? null,
          options.includeArchived ? 1 : 0, options.category ?? null, options.category ?? null) as { id: number }[];
      eligible = new Set(rows.map((row) => row.id));
    }
    const nearest = this.vectors.nearest(queryVector, CANDIDATES * 3, minSimilarity, eligible);
    if (nearest.length === 0) return none;
    const rows = this.db
      .prepare(
        `SELECT id, category, archived_at, created_at FROM memories WHERE id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(nearest.map((hit) => hit.id))) as CandidateRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const inCategory = nearest.filter((hit) => {
      const row = byId.get(hit.id);
      return row !== undefined && (!options.category || row.category === options.category);
    });
    const matches = inCategory
      .filter((hit) => options.includeArchived || byId.get(hit.id)!.archived_at === null)
      .slice(0, CANDIDATES)
      .map((hit) => ({ ...hit, createdAt: byId.get(hit.id)!.created_at }));
    return { matches, closest: inCategory[0]?.similarity ?? 0 };
  }
}
