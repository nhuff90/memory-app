# Photo text: local delivery record

Prepared November 24, 2026 for the photo-text batch (tasks 01–07) planned on November 24, 2026. This is **local implementation evidence only**. Nothing was deployed. No production host or production data was touched. No Fly or Litestream commands were run. No live AI provider was called: `RECALL_LIVE_AI` stayed empty and the tests use the fake LLM and fake embedding providers throughout. This document does **not** establish release readiness.

- Repository: `C:/Users/Nate/repos/memory-app`, branch `feature/photo-text`.
- Code described: commits `1d30a55` (task 01) through `91484fe` (task 07), on top of `6d95473`. This task adds only this file; no source or test file changed.
- Each statement below was checked against the merged source named next to it. Where a statement is a consequence of the code rather than something a test exercises, it says so.

## What photo text does

### Schema (`server/src/migrations/006_photo_text.ts`, `server/src/db.ts`)

- New forward migration 006, appended to `MIGRATIONS` in `server/src/migrations/index.ts`. Migrations 001–005 are unchanged.
  - `photos.extracted_text TEXT`: the text read from that photo, line breaks kept. NULL when no text was read.
  - `photos.text_read_at INTEGER`: when a reading finished, set even when it found no text. NULL means the photo has never been read.
  - `memories.photo_text TEXT`: every photo's text in photo id order, joined with a blank line. NULL when no photo has text. It exists only so the keyword index can cover photo text.
  - `memories_fts` is dropped and recreated with a fifth column, `photo_text` (`body, tags, captions, custom_keywords, photo_text`, `porter unicode61`), then rebuilt. The insert, delete and update triggers are recreated, and the update trigger now also fires on `photo_text`. Keyword search ranks a `photo_text` match with bm25 weight 0.5, the same as tags, captions and custom keywords; the body keeps 1.0 (`server/src/search.ts`).
- The schema goes from **v5 to v6**. `migrate` runs at startup, applies each missing migration in its own transaction and sets `PRAGMA user_version`. An upgraded v5 database keeps its memories and leaves the new columns empty (`server/test/db.test.ts`, "upgrades version 5 to photo text").
- **An older app refuses a v6 database.** `migrate` throws "The database is at version 6, but this app only knows 5 migrations. Update the app first." when `user_version` is higher than the number of migrations it knows. This guard is unchanged in this batch. The v5 behaviour on a v6 file follows from that code; it was not run against the old binary. **Rollback consequence:** once 006 has run, rolling the binary back to a v5 app needs a matched pre-upgrade backup of the database and photos (and accepting the loss of writes made after it), or a separately reviewed down-migration. None is provided.

### The Claude call (`server/src/enrich.ts`)

- **One call per new photo** returns both the caption and the full text, when **Describe photos** is on. The system prompt is `PHOTO_PROMPT` and the user content is the JPEG plus "Describe this photo.".
  - `caption`: one or two plain sentences on what the photo shows, quoting the most important readable text exactly. People are described briefly and never identified.
  - `text`: all readable text, exactly as written, in reading order, one line per line of text. It includes handwriting, labels, signs, screens and printed pages. The model must not correct, summarize, translate or explain it, writes `[?]` for an unreadable word, leaves the field empty when there is no text, and stops after about 1,500 words, ending with "…".
