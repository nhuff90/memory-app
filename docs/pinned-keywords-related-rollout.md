# Pinned memories, custom keywords and related memories

Implementation and local validation only. **No production commands in this document were executed.** Deployment is a separate owner-authorized follow-up. Commands below are for that follow-up, from PowerShell in this repository, except code explicitly uploaded to the Linux Machine. Keep the app unavailable during maintenance; warn users that capture/Siri will fail and that offline queued captures may sync when service returns.

The configured app is `mem-recall-app`, region `iad`, one Machine, volume `recall_data` mounted at `/data`, database `/data/recall.db`, photos `/data/photos`. `scripts/start.sh` optionally runs Litestream; its replica covers the database, **not photos**. Daily snapshots or an older export do not replace the fresh matched backup below. Migration 004 adds unpinned/empty-keyword defaults and rebuilds FTS. It runs transactionally at startup before HTTP listening. It preserves embeddings; keywords remain outside their input.

Before maintenance, finish and verify saved edits, or copy unsaved text/keywords and retain original photos outside the app. Reload can discard an in-memory draft; do not rely on a discard prompt from the update banner. Check each device's queued/rejected captures and preserve their contents before any client transition. Rejected captures remain for user action; transient failures may retry automatically when service returns. After upgrade or rollback, sign in if needed and reconcile queued captures with the server before resubmitting, checking each arrived once. A capture acknowledged after the backup can be lost on rollback even if it has left the device's queue. Do not clear site storage or discard a rejected item until its contents are recovered.

## Feature follow-up: keyword pills and reuse — November 18, 2026

**Proposed scope, not implemented or validated by this update.** The sections from “Local release checks” onward retain the original migration 004 rollout procedure and its historical evidence; they are not a release procedure or test results for keyword pills. The current checkout contains pinning, editable custom keywords and related-memory navigation. It does not establish that these features are deployed. The latest [Task3E diagnosis](releases/2026-11-16-task-3-ssh-diagnosis.md) leaves current production state and rollout readiness unknown. Recheck the actual baseline before any future rollout; do not assume production still has schema v3 or that an older backup is suitable.

### Product goal and first release

Make a recall easy to label with the user's own vocabulary, then easy to find through those labels. Keep labeling optional so a quick text or photo capture remains quick. Build on `customKeywords`; pinning remains a separate way to mark an individual recall as important.

The first release includes reusable keyword pills during capture and editing, suggestions from existing custom keywords, and exact keyword browsing. Example: “Christmas lights are in the blue bin” can carry `Christmas` and `Garage`. Tapping `Garage` on a saved recall opens recalls explicitly labeled `Garage`, with the selected filter visible and removable.

### Carry forward the existing behavior

- Preserve the shared [keyword rules](../shared/keywords.ts): trim whitespace, ignore empty values, split comma-separated pasted values, deduplicate case-insensitively, and allow at most ten keywords of forty characters each. Preserve display spelling; case variants represent the same keyword for suggestions and filtering.
- Keep custom keywords separate from automatic tags and broad categories. Accepting a suggestion is an explicit user action; no keyword is silently attached. Automatic tags remain separate search metadata.
- Preserve explicit Save/Cancel in the editor. Adding or removing a pill changes the draft until Save. Pin/unpin remains independent and must neither save nor erase unsaved body or keyword changes. Close, Related and keyword navigation all require discard protection, including unfinished text in the keyword input.
- Keep keywords searchable immediately after saving and separate from embedding input. Keyword-only edits must not invoke AI enrichment or regenerate embeddings. Preserve the existing Ask distinction between user-provided search metadata and factual recall content.
- Keep readable `customKeywords`, automatic tags and pin state distinct in JSON/Markdown exports. Outdated recalls retain their keywords for restoration and export.
- Preserve Related memories and its same-sheet loading, empty, retryable-error and late-response handling. Exact keyword browsing is an additional navigation path, not a replacement for Related.

