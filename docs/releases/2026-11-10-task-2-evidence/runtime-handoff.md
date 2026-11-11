# Task 2 runtime handoff — completed replay-3 procedure

**Completed by the parent coordinator, delivered in A-0027; do not execute this historical procedure again.** Receipts 40–62 and their log hashes were imported and verified, including actual browser exit 0 in receipt 47. Real banner Reload recovered the old client after the confirmed pre-PATCH crash; retention and scoped cleanup succeeded. Task containers/volume/temp are gone, retained v3/v4 recovery sets and Task 1 images remain. Final local checks and independent runner review are the only remaining handoff; see the dated record and current progress checkpoint. No Docker/browser runtime ran in the restricted child.

The following preserves the exact approved work order and its helper hash as execution context. A-0025 confirmed the bounded browser replay and success-only original cleanup fit Task 2 and the parent-runtime exception. Native denials remained in force and were not retried.

## Checkpoint and fixed resources

Parent receipts 19–25 and 27–29 have actual exit 0. Receipt 21 prepared and verified scratch v4 once; 24 created the scratch-only candidate with `--pull=never`; 25 verifies image/mount/binding. **26-browser-replay-interrupted.json is an intervention record, not a completed helper receipt:** Ctrl+C stopped an unbounded pre-login worker wait. Helper exit code is null; unified session exit is 1. No ready/final observation, screenshot or server switch occurred. There is no normal receipt 26 or log.

Replay-2 then logged in successfully, but receipt 37 records actual exit 1 after a 60-second controller timeout. Its `postLoginWorker` still had installing sw.js and no active/controller, despite `workerReadyAt` being set: the async `waitForFunction` predicate resolved false without polling. At failure the worker was activated and candidate assets cached, but the tab was uncontrolled. No ready checkpoint or compatibility server switch occurred. Preserve observation `10-browser-replay-2.json`, its failure screenshot and `parent-runtime/replay2-readiness-diagnosis.json`; launch metadata is not a completed receipt.

Receipts 38/39 stopped replay-cand-1 and restarted restored old on localhost:18766, both exit 0. Verify no owned replay browser/Node process remains before starting again. Preserve original/replay-1/replay-2 profiles and failed evidence until successful proof and evidence custody. Never rerun `prepare-replay`, recopy, reseed or remigrate. A-0026 authorizes only this narrow readiness correction and replay-3 continuation within the existing exception.

All commands below run individually and directly from `C:/Users/Nate/repos/memory-app` through the parent's receipt harness: exact argv/cwd/timestamps, actual process exit code and complete output hashes. Never print authenticated-container environment values. Browser origin remains **http://localhost:18766**.

| Resource | Exact identity |
| --- | --- |
| Helper | `docs/releases/2026-11-10-task-2-evidence/task2.mjs` |
| Helper SHA256 | `67ffe1254262d4b86e4d5ca5d9290500ff294869889f1dbb51c3b83ffb84e4ae` |
| Reuse stopped container | `recall-task2-20261110-6c4a91f2-replay-cand-1` |
| Recorded container ID | `57da8f08a8bfc134302ddb7565ce2e0d9d47826e1ad00503acc6720d2ab3b29e` |
| Fixed candidate | `sha256:df68724179863a4f7e0a9637f5e8f05efbfa326e910d86c92fdabf7df8443aa6` |
| Reuse scratch bind | `C:/Users/Nate/AppData/Local/Temp/recall-task2-20261110-6c4a91f2/browser-replay-v4-1` |
| New profile only | `C:/Users/Nate/AppData/Local/Temp/recall-task2-20261110-6c4a91f2/browser-profile-replay-3` |
| New evidence label | `10-browser-replay-3` |
| Restored old container / volume | `recall-task2-20261110-6c4a91f2-restored` / `recall-task2-20261110-6c4a91f2-data` |
| Fixed old image | `sha256:c40d1824f9c443d6c038fb0687be13faa8af2ba4b3479420e12176f358835371` |

RET is `C:/Users/Nate/.codex/visualizations/2026/11/05/01a1ac1a-f315-7de0-a1ed-cb6517f1fc06/task2-20261110-6c4a91f2-retained`. Never mount RET or the original restored v3 volume in the candidate. Keep both recovery sets, application 842459e, images and existing env/HF block unchanged. Runtime AI/bucket credentials remain absent; RECALL_LIVE_AI stays empty.

