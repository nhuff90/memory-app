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