### Pill entry and suggestions

Use the same control in Remember and the recall editor: removable pills, a text input, matching existing keywords, and an explicit way to create a new keyword. Enter accepts a selection or creates the typed keyword; it must not accidentally submit the recall form. Save commits valid unfinished input before saving. Invalid input stays visible with an explanation and blocks the save without partially changing the recall. Support keyboard navigation, labeled remove buttons and touch targets suitable for a phone.

Show at most five suggestions, excluding keywords already selected. When typing, text matches take priority. With an empty input, reserve up to two slots for recently assigned keywords and fill the remaining slots with frequently used keywords; fill unused recent slots from frequency. Use a stable alphabetical tie-break so suggestions do not move unpredictably.

Frequency means the number of active saved recalls carrying the normalized keyword, counted once per recall. Suggestion clicks, repeated saves and upload retries do not increase it. Exclude keywords found only on outdated recalls from default suggestions; restoring a recall makes its assignments eligible again. An existing pill on the recall being edited remains visible even if it is absent from suggestions.

Recency means the last successful new assignment of a keyword, whether during capture or editing. A body edit or pin/unpin must not make its keywords “recent.” Persist that assignment metadata with the successful save; existing keywords use frequency until genuine assignment recency is available. Pending offline captures do not affect server usage counts until accepted. Share the same normalized identity between counts, recency and filtering, without silently merging distinct words or synonyms.

Suggestions are optional assistance. If loading fails or the device is offline, typing and saving still work; a cached vocabulary may supply suggestions. A failure must not clear selected pills or block capture. Context-based/AI suggestions and global rename/merge are later additions after observing real usage.

### Exact keyword browsing

Add a dedicated keyword filter rather than placing the keyword in the free-text search box. Match the whole normalized custom keyword: `Home` must not match `Homework`, a body-only mention of “home,” or an automatic tag alone.

For the first release, allow one active keyword filter. It intersects with the existing category or Pinned selection, search text, photo mode and outdated visibility; the existing category/Pinned exclusivity remains unchanged. Clearing the keyword preserves those other selections. Changing any filter resets pagination, and exact filtering must happen before candidate limits and pagination in both lexical and semantic retrieval. Hide outdated recalls by default and respect “Show outdated.”

Show the selected keyword and a clear empty state even when there are no matches. Explicitly label the action “Ask all memories” while a keyword filter is active, extending the existing Pinned-view wording; do not imply that Ask is scoped to the keyword view without separately implementing that behavior. Related remains its existing similarity view and must not be presented as an exact keyword result set.

### Capture, persistence and compatibility

Carry `customKeywords` through the entire capture path: draft persistence, queued/rejected item display and editing, outbox storage, the client API, JSON and multipart create requests, validation, database insert and response. Save body/photos/keywords together; do not create the recall and attach keywords in a second PATCH. Preserve the stable `clientId` retry contract so an interrupted upload cannot create a duplicate recall or double-count keyword usage.

Old drafts, queued items and older clients without the field continue to mean an empty keyword list. Restoring or editing a queued item must retain its selected keywords. Clearing a successful capture must not erase anything the user typed or selected for the next recall while that save was in flight. On validation or upload failure, retain the draft or queued item for correction.

The existing create endpoint ignores unknown fields. Consequently, a new client talking to an old server can receive success while its keywords are discarded. Add an explicit server capability check for keyword capture and verify the normalized returned saved keywords before clearing a keyword-bearing outbox item. If support is absent or persistence cannot be confirmed, retain the local content in a held “needs reconciliation” state, excluded from automatic retries. Do not report complete success or blindly create another recall. Provide an authenticated recovery flow that reconciles the original `clientId` with any already-created server record and lets the user recover missing keywords without overwriting later edits; repeating create alone cannot repair that record. Missing keyword fields in older responses must not crash the UI.

