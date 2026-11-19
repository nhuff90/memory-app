import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { MemoryStore } from "../src/memories.js";
import { MIGRATIONS } from "../src/migrations/index.js";
import { PhotoStore } from "../src/photos.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "recall-db-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ftsIds(db: ReturnType<typeof openDb>, query: string): number[] {
  return (db.prepare(`SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ?`).all(query) as { id: number }[]).map(
    (row) => row.id,
  );
}

describe("database", () => {
  it("upgrades version 3 preserving memories, photos, tags, captions, vectors and all FTS columns", async () => {
    const dir = tempDir();
    const file = join(dir, "recall.db");
    const photos = new PhotoStore(join(dir, "photos"));
    const jpeg = Uint8Array.of(255, 216, 255, 224, 1, 2, 3);
    const stored = await photos.save(jpeg, jpeg);
    const old = new Database(file);
    old.pragma("foreign_keys = ON");
    for (const sql of MIGRATIONS.slice(0, 3)) old.exec(sql);
    old.pragma("user_version = 3");
    old.prepare(`INSERT INTO memories (id, body, tags, captions, category, category_set_by_user, created_at, updated_at, enriched_at)
      VALUES (7, 'compass cabinet', 'navigation', 'amber toolbox', 'things', 1, 100, 200, 201)`).run();
    old.prepare(`INSERT INTO photos (id, memory_id, file, thumb, caption, captioned_at, created_at)
      VALUES (9, 7, ?, ?, 'amber toolbox', 201, 100)`).run(stored.file, stored.thumb);
    old.prepare(`INSERT INTO embeddings VALUES (7, 'fictional-model', ?)`).run(Buffer.from([1, 2, 3, 4]));
    const before = old.prepare(`SELECT * FROM memories`).get();
    const photoBefore = old.prepare(`SELECT * FROM photos`).all();
    const vectorBefore = old.prepare(`SELECT * FROM embeddings`).all();
    old.close();
    const db = openDb(file);
    try {
      // Upgrades through 004 and every later forward migration (005 keyword assignments).
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      expect(db.prepare(`SELECT * FROM memories`).get()).toEqual({ ...before as object, pinned: 0, custom_keywords: "" });
      expect(db.prepare(`SELECT * FROM photos`).all()).toEqual(photoBefore);
      expect(db.prepare(`SELECT * FROM embeddings`).all()).toEqual(vectorBefore);
      expect(await photos.read(stored.file)).toEqual(Buffer.from(jpeg));
      expect(await photos.read(stored.thumb)).toEqual(Buffer.from(jpeg));
      for (const term of ["compass", "navigation", "amber"]) expect(ftsIds(db, term)).toEqual([7]);
      const store = new MemoryStore(db, photos);
      expect(store.require(7)).toMatchObject({ pinned: false, customKeywords: [], tags: ["navigation"], photos: [{ id: 9, caption: "amber toolbox", createdAt: 100 }] });
      await store.update(7, { customKeywords: ["Zephyr"] });
      expect(ftsIds(db, "zephyr")).toEqual([7]);
      await store.update(7, { body: "sundial" });
      expect(ftsIds(db, "compass")).toEqual([]);
      expect(ftsIds(db, "sundial AND zephyr AND amber AND navigation")).toEqual([7]);
      await store.delete(7);
      expect(ftsIds(db, "sundial OR zephyr OR amber OR navigation")).toEqual([]);
      const inserted = await store.create({ body: "fresh compass" });
      expect(inserted.memory).toMatchObject({ pinned: false, customKeywords: [] });
      expect(ftsIds(db, "compass")).toEqual([inserted.memory.id]);
    } finally { db.close(); }
  });

  it("runs every migration once and records the version", () => {
    const file = join(tempDir(), "recall.db");
    const db = openDb(file);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    db.close();

    const reopened = openDb(file);
    expect(reopened.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    reopened.close();
  });

  it("upgrades an existing database without losing its keyword index", () => {
    const file = join(tempDir(), "recall.db");
    const old = new Database(file);
    for (const sql of MIGRATIONS.slice(0, 2)) old.exec(sql);
    old.pragma("user_version = 2");
    old
      .prepare(`INSERT INTO memories (body, tags, created_at, updated_at) VALUES (?, ?, 1, 1)`)
      .run("Christmas boxes are in the attic", "xmas, decorations");
    old.close();

    const db = openDb(file);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(ftsIds(db, "attic")).toEqual([1]);
    expect(ftsIds(db, "xmas")).toEqual([1]);
    db.prepare(`UPDATE memories SET captions = 'a red plastic bin' WHERE id = 1`).run();
    expect(ftsIds(db, "plastic")).toEqual([1]);
    db.prepare(`DELETE FROM memories WHERE id = 1`).run();
    expect(ftsIds(db, "attic OR plastic")).toEqual([]);
    db.close();
  });

  it("refuses to open a database from a newer version of the app", () => {
    const file = join(tempDir(), "recall.db");
    const db = openDb(file);
    db.pragma("user_version = 999");
    db.close();
    expect(() => openDb(file)).toThrow(/Update the app first/);
  });

  it("keeps the keyword index in sync with edits and deletes", async () => {
    const dir = tempDir();
    const db = openDb(join(dir, "recall.db"));
    const store = new MemoryStore(db, new PhotoStore(join(dir, "photos")));

    const { memory } = await store.create({ body: "I put the screwdriver in the basement next to the washer" });
    expect(ftsIds(db, "screwdriver")).toEqual([memory.id]);
    expect(ftsIds(db, "washers")).toEqual([memory.id]);

    await store.update(memory.id, { body: "screwdriver is in the garage now" });
    expect(ftsIds(db, "basement")).toEqual([]);
    expect(ftsIds(db, "garage")).toEqual([memory.id]);

    await store.delete(memory.id);
    expect(ftsIds(db, "screwdriver")).toEqual([]);
    db.close();
  });
});
