# Keyword cleanup (rename and merge): local delivery record

Prepared November 23, 2026 for the keyword rename and merge work merged on branch `keyword-cleanup` (commits `d7e33d1`, `f24ec80`, `fce44e1`, `d95ef0d`). This is **local implementation evidence only**. Nothing was deployed, no production host or data was touched, no Fly or Litestream commands were run, and no live AI provider was called (`RECALL_LIVE_AI` empty; the tests use the fake embedding and LLM providers). This document records the merged behavior and does not change it. Release readiness is not established here.

- Recorded against: `d95ef0dae5bdd2ece437423f7c86d292dd2f02a6` (branch `keyword-cleanup`, clean working tree). The only change on top of it is this document.
- Code of record: `server/src/memories.ts` (`MemoryStore.renameKeyword`), `server/src/app.ts` (route and `/api/me` capability), `shared/keywords.ts` (`KEYWORD_RENAME_CAPABILITY`), `shared/types.ts` (`KeywordRenameResult`), `web/src/api.ts`, `web/src/lib/keywords.ts`, `web/src/components/KeywordManager.tsx` and `web/src/components/SettingsSheet.tsx`. Tests: `server/test/keyword-cleanup.test.ts`, `web/src/lib/keywords.test.ts`.

## What it does

**Route.** `POST /api/keywords/rename` with the JSON body `{ "from": string, "to": string }` (strict: no other fields; each string at most 1000 characters before keyword validation). It returns `200` with a `KeywordRenameResult`:

```json
{ "status": "renamed" | "merged" | "respelled" | "unchanged", "keyword": "<new display spelling>", "key": "<its normalized identity>", "affected": <number of recalls whose saved keyword list changed> }
```

- `400` when `to` is empty after trimming, contains a comma, or breaks the shared keyword rules (for example more than 40 characters). Nothing changes.
- `404` ("No memory has that keyword.") when no recall, active or outdated, carries `from`. Nothing changes.
- `401` without a login session, including requests made with a Siri Shortcuts key (see "Session-only access" below).

**Capability.** `GET /api/me` advertises `capabilities: ["keyword-capture", "keyword-rename"]`. The client (`supportsKeywordRename`) shows the rename controls only when `keyword-rename` is present, so an older server never receives the request.

**The four result statuses** (computed by comparing the normalized keys of `from` and `to`, `keywordKey`: trim + lowercase):

| Status | When |
| --- | --- |
| `renamed` | `to` is a different keyword and no recall carried it. |
| `merged` | `to` is a different keyword that at least one recall (active or outdated) already carried; the two are now one keyword. |
| `respelled` | `to` is the same keyword with a different display spelling on at least one recall (saved list or keyword row). |
| `unchanged` | `to` is the same keyword and every recall already used exactly that spelling. Nothing is written. |

Repeating a request is safe: a repeat of a completed rename or merge answers `404` (no recall carries the old keyword any more), and a repeat of a respelling answers `unchanged`.

**Merging on one recall.** A recall that carries both keywords keeps the target keyword at its own position in the list, and the old keyword is dropped. A recall that carries only the old keyword gets the new spelling at the old keyword's position.

**Client.** Settings has a Keywords section (`KeywordManager`) that lists every custom keyword with its usage and previews each change with `planKeywordRename` before sending (invalid, unchanged, respell, rename or merge). A merge sends nothing until the user confirms it with the explicit Merge button. The confirmation says that outdated memories change too and that the merge can't be undone. After success the status line reports the server's `affected` count, and an active Recall keyword filter on the renamed keyword (or on the merge target) follows the new spelling (`keywordFilterAfterRename`). The client rejects a malformed or inconsistent reply with a readable error, never partial data (`normalizeKeywordRenameResult`).

## Decisions