Do not rewrite migration 004. If assignment metadata or a keyword index requires a schema change, add a new forward migration and specify the resulting upgrade/rollback path separately. Preserve existing labels, FTS behavior, embeddings and export fidelity. An older binary's database-version guard still applies; the original v3 restore commands below must not be reused as a generic rollback for this follow-up.

### Acceptance and release evidence to add

Extend the existing focused tests and disposable browser rehearsal, using fake providers and no live AI calls:

1. Create text-only and photo recalls with pills; reopen and export them. Cover old clients/queued items without keywords, shared limits, comma paste, case deduplication, unfinished input and invalid saves with no partial updates.
2. Verify editor Save/Cancel, removal, dirty pin/unpin, discard protection on close/Related/keyword navigation, and continued typing during an in-flight capture. Include keyboard operation and phone-sized layouts.
3. Verify suggestion ranking, deterministic ties, exclusion of selected/outdated-only keywords, count changes after removal/archive/restore/delete, and no count/recency changes on pinning, unrelated edits or retry. Suggestion failures must leave manual entry usable.
4. Verify exact filtering, clear/reset behavior, combined filters, pagination and both search paths. Include a keyword-only match, body-only and automatic-tag-only nonmatches, and similar spellings. Confirm Ask remains accurately labeled and Related navigation still works.
5. Capture offline, reload, edit a rejected item and retry after reconnecting. Verify body/photos/keywords arrive together exactly once. Exercise an old queued record and an interrupted upload whose first request reached the server.
6. Exercise actual service-worker activation and mixed old/new client/server responses. A successful HTTP response with missing keyword persistence must retain recoverable local data in a held state without automatic retry loops. Verify reconciliation recovers missing keywords without duplicating the recall or overwriting later edits. Verify the UI survives old response shapes and that no recovery step clears site storage to hide a failure.

Run the repository typecheck, test and build checks after implementation, then the updated browser rehearsal. Historical results below cover only their original scope. Record fresh results against the candidate revision; Chromium mobile emulation does not establish physical iPhone/Safari behavior. Reuse the matched database/photo backup, draft preservation and client-recovery principles from the original rollout, with new commands and schema expectations reviewed for the actual release baseline.

### Delivery order and deferred ideas

Implement capture/edit pills and persistence first, add reuse suggestions, then exact keyword browsing; all three form the first feature release. Validate the complete flow before release. Keyword cleanup/merge and content-based suggestions can follow if usage justifies them. Keyword-filtered people practice is a useful later extension of the existing practice feature.

One-off reminders and linked updates/history remain separate proposed features. They should not expand this keyword release or inherit its acceptance evidence.

## Local release checks