- Structured output schema `PHOTO_SCHEMA`: `{ caption: string, text: string }`, both required, `additionalProperties: false`. When the reply is parsed, only `caption` is required: a missing or non-string `text` counts as no text.
- `maxTokens: 4096`.
- **Cut-off fallback:** when the reply cannot be parsed and its stop reason is `max_tokens`, the enricher makes one caption-only call (`CAPTION_PROMPT`, `CAPTION_SCHEMA`, `maxTokens: 300`) and saves its caption with no text, so the photo counts as read. If Describe photos was turned off in the meantime, the retry is not sent and the photo stays undescribed and unread. This is the only extra call.
- Other failures: a missing file, a request skipped by a 400 (after a call has already succeeded), a refusal or another unusable reply saves no caption and no text, and the photo is marked done. An outage saves nothing and pauses until the next sweep (at startup and every 15 minutes).
- `cleanPhotoText` normalizes line endings, drops trailing spaces, allows at most one blank line in a row and trims. Empty text becomes NULL. Text longer than **10,000 characters** (`MAX_PHOTO_TEXT_LENGTH`) is cut at the last line break or space within the first 10,000 characters, and "…" is appended.
- Usage: the combined call, the caption-only retry and the reading of saved photos are each recorded with `usage.record("caption", …)`. Migration 006 does not touch `ai_usage`.
- `MemoryStore.saveCaption` (`server/src/memories.ts`) saves the caption and the text in one transaction and refreshes `memories.photo_text`. A changed caption re-tags and re-embeds from the captions, as before. A text change on its own never resets `enriched_at`, never re-embeds and emits no change.
- Photo text stays out of embedding input (`embeddingText` uses the body, or the captions when there is no body) and out of the auto-tagging request (`Note:` plus `Photo shows:` captions only). Related's search terms come from the body, captions and custom keywords, not photo text.

### Reading saved photos (`server/src/app.ts`, `server/src/settings.ts`, `server/src/enrich.ts`, `server/src/memories.ts`)

- **Route:** `POST /api/photo-text/read-saved`. It refuses with 400 when the server has no Anthropic key ("Reading text in photos needs an Anthropic API key on the server.") and when Describe photos is off ("Turn on Describe photos first."). Otherwise it records the request, starts a sweep and returns the `/api/me` body.
- **Session only:** the route is not in `TOKEN_ROUTES`, so a Siri Shortcuts key gets 401, and so does a request with no session (`server/test/photo-text.test.ts`).
- **Setting:** `read_saved_photo_text` in the `settings` table, off until asked. Nothing in the API turns it off again; once asked it stays true.
- **Sweep:** while Describe photos is on **and** the request is recorded, `Enricher.sweep()` also queues `photosWithoutText()`: memories, outdated ones included, newest first (up to 1,000 per sweep), that have a photo with `captioned_at` set and `text_read_at` NULL. For each memory, undescribed photos are described first, then each unread described photo is read in id order.
- **What it changes:** `readText` sends the same `PHOTO_PROMPT`/`PHOTO_SCHEMA`/4,096-token call and saves only the text through `savePhotoText`, which sets `extracted_text` and `text_read_at` and refreshes `memories.photo_text`. It **never** changes the caption, the memory's captions, tags, category, `enriched_at`, `updated_at` or embeddings, and it emits no change, so nothing is re-tagged or re-embedded. A missing file, a skipped photo, a refusal, an unusable reply or a reply cut off by the token limit is saved as no text, so the photo is not sent again. There is no caption-only retry, because the photo already has a caption. An outage saves nothing and pauses.
- **Pause and resume:** reading runs only while Describe photos is on. The check is made before each photo, so turning Describe photos off stops the reading after any call already in flight. The request stays recorded. Turning Describe photos on again (`PATCH /api/settings` starts a sweep) resumes it.

### `/api/me` (`server/src/app.ts`, `shared/types.ts`)

- `capabilities` now lists `"keyword-capture"`, `"keyword-rename"` and **`"photo-text"`** (`PHOTO_TEXT_CAPABILITY`).
- New field **`photoText: { unread, requested }`**:
  - `unread` is `countPhotosWithoutText()`, the described photos (outdated memories included) whose text has never been read.
  - `requested` is the `read_saved_photo_text` setting.
- `PATCH /api/settings` and `POST /api/photo-text/read-saved` return the same body. In `shared/types.ts`, `photoText` is optional because older servers omit it.

### Ask (`server/src/ask.ts`)