1. **Rename and merge only.** The route changes one custom keyword into another spelling or another keyword. It does not delete keywords, does not touch automatic tags or categories, and does not attach a keyword to a recall that did not already carry one of the two keywords.
2. **Outdated recalls are included.** The change runs over every recall carrying the keyword, active and outdated, in one SQLite transaction. The `404` check also counts outdated recalls.
3. **Assignment times are kept.** A rename is not a new assignment, so a recall's `memory_keywords.assigned_at` is carried over unchanged. Where a recall had both keywords (merge overlap), the later non-null time wins; if both were null it stays null. Keyword recency in suggestions is therefore not refreshed by cleanup.
4. **The new spelling applies everywhere.** `to` (trimmed) becomes the display spelling on every recall that ends up with the keyword, including recalls that already carried the target keyword with a different case. This applies to both `memories.custom_keywords` and the `memory_keywords.label` rows.
5. **`updated_at` is bumped only on changed recalls.** A recall gets a new `updated_at` (and an `updated` change event) only when its saved `custom_keywords` text actually changes. Recalls whose list already matched are not bumped; at most, a stale keyword row label on such a recall is corrected. `affected` counts only the bumped recalls.
6. **No enrichment and no re-embedding.** The change events are emitted with `bodyChanged: false`. The enrichment queue (`server/src/enrich.ts`) and the search re-index (`server/src/search.ts`) act only on `updated` events with `bodyChanged: true`, so cleanup never calls the LLM or regenerates embeddings. Keywords stay out of the embedding input.
7. **No schema change, so the schema stays v5.** No migration was added; the code uses the existing `memories.custom_keywords` column and the `memory_keywords` table from `005_keyword_assignments.ts`. Migrations remain 001–005 and are unchanged.
8. **Session-only access.** The route sits behind the same `requireAuth` middleware as every other `/api/*` route and is not in `TOKEN_ROUTES`, which lists only `POST /api/capture` and `POST /api/ask`. A Siri Shortcuts key therefore gets `401`; the HTTP tests cover this case.

## Known limits

- **There is no undo.** A merge cannot be split back apart, because the server does not record which recalls carried which keyword before the change. A rename can only be reversed by renaming again, and that new rename applies to every recall carrying the keyword at that time. The client says this before a merge.
- **Device-local copies are not rewritten.** Held outbox captures, local drafts (`recall:draft-keywords`) and an editor already open with the old spelling keep the old keyword. Saving one of them, or reconciling a held capture, can bring the old keyword back as a separate keyword (after a rename or merge) or restore the old spelling (after a respelling). The user would then need to rename or merge again.
- **A bumped `updated_at` makes a later receipt-less reconcile of an affected recall answer `conflict`.** For a recall an older server created without receipts, `reconcile` adds missing keywords only when `expectedUpdatedAt` equals the recall's current `updated_at`. After cleanup changes that recall, a held capture's stored time (or the time from an earlier `conflict` answer) no longer matches. The answer is then `conflict` with the current recall, and the user must choose Add or Keep again. This is intended: the user sees the renamed keywords before anything is added.
- **Future work:** deleting a keyword from every recall, and suggesting keywords (or merges) from recall content, are not implemented.

## Local results (this tree)

The implementer ran the checks below directly in `C:/Users/Nate/repos/memory-app`, in this order, on the final tree: commit `d95ef0d` plus this document in its final form (no further edit followed the checks). No source, test or configuration file differs from `d95ef0d`. An earlier run of the same checks on `d95ef0d` alone, before the document existed, gave the same results; it is superseded by this run. Exact outputs are in the runner's captured tool output for the implementation round in which this document was last edited.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed (`tsc` for the root, server and web projects reported no errors). |
| `npm test` | Passed: 16 test files, 211 tests (vitest 5.0.5). |
| `npm run build` | Passed (vite 8.3.5 client build plus `tsc -p server/tsconfig.build.json`; PWA service worker generated). |
| `git diff --check` | Passed (no output). Git does not inspect this untracked document with this command. |

The runner's own gates (typecheck, tests, build, `git diff --check`) run separately after the implementer's report and are not claimed here. No browser rehearsal, Playwright run, Safari test or physical iPhone validation was performed for this work. The UI behavior described above is taken from the source and the Node unit tests, not from a browser run.