Dependencies already exist. Do not install anything for these checks. Leave `RECALL_LIVE_AI` unset/empty.

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
node scripts/verify-memory-features.mjs --playwright C:/Users/Nate/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs --browser C:/Users/Nate/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe
```

The browser command serves built assets and the real API against a unique disposable SQLite database under ignored `screenshots/`, with deterministic fake providers and no `.env` loading. It asserts save/cancel, both keyword limits, dirty pin/unpin, keyword addition/removal, Pinned search/outdated/category exclusivity, collection-wide Ask labeling, discard protection, same-sheet related navigation, loading/empty/retryable error, late-response isolation and recovered navigation. It prints observations and writes `memory-features-{pinned-search,related-navigation,related-loading,related-empty,related-error}.png`. This is Chromium mobile/touch emulation at 390×844, not physical iPhone/Safari proof.

## Record the release and enter maintenance

The following uses the Fly Machines API to replace the process with `sleep infinity` and remove public services during maintenance. This stops **both** the app and Litestream, prevents proxy autostart from reopening an old writable app during backup/restore, and leaves SSH available. It avoids relying on a stopped Machine staying stopped when `auto_start_machines = true`. Save the full original Machine configuration before changing anything. Do not scale, clone, or attach a second writer to the SQLite volume.

```powershell
$app = 'mem-recall-app'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path (Get-Location) "screenshots/rollout-$stamp"
New-Item -ItemType Directory -Path $backupDir
fly machine list --app $app
fly volumes list --app $app
```

Confirm exactly one application Machine in `iad` and its `recall_data` volume at `/data`. Substitute its actual ID, then record its current config and immutable image reference. Keep this directory outside any disposable browser-fixture directory; copy it to an independent secure backup location before rollout.

```powershell
$machine = '<actual-machine-id>'
$headers = @{ Authorization = "Bearer $(fly auth token)" }
$machineApi = "https://api.machines.dev/v1/apps/$app/machines/$machine"
$before = Invoke-RestMethod -Uri $machineApi -Headers $headers
$before | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $backupDir 'machine-before.json')
$oldImage = "$($before.image_ref.registry)/$($before.image_ref.repository)@$($before.image_ref.digest)"
$oldImage
$before.config.mounts
```

Stop if the resolved image reference lacks a `sha256:` digest, the volume/path differs, or another writer exists. Record the volume ID and old image digest with the backup. Build/push the candidate **without releasing it** and record the immutable image reference from its output:

```powershell
fly deploy --app $app --build-only --push --ha=false --image-label pinned-keywords-related-v4
$newImage = '<candidate registry.fly.io/mem-recall-app@sha256:... from build output>'
```

Define the update helper. Each POST replaces the complete config with the saved clone plus the stated changes; never manufacture mounts/secrets/services from scratch. These variables and the saved JSON must remain available throughout the window.

```powershell
function Set-RecallMachineConfig($config) {
  $body = @{ config = $config } | ConvertTo-Json -Depth 100 -Compress
  Invoke-RestMethod -Method Post -Uri $machineApi -Headers $headers -ContentType 'application/json' -Body $body
}
$original = $before.config | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
$maintenance = $before.config | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
$maintenance.init = @{ exec = @('sleep', 'infinity') }
$maintenance.services = @()
$maintenance.checks = @{}
$maintenance.restart = @{ policy = 'always' }
Set-RecallMachineConfig $maintenance
fly machine status $machine --app $app
fly ssh console --app $app --machine $machine -C 'df -h /data /tmp'
```

Wait until this exact Machine is started with `sleep infinity` and services empty. The helper below also refuses backup/restore verification if a Node app or Litestream process remains. Do not proceed if shutdown has not completed. Public requests must fail during maintenance; leave this configuration in place until backup verification finishes. Ensure `/tmp` has room for the SQLite copy, all photos, and the archive. If a command fails, remain in maintenance and investigate; do not migrate without a verified backup.

## Take and verify a fresh matched backup

Create this helper locally and upload it to the maintenance Machine. It uses SQLite's backup API rather than copying a live `.db` file, and copies photos while all writers are stopped. It checks database integrity, version, row counts and every referenced full/thumbnail file. It never imports application `openDb` (which would migrate).

```powershell
$backupScript = Join-Path $backupDir 'recall-backup.mjs'
@'
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
'@ | Set-Content -Encoding utf8 -LiteralPath $backupScript
fly ssh sftp put --app $app --machine $machine $backupScript /tmp/recall-backup.mjs
$remoteStage = "/tmp/recall-backup-$stamp"
$remoteArchive = "$remoteStage.tgz"
fly ssh console --app $app --machine $machine -C "node /tmp/recall-backup.mjs $remoteStage"
fly ssh console --app $app --machine $machine -C "tar -C $remoteStage -czf $remoteArchive ."
fly ssh console --app $app --machine $machine -C "sha256sum $remoteArchive"
$archive = Join-Path $backupDir "recall-v3-$stamp.tgz"
fly ssh sftp get --app $app --machine $machine $remoteArchive $archive
Get-FileHash -Algorithm SHA256 -LiteralPath $archive
$verified = Join-Path $backupDir 'verified'
New-Item -ItemType Directory -Path $verified
tar -xzf $archive -C $verified
```

The local and remote archive SHA-256 values must match. Verify the downloaded copy from the repo root using the existing local SQLite dependency:

```powershell
@'
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
'@ | node --input-type=module - $verified
```

Keep the fresh archive, manifest, hashes, original Machine configuration and immutable old image digest together in an independent secure location. The backup includes personal data and token/session records; do not commit it. Leave the Machine in maintenance until these checks succeed. An optional additional volume snapshot can be created now (`fly volumes snapshots create <actual-volume-id> --app $app`), but it does not replace this verified archive.

## Apply the candidate and verify

Use the saved original process/services/mount configuration with only its image replaced. Startup opens the existing `/data/recall.db`, applies migration 004, then starts listening on 8080. No old application process overlaps this migration. Restoring services in the same update allows requests only when the new server has finished migration and listens.

```powershell
$candidate = $before.config | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
$candidate.image = $newImage
Set-RecallMachineConfig $candidate
fly machine status $machine --app $app
fly logs --app $app --no-tail
Invoke-RestMethod -Uri 'https://mem-recall-app.fly.dev/api/health'
fly ssh console --app $app --machine $machine -C 'node --input-type=module -e "import Database from \"better-sqlite3\"; const db = new Database(\"/data/recall.db\", {readonly:true}); console.log({version:db.pragma(\"user_version\",{simple:true}), integrity:db.pragma(\"integrity_check\",{simple:true}), counts:db.prepare(\"SELECT (SELECT count(*) FROM memories) AS memories, (SELECT count(*) FROM photos) AS photos\").get()}); db.close();"'
```

Require healthy HTTP, `user_version = 4`, integrity `ok`, unchanged memory/photo counts compared with the manifest (unless users have already resumed capture), and no migration/FTS errors in logs. Verify Litestream resumes if configured. Do not delete the backup after a successful smoke test.

On every open client after upgrade, protect drafts and reconcile captures as above, then use **Reload** in the real “A new version of Recall is ready.” banner before testing the new controls. Confirm the candidate assets/UI are active. The local rehearsal exercised this old-client-to-candidate transition with the real service worker; a normal page reload alone does not establish that the waiting worker activated. Log in normally; check existing body/tag/caption search and photos, pin/unpin across a second session, Pinned text search/outdated handling, keyword save/remove, export metadata, and related navigation. Avoid invoking Ask or enrichment merely as a smoke test: the local fake-provider tests cover their integration.

This bounded procedure uses a direct Machine configuration/image update rather than claiming a Fly release record was created. Record the running image digest and the completed checks. A subsequent conventional `fly deploy` must use the same reviewed source/image and the repository's `fly.toml`/default entrypoint, never the temporary maintenance process.

## Rollback: restore the matched v3 data and old image

**An image-only rollback will fail.** `server/src/db.ts` rejects a database whose `user_version` exceeds the application's migration registry. The old image knows migrations 001–003 and cannot reopen version 4. Do not lower `PRAGMA user_version`, edit migration history, or point the old image at the upgraded database. Restoring v3 loses all changes since the backup, including captures, pin/keyword edits, deletes, photo changes and token changes. Obtain an owner decision about that data loss; retain a separate matched v4 backup first if any writes occurred after rollout.

Return the same Machine to maintenance **before restoring anything**, using the helper above. Confirm no app/Litestream writer remains. Upload the verified v3 archive, compare SHA-256 again, and extract into a unique staging directory; do not extract over the mounted live files.

```powershell
Set-RecallMachineConfig $maintenance
fly machine status $machine --app $app
fly ssh sftp put --app $app --machine $machine $backupScript /tmp/recall-backup.mjs
fly ssh sftp put --app $app --machine $machine $archive /tmp/recall-restore-v3.tgz
fly ssh console --app $app --machine $machine -C 'sha256sum /tmp/recall-restore-v3.tgz'
$restoreStage = "/data/restore-v3-$stamp"
fly ssh console --app $app --machine $machine -C "mkdir $restoreStage"
fly ssh console --app $app --machine $machine -C "tar -xzf /tmp/recall-restore-v3.tgz -C $restoreStage"
fly ssh console --app $app --machine $machine -C "node /tmp/recall-backup.mjs --verify $restoreStage"
```

Compare the archive hash with the verified local value. The `--verify` command must succeed before the following moves: it checks the staged DB read-only (`integrity_check = ok`, `user_version = 3`, counts matching the manifest), every referenced photo hash, and absence of app/Litestream writers. Check enough volume space before extracting; if space is insufficient, stop and arrange adequate restore space rather than deleting the only v4 data copy.

The following Linux block runs only on the confirmed maintenance Machine. It preserves the v4 database, WAL/SHM and photos in quarantine, then installs the matched v3 set. Substitute the same actual timestamp in each path and run it through `fly ssh console` or its interactive shell:

```sh
set -eu
stage=/data/restore-v3-ACTUAL_TIMESTAMP
quarantine=/data/post-v4-ACTUAL_TIMESTAMP
test -f "$stage/recall.db"
test -d "$stage/photos"
mkdir "$quarantine"
for name in recall.db recall.db-wal recall.db-shm photos; do
  if [ -e "/data/$name" ]; then mv "/data/$name" "$quarantine/$name"; fi
