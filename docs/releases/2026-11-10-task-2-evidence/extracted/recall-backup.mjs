import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, sep } from "node:path";
const Database = createRequire("/app/package.json")("better-sqlite3");
for (const pid of (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry))) {
  const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch((error) => {
    if (error.code === "ENOENT" || error.code === "ESRCH") return "";
    throw error;
  });
  if (command.includes("dist/server/src/index.js") || command.includes("litestream")) {
    throw Error(`A database writer still exists: PID ${pid}`);
  }
}
if (process.argv[2] === "--verify") {
  const root = resolve(process.argv[3]);
  if (!root.startsWith("/data/restore-v3-")) throw Error("Unexpected restore path");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const db = new Database(join(root, "recall.db"), { readonly: true, fileMustExist: true });
  assert.equal(db.pragma("user_version", { simple: true }), 3);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  for (const table of ["memories", "photos", "embeddings", "api_tokens", "settings", "ai_usage"]) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, manifest.counts[table]);
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
  console.log("Verified staged v3 database and matched photos; no writers running");
  process.exit(0);
}
const stage = resolve(process.argv[2]);
if (!stage.startsWith("/tmp/recall-backup-")) throw Error("Unexpected backup path");
await mkdir(stage); // A pre-existing destination is an error; never reuse an older backup.
const db = new Database("/data/recall.db", { readonly: true, fileMustExist: true });
if (db.pragma("user_version", { simple: true }) !== 3) throw Error("Expected pre-migration version 3");
if (db.pragma("integrity_check", { simple: true }) !== "ok") throw Error("Integrity check failed");
await db.backup(join(stage, "recall.db"));
const photos = join(stage, "photos");
if (existsSync("/data/photos")) await cp("/data/photos", photos, { recursive: true, errorOnExist: true, force: false });
else await mkdir(photos);
const files = {};
for (const row of db.prepare("SELECT file, thumb FROM photos").all()) {
  for (const file of [row.file, row.thumb]) {
    const path = resolve(photos, file);
    if (!path.startsWith(photos + sep)) throw Error("Photo path escapes backup");
    files[file] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
}
const manifest = { version: 3, at: new Date().toISOString(),
  counts: Object.fromEntries(["memories", "photos", "embeddings", "api_tokens", "settings", "ai_usage"].map(
    (table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n])), files };
db.close();
const copy = new Database(join(stage, "recall.db"), { readonly: true, fileMustExist: true });
if (copy.pragma("integrity_check", { simple: true }) !== "ok") throw Error("Backup integrity check failed");
copy.close();
await writeFile(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
