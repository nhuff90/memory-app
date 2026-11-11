import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, sep } from "node:path";
const root = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const db = new Database(join(root, "recall.db"), { readonly: true, fileMustExist: true });
assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
assert.equal(db.pragma("user_version", { simple: true }), 3);
for (const [table, count] of Object.entries(manifest.counts)) {
  assert(["memories", "photos", "embeddings", "api_tokens", "settings", "ai_usage"].includes(table));
  assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, count);
}
const photos = join(root, "photos");
for (const row of db.prepare("SELECT file, thumb FROM photos").all()) {
  for (const file of [row.file, row.thumb]) {
    const path = resolve(photos, file);
    assert(path.startsWith(photos + sep));
    assert.equal(createHash("sha256").update(await readFile(path)).digest("hex"), manifest.files[file]);
  }
}
db.close();
console.log("Verified downloaded v3 database, row counts and full/thumbnail photo hashes");