done
mv "$stage/recall.db" /data/recall.db
mv "$stage/photos" /data/photos
chown -R node:node /data/recall.db /data/photos
```

No v4 WAL/SHM may remain beside the restored v3 file. Only after the matched database/photos are installed, restore the original config and immutable old image together:

```powershell
$rollback = $before.config | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
$rollback.image = $oldImage
Set-RecallMachineConfig $rollback
fly machine status $machine --app $app
fly logs --app $app --no-tail
Invoke-RestMethod -Uri 'https://mem-recall-app.fly.dev/api/health'
```

Verify version 3, integrity, original counts, login, existing text/tag/caption search and photos. `scripts/start.sh` must see the restored database already present, so Litestream's `-if-db-not-exists` cannot substitute a newer replica. Retain the fresh v3 archive and quarantined v4 files until the owner confirms recovery. Reconcile the off-site replica's history before relying on it for future restores; never silently restore a v4 replica into the old image.

After rollback, protect drafts/captures and use the real update banner's **Reload** on each cached candidate client before editing. Confirm old assets/UI are active, candidate-only pin/keyword/related controls are absent, and edits, existing search and photos work. The local Chromium rehearsal confirmed that the old API ignores the cached candidate's Pinned filter and returns all notes. Opening a memory then crashes the candidate UI because the old response omits `customKeywords` (`Cannot read properties of undefined (reading 'join')`). No PATCH was sent before that crash; the source-predicted strict-schema PATCH rejection was not observed.

If the app is blank, preserve any draft already copied out and open another tab at the same origin to recover the UI; the crashed root cannot display the banner. This navigation itself is separate from the required **Reload** action. In the successful browser-only replay, the new tab still used cached candidate assets; a real service-worker update check discovered the restored old worker, the banner appeared, and clicking **Reload** activated old assets. Edits, text/tag/caption search and photos then worked, with no candidate-only controls. If old assets have already activated, record and verify that state explicitly. Do not clear storage to hide a transition failure. See the [dated Task 2 record](releases/2026-11-10-task-2.md) for the successful proof and preserved failed harness attempts; server health alone does not establish client recovery.

Task 2 uses local Docker maintenance (`sleep infinity` on the same volume), `docker exec` for remote commands, and `docker cp` for transfers. It does not validate Fly Machines configuration/API behavior, Litestream replication, or physical iPhone/Safari behavior. Those checks remain future owner-authorized work.