- When a memory has photo text, `formatNotes` adds one line after its `photo shows:` captions line, if it has one, and before its tags: `  text in photo (transcribed, may have errors): …`.
- The text is every photo's text in photo order on one line. Line breaks, including the breaks between photos, become " / ", and whitespace collapses. It is capped at **1,500 characters** (`MAX_PHOTO_TEXT`), cut at a word with "…" appended, without splitting a surrogate pair or leaving a dangling " /".
- Memories without photo text are sent exactly as before. How Ask picks its notes is unchanged; because the keyword index now covers photo text, a keyword match in photo text counts as a search match.

### Export (`server/src/export.ts`)

- **JSON** (`memories.json`): each photo is `{ file, caption, text }`. `text` is the photo's text, or `null` when it has none or has not been read. `customKeywords`, `tags` and `pinned` stay separate fields.
- **Markdown** (`memories.md`): under each photo's image line, a photo with non-blank text gets `Text in photo:` followed by the text as a blockquote, one `> ` line per line. Blank lines become a bare `>`, so the line breaks are kept.

### The client (`web/src`)

- **Older response shapes** (`web/src/api.ts`): `normalizePhoto` turns a missing, non-string or whitespace-only `text` into `null` and keeps real text exactly. `readSavedPhotoText()` calls the new route.
- **Capability and status** (`web/src/lib/photoText.ts`): `supportsPhotoText` checks for the `photo-text` capability. `photoTextStatus` returns null when the capability is missing or `photoText` is missing or malformed, so the screen offers nothing. Otherwise it reports `reading` (requested, photos unread, Describe photos on) or `paused` (requested, photos unread, Describe photos off).
- **Card snippet** (`web/src/components/MemoryCard.tsx`, `photoTextSnippet` in `web/src/lib/format.ts`): with a search query that matches no word in the card's shown text (the body, or the captions when there is no body), the card shows "In photo:" and a one-line snippet from the first photo whose text matches.
  - The snippet is at most 160 characters, cut only between words, with "…" at each cut end.
  - The matched word is highlighted the way search matches it and is never cut.
  - There is no snippet with an empty query.
- **Sheet block** (`web/src/components/MemorySheet.tsx`): each photo with text gets a read-only, selectable "Text in photo" section ("Text in photo N" when the memory has several photos), with line breaks kept.
  - Text longer than 300 characters or 6 lines is clamped to 6 lines behind Show all / Show less.
  - The buttons are 44px tall and disabled while the sheet is busy.
- **Copy:** writes the text with `navigator.clipboard.writeText` and shows "Copied" for 2 seconds. If that fails, it shows "Couldn't copy. Select the text and copy it instead.".
- **Add to note:** `addTextToNote` puts the text into the editor's body, at the end after a blank line, or as the whole note when the note is empty. It is refused, with a message, when the note already contains the text or the result would pass 10,000 characters. It only changes the editor text, so the explicit Save/Cancel and discard protection apply. The extracted text itself is never edited in place.
- **Settings** (`web/src/components/SettingsSheet.tsx`):
  - The Describe photos help now says Claude also copies out any text in each photo.
  - The saved-photos offer appears when the server advertises photo text, Describe photos is on, saved photos are unread and nothing has been requested yet. It reads "N photos were described before Recall could read the text in them.", with a "Read text in N photos" button and "Each one is sent to Claude once more.". The button is disabled while sending and while offline ("You’re offline."), and errors are shown.
  - A live status line reads "Reading text in saved photos: N left." while reading, and the sheet refreshes `/api/me` every 10 seconds while it is open and reading.
  - When the reading is paused, the line reads "Reading text in saved photos is paused while Describe photos is off.". It reads "Text read in all saved photos." when the count reached 0 while the sheet was open.

## Decisions

