import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, registerFunctions } from "../src/db.js";
import { MemoryStore } from "../src/memories.js";
import { MIGRATIONS } from "../src/migrations/index.js";
import { PhotoStore } from "../src/photos.js";
import { SearchIndex } from "../src/search.js";
import { FakeEmbedder } from "./fakeEmbedder.js";

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
      // Upgrades through 004 and every later forward migration (005 keyword assignments, 006 photo text).
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      expect(db.prepare(`SELECT * FROM memories`).get()).toEqual({
        ...before as object, pinned: 0, custom_keywords: "", photo_text: null,
      });
      expect(db.prepare(`SELECT * FROM photos`).all()).toEqual(
        (photoBefore as object[]).map((photo) => ({ ...photo, extracted_text: null, text_read_at: null })),
      );
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

  it("upgrades version 5 to photo text, keeping memories findable and leaving the new columns empty", async () => {
    const dir = tempDir();
    const file = join(dir, "recall.db");
    const photos = new PhotoStore(join(dir, "photos"));
    const jpeg = Uint8Array.of(255, 216, 255, 224, 1, 2, 3);
    const stored = await photos.save(jpeg, jpeg);
    const old = new Database(file);
    old.pragma("foreign_keys = ON");
    registerFunctions(old);
    for (const sql of MIGRATIONS.slice(0, 5)) old.exec(sql);
    old.pragma("user_version = 5");
    old.prepare(`INSERT INTO memories (id, body, tags, captions, custom_keywords, category, created_at, updated_at, enriched_at)
      VALUES (3, 'quartz lantern', 'lighting', 'copper kettle', 'Basalt, Juniper', 'things', 100, 200, 201)`).run();
    old.prepare(`INSERT INTO memory_keywords (memory_id, keyword, label, assigned_at)
      VALUES (3, 'basalt', 'Basalt', 150), (3, 'juniper', 'Juniper', 150)`).run();
    old.prepare(`INSERT INTO photos (id, memory_id, file, thumb, caption, captioned_at, created_at)
      VALUES (5, 3, ?, ?, 'copper kettle', 201, 100)`).run(stored.file, stored.thumb);
    old.prepare(`INSERT INTO memories (id, body, created_at, updated_at) VALUES (4, 'walnut shelf', 300, 300)`).run();
    const before = old.prepare(`SELECT * FROM memories ORDER BY id`).all() as object[];
    old.close();

    const db = openDb(file);
    try {
      expect(MIGRATIONS).toHaveLength(6);
      expect(db.pragma("user_version", { simple: true })).toBe(6);
      expect(db.prepare(`SELECT * FROM memories ORDER BY id`).all()).toEqual(
        before.map((row) => ({ ...row, photo_text: null })),
      );
      expect(db.prepare(`SELECT id, extracted_text, text_read_at FROM photos`).all()).toEqual([
        { id: 5, extracted_text: null, text_read_at: null },
      ]);
      for (const term of ["quartz", "lighting", "copper", "basalt", "juniper"]) expect(ftsIds(db, term)).toEqual([3]);
      expect(ftsIds(db, "walnut")).toEqual([4]);

      // Keyword search with the new bm25 weights still finds them by body, tag, caption and custom keyword.
      const search = new SearchIndex(db, new FakeEmbedder(), () => 1000, () => {});
      for (const term of ["quartz", "lighting", "copper", "basalt"]) {
        expect((await search.search(term)).map((hit) => hit.id)).toEqual([3]);
      }
      const store = new MemoryStore(db, photos);
      expect(store.require(3).photos).toEqual([{ id: 5, caption: "copper kettle", text: null, createdAt: 100 }]);

      // The rebuilt index covers photo_text, and the update trigger fires on photo_text alone.
      db.prepare(`UPDATE memories SET photo_text = 'saffron receipt' WHERE id = 4`).run();
      expect(ftsIds(db, "saffron")).toEqual([4]);
      expect(ftsIds(db, "photo_text:saffron")).toEqual([4]);
      expect(ftsIds(db, "walnut")).toEqual([4]);
      db.prepare(`UPDATE memories SET photo_text = NULL WHERE id = 4`).run();
      expect(ftsIds(db, "saffron")).toEqual([]);
      db.prepare(`UPDATE memories SET photo_text = 'saffron receipt' WHERE id = 4`).run();
      db.prepare(`DELETE FROM memories WHERE id = 4`).run();
      expect(ftsIds(db, "saffron OR walnut")).toEqual([]);
      db.prepare(`INSERT INTO memories (id, body, photo_text, created_at, updated_at)
        VALUES (8, 'pantry', 'cumin label', 400, 400)`).run();
      expect(ftsIds(db, "cumin")).toEqual([8]);
    } finally { db.close(); }
  });

  it("creates the photo text columns on a fresh database", () => {
    const db = openDb(join(tempDir(), "recall.db"));
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      const columns = (table: string) =>
        (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((row) => row.name);
      expect(columns("photos")).toEqual(expect.arrayContaining(["extracted_text", "text_read_at"]));
      expect(columns("memories")).toContain("photo_text");
      expect(columns("memories_fts")).toEqual(["body", "tags", "captions", "custom_keywords", "photo_text"]);
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
