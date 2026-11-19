import type { Category, KeywordUsage, Memory, Photo, ReconcileResponse } from "../../shared/types.js";
import { keywordKey, normalizeKeywords } from "../../shared/keywords.js";
import { isCategory } from "../../shared/types.js";
import type { DB } from "./db.js";
import { badRequest, notFound, tooLarge } from "./errors.js";
import {
  isJpeg,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS_PER_REQUEST,
  MAX_THUMB_BYTES,
  type PhotoStore,
  type StoredPhotoFiles,
} from "./photos.js";

export const MAX_BODY_LENGTH = 10_000;
const EARLIEST_CREATED_AT = Date.UTC(2000, 0, 1);
const CLOCK_SKEW_MS = 10 * 60 * 1000;

export interface PhotoUpload {
  full: Uint8Array;
  thumb: Uint8Array;
}

export interface CreateMemoryInput {
  body: string;
  clientId?: string | null;
  createdAt?: number | null;
  photos?: PhotoUpload[];
  /** Saved in the same transaction as the body and photos. Older clients omit it: no keywords. */
  customKeywords?: string[];
}

export interface UpdateMemoryInput {
  body?: string;
  pinned?: boolean;
  customKeywords?: string[];
  archived?: boolean;
  /** A category picked by hand, which auto-tagging then leaves alone. */
  category?: Category;
}

export interface Enrichment {
  category: Category;
  tags: string[];
}

export interface ListOptions {
  pinned?: boolean;
  cursor?: string | null;
  limit?: number;
  category?: Category | null;
  includeArchived?: boolean;
  withPhotosOnly?: boolean;
  /** Exact whole custom keyword, matched by normalized identity. */
  keyword?: string | null;
}

/** SQL fragment matching memories (aliased `alias`) carrying the normalized keyword bound to the placeholder. */
export function keywordClause(alias: string): string {
  return `EXISTS (SELECT 1 FROM memory_keywords k WHERE k.memory_id = ${alias}.id AND k.keyword = ?)`;
}

function parseKeywords(values: readonly string[]): string[] {
  try {
    return normalizeKeywords(values);
  } catch (error) {
    throw badRequest((error as Error).message);
  }
}

export type MemoryChange =
  | { kind: "created"; id: number; photoIds: number[] }
  | { kind: "updated"; id: number; bodyChanged: boolean }
  | { kind: "photos-added"; id: number; photoIds: number[] }
  | { kind: "photo-removed"; id: number; photoId: number; captionsChanged: boolean }
  | { kind: "captioned"; id: number }
  | { kind: "deleted"; id: number };

export type ChangeListener = (change: MemoryChange) => void | Promise<void>;

export interface MemoryRow {
  pinned: number;
  custom_keywords: string;
  id: number;
  client_id: string | null;
  body: string;
  category: string | null;
  tags: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  enriched_at: number | null;
  category_set_by_user: number;
  /** Every photo caption, joined with "; ". */
  captions: string | null;
}

interface PhotoRow {
  id: number;
  memory_id: number;
  file: string;
  thumb: string;
  created_at: number;
  caption: string | null;
  captioned_at: number | null;
}

export function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").trim();
}

export function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function clampCreatedAt(createdAt: number | null | undefined, now: number): number {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return now;
  if (createdAt < EARLIEST_CREATED_AT || createdAt > now + CLOCK_SKEW_MS) return now;
  return Math.round(createdAt);
}

