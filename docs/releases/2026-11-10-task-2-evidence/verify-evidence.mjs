// Read-only final evidence/custody check. No Docker, browser, network or DB opens.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const parent = join(here, "parent-runtime");
const read = (p) => readFileSync(p, "utf8");
const json = (p) => JSON.parse(read(p));
const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const obs = (name) => json(join(here, "observations", `${name}.json`));
function contained(root, file) {
  const rel = relative(realpathSync(root), realpathSync(file));
  assert(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  assert(!lstatSync(file).isSymbolicLink());
}

assert.equal(digest(join(repo, ".cursor/plans/recall_release_path_904186b3.plan.md")),
  "400795a7f4865d9f6516c1a1dacaeb3eb6dd4d3f56d6527a58d5a4c31df8af88");
assert.equal(digest(join(here, "task2.mjs")),
  "67ffe1254262d4b86e4d5ca5d9290500ff294869889f1dbb51c3b83ffb84e4ae");
const baseline = json(join(parent, "replay3-repository-baseline.json"));
const edited = new Set(["progress.md", "runtime-handoff.md"]);
for (const file of baseline.files) {
  const path = resolve(file.path);
  contained(here, path);
  if (!edited.has(relative(here, path))) assert.equal(digest(path), file.sha256, path);
}

let receipts = 0;
for (const name of readdirSync(parent).filter((n) => /^\d\d-.*\.json$/.test(n))) {
  const receipt = json(join(parent, name));
  if (name.startsWith("26-")) {
    assert.equal(receipt.child_process_exit_code, null);
    assert.equal(receipt.unified_session_exit_code, 1);
    assert.equal(receipt.normal_receipt_present, false);
    continue;
  }
  assert.equal(receipt.exit_code, /^(17|18|37)-/.test(name) ? 1 : 0, name);
  const log = join(parent, basename(receipt.output_log));
  assert.equal(digest(log), receipt.output_sha256, name);
  receipts++;
}
assert.equal(receipts, 61);
let generated = 0;
for (const name of ["runtime-generated-manifest.json", "recovery-generated-manifest.json",
  "replay-generated-manifest.json", "replay2-generated-manifest.json", "replay3-generated-manifest.json"]) {
  for (const file of json(join(parent, name)).files) {
    const path = resolve(here, file.relative);
    contained(here, path);
    assert.equal(digest(path), file.sha256, file.relative);
    generated++;
  }
}

const rollout = read(join(repo, "docs/pinned-keywords-related-rollout.md")).replace(/\r\n/g, "\n");
const blocks = [...rollout.matchAll(/^@'\n([\s\S]*?)\n'@/gm)].map((m) => m[1] + "\n");
assert.equal(blocks.length, 2);
for (const [index, name] of ["recall-backup.mjs", "local-verify.mjs"].entries()) {
  assert.equal(read(join(here, "extracted", name)).replace(/\r\n/g, "\n"), blocks[index], name);
}
const quarantine = read(join(here, "quarantine-install.sh")).replace(/\r\n/g, "\n")
  .split("# ---- verbatim from the rollout document ----\n")[1]
  .split("# ---- end of verbatim block ----")[0];
assert(rollout.includes(quarantine.replaceAll("20261110-090500", "ACTUAL_TIMESTAMP")));

const ready = obs("10-browser-replay-3-ready");
assert.equal(ready.status, "ready_for_parent_server_switch");
assert.equal(ready.workerRegistration.active.state, "activated");
assert.equal(ready.postLoginWorker.workerStates.active, "activated");
assert.equal(ready.identity.workerStates.controller, "activated");
assert(Date.parse(ready.authenticatedAt) < Date.parse(ready.workerReadyAt));
assert(Date.parse(ready.workerReadyAt) < Date.parse(ready.readyAt));
const browser = obs("10-browser-replay-3");
assert.equal(browser.status, "passed");
assert.deepEqual(browser.viewport, { width: 390, height: 844 });
assert.deepEqual(browser.editBefore.patchRequestsObserved, []);
assert.equal(browser.editBefore.appRootChildren, 0);
assert(browser.log.pageErrors.includes("Cannot read properties of undefined (reading 'join')"));
assert.deepEqual(browser.pinnedBefore.returnedIds, [4, 3, 2, 1]);
assert.equal(browser.withBanner.workerStates.waiting, "installed");
assert.equal(browser.afterReloadIdentity.documentScript, "/assets/index-DWaWk5OZ.js");
assert.equal(browser.afterReloadIdentity.waiting, null);
assert.equal(browser.editAfterStatus, 200);
assert.equal(browser.photoHashesUnchanged, true);
assert.deepEqual(browser.oldSheetControls, { pinButtons: 0, keywordFields: 0, relatedSections: 0 });

const retained = obs("11-replay-retention").retained;
assert.equal(digest(retained.archive), retained.archiveSha256);
for (const file of retained.files) {
  const path = resolve(retained.source, file.path);
  contained(retained.source, path);
  assert.equal(digest(path), file.sha256, file.path);
}
assert.equal(retained.files.length, 7);
const cleanup = obs("12-cleanup-temp");
assert.equal(cleanup.exists, false);
assert.equal(existsSync(cleanup.removed), false);
assert.equal(obs("http-down-after-cleanup").unavailable, true);
assert.equal(json(join(parent, "runtime-completion.json")).status, "runtime_complete_and_staged");

const inventory = json(join(here, "file-inventory.json"));
for (const file of inventory.files) {
  const path = resolve(repo, file.path);
  contained(repo, path);
  assert.equal(readFileSync(path).length, file.bytes, file.path);
  assert.equal(digest(path), file.sha256, file.path);
}
function list(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    assert(!entry.isSymbolicLink());
    return entry.isDirectory() ? list(path) : [relative(repo, path).replaceAll("\\", "/")];
  });
}
const actual = list(here).filter((p) => !p.endsWith("/file-inventory.json")).sort();
const recorded = inventory.files.map((f) => f.path).filter((p) => p.startsWith("docs/releases/2026-11-10-task-2-evidence/")).sort();
assert.deepEqual(actual, recorded);
assert(!actual.some((p) => /\.(db|tgz|jpg|env)$|browser-profile|fixture-secrets/.test(p)));
console.log(JSON.stringify({ status: "verified", receipts, generatedArtifacts: generated,
  baselineFiles: baseline.files.length, retainedV4Files: retained.files.length,
  inventoryFiles: inventory.files.length, boundary: "read-only local evidence and retained-byte checks; no runtime replay" }));
