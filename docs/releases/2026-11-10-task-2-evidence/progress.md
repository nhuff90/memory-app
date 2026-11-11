# Task 2 rehearsal progress and resume point

This is a working file for resuming after permission pauses. The dated record is `docs/releases/2026-11-10-task-2.md`. Each command runs alone, from the repository root. Steps 1–31 below describe loop execution. Later runtime work was performed by the parent coordinator under the explicit owner exception A-0022; its imported receipts live in `parent-runtime/`. The planned command blocks are historical procedure references, not instructions to rerun completed work. The current checkpoint below takes precedence.

Names used below:

- `V`: `recall-task2-20261110-6c4a91f2-data`
- `OLD`: `sha256:c40d1824f9c443d6c038fb0687be13faa8af2ba4b3479420e12176f358835371`
- `CAND`: `sha256:df68724179863a4f7e0a9637f5e8f05efbfa326e910d86c92fdabf7df8443aa6`
- `ENV`: `C:/Users/Nate/AppData/Local/Temp/recall-task2-20261110-6c4a91f2/runtime.env`
- `EV`: `C:/Users/Nate/repos/memory-app/docs/releases/2026-11-10-task-2-evidence`
- `RET`: `C:/Users/Nate/.codex/visualizations/2026/11/05/01a1ac1a-f315-7de0-a1ed-cb6517f1fc06/task2-20261110-6c4a91f2-retained`

The stamps `20261110-090000` (backup) and `20261110-090500` (restore) were fixed in advance as unique labels, so each Docker command can be approved exactly. They are not clock times.

## Done

1. `node docs/releases/2026-11-10-task-2-evidence/task2.mjs preflight`: passed (see `observations/01-preflight.json`).
2. `docker volume inspect recall-task2-20261110-6c4a91f2-data`: exit 1, `No such volume` (safe before creation).
3. `docker volume create recall-task2-20261110-6c4a91f2-data`: returned the volume name.
4. Seed `docker run` (old image, approved exact command): returned container ID `fc424117f754…`.
5. `task2.mjs seed`: passed at 2026-11-10T14:04:10Z. Four fictional notes (two with photos, one through the Siri key), one Siri key, meaning search found the heartworm note, the old worker controls the page with asset `/assets/index-DWaWk5OZ.js` (see `observations/02-seed.json`).
6. `docker stop recall-task2-20261110-6c4a91f2-seed` (approved exact command): returned the container name.
7. One-shot `fixture-enrich` `docker run --rm` (approved exact command, answer A-0006): printed the applied fixture. Memory 1 got tags `veterinary, monthly` (things); memory 2 got caption `A brass key hanging on a teal hook` and tag `storage` (things); memory 3 got tag `beverages` (people). No Anthropic request. The container removed itself.

Plan corrections after the owner's answer A-0005 (none of these commands had been attempted):

- `docker exec … ps -eo pid,user,args` is dropped. `probe.mjs` now lists every process from `/proc` and reports any app or Litestream writer; the document's backup helper checks for writers too.
- `docker inspect` on app containers is dropped, because it would print the fixture secrets from the environment. Startup timing uses `docker logs --timestamps` and the health poll in `task2.mjs`. The refusal container's numeric exit status comes from `docker wait recall-task2-20261110-6c4a91f2-refusal`.

## Planned, in order (the full commands are spelled out)

Seed v3 with the old image:

```
docker run -d --name recall-task2-20261110-6c4a91f2-seed --platform linux/amd64 --env-file C:/Users/Nate/AppData/Local/Temp/recall-task2-20261110-6c4a91f2/runtime.env -v recall-task2-20261110-6c4a91f2-data:/data -p 127.0.0.1:18766:8080 sha256:c40d1824f9c443d6c038fb0687be13faa8af2ba4b3479420e12176f358835371
node docs/releases/2026-11-10-task-2-evidence/task2.mjs seed
docker stop recall-task2-20261110-6c4a91f2-seed
docker run --rm --name recall-task2-20261110-6c4a91f2-enrich --platform linux/amd64 -u node -v recall-task2-20261110-6c4a91f2-data:/data -v C:/Users/Nate/repos/memory-app/docs/releases/2026-11-10-task-2-evidence:/task2:ro --entrypoint node sha256:c40d1824f9c443d6c038fb0687be13faa8af2ba4b3479420e12176f358835371 /task2/fixture-enrich.mjs
docker start recall-task2-20261110-6c4a91f2-seed
node docs/releases/2026-11-10-task-2-evidence/task2.mjs baseline
docker stop recall-task2-20261110-6c4a91f2-seed
```