1. **One switch.** Reading text is part of the existing **Describe photos** switch, off by default. There is no second setting, and no photo goes to Claude while it is off. Each photo was already sent once to be described, and a separate text setting would add a second consent for the same upload.
2. **Saved photos only on request.** Photos described before this feature are re-sent only after the user asks, through Settings, which calls `POST /api/photo-text/read-saved`, and only while Describe photos is on. Re-sending costs money and sends personal photos to Claude again, so it is never automatic.
3. **One call per photo.** The caption and the text come back from one Claude call, recorded as kind `caption`, so a new photo costs one request and is uploaded once. The only extra call is the caption-only retry when a reply is cut off by the token limit.
4. **Photo text is keyword search only.** It is in the FTS index, but never in embedding input or the auto-tagging request.
   - It is a machine transcription that may contain errors and can be long, while meaning vectors are built from the note's own words (or captions). The project's eval found that mixing auto-tags into the vector blurred close matches without finding anything new (`server/src/search.ts`), and there is no eval evidence yet that photo text would do better.
   - Keeping it out of tags stops long or wrong transcriptions from driving categories and tags.
   - It also means that reading or changing text never re-tags or re-embeds, which costs nothing extra.
5. **Text is not edited in place.** Extracted text is a record of what was read. "Add to note" copies it into the editor under the normal Save/Cancel and discard protection, so there is no second edit path to keep consistent.
6. **Session-only route.** Reading saved photos starts paid calls over the whole photo library, so only a signed-in session may request it. Siri Shortcuts keys stay limited to `/api/capture` and `/api/ask`.
7. **Mixed old/new client and server tolerance.**
   - New clients tolerate servers without `Photo.text`, `MeResponse.photoText` or the `photo-text` capability: text becomes null and Settings offers nothing.
   - Old clients keep working against the new server. The new fields are additions, `PATCH /api/settings` still accepts only `photoCaptions`, and old clients simply never ask to read saved photos.
   - The old-client side follows from the API shape; no old client build was run against the new server.

## Not verified

Stated plainly, none of these were checked:

- **Real transcription quality** on printed pages, handwriting, screenshots and small print. Only the fake LLM was used, so nothing is known about how well Claude reads real photos with this prompt.
- **Whether the 1600px upload size loses small print.** The client scales photos down to at most 1600px on the long edge (`FULL_SIZE` in `web/src/lib/images.ts`, JPEG quality 0.82) before upload, and Claude reads that upload. Whether small print survives that is untested.
- **Real token use and cost** of long transcriptions (up to 4,096 output tokens per photo, plus a possible caption-only retry) and of reading saved photos across a whole library.
- **Behaviour on a physical iPhone**, including clipboard access (Copy) in the installed PWA. No browser rehearsal, Safari or iPhone check was run for this batch.

## Follow-ups

- Siri Shortcut image capture.
- Photo text in meaning search or tags, decided with `npm run eval`.
- Editing extracted text.
- Higher upload resolution for documents.

## Local results (this tree)

The implementer ran these in the repository root on the final source tree (the merged code plus this file), November 24–25, 2026. The exact output is in the runner's captured tool output for this implementation run.

- `npm test`: **passed**. 18 test files passed (18), 264 tests passed (264), vitest 5.0.5.
- `git diff --check`: **passed**, with no output. It checks tracked files only. This file is new and untracked (nothing was staged), so `git diff --check` does not cover it. A separate search of this file for trailing whitespace found none.
- `npm run typecheck`: **not run** by the implementer, because it is not on the run's allowed command list. No result is claimed.
- `npm run build`: **not run** by the implementer, for the same reason. No result is claimed.

The owner decided (November 25, 2026) that typecheck and build would be recorded as not run here, rather than run by the implementer. After implementation, the runner's verification gates run `npm run typecheck`, `npm test`, `npm run build` and `git diff --check` on this tree. Their results are in that run's verification evidence, not in this document.

Not run, and not claimed: any browser rehearsal, iPhone or Safari check, `npm run test:live`, `npm run eval`, and any Fly, Litestream or production command.
