// Task 2 read-only state probe. Runs inside a Recall container (old or candidate image) as the node user:
//   node /task2/probe.mjs <dataDir> [search terms...]
// Lists the directory BEFORE opening anything, then opens recall.db read-only and prints version, integrity,
// the six table counts, logical rows, photo file hashes and embedding identities. Never prints token hashes.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const Database = createRequire("/app/package.json")("better-sqlite3");
const TABLES = ["memories", "photos", "embeddings", "api_tokens", "settings", "ai_usage"];
const root = resolve(process.argv[2] ?? "/data");
const terms = process.argv.slice(3);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const listing = [];
for (const name of (await readdir(root)).sort()) {
  const stat = await lstat(join(root, name));
  const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
  listing.push({ name, type, size: stat.size, uid: stat.uid, gid: stat.gid });
}
// Every process in this container (from /proc), so a remaining app or Litestream writer would be visible.
const processes = [];
for (const pid of (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry)).sort((a, b) => a - b)) {
  const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
  processes.push({ pid: Number(pid), command: command.split("\0").filter(Boolean).join(" ") });
}
const writers = processes.filter((entry) => entry.command.includes("dist/server/src/index.js") || entry.command.includes("litestream"));
const out = { at: new Date().toISOString(), root, processUid: process.getuid(), processes, writers, listingBeforeOpen: listing };
if (!listing.some((entry) => entry.name === "recall.db")) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const db = new Database(join(root, "recall.db"), { readonly: true, fileMustExist: true });
out.version = db.pragma("user_version", { simple: true });
out.integrity = db.pragma("integrity_check", { simple: true });
out.counts = Object.fromEntries(TABLES.map((table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
const memoryColumns = db.prepare("SELECT name FROM pragma_table_info('memories')").all().map((row) => row.name);
const ftsColumns = db.prepare("SELECT name FROM pragma_table_info('memories_fts')").all().map((row) => row.name);
out.schema = {
  memoryColumns,
  ftsColumns,
  objects: db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger', 'table') ORDER BY type, name").all()
    .map((row) => `${row.type}:${row.name}`),
};
const extra = memoryColumns.includes("pinned") ? ", pinned, custom_keywords" : "";
out.memories = db.prepare(`SELECT id, client_id IS NOT NULL AS hasClientId, body, category, tags, captions, created_at, updated_at,
  archived_at, enriched_at IS NOT NULL AS enriched${extra} FROM memories ORDER BY id`).all();

const photoRoot = join(root, "photos");
out.photos = [];
for (const row of db.prepare("SELECT id, memory_id, file, thumb, caption, created_at FROM photos ORDER BY id").all()) {
  const files = {};
  for (const [kind, file] of [["full", row.file], ["thumb", row.thumb]]) {
    const path = resolve(photoRoot, file);
    if (!path.startsWith(photoRoot + sep)) throw Error(`Photo path escapes ${photoRoot}`);
    const bytes = await readFile(path);
    const stat = await lstat(path);
    files[kind] = { file, bytes: bytes.length, sha256: sha256(bytes), uid: stat.uid };
  }
  out.photos.push({ id: row.id, memoryId: row.memory_id, caption: row.caption, createdAt: row.created_at, ...files });
}
out.embeddings = db.prepare("SELECT memory_id, model, vector FROM embeddings ORDER BY memory_id").all()
  .map((row) => ({ memoryId: row.memory_id, model: row.model, vectorBytes: row.vector.length, vectorSha256: sha256(row.vector) }));
out.apiTokens = db.prepare("SELECT id, name, time_zone, created_at, last_used_at FROM api_tokens ORDER BY id").all();
out.settings = db.prepare("SELECT key, value FROM settings ORDER BY key").all();

// Keyword index lookups per indexed column, so text, tag, caption and custom-keyword matches are attributable.
out.fts = {};
for (const term of terms) {
  out.fts[term] = {};
  for (const column of ftsColumns) {
    out.fts[term][column] = db.prepare("SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rowid")
      .all(`${column} : ${JSON.stringify(term)}`).map((row) => row.id);
  }
}

// Digest of the data a v3 restore must reproduce (columns common to v3 and v4, photo bytes, vectors, token identities).
const common = out.memories.map(({ pinned, custom_keywords, ...rest }) => rest);
out.logicalV3Digest = sha256(JSON.stringify({ common, photos: out.photos.map(({ full, thumb, id, memoryId, caption }) =>
  ({ id, memoryId, caption, full: full.sha256, thumb: thumb.sha256 })), embeddings: out.embeddings, tokens: out.apiTokens.map(({ id, name, time_zone, created_at }) => ({ id, name, time_zone, created_at })), settings: out.settings }));
out.logicalFullDigest = sha256(JSON.stringify({ memories: out.memories, photos: out.photos.map(({ full, thumb, ...rest }) => ({ ...rest, full: full.sha256, thumb: thumb.sha256 })), embeddings: out.embeddings, apiTokens: out.apiTokens, settings: out.settings }));
db.close();
console.log(JSON.stringify(out, null, 2));