Maintenance 1 and matched backup (no migration before the local verifier passes):

```
docker run -d --name recall-task2-20261110-6c4a91f2-maint1 --platform linux/amd64 -v recall-task2-20261110-6c4a91f2-data:/data -v C:/Users/Nate/repos/memory-app/docs/releases/2026-11-10-task-2-evidence:/task2:ro --entrypoint sleep sha256:c40d1824f9c443d6c038fb0687be13faa8af2ba4b3479420e12176f358835371 infinity
node docs/releases/2026-11-10-task-2-evidence/task2.mjs http-down maintenance-1
docker exec -u node recall-task2-20261110-6c4a91f2-maint1 node /task2/probe.mjs /data heartworm beverages teal Quillon
docker cp docs/releases/2026-11-10-task-2-evidence/extracted/recall-backup.mjs recall-task2-20261110-6c4a91f2-maint1:/tmp/recall-backup.mjs
docker exec recall-task2-20261110-6c4a91f2-maint1 node /tmp/recall-backup.mjs /tmp/recall-backup-20261110-090000
docker exec recall-task2-20261110-6c4a91f2-maint1 tar -C /tmp/recall-backup-20261110-090000 -czf /tmp/recall-backup-20261110-090000.tgz .
docker exec recall-task2-20261110-6c4a91f2-maint1 sha256sum /tmp/recall-backup-20261110-090000.tgz
docker cp recall-task2-20261110-6c4a91f2-maint1:/tmp/recall-backup-20261110-090000.tgz RET/recall-v3-20261110-090000.tgz
node docs/releases/2026-11-10-task-2-evidence/task2.mjs archive v3 <container sha256> RET/recall-v3-20261110-090000.tgz RET/verified
node docs/releases/2026-11-10-task-2-evidence/extracted/local-verify.mjs RET/verified
node docs/releases/2026-11-10-task-2-evidence/task2.mjs inspect v3-verified RET/verified
node docs/releases/2026-11-10-task-2-evidence/task2.mjs migrate-time RET/verified
docker exec -u node recall-task2-20261110-6c4a91f2-maint1 node /task2/probe.mjs /data heartworm beverages teal Quillon
docker rm -f recall-task2-20261110-6c4a91f2-maint1
```

Candidate on the same volume:

```
docker run -d --name recall-task2-20261110-6c4a91f2-cand --platform linux/amd64 --env-file C:/Users/Nate/AppData/Local/Temp/recall-task2-20261110-6c4a91f2/runtime.env -v recall-task2-20261110-6c4a91f2-data:/data -v C:/Users/Nate/repos/memory-app/docs/releases/2026-11-10-task-2-evidence:/task2:ro -p 127.0.0.1:18766:8080 sha256:df68724179863a4f7e0a9637f5e8f05efbfa326e910d86c92fdabf7df8443aa6
docker logs --timestamps recall-task2-20261110-6c4a91f2-cand
docker exec -u node recall-task2-20261110-6c4a91f2-cand node /task2/probe.mjs /data heartworm beverages teal Quillon
node docs/releases/2026-11-10-task-2-evidence/task2.mjs candidate
docker exec -u node recall-task2-20261110-6c4a91f2-cand node /task2/probe.mjs /data heartworm beverages teal Quillon
docker stop recall-task2-20261110-6c4a91f2-cand
docker logs --timestamps recall-task2-20261110-6c4a91f2-cand
```

Expected refusal of the old image on v4:

```
docker run --name recall-task2-20261110-6c4a91f2-refusal --platform linux/amd64 --env-file C:/Users/Nate/AppData/Local/Temp/recall-task2-20261110-6c4a91f2/runtime.env -v recall-task2-20261110-6c4a91f2-data:/data sha256:c40d1824f9c443d6c038fb0687be13faa8af2ba4b3479420e12176f358835371
docker wait recall-task2-20261110-6c4a91f2-refusal
docker logs --timestamps recall-task2-20261110-6c4a91f2-refusal
```

Maintenance 2, verify, quarantine and install:

```
docker run -d --name recall-task2-20261110-6c4a91f2-maint2 --platform linux/amd64 -v recall-task2-20261110-6c4a91f2-data:/data -v C:/Users/Nate/repos/memory-app/docs/releases/2026-11-10-task-2-evidence:/task2:ro --entrypoint sleep sha256:c40d1824f9c443d6c038fb0687be13faa8af2ba4b3479420e12176f358835371 infinity
node docs/releases/2026-11-10-task-2-evidence/task2.mjs http-down maintenance-2
docker exec -u node recall-task2-20261110-6c4a91f2-maint2 node /task2/probe.mjs /data heartworm beverages teal Quillon
docker cp docs/releases/2026-11-10-task-2-evidence/extracted/recall-backup.mjs recall-task2-20261110-6c4a91f2-maint2:/tmp/recall-backup.mjs
docker cp RET/recall-v3-20261110-090000.tgz recall-task2-20261110-6c4a91f2-maint2:/tmp/recall-restore-v3.tgz
docker exec recall-task2-20261110-6c4a91f2-maint2 sha256sum /tmp/recall-restore-v3.tgz
docker exec recall-task2-20261110-6c4a91f2-maint2 mkdir /data/restore-v3-20261110-090500
docker exec recall-task2-20261110-6c4a91f2-maint2 tar -xzf /tmp/recall-restore-v3.tgz -C /data/restore-v3-20261110-090500
docker exec recall-task2-20261110-6c4a91f2-maint2 node /tmp/recall-backup.mjs --verify /data/restore-v3-20261110-090500
docker exec recall-task2-20261110-6c4a91f2-maint2 sh /task2/quarantine-install.sh
docker cp recall-task2-20261110-6c4a91f2-maint2:/data/post-v4-20261110-090500 RET/quarantine-v4-20261110-090500
node docs/releases/2026-11-10-task-2-evidence/task2.mjs inspect quarantine-v4 RET/quarantine-v4-20261110-090500
docker exec -u node recall-task2-20261110-6c4a91f2-maint2 node /task2/probe.mjs /data heartworm beverages teal Quillon
docker rm -f recall-task2-20261110-6c4a91f2-maint2
```

Restored old image, then the cached candidate client:

```
docker run -d --name recall-task2-20261110-6c4a91f2-restored --platform linux/amd64 --env-file C:/Users/Nate/AppData/Local/Temp/recall-task2-20261110-6c4a91f2/runtime.env -v recall-task2-20261110-6c4a91f2-data:/data -v C:/Users/Nate/repos/memory-app/docs/releases/2026-11-10-task-2-evidence:/task2:ro -p 127.0.0.1:18766:8080 sha256:c40d1824f9c443d6c038fb0687be13faa8af2ba4b3479420e12176f358835371
node docs/releases/2026-11-10-task-2-evidence/task2.mjs restored
node docs/releases/2026-11-10-task-2-evidence/task2.mjs cached-client
docker exec -u node recall-task2-20261110-6c4a91f2-restored node /task2/probe.mjs /data heartworm beverages teal Quillon
docker logs --timestamps recall-task2-20261110-6c4a91f2-restored
```

Cleanup, only after the retained artifacts are checked:

```
docker rm -f recall-task2-20261110-6c4a91f2-restored recall-task2-20261110-6c4a91f2-refusal recall-task2-20261110-6c4a91f2-cand recall-task2-20261110-6c4a91f2-seed
docker volume rm recall-task2-20261110-6c4a91f2-data
node docs/releases/2026-11-10-task-2-evidence/task2.mjs cleanup-temp
docker ps -a --filter name=recall-task2-20261110-6c4a91f2
docker volume ls --filter name=recall-task2-20261110-6c4a91f2
```

`RET` stands for the retained root written out in full.