function validatePhotos(photos: PhotoUpload[]): void {
  if (photos.length > MAX_PHOTOS_PER_REQUEST) {
    throw badRequest(`Add up to ${MAX_PHOTOS_PER_REQUEST} photos at a time.`);
  }
  for (const photo of photos) {
    if (!isJpeg(photo.full) || !isJpeg(photo.thumb)) throw badRequest("Photos must be JPEG images.");
    if (photo.full.byteLength > MAX_PHOTO_BYTES || photo.thumb.byteLength > MAX_THUMB_BYTES) {
      throw tooLarge("That photo is too large.");
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function parseCursor(cursor: string): [number, number] {
  const match = /^(\d+)_(\d+)$/.exec(cursor);
  if (!match) throw badRequest("That page link is invalid.");
  return [Number(match[1]), Number(match[2])];
}

/** Owns memory rows and their photo files. Listeners run after every change (search indexing, AI tagging). */
export class MemoryStore {
  private readonly listeners: ChangeListener[] = [];

  constructor(
    readonly db: DB,
    readonly photos: PhotoStore,
    private readonly now: () => number = Date.now,
    private readonly log: (message: string, error?: unknown) => void = console.error,
  ) {}

  onChange(listener: ChangeListener): void {
    this.listeners.push(listener);
  }

  async create(input: CreateMemoryInput): Promise<{ memory: Memory; created: boolean }> {
    const body = normalizeBody(input.body);
    const uploads = input.photos ?? [];
    if (body.length > MAX_BODY_LENGTH) throw badRequest(`Keep memories under ${MAX_BODY_LENGTH} characters.`);
    if (!body && uploads.length === 0) throw badRequest("Type something or add a photo first.");
    validatePhotos(uploads);
    // Validated before anything is stored: an invalid keyword list saves nothing at all.
    const keywords = parseKeywords(input.customKeywords ?? []);

    const clientId = input.clientId ?? null;
    if (clientId) {
      // A retry of a capture that already arrived: return it unchanged, never a second copy or a second count.
      const existing = this.findByClientId(clientId);
      if (existing) return { memory: existing, created: false };
    }

    const now = this.now();
    const createdAt = clampCreatedAt(input.createdAt, now);
    const stored: StoredPhotoFiles[] = [];
    let inserted: { id: number; photoIds: number[] };
    try {
      for (const upload of uploads) stored.push(await this.photos.save(upload.full, upload.thumb));
      inserted = this.db.transaction(() => {
        const result = this.db
          .prepare(
            `INSERT INTO memories (client_id, body, custom_keywords, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(clientId, body, keywords.join(", "), createdAt, now);
        const id = Number(result.lastInsertRowid);
        this.syncKeywordRows(id, keywords, now);
        if (clientId) {
          this.db
            .prepare(`INSERT INTO capture_receipts (client_id, memory_id, custom_keywords, received_at) VALUES (?, ?, ?, ?)`)
            .run(clientId, id, JSON.stringify(keywords), now);
        }
        return { id, photoIds: this.insertPhotoRows(id, stored, now) };
      })();
    } catch (error) {
      await this.photos.remove(stored.flatMap((files) => [files.file, files.thumb]));
      if (clientId && isUniqueViolation(error)) {
        const existing = this.findByClientId(clientId);
        if (existing) return { memory: existing, created: false };
      }
      throw error;
    }

    await this.emit({ kind: "created", id: inserted.id, photoIds: inserted.photoIds });
    return { memory: this.require(inserted.id), created: true };
  }

  get(id: number): Memory | null {
    const row = this.getRow(id);
    return row ? this.hydrate([row])[0]! : null;
  }

  require(id: number): Memory {
    const memory = this.get(id);
    if (!memory) throw notFound();
    return memory;
  }

  getRow(id: number): MemoryRow | null {
    return (this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined) ?? null;
  }

  /** Returns memories in the order of `ids`, skipping any that no longer exist. */
  getMany(ids: number[]): Memory[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as MemoryRow[];
    const byId = new Map(this.hydrate(rows).map((memory) => [memory.id, memory]));
    return ids.map((id) => byId.get(id)).filter((memory): memory is Memory => memory !== undefined);
  }

  list(options: ListOptions = {}): { memories: Memory[]; nextCursor: string | null } {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 30), 1), 200);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!options.includeArchived) where.push("archived_at IS NULL");
    if (options.pinned) where.push("pinned = 1");
    if (options.category) {
      where.push("category = ?");
      params.push(options.category);
    }
    if (options.withPhotosOnly) where.push("EXISTS (SELECT 1 FROM photos p WHERE p.memory_id = memories.id)");
    const key = options.keyword ? keywordKey(options.keyword) : "";
    if (key) {
      where.push(keywordClause("memories"));
      params.push(key);
    }
    if (options.cursor) {
      const [createdAt, id] = parseCursor(options.cursor);
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(createdAt, createdAt, id);
    }
    const sql = `SELECT * FROM memories ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit + 1) as MemoryRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      memories: this.hydrate(page),
      nextCursor: rows.length > limit && last ? `${last.created_at}_${last.id}` : null,
    };
  }

  async update(id: number, input: UpdateMemoryInput): Promise<Memory> {
    const current = this.getRow(id);
    if (!current) throw notFound();
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    let bodyChanged = false;
    let keywords: string[] | null = null;

    if (input.customKeywords !== undefined) {
      keywords = parseKeywords(input.customKeywords);
      const stored = keywords.join(", ");
      if (stored !== current.custom_keywords) {
        sets.push("custom_keywords = ?");
        params.push(stored);
      } else {
        keywords = null;
      }
    }
    if (input.pinned !== undefined && Number(input.pinned) !== current.pinned) {
      sets.push("pinned = ?");
      params.push(Number(input.pinned));
    }

    if (input.body !== undefined) {
      const body = normalizeBody(input.body);
      if (body.length > MAX_BODY_LENGTH) throw badRequest(`Keep memories under ${MAX_BODY_LENGTH} characters.`);
      if (!body && this.photoCount(id) === 0) throw badRequest("A memory needs some text or a photo.");
      if (body !== current.body) {
        // New text needs new tags.
        sets.push("body = ?", "enriched_at = NULL");
        params.push(body);
        bodyChanged = true;
      }
    }
    if (input.archived !== undefined) {
      sets.push("archived_at = ?");
      params.push(input.archived ? (current.archived_at ?? this.now()) : null);
    }
    if (input.category !== undefined && (input.category !== current.category || current.category_set_by_user !== 1)) {
      sets.push("category = ?", "category_set_by_user = 1");
      params.push(input.category);
    }
    if (sets.length === 0) return this.require(id);

    const now = this.now();
    sets.push("updated_at = ?");
    params.push(now);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
      if (keywords) this.syncKeywordRows(id, keywords, now);
    })();
    await this.emit({ kind: "updated", id, bodyChanged });
    return this.require(id);
  }

  /**
   * Reconciles a capture held on a device by its original clientId.
   * - No recall with that clientId: `missing` (the device may upload it).
   * - A recall this server saved with its keywords (receipt): `already-saved`; differences are later edits.
   * - A recall an older server created without the keywords (no receipt): nobody recorded what happened to its
   *   keywords since, so a held keyword that is absent now may have been removed on purpose. The missing keywords
   *   are only added when the recall is provably untouched since that capture (`expectedUpdatedAt` equals the
   *   `updatedAt` the device received in the create's 201 response, and it still has no keywords; a retry's 200
   *   response is never such proof), or when the user explicitly chose `add` after seeing the
   *   current keywords (`expectedUpdatedAt` from that `conflict` answer, so a newer edit is never overwritten).
   *   Otherwise nothing changes and the answer is `conflict`, with the current recall and the missing keywords.
   *   `keep` records the user's choice to keep the recall as it is.
   */
  async reconcile(
    clientId: string,
    customKeywords: string[],
    options: { expectedUpdatedAt?: number | null; resolution?: "add" | "keep" | null } = {},
  ): Promise<ReconcileResponse> {
    const held = parseKeywords(customKeywords);
    const row = this.db.prepare(`SELECT * FROM memories WHERE client_id = ?`).get(clientId) as MemoryRow | undefined;
    if (!row) return { status: "missing", memory: null };
    const receipt = this.db.prepare(`SELECT 1 FROM capture_receipts WHERE client_id = ?`).get(clientId);
    if (receipt) return { status: "already-saved", memory: this.require(row.id) };

    const current = parseTags(row.custom_keywords);
    const currentKeys = new Set(current.map(keywordKey));
    const missing = held.filter((keyword) => !currentKeys.has(keywordKey(keyword)));
    const writeReceipt = () =>
      this.db
        .prepare(`INSERT INTO capture_receipts (client_id, memory_id, custom_keywords, received_at) VALUES (?, ?, ?, ?)`)
        .run(clientId, row.id, JSON.stringify(held), this.now());
    if (missing.length === 0 || options.resolution === "keep") {
      writeReceipt();
      return { status: missing.length === 0 ? "reconciled" : "kept", memory: this.require(row.id) };
    }
    const sameVersion = typeof options.expectedUpdatedAt === "number" && options.expectedUpdatedAt === row.updated_at;
    // Without an explicit "add", the recall must also still look exactly as the older server created it: that server
    // never stored keywords, so any keyword now present proves later keyword edits (and a removal may be among them).
    const untouched = sameVersion && (options.resolution === "add" || current.length === 0);
    if (!untouched) return { status: "conflict", memory: this.require(row.id), missingKeywords: missing };

    let merged: string[];
    try {
      merged = normalizeKeywords([...current, ...held]);
    } catch (error) {
      throw badRequest(
        `This memory already has ${current.length} keyword${current.length === 1 ? "" : "s"}. ${(error as Error).message} Remove some, then try again.`,
      );
    }
    const now = this.now();
    this.db.transaction(() => {
      // Guarded by updated_at too, so an edit landing between the check and this write is never overwritten.
      const result = this.db
        .prepare(`UPDATE memories SET custom_keywords = ?, updated_at = ? WHERE id = ? AND updated_at = ?`)
        .run(merged.join(", "), now, row.id, row.updated_at);
      if (result.changes === 0) throw badRequest("This memory just changed. Try recovering again.");
      this.syncKeywordRows(row.id, merged, now);
      writeReceipt();
    })();
    await this.emit({ kind: "updated", id: row.id, bodyChanged: false });
    return { status: "reconciled", memory: this.require(row.id) };
  }

  /**
   * Every custom keyword with its active usage count (once per recall, outdated recalls excluded) and last genuine
   * assignment time. Keywords found only on outdated recalls are listed with a count of 0, for typed matches only.
   */
  keywordVocabulary(): KeywordUsage[] {
    const rows = this.db
      .prepare(
        `SELECT k.keyword AS key, k.label, k.assigned_at, m.archived_at
         FROM memory_keywords k JOIN memories m ON m.id = k.memory_id`,
      )
      .all() as { key: string; label: string; assigned_at: number | null; archived_at: number | null }[];
    const byKey = new Map<string, { count: number; last: number | null; labels: Map<string, number>; anyLabel: string }>();
    for (const row of rows) {
      const entry = byKey.get(row.key) ?? { count: 0, last: null, labels: new Map(), anyLabel: row.label };
      if (row.archived_at === null) {
        entry.count++;
        if (row.assigned_at !== null) entry.last = Math.max(entry.last ?? 0, row.assigned_at);
        entry.labels.set(row.label, (entry.labels.get(row.label) ?? 0) + 1);
      }
      if (row.label < entry.anyLabel) entry.anyLabel = row.label;
      byKey.set(row.key, entry);
    }
    return [...byKey.entries()]
      .map(([key, entry]) => {
        // The most used spelling among active recalls; alphabetical on ties so it never flickers.
        const labels = [...entry.labels.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        return { keyword: labels[0]?.[0] ?? entry.anyLabel, key, count: entry.count, lastAssignedAt: entry.last };
      })
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** Memories still waiting for auto-tagging, newest first. */
  unenriched(limit = 1000): number[] {
    const rows = this.db
      .prepare(`SELECT id FROM memories WHERE enriched_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as { id: number }[];
    return rows.map((row) => row.id);
  }

  /**
   * Saves auto-tags, unless the text or photo captions changed since they were read (the change queues a fresh
   * run). A category picked by hand is kept. Returns whether anything was saved.
   */
  applyEnrichment(id: number, seen: { body: string; captions: string | null }, enrichment: Enrichment): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories
         SET tags = ?, category = CASE WHEN category_set_by_user = 1 THEN category ELSE ? END, enriched_at = ?
         WHERE id = ? AND body = ? AND captions IS ?`,
      )
      .run(
        enrichment.tags.length > 0 ? enrichment.tags.join(", ") : null,
        enrichment.category,
        this.now(),
        id,
        seen.body,
        seen.captions,
      );
    return result.changes > 0;
  }

  /** Memories with photos that haven't been described yet, newest first. */
  uncaptioned(limit = 1000): number[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM memories m
         WHERE EXISTS (SELECT 1 FROM photos p WHERE p.memory_id = m.id AND p.captioned_at IS NULL)
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(limit) as { id: number }[];
    return rows.map((row) => row.id);
  }

  uncaptionedPhotos(memoryId: number): number[] {
    const rows = this.db
      .prepare(`SELECT id FROM photos WHERE memory_id = ? AND captioned_at IS NULL ORDER BY id`)
      .all(memoryId) as { id: number }[];
    return rows.map((row) => row.id);
  }

  /**
   * Records what Claude saw in a photo, or null when it couldn't say, so the photo isn't sent again.
   * A new caption makes the memory findable by it and queues fresh tags.
   */
  async saveCaption(photoId: number, caption: string | null): Promise<void> {
    const photo = this.db.prepare(`SELECT memory_id FROM photos WHERE id = ?`).get(photoId) as
      | Pick<PhotoRow, "memory_id">
      | undefined;
    if (!photo) return;
    const changed = this.db.transaction(() => {
      this.db.prepare(`UPDATE photos SET caption = ?, captioned_at = ? WHERE id = ?`).run(caption, this.now(), photoId);
      return this.refreshCaptions(photo.memory_id);
    })();
    if (changed) await this.emit({ kind: "captioned", id: photo.memory_id });
  }

  /** Marks a memory as done without new tags, so it isn't retried forever. */
  markEnriched(id: number): void {
    this.db.prepare(`UPDATE memories SET enriched_at = ? WHERE id = ?`).run(this.now(), id);
  }

  async delete(id: number): Promise<boolean> {
    const photoRows = this.photoRows(id);
    const result = this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    if (result.changes === 0) return false;
    await this.photos.remove(photoRows.flatMap((photo) => [photo.file, photo.thumb]));
    await this.emit({ kind: "deleted", id });
    return true;
  }

  async addPhotos(id: number, uploads: PhotoUpload[]): Promise<Memory> {
    if (!this.getRow(id)) throw notFound();
    if (uploads.length === 0) throw badRequest("Choose a photo to add.");
    validatePhotos(uploads);
    const stored: StoredPhotoFiles[] = [];
    let photoIds: number[];
    try {
      for (const upload of uploads) stored.push(await this.photos.save(upload.full, upload.thumb));
      const now = this.now();
      photoIds = this.db.transaction(() => {
        const ids = this.insertPhotoRows(id, stored, now);
        this.db.prepare(`UPDATE memories SET updated_at = ? WHERE id = ?`).run(now, id);
        return ids;
      })();
    } catch (error) {
      await this.photos.remove(stored.flatMap((files) => [files.file, files.thumb]));
      throw error;
    }
    await this.emit({ kind: "photos-added", id, photoIds });
    return this.require(id);
  }

  async removePhoto(photoId: number): Promise<Memory> {
    const photo = this.db.prepare(`SELECT * FROM photos WHERE id = ?`).get(photoId) as PhotoRow | undefined;
    if (!photo) throw notFound("That photo no longer exists.");
    const memory = this.getRow(photo.memory_id);
    if (memory && !memory.body && this.photoCount(memory.id) === 1) {
      throw badRequest("This memory is only a photo. Add some text first, or delete the memory instead.");
    }
    const captionsChanged = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM photos WHERE id = ?`).run(photoId);
      this.db.prepare(`UPDATE memories SET updated_at = ? WHERE id = ?`).run(this.now(), photo.memory_id);
      return this.refreshCaptions(photo.memory_id);
    })();
    await this.photos.remove([photo.file, photo.thumb]);
    await this.emit({ kind: "photo-removed", id: photo.memory_id, photoId, captionsChanged });
    return this.require(photo.memory_id);
  }

  photoPath(photoId: number, size: "full" | "thumb"): string | null {
    const photo = this.db.prepare(`SELECT file, thumb FROM photos WHERE id = ?`).get(photoId) as
      | Pick<PhotoRow, "file" | "thumb">
      | undefined;
    if (!photo) return null;
    return size === "thumb" ? photo.thumb : photo.file;
  }

  /** Every memory, newest first, including outdated ones. */
  all(): Memory[] {
    const rows = this.db.prepare(`SELECT * FROM memories ORDER BY created_at DESC, id DESC`).all() as MemoryRow[];
    return this.hydrate(rows);
  }

  counts(): { memories: number; photos: number } {
    const row = this.db
      .prepare(`SELECT (SELECT count(*) FROM memories) AS memories, (SELECT count(*) FROM photos) AS photos`)
      .get() as { memories: number; photos: number };
    return { memories: row.memories, photos: row.photos };
  }

  hydrate(rows: MemoryRow[]): Memory[] {
    if (rows.length === 0) return [];
    const photoRows = this.db
      .prepare(`SELECT * FROM photos WHERE memory_id IN (SELECT value FROM json_each(?)) ORDER BY id`)
      .all(JSON.stringify(rows.map((row) => row.id))) as PhotoRow[];
    const photosByMemory = new Map<number, Photo[]>();
    for (const photo of photoRows) {
      const list = photosByMemory.get(photo.memory_id) ?? [];
      list.push({ id: photo.id, caption: photo.caption, createdAt: photo.created_at });
      photosByMemory.set(photo.memory_id, list);
    }
    return rows.map((row) => ({
      id: row.id,
      body: row.body,
      pinned: row.pinned === 1,
      customKeywords: parseTags(row.custom_keywords),
      category: isCategory(row.category) ? row.category : null,
      categorySetByUser: row.category_set_by_user === 1,
      tags: parseTags(row.tags),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      enrichedAt: row.enriched_at,
      photos: photosByMemory.get(row.id) ?? [],
    }));
  }

  private findByClientId(clientId: string): Memory | null {
    const row = this.db.prepare(`SELECT * FROM memories WHERE client_id = ?`).get(clientId) as MemoryRow | undefined;
    return row ? this.hydrate([row])[0]! : null;
  }

  /**
   * Keeps the keyword assignment rows equal to the saved list. Only keywords new to this recall get a fresh
   * assignment time; kept keywords keep theirs (a respelling is not a new assignment), removed ones are dropped.
   * Must run inside the transaction that writes `custom_keywords`.
   */
  private syncKeywordRows(memoryId: number, keywords: string[], now: number): void {
    const existing = new Map(
      (this.db.prepare(`SELECT keyword, label FROM memory_keywords WHERE memory_id = ?`).all(memoryId) as {
        keyword: string;
        label: string;
      }[]).map((row) => [row.keyword, row.label]),
    );
    const next = new Map(keywords.map((keyword) => [keywordKey(keyword), keyword]));
    const remove = this.db.prepare(`DELETE FROM memory_keywords WHERE memory_id = ? AND keyword = ?`);
    const relabel = this.db.prepare(`UPDATE memory_keywords SET label = ? WHERE memory_id = ? AND keyword = ?`);
    const insert = this.db.prepare(
      `INSERT INTO memory_keywords (memory_id, keyword, label, assigned_at) VALUES (?, ?, ?, ?)`,
    );
    for (const key of existing.keys()) if (!next.has(key)) remove.run(memoryId, key);
    for (const [key, label] of next) {
      const previous = existing.get(key);
      if (previous === undefined) insert.run(memoryId, key, label, now);
      else if (previous !== label) relabel.run(label, memoryId, key);
    }
  }

  private insertPhotoRows(memoryId: number, stored: StoredPhotoFiles[], createdAt: number): number[] {
    const insert = this.db.prepare(`INSERT INTO photos (memory_id, file, thumb, created_at) VALUES (?, ?, ?, ?)`);
    return stored.map((files) => Number(insert.run(memoryId, files.file, files.thumb, createdAt).lastInsertRowid));
  }

  private photoRows(memoryId: number): PhotoRow[] {
    return this.db.prepare(`SELECT * FROM photos WHERE memory_id = ?`).all(memoryId) as PhotoRow[];
  }

  /** Copies the photo captions onto the memory row, clearing its tags' done mark if they changed. */
  private refreshCaptions(memoryId: number): boolean {
    const rows = this.db
      .prepare(`SELECT caption FROM photos WHERE memory_id = ? AND caption IS NOT NULL ORDER BY id`)
      .all(memoryId) as { caption: string }[];
    const captions = rows.length > 0 ? rows.map((row) => row.caption).join("; ") : null;
    const result = this.db
      .prepare(`UPDATE memories SET captions = ?, enriched_at = NULL WHERE id = ? AND captions IS NOT ?`)
      .run(captions, memoryId, captions);
    return result.changes > 0;
  }

  private photoCount(memoryId: number): number {
    const row = this.db.prepare(`SELECT count(*) AS n FROM photos WHERE memory_id = ?`).get(memoryId) as { n: number };
    return row.n;
  }

  private async emit(change: MemoryChange): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(change);
      } catch (error) {
        this.log(`Change listener failed for memory ${change.id}`, error);
      }
    }
  }
}
