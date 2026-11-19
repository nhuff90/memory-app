# Keyword pills and reuse: local delivery record

Prepared November 18, 2026 for the feature specified in `docs/pinned-keywords-related-rollout.md`, section “Feature follow-up: keyword pills and reuse — November 18, 2026”. This is **local implementation and acceptance evidence only**. Nothing was deployed, no production host or data was touched, no Fly commands were run, and no live AI provider was called (`RECALL_LIVE_AI` empty; fake embedding and LLM providers throughout). Release readiness is not established by this document.

- Worktree: `C:/Users/Nate/repos/memory-app-keywords`, branch `codex/keyword-pills`.
- Starting commit (runner baseline): `07a034d466ea1de6b1686bdde7eab54c3eca81dc` (schema v4, pinning, editable custom keywords, Related).
- Candidate: the feature commit directly on top of that baseline (branch `codex/keyword-pills`). Results below apply to that tree only.
- Re-verified November 19, 2026 on the exact tree committed, after the runner's run records were deleted: `npm.cmd run typecheck` passed; `npm.cmd test` passed (15 files, 176 tests); `npm.cmd run build` passed; the browser rehearsal passed with 26 observations and no page errors (Playwright 1.66.0-alpha, Chromium 1243). The runner's Astra review records no longer exist, so this document does not claim a final review verdict.

## What changed

**Storage and API (server)**
- New forward migration `server/src/migrations/005_keyword_assignments.ts` (schema **v5**). Migration 004 is unchanged.
  - `memory_keywords(memory_id, keyword, label, assigned_at)`: one row per recall and normalized keyword (shared `keywordKey`: trim + lowercase). Used for exact filtering, active usage counts and assignment recency. Existing v4 keywords are backfilled with `assigned_at = NULL` (frequency only, no invented recency). Rows cascade on delete.
  - `capture_receipts(client_id, memory_id, custom_keywords, received_at)`: written in the same transaction as every new clientId capture, so reconciliation can tell a capture this server saved with its keywords from one an older server created without them.
  - `openDb` registers the SQL function `recall_keyword_key` (used only by the migration backfill, never by triggers), so SQL and app normalization agree, including non-ASCII case.
- `memories.custom_keywords` remains the display/FTS/export source; keyword rows are kept in step inside the same transactions.
- `POST /api/memories` accepts `customKeywords` (JSON array, or repeated multipart fields). Body, photos and keywords are validated first and saved in one transaction; invalid keywords save nothing (no recall, photos or usage). A repeated clientId returns the existing recall unchanged (no duplicate, no second count, no new recency); repeating create cannot repair or modify an existing record.
- `GET /api/me` advertises `capabilities: ["keyword-capture"]`.
- `GET /api/keywords`: vocabulary with display spelling, normalized key, active count (once per recall, outdated excluded) and last genuine assignment time. Outdated-only keywords are listed with count 0 (typed matches only).
- `POST /api/memories/reconcile` `{clientId, customKeywords, expectedUpdatedAt?, resolution?}` (review round 1 correction KP-02):
  - `missing`: no recall has that clientId (the device may upload it with the same clientId).
  - `already-saved`: a receipt exists (this server saved the capture with its keywords); nothing changes.
  - For a receipt-less recall (created by an older server that dropped the keywords) nobody recorded later keyword history, so a held keyword that is absent now may have been removed on purpose. Missing keywords are added (`reconciled`) only when the recall is provably untouched since the capture, or when the user explicitly chose `add` against the `updatedAt` shown in a `conflict` answer; the update itself is also guarded by `updated_at`. “Provably untouched” (review round 2 correction KP-02) requires both: `expectedUpdatedAt` from the old server's **201 Created** response to that very request (a same-clientId retry's 200 returns the current record, which may include later edits, so the client never records it), and that the recall still has no keywords (an older server never stored any, so present keywords prove later keyword edits). Otherwise nothing changes and the answer is `conflict` with the current recall and the missing keywords. `keep` records the user's choice to keep Recall's version (`kept`). Every resolution writes a receipt, so repeats are no-ops. Over-limit merges are refused with 400 and change nothing.
- `keyword` filter on `GET /api/memories` and `GET /api/search`, applied in SQL before pagination and before both the lexical (FTS) and semantic (vector eligibility) candidate limits.
- Recency changes only for genuinely new assignments (capture, edit adding a keyword, reconciliation adding one). Body edits, pin/unpin, respelling a keyword, archive/restore and retries never change it. Keyword-only edits and reconciliation do not trigger enrichment or embedding.
- New routes are session-only; Siri keys remain limited to `/api/capture` and `/api/ask` (tested 401).