## Historical resource state before the parent continuation

- Volume `recall-task2-20261110-6c4a91f2-data`: restored matched v3 data; the parent-started `recall-task2-20261110-6c4a91f2-restored` old-image app is the sole running writer at the last observation (parent receipt 15).
- Seed, candidate and refusal containers: stopped. Both maintenance containers: removed. No cleanup of the remaining containers/volume has run.
- Temp root: still holds disposable auth/env, original/replay-1/replay-2 browser profiles and prepared scratch v4. Receipt 18 confirmed the original profile already serves old assets with no waiting worker. Preserve it; no storage clearing or silent rewarming. The latest A-0026 checkpoint below governs replay-3.
- Retained root: verified v3 archive/manifest/hash/extraction and matched quarantined v4 DB/WAL/SHM/photos plus inspect/hash manifest. Keep both outside Git and disposable resources.
- Fixture tags and caption are applied. Do not rerun the fixture or reseed.
- 8. `docker start recall-task2-20261110-6c4a91f2-seed` (approved, A-0007): returned the name. 9. `task2.mjs baseline`: passed at 2026-11-10T17:03:46Z (text `heartworm`, tag `beverages`, caption `teal` search; both photos rendered; see `observations/03-baseline.json`).
- 10. `docker stop recall-task2-20261110-6c4a91f2-seed` after the baseline: returned the name. 11. Maintenance-1 `docker run` (approved, A-0008): returned container ID `4430958696e3…`. Seed container is stopped; maint1 runs only `sleep infinity`, with no published port.
- 12. `task2.mjs http-down maintenance-1`: both origins ECONNREFUSED at 2026-11-10T22:00:46Z. 13. maint1 probe (approved, A-0009) at 22:01:29Z: processes were only `sleep infinity` and the probe, with no writers. `/data` held only `photos` and `recall.db`, with no WAL/SHM. v3, integrity ok, counts memories 4, photos 2, embeddings 4, api_tokens 1, settings 0, ai_usage 0. FTS hits: text heartworm→1, tag beverages→3, caption teal→2. logicalV3Digest `060e24fb…f30dd`.
- 14. The `docker cp` of the verbatim recall-backup.mjs (approved, A-0010) completed with no output. 15. The backup helper run (approved, A-0011) printed its manifest: version 3, at 2026-11-10T22:03:28.975Z, counts 4/2/4/1/0/0, and four photo file hashes that match the probe.
- 16. The tar run (approved, A-0012) completed with no output.
- 17. The in-container `sha256sum` (approved, A-0013) printed `d302184711d797d27c6164099e1642c93d1738129f5d05aa26e97160907d00aa  /tmp/recall-backup-20261110-090000.tgz`.
- 18. The `docker cp` out (approved, A-0014) completed with no output. 19. `task2.mjs archive v3 …`: local SHA256 matched the container's (`d3021847…07d00aa`, 14056 bytes). The archive was extracted to `RET/verified`, and `RET/recall-v3-20261110-090000.tgz.sha256.json` was written. The archive holds manifest.json, recall.db, a 0-byte recall.db-wal, a recall.db-shm, and 4 photo files. 20. The verbatim `local-verify.mjs RET/verified` printed "Verified downloaded v3 database, row counts and full/thumbnail photo hashes". 21. `task2.mjs migrate-time RET/verified`: migrate() alone took 5.68 ms on a scratch copy, going from version 3 to 4 with integrity ok.
- 22. `docker rm -f recall-task2-20261110-6c4a91f2-maint1` (approved, A-0015): returned the name. Maintenance 1 has ended; the volume is still v3 and unmigrated.
- 23. Candidate `docker run` (approved, A-0016): returned container ID `e276d453be35…`. 24. `task2.mjs candidate` passed (observation `05-candidate`, at 2026-11-11T13:01:09Z): the health poll started at 13:00:52.283Z and saw the first healthy response at 13:00:52.444Z (162 ms; the server was already healthy when polling began, so the startup boundary must come from the container's timestamped logs). The cached old client (`index-DWaWk5OZ.js`) showed the update banner with the new worker waiting; clicking Reload loaded `index-BI1X1ilU.js` (candidate sw sha256 `9174a5f7…c23f`). Text, tag and caption searches and both photos passed, and seed data and photo hashes are preserved. v4 changes: pinned heartworm and recital; custom keyword Quillon on shed (found by search). Siri key accepted (empty capture returned 400).
- 25. Candidate probe (approved, A-0017) at 13:02:05Z: the only processes were PID 1 `node dist/server/src/index.js` (the candidate writer) and the probe. `/data` held photos, recall.db, recall.db-shm and recall.db-wal (70072 bytes), all uid 1000. Version 4, integrity ok, counts 4/2/4/1/0/0. New columns pinned and custom_keywords, FTS columns body/tags/captions/custom_keywords, index memories_pinned_by_created present. pinned=1 on memories 1 and 4; custom_keywords "Quillon" on 2. FTS: heartworm→body 1, beverages→tags 3, teal→captions 2, Quillon→custom_keywords 2. Photo hashes equal the v3 baseline. logicalV3Digest `311b6a76…6994` differs from v3's `060e24fb…f30dd` only because updated_at changed on memories 1, 2 and 4 through the pin/keyword edits. 26. `task2.mjs inspect v3-verified RET/verified` (13:02:24Z) wrote `RET/v3-verified.inspect.json`: v3, integrity ok, and the four embedding vector hashes (`2ea99e52…`, `e4d19008…`, `402c7e29…`, `e232b76f…`) equal the v4 probe's, so the migration preserved the embeddings.
- 27. `docker stop recall-task2-20261110-6c4a91f2-cand` (approved, A-0018): returned the name. No container is running on the volume now; the volume is at v4 with the post-backup pin/keyword changes.
- 28. `docker logs --timestamps recall-task2-20261110-6c4a91f2-cand`: first line `13:00:51.781672Z Recall is listening on http://localhost:8080` (the server listens only after `migrate()` returns), then the no-API-key notice; no migration, FTS or other error lines; all API requests 200 except the intentional empty Siri capture (400); `13:03:27.358923Z SIGTERM received, shutting down.` Timing boundaries: listening (log) 13:00:51.782Z → first healthy HTTP response seen by the poll 13:00:52.444Z (the poll began at 13:00:52.283Z, so it was already healthy on the first try). The container's own start instant was not observed (no unredacted `docker inspect`, per A-0005), so a container-start-to-healthy figure is not claimed; `migrate()` alone measured 5.68 ms separately.
- 29. Refusal `docker run` (approved, A-0019, foreground, no port): the tool reported `Exit code 1` (the foreground `docker run` propagates the container's exit status) and the output `Error: The database is at version 4, but this app only knows 3 migrations. Update the app first.` thrown from `migrate` (`/app/dist/server/src/db.js:15`) via `openDb` and `index.js:25`, Node v22.23.4. This is the expected success of the version guard. The container `recall-task2-20261110-6c4a91f2-refusal` is now exited. `docker wait`/`docker logs` for it are optional confirmations and were not run (each needs a separate approval); the exit code above is the CLI-reported status of the run itself.
- (Host reboot between attempts 027 and 028; per A-0020 Docker came back healthy, seed/cand/refusal containers stayed stopped, nothing changed.) 30. Maintenance-2 `docker run` (approved, A-0020): container ID `160915e36378…`, sleep infinity, no port. 31. `task2.mjs http-down maintenance-2` at 2026-11-11T18:02:04Z: both origins ECONNREFUSED.
- 32. The maint2 probe DID complete in Claude attempt 029 at 18:02:40Z; its full digest equals step 25, `f303f7a8a2d34db7c8dd969f1336c7025f14d85e1401b59caef5213dd2eab96d`. Version 4, integrity ok, all six counts, photos, embeddings and logical data unchanged. A later redundant Codex probe was denied at Docker config access; do not retry Docker or any workaround in the restricted child (A-0022).

## Parent runtime continuation and next handoff

Owner answer A-0022 supersedes the original loop-only runtime restriction only for the parent coordinator. Sol remains responsible for helper/doc changes and importing sanitized evidence inside this loop. A-0023 authorizes only scoped repository/named evidence inspection after a separate unrelated-path discovery denial. No native permission changes or Codex retry authorizations exist.

Parent receipts 01–17, exact argv, timestamps, authoritative process exit codes and raw logs are preserved under `parent-runtime/`. All 17 log hashes were verified during import. The 21 pre-existing Task 2 files matched `parent-runtime/repository-evidence-baseline.json` before these helper/progress corrections. Six staged observation/screenshot files were imported without overwriting evidence; total import was 43 files including receipts/provenance.

- Receipts 02–10: resource-specific no-writer check and fresh HTTP-down check; copied faithful verifier and retained v3 archive back; SHA256 matches `d3021847…07d00aa`; staged `--verify` passed; guarded quarantine/install passed. No v4 sidecars beside restored v3; DB/photos uid 1000.
- Receipts 11–13: matched v4 quarantine retained outside Git; inspect confirms v4, integrity ok, counts 4/2/4/1/0/0 and original post-backup pin/keyword changes. Restored volume probe is v3, integrity ok, matching baseline photos/vectors/counts and logicalV3Digest `060e24fb876d0567a3426b7392ded1802e8c080e004bffa576bd90e24f7f30dd`.
- Receipts 14–16: maint2 removed; fixed old image started at the same localhost origin. Fresh-context restored-app login/search/photos/Siri-key/data comparison passed (exit 0). This separate fresh context blocked workers and is not the cached-client Reload proof.
- Receipt 02 also records the original candidate `StartedAt=2026-11-11T13:00:50.12500593Z`. Against the existing observed healthy timestamp `13:00:52.444Z`, startup-to-observed-healthy was approximately 2.319 seconds. The 162 ms late poll and 5.6809 ms host scratch migration are separate measurements.
- Receipt 17: original `cached-client` exited 1 waiting 120 seconds for the real banner. Pinned screenshot displays all four notes; opening memory left a blank screenshot. No `09-cached-client.json` was written by the failed original helper. No strict-schema PATCH failure or Reload recovery is claimed. The customKeywords `.join` crash remains a source-supported hypothesis until browser error evidence confirms it.

The revised helper preserves uniquely labeled screenshots, writes partial outcomes/errors/worker and asset identities before context close, stops if the original profile no longer serves candidate assets, and can open a fresh tab after a blank-root failure while keeping the crashed controlled tab open. That navigation is explicitly distinct from clicking the real banner's Reload. It never clears storage, rewarms a candidate, changes the server or mocks a response.

**Historical pending action (now resolved by receipt 18):** `node docs/releases/2026-11-10-task-2-evidence/task2.mjs cached-client 09-cached-client-resume-1` ran once in the parent and exited 1 with prerequisite_lost. See the checkpoint below; never rerun this label. The restricted child must not execute Docker/browser work.

## Sol checkpoint — A-0024 replay preparation, 2026-11-11

Imported the three staged recovery artifacts (observation/two screenshots), receipt 18/log, recovery-generated-manifest and retention-verification without overwriting any file. Checked artifact hashes and receipt log SHA256; all match. Rechecked all seven retained-v4 file hashes read-only; all match. Receipt 18 proves old assets are active in the original profile through the real worker, waiting=null. It does not prove Reload, a PATCH rejection, or the time of worker activation. Preserve both browser failures.

Prepared only the requested browser-only replay in `task2.mjs` and `runtime-handoff.md`. New modes: prepare-replay (guarded copy/inspection of scratch v4 only), replay-client (new profile, real candidate cache, controlled tab held open through parent server switch, actual banner action), verify-replay-retention (read-only custody hashes). Original cached-client mode keeps its original-profile guard and partial evidence. Unique labels/path collisions fail closed. No execution of these new modes, Docker, browser, migration, reseed, cleanup or production operations occurred here.

The handoff proposes exact scratch/container/profile names, direct parent commands, asynchronous browser receipt capture, success/failure conditions and conditional original-task cleanup. A-0024 asks the coordinator to decide whether this bounded replay fits the existing exception or needs a specific scope amendment. This is the next pending decision, not authorization inferred by the child. Application, Task 1 and plan remain unchanged; original old server state is known from the parent checkpoint, not a fresh child runtime check. Final replay evidence/cleanup/documentation/gates/independent acceptance remain outstanding.

Preparation checks in this attempt returned exit 0: helper syntax, faithful script extracts/plan hash/handoff helper hash, diff whitespace, typecheck, tests (13 files/144 tests), build. Typecheck/tests preceded the final wait-for-candidate-health helper adjustment; syntax/build followed it, with only documentation updates afterward. Helper SHA256 is recorded in the handoff. These do not establish runtime replay, cleanup or runner final-source gates. No Docker/browser operation ran in this child.

## Historical checkpoint — A-0025 corrected replay-2 handoff

The coordinator confirmed the browser replay and success-only original cleanup fit the already-authorized exception. Parent receipts 19–25 and 27–29 completed with actual exit 0. Scratch v4 was copied/verified once, and replay-cand-1 created once with the fixed candidate, `--pull=never`, scratch-only bind and localhost:18766. Do not recopy, reseed, migrate, or rerun prepare-replay. See imported receipt 25 for identity/mount proof and observation 10-browser-replay-prepared for matching data/photos/vectors.

The first replay did not reach login: it awaited service-worker readiness before authentication, but UpdateBanner/useRegisterSW mounts only after login. Parent record 26 captures Ctrl+C interruption of unified session 47352, session exit 1 and helper process exit null. No normal receipt/log 26, readiness/final observation or screenshot exists. No compatibility server switch occurred. This is an interrupted harness check, never a pass or an inferred child exit 1. Candidate log 27 confirms /api/me 401 and no login. Receipts 28/29 restored the safe state: replay-cand-1 stopped, restored old server running again; no owned replay Node/Chrome process survived.

Imported 26 files without overwrites: ten new normal receipt/log pairs, interruption/disposition/manifest/baseline, and two generated observations. All 72 pre-existing Task 2 files matched the parent baseline before edits; all ten log hashes and both generated artifact hashes matched. Original evidence remains unchanged. No Docker/browser/runtime operation was attempted in this child.

Helper now authenticates through the real UI before finite activated-registration/controller waits, records the post-login checkpoint, bounds cache/update/identity waits and persists partial warmup failures/screenshots before context close. Next label/profile are 10-browser-replay-2 / browser-profile-replay-2. New verify-replay-scratch mode inspects existing stopped scratch read-only and compares retained/data identities; it does not recreate any resource. Cleanup fails closed unless replay-2 passed, custody is recorded and current retained hashes/root validation succeed.

**Pending parent action:** follow runtime-handoff.md with its helper SHA256 and exact commands: safe identity/mount inventory, verify-replay-scratch, stop restored/prove HTTP down/start existing replay-cand-1, asynchronously launch replay-client, require post-login ready checkpoint, switch back to restored while controlled tab stays open, collect actual banner Reload proof, verify retention, then success-only original cleanup. Return staged sanitized outputs/receipts without overwriting earlier evidence. No new human Task2/runtime approval is requested. Full project gates are deferred until final-source verification after this evidence returns; syntax/focused static checks cover this helper correction. Final docs/gates/review remain pending.

## Historical checkpoint — A-0026 corrected replay-3 handoff

Imported 28 new files without overwrites: receipts/logs 30–39, replay2 launch metadata/manifest/diagnosis/baseline, and four generated observation/screenshot artifacts. All 98 pre-existing Task 2 evidence files matched the parent baseline before edits/import; all ten receipt log SHA256 values and four artifact hashes matched. Launch metadata has no output log and is not treated as a completed receipt. No Docker/browser action ran in this child.

Parent receipt 32 verified the existing scratch/retained identities, then receipts 33–36 stopped restored, proved HTTP down and started the same scratch-only replay-cand-1. Receipt 37 is a completed browser failure with actual exit 1 (distinct from interrupted replay-1). POST /api/login returned 200; authenticatedAt was 21:40:42.035Z. The async readiness predicate returned without polling: postLoginWorker was still installing with active/controller null, yet workerReadyAt was set at 21:40:42.090Z. The subsequent navigation preceded activation. The controller wait timed out after 60 seconds; the failure snapshot shows activated worker, fully cached candidate assets, but controller null. The observation and failure screenshot are preserved. No ready checkpoint, old-server compatibility switch or Reload proof occurred. The installed Playwright diagnosis is imported, so no library rescan is needed.

Receipts 38/39 returned exit 0 stopping replay-cand-1 and restarting restored old. This is the last observed runtime state, not a fresh child check. Preserve all original/replay-1/replay-2 profiles and the existing scratch; do not prepare/copy/reseed/remigrate. Parent must verify no owned Node/Chromium process survives before the next start.

Only the helper's readiness sequencing and replay identity changed: replay-3 uses a new profile/label, an explicit bounded host loop awaits registration snapshots until active.state is activated, then independently asserts postLoginWorker.workerStates.active before setting workerReadyAt and navigating. Each snapshot shares the 60-second deadline; failure paths still write partial evidence and a unique screenshot before context close. The synchronous controller predicate remains. Scratch verification uses the new label and cleanup requires replay-3 success plus recorded custody/current retained hashes/root validation. Application, tests/specs, rollout edits, Task 1 and plan remain unchanged.

**Pending parent continuation:** follow the updated runtime-handoff.md, helper SHA256 `67ffe1254262d4b86e4d5ca5d9290500ff294869889f1dbb51c3b83ffb84e4ae`. Require process absence, exact existing image/container/mount/data checks; launch replay-client asynchronously in new profile browser-profile-replay-3; require both activated snapshots and real controlled candidate readiness before switching to restored old; obtain actual compatibility/banner Reload evidence; then verify retention and perform success-only original cleanup. Preserve partial evidence/resources on failure. No new human Task 2/runtime approval is requested. Final browser proof, cleanup, final documentation, mandatory final-source gates and independent acceptance remain pending; this is a runtime handoff, not completion.

## Current checkpoint — A-0027 runtime complete, ready for review

The preceding pending instructions are historical and were completed by the parent; do not rerun them. Receipts 40–62 have actual exit 0 and their 23 log hashes were verified at import. All 126 pre-existing Task 2 files matched the supplied replay3 baseline before any finalization edits. Imported 68 new files without overwrites: 16 manifest-bound observations/screenshots, 23 receipt/log pairs and six completion/provenance/custody records. Parent runtime is distinct from native implementation checks; no Docker/browser operation or denied action was retried in this child.

Replay-3 reused the sole scratch v4 copy and existing replay-cand-1. Real UI login preceded activated registration snapshots; controlled candidate readiness was recorded at 21:52:19.700Z. The controlled tab stayed open across the actual old-server switch. Pinned returned all four notes. Opening oat memory crashed with undefined customKeywords.join before PATCH (no PATCH observed); do not claim strict-schema 400. A new tab retained the crashed tab and cached candidate, then real registration.update discovered a waiting old worker. Actual application Reload at 21:56:14.188Z activated old assets/UI; PATCH 200 saved the oat edit, four searches and both rendered photos/full-thumb hashes passed. Receipt 47 completed exit 0. Screenshots 05/07 were visually inspected in finalization. Earlier receipt 17/18/37 failures and interrupted 26 remain failures.

Receipts 51–54 verified retained hashes, final v3 integrity/counts/photos and exact owned resources; final memory-3 body/vector changed because the post-Reload edit succeeded. Pre-edit restore equality remains in receipt 13. Custody/process records preceded cleanup. Receipts 55–58 removed only the five exact task containers, named volume and validated temp root (including all profiles, scratch and secrets). 59/60 show task resources absent, 61 HTTP down, 62 all three Task 1 images retained. RET archive and seven v4 hashes still match after cleanup. No runtime resource remains to resume.

Finalization edits only the dated record, rollout guidance, progress/handoff, adds read-only evidence verification/inventory and scoped ignore exceptions for sanitized logs/screenshots. Application, tests/specs, Task 1, plan and prior runtime evidence remain preserved. Final local helper/evidence/whitespace and mandatory npm checks are captured by this implementation attempt; runner gates and independent acceptance remain separate canonical evidence. Stop at review handoff; no stage/commit/deploy/production or Task 3.
