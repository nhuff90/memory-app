// Task 2 seed step: fictional stand-in for auto-tags and a photo caption, so tag and caption search can be exercised
// without any Anthropic request. Runs once in a one-shot OLD-image container as the node user, after the seeding app
// has stopped (no other writer), using the old image's own MemoryStore methods that the Enricher would call:
//   node /task2/fixture-enrich.mjs
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { openDb } from "/app/dist/server/src/db.js";
import { MemoryStore } from "/app/dist/server/src/memories.js";
import { PhotoStore } from "/app/dist/server/src/photos.js";

for (const pid of (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry))) {
  const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
  assert(!command.includes("dist/server/src/index.js") && !command.includes("litestream"), `Writer PID ${pid}`);
}
const Database = createRequire("/app/package.json")("better-sqlite3");
const check = new Database("/data/recall.db", { readonly: true, fileMustExist: true });
assert.equal(check.pragma("user_version", { simple: true }), 3, "Expected the seeded version 3 database");
check.close();

const db = openDb("/data/recall.db");
const store = new MemoryStore(db, new PhotoStore("/data/photos"));
const byPrefix = (prefix) => {
  const row = db.prepare("SELECT id FROM memories WHERE body LIKE ?").get(`${prefix}%`);
  assert(row, `No memory starts with ${prefix}`);
  return store.require(row.id);
};

const shed = byPrefix("Spare key for the Larkspur Lane shed");
assert.equal(shed.photos.length, 1);
await store.saveCaption(shed.photos[0].id, "A brass key hanging on a teal hook");

const fixtures = [
  [byPrefix("Biscuit the beagle"), { category: "things", tags: ["veterinary", "monthly"] }],
  [byPrefix("Spare key for the Larkspur Lane shed"), { category: "things", tags: ["storage"] }],
  [byPrefix("Marisol prefers oat milk"), { category: "people", tags: ["beverages"] }],
];
const applied = [];
for (const [memory, enrichment] of fixtures) {
  const row = store.getRow(memory.id);
  assert(store.applyEnrichment(memory.id, { body: row.body, captions: row.captions }, enrichment));
  const after = store.require(memory.id);
  applied.push({ id: after.id, category: after.category, tags: after.tags, captions: after.photos.map((photo) => photo.caption) });
}
assert.equal(db.pragma("user_version", { simple: true }), 3);
db.close();
console.log(JSON.stringify({ fixture: "fictional auto-tags and caption; no Anthropic request", applied }, null, 2));