**Client**
- `KeywordPills` (one control for Remember and the editor): removable labeled pills (44px targets), combobox input, up to five suggestions, explicit “Create …” option, Enter/arrow/Escape keyboard operation (Enter never submits the form), comma typing and comma paste, invalid text kept visible with an explanation. The suggestion list renders in page flow so it never covers Save.
- Suggestions (`web/src/lib/keywords.ts`): typed matches only (exact, prefix, word-start, contains; active before outdated-only); empty input: two most recent, then frequency, unused recent slots filled by frequency; alphabetical tie-break; selected keywords excluded. The vocabulary is cached for offline use; failures never block capture.
- Remember: durable draft — text (`recall:draft`, unchanged key), keywords + unfinished input (`recall:draft-keywords`), photos (IndexedDB `recall-draft`). Save commits valid unfinished input; a completing save clears only what it sent.
- Editor: explicit Save/Cancel, unfinished keyword text counts as dirty, pin/unpin independent, discard protection on close, Related and keyword navigation. Saved keywords are buttons that open exact keyword browsing.
- Recall: one visible, removable keyword filter intersected with category/Pinned, search text, People photo grid and Show outdated; filter changes reset pagination; clearing keeps the other selections; empty state names the keyword; Ask reads “Ask all memories” while a keyword (or Pinned) filter is active.
- Outbox: items carry `customKeywords` (missing = empty for legacy items). Keyword-bearing items check the capability first and verify the returned normalized keywords. Held items show **Needs reconciliation**, keep body/photos/keywords, and are excluded from automatic retries. User recovery reconciles by the original clientId (uploading, with that clientId, only if the server reports `missing`). Older response shapes are normalized so the UI never crashes.
  - Review round 1 correction KP-03: `uploadStarted` is stored durably before any create request leaves. Held reasons: `unsupported` (capability absent and no upload ever started: the only state offering Edit), `unverified` (an upload may have reached a server: success without matching keywords, an interrupted attempt, or a refused retry after an earlier attempt), `conflict` (explicit **Add missing keywords** / **Keep Recall's version**). A failed recovery or capability loss never turns a possibly-saved capture back into `unsupported`, so it can never be edited and re-saved under a new clientId; the state survives reloads.
- Remember, review round 1 correction KP-01: when an upload completes, only the sent keywords that were not removed and selected again during the upload leave the form.

## Fresh local results (this candidate)

Commands were run directly from the worktree, in this order, on the final source: typecheck, tests, build, then the browser rehearsal after the final build. Exact outputs are in the runner's captured tool output for this implementation run.

- `npm.cmd run typecheck`
- `npm.cmd test` — includes new `server/test/keyword-pills.test.ts`, `web/src/lib/keywords.test.ts` and extended `web/src/lib/outbox.test.ts`.
- `npm.cmd run build`
- `node scripts/verify-memory-features.mjs --playwright <cached playwright> --browser <cached chromium-1243>`

Browser rehearsal: Chromium 1243, 390x844, `isMobile`, `hasTouch`. Context A blocks service workers (UI behavior); context B allows the real built `sw.js`. Screenshots are under ignored `screenshots/memory-features-*.png`. Observations (all passed, no page errors):

1. Default suggestions: Christmas, Lantern (two most recent), then Bulk, Garage (frequency), Home before Tools at a tie; outdated-only Holiday and outdated HOME not counted.
2. Remember pills by keyboard, explicit Create, comma dedupe, 44px labeled remove targets, keyboard removal; unfinished text committed on Save; Enter never submits.
3. Invalid input (41 characters, eleventh keyword by comma paste) stays visible, adds nothing, disables Save.
4. Photo-only capture with pills in one request; JSON/Markdown export keeps keywords separate from tags, with the photo.
5. Text, a new pill, a sent keyword removed and selected again (same normalized keyword), and unfinished keyword input typed during an in-flight save remain for the next memory, also after a reload.
6. Interrupted upload whose first request reached the server: retry with the same clientId, exactly one recall, no second count or recency change.
7. Pin and body edits leave counts/recency unchanged; Mark outdated removes a keyword from defaults; restore returns its count with the original recency; delete removes it.
8. Suggestion endpoint failure (503): manual keywords still save.
9–13. Existing pinned/Ask/editor/Related acceptance retained (selectors adapted to pills): dirty pin/unpin, Cancel, validation without partial saves, unfinished text blocks close and keyword navigation, Related loading/error/retry/empty/late-response handling.
14. Exact browsing: Home/home/HOME match; Homework, body-only and tag-only do not; intersects with Show outdated, Pinned, category and search; empty state; Ask all memories is not scoped; clearing keeps query and category.
15. Keyword filter before pagination (30 + Show more) with reset on filter change; keyword + search finds a labeled note behind 65 newer unlabeled matches (beyond the 60-candidate limit).
16. Real service worker registers, activates and controls the page.
17. Offline (served by the service worker): queued capture with photo and pills; offline reload restores the queue and the draft's text, pills, keyword input and photo.
18. Server-refused queued upload (413) → Edit restores body/photo/pills into the durable draft (survives reload) → corrected capture arrives once.
19. An old client's queued record without `customKeywords` uploads once with no keywords.
20. Recovering the possibly-saved (unverified) capture while the server is old again keeps it reconcilable (Recover keywords only, no Edit, no upload), also after a reload; only the never-uploaded capture offers Edit.
20a. Split rollout with a lost response: the old instance saved body+photo, the recall was then edited elsewhere (Garage added with Shelf, then Garage removed), and the same-clientId retry received 200 with the edited record. The capture is held (no Edit) with body, photo and Garage/Porch across a reload.
21. Mixed versions with the **real baseline server source** (commit above, run via tsx on its own v4 database): keyword capture held, nothing uploaded; a split rollout where the old version handled the create returned 201 without keywords → held as Needs reconciliation; no automatic retries; responses without `pinned`/`customKeywords` render without errors.
22. Service-worker update: changed `sw.js` installs and waits, the real update banner appears, Reload activates it; held items and the draft survive (no site storage cleared).
23. The old server's v4 database is forward-migrated to v5 by the candidate. The recall had been edited since (body, Shelf), so Recover keywords shows an explicit conflict (Recall has Shelf; missing Christmas, Ornaments) without changing anything; Add missing keywords reconciles the original clientId once, keeping the later edit; Try again uploads the never-sent capture exactly once. Screenshot `memory-features-sw-conflict.png`.
23a. After the upgrade, recovering the lost-response capture shows an explicit conflict (Recall has Shelf; missing Garage, Porch) and does not restore the removed Garage, also when a repeated recovery offers the retry's timestamp; Keep Recall's version keeps the later body, Shelf and photo with one recall, and a further recovery answers already-saved. Screenshot `memory-features-sw-conflict-lost-response.png`. (The final run reports 26 observations; 20a and 23a are numbered to keep the earlier references stable.)
24. An upload that reached the server but lost its response, followed by capability loss (a stale baseline instance answering `/api/me`), is held as Needs reconciliation with no Edit across a reload; recovery reconciles it as already saved with one recall, one count and no second upload.

Limitations, stated plainly:
- Chromium mobile/touch emulation only. **Not** a physical iPhone or Safari test. After a mid-run `page.reload()` Chromium reported `maxTouchPoints` 0 (touch is asserted before reloads; the post-reload value is reported in the rehearsal output).
- The split rollout (capability answered by the candidate, create served by the baseline) is produced by the harness's HTTP dispatcher on one origin; both servers are real code, not page-route mocks. The harness's “413” rejection and “older response shape” are also produced server-side by that dispatcher.
- Interrupted upload in context A uses a Playwright route that forwards the request to the real server and then resets the connection. In context B the harness dispatcher lets the real server process the create and then fails the response stream; `@hono/node-server` logs that intentional `fictional connection lost` error to the console.
- The receipt-less conflict rule is deliberately conservative: a recall edited in any way after an older server saved it requires the user's explicit Add/Keep choice, even if the edit did not touch keywords.

## Schema, upgrade and rollback prerequisites (not executed)

These are prerequisites for a future, separately authorized release. None were run.

1. **Verify the actual production baseline first.** The November 16 Task3E diagnosis leaves production state unknown. Confirm the running image digest, the database `user_version` (v3 or v4 are both possible), row/photo counts and that exactly one writer exists. Do not assume schema v4 or reuse an older backup.
2. **Take a fresh matched backup** of the database (SQLite backup API) and the photo directory with all writers stopped, verify integrity, version, counts and every referenced photo file, and copy it off the host before any upgrade.
3. **Upgrade path.** Starting from v3 the candidate applies 004 then 005; from v4 it applies 005 only. 005 creates two tables and backfills keyword rows from `custom_keywords`; it does not alter `memories`, FTS, embeddings or photos. Verify `user_version = 5`, keyword row counts matching the non-empty keyword lists, FTS search on keywords, and an export after migration.
4. **Database-version guard / rollback.** An older (v4 or v3) binary refuses a v5 database (“Update the app first”). Rolling back the binary therefore requires restoring the matched pre-upgrade backup taken in step 2 for the actual baseline version, accepting loss of writes made after it, or a separately reviewed down-migration (none is provided). The historical v3 restore commands in the rollout document must not be reused as a generic rollback.
5. **Client drafts and outbox during updates.** The update banner keeps prompting before reload; local drafts (`recall:draft`, `recall:draft-keywords`, IndexedDB `recall-draft`) and the outbox (`recall`/`outbox`) must never be cleared. Captures held while a server lacks `keyword-capture`, or saved by an older server without their keywords, stay in Needs reconciliation until the user recovers them after the upgrade; recovery is by original clientId and does not duplicate. If a rollback restores a backup that predates a capture, reconciliation reports `missing` and the held capture is uploaded once on the user's request.
6. Re-run the typecheck/test/build gates and this rehearsal against the exact release revision, then perform a physical iPhone/Safari check before any production rollout decision.