## 1. Verify reuse before stopping the restored old server

Verify the helper hash above, then inspect safe fields and run the new scratch verifier once:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'recall-task2-20261110-6c4a91f2|2026-11-10-task-2-evidence[\\/]task2\.mjs' } | Select-Object ProcessId, Name
docker ps -a --filter name=recall-task2-20261110-6c4a91f2 --format "{{.Names}} {{.Status}} {{.Ports}}"
docker inspect --format "{{.Id}} {{.Image}} {{.State.Status}} {{json .Mounts}} {{json .HostConfig.PortBindings}}" recall-task2-20261110-6c4a91f2-replay-cand-1
docker inspect --format "{{.Image}} {{json .Mounts}} {{json .HostConfig.PortBindings}}" recall-task2-20261110-6c4a91f2-restored
node docs/releases/2026-11-10-task-2-evidence/task2.mjs verify-replay-scratch
```

Require the process inventory to return no task-owned Node/Chromium rows; only PID/name are printed, never command lines or secrets. Stop if any survive. Require recorded candidate ID/image stopped, only existing scratch bind at `/data`, only 127.0.0.1:18766 published. Restored must be the fixed old image on the original named volume, sole running app; seed/cand/refusal stopped, maintenance absent. The verifier validates resolved paths/no links, inspects scratch read-only, compares v4/integrity/counts/memories/photos/vectors to retained inspection, rechecks seven retained-v4 hashes and v3 archive SHA256, and requires new profile absent. Require exit 0 and `observations/10-browser-replay-3-reuse.json`, `status=verified_for_reuse`. Stop on mismatch/collision. No copy/migration/browser/server action occurs.

## 2. Reuse candidate on existing scratch

```powershell
docker stop recall-task2-20261110-6c4a91f2-restored
node docs/releases/2026-11-10-task-2-evidence/task2.mjs http-down browser-replay-3-switch-1
docker start recall-task2-20261110-6c4a91f2-replay-cand-1
docker inspect --format "{{.Id}} {{.Image}} {{.State.Status}} {{json .Mounts}} {{json .HostConfig.PortBindings}}" recall-task2-20261110-6c4a91f2-replay-cand-1
```

Require HTTP down during the gap, then the same container/image/mount/binding running. No new container, scratch directory, copy or writer on original v3.

## 3. Start browser asynchronously; require post-login worker readiness

Launch with the parent's receipt harness, capturing pipes without shell redirection. Use a hidden helper window if needed. **Keep this process running during step 4; do not wait for completion first.**

```powershell
node docs/releases/2026-11-10-task-2-evidence/task2.mjs replay-client
```

New replay-3 profile uses cached Chromium/Playwright at 390×844 and real workers. It waits for candidate health, navigates, **logs in via the real UI before waiting for worker registration**, then polls registration snapshots in an explicit host loop that awaits each `page.evaluate`. A shared 60-second deadline bounds snapshots and polling; the loop requires `workerRegistration.active.state === "activated"`. The separate `postLoginWorker.workerStates.active` assertion must also equal `activated` before `workerReadyAt` is set or controlled navigation begins. There is no async `waitForFunction` readiness predicate. A second navigation while the real candidate still serves warms control; it is not rollback Reload proof. Browser launch/navigation/login/worker/controller waits have explicit finite bounds (60 s maximum); cache/identity inspection 15 s; update discovery 60 s; banner 120 s; health 180 s; parent switch ten minutes. Server identity requests have 5 s bounds each. Warmup failure saves phase/log/identity and uniquely named failure screenshot before context close; screenshot failure is recorded too.

Require `observations/10-browser-replay-3-ready.json` and a still-running process:

- `status=ready_for_parent_server_switch`, `phase=hold-controlled-tab-open`.
- Real UI login recorded in `signIn`/API log; `authenticatedAt` precedes `workerReadyAt` and `readyAt`; both `workerRegistration.active.state` and `postLoginWorker.workerStates.active` equal `activated`, with the real `/sw.js` script identity. `postLoginWorker.active` is a URL, not a state.
- Candidate document `/assets/index-BI1X1ilU.js`, real controller/cache hashes, no waiting worker, candidate server SW SHA256 `9174a5f7a5045b44fecd8d452400955074e3833eb6a10a12a67c3afb7998c23f`.
- Pins 1/4, Quillon on memory 2, fictional data unchanged; browser version and `10-browser-replay-3-00-candidate-controlled.png`.

Do not switch on partial failure or merely because a browser process exists. Keep the controlled tab/context open and preserve original/replay-1/replay-2 profiles.

## 4. Switch to actual restored old server with controlled tab held open

```powershell
docker stop recall-task2-20261110-6c4a91f2-replay-cand-1
node docs/releases/2026-11-10-task-2-evidence/task2.mjs http-down browser-replay-3-switch-2
docker start recall-task2-20261110-6c4a91f2-restored
```

The process observes old asset/SW outside the browser without navigating its held candidate tab, records actual Pinned/edit/API/error/stack/server-body outcomes, then discovers the real update. If React crashes on opening the sheet, a new tab recovers the root while retaining the crashed controlled tab. This navigation is separate from real `registration.update()` discovery and the application's **Reload** button. No direct worker activation, storage clearing, mock/proxy, or plain-reload substitution.

Collect process completion once. Require exit 0 and `observations/10-browser-replay-3.json`, `status=passed`. Inspect actual compatibility observations: a crash before PATCH is not a strict-schema rejection. Require candidate document and real waiting worker/banner before the recorded button click, old `/assets/index-DWaWk5OZ.js`/controller/cache after it, candidate-only pin/keyword/related controls absent, PATCH 200, saved-body/text/tag/caption searches, rendered photos and unchanged full/thumb hashes. Preserve all screenshots, worker/asset hashes and browser version; Chromium is not physical iPhone proof.

On failure/prerequisite loss, preserve partial evidence/profiles/resources and stop without rerun/rewarm/reseed. If candidate remains serving, stop only replay-cand-1 and restart restored, separately recording recovery commands. Never clean failed resources. Any native permission denial stops immediately with the exact pending command.

## 5. Evidence custody and success-only original cleanup

Only after browser success:

```powershell
node docs/releases/2026-11-10-task-2-evidence/task2.mjs verify-replay-retention
```

Require exit 0 and `observations/11-replay-retention.json` matching original v3 archive SHA256 `d302184711d797d27c6164099e1642c93d1738129f5d05aa26e97160907d00aa` and all seven original retained-v4 hashes. Preserve observations/screenshots/receipts/logs outside disposable resources before cleanup. Confirm no replay Node/browser process, only restored app running and exact names/mounts. Keep all images, RET and repository evidence.

```powershell
docker stop recall-task2-20261110-6c4a91f2-restored
docker rm recall-task2-20261110-6c4a91f2-replay-cand-1 recall-task2-20261110-6c4a91f2-restored recall-task2-20261110-6c4a91f2-seed recall-task2-20261110-6c4a91f2-cand recall-task2-20261110-6c4a91f2-refusal
docker volume rm recall-task2-20261110-6c4a91f2-data
node docs/releases/2026-11-10-task-2-evidence/task2.mjs cleanup-temp
docker ps -a --filter name=recall-task2-20261110-6c4a91f2
docker volume ls --filter name=recall-task2-20261110-6c4a91f2
node docs/releases/2026-11-10-task-2-evidence/task2.mjs http-down after-cleanup
```

`cleanup-temp` requires successful replay-3/recorded retention, rehashes RET and validates the exact real resolved task root before recursive removal. It removes scratch, original/replay-1/replay-2/replay-3 profiles and auth; RET/repo remain outside that root. No container `-v`, broad prune or image deletion. Require `12-cleanup-temp.json`, temp/container/volume absence, HTTP down and RET still present.

Return sanitized new artifacts with relative names/SHA256 and receipt/log pairs. Verify all pre-existing repository evidence byte-identical and stage new files outside Git for import as before. Do not overwrite earlier observations or label parent runtime as child checks. Sol will reconcile final docs/record and obtain mandatory final-source gates/independent review after these results return. No production, Task 3, commit/push/deploy or acceptance claim here.
