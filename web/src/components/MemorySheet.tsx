import { useCallback, useEffect, useRef, useState } from "react";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  photoUrl,
  type Category,
  type KeywordUsage,
  type Memory,
  type Photo,
} from "../../../shared/types";
import { addPhotos, deleteMemory, deletePhoto, errorMessage, relatedMemories, updateMemory } from "../api";
import { formatFullDate } from "../lib/format";
import { useAutosize } from "../lib/hooks";
import { preparePhoto } from "../lib/images";
import { applyKeywordInput, pendingKeywordError, sameKeywordList, type PillInput } from "../lib/keywords";
import { ArchiveIcon, CloseIcon, TrashIcon } from "./icons";
import { KeywordPills } from "./KeywordPills";
import { PhotoButton } from "./PhotoButton";
import { PhotoViewer } from "./PhotoViewer";
import { Sheet } from "./Sheet";
import { MemoryList } from "./MemoryCard";

type Busy = null | "save" | "archive" | "delete" | "photo" | "category" | "pin";

export function MemorySheet({
  memory: initial,
  onClose,
  onChanged,
  onDeleted,
  onOpen,
  onBrowseKeyword,
  vocabulary,
  vocabularyError = null,
}: {
  memory: Memory;
  onClose: () => void;
  onChanged: (memory: Memory) => void;
  onDeleted: (id: number) => void;
  onOpen: (memory: Memory) => void;
  /** Opens exact keyword browsing for a saved keyword. */
  onBrowseKeyword: (keyword: string) => void;
  vocabulary: readonly KeywordUsage[];
  vocabularyError?: string | null;
}) {
  const [memory, setMemory] = useState(initial);
  const [body, setBody] = useState(initial.body);
  const [pills, setPills] = useState<PillInput>({ keywords: initial.customKeywords, input: "" });
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Photo | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useAutosize(textarea, body, 96);

  // Unfinished keyword text counts as an unsaved change too.
  const dirty =
    body.trim() !== memory.body || !sameKeywordList(pills.keywords, memory.customKeywords) || pills.input.trim() !== "";
  const keywordError = pendingKeywordError(pills.keywords, pills.input);
  const archived = memory.archivedAt !== null;

  const [retry, setRetry] = useState(0);
  const relatedKey = JSON.stringify([memory.id, memory.body, memory.customKeywords, memory.photos, retry]);
  const [related, setRelated] = useState<{ key: string; results: Memory[]; error: string | null } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    relatedMemories(memory.id, controller.signal).then(
      (response) => {
        if (!controller.signal.aborted) setRelated({ key: relatedKey, results: response.results, error: null });
      },
      (caught: unknown) => {
        if (!controller.signal.aborted) setRelated({ key: relatedKey, results: [], error: errorMessage(caught) });
      },
    );
    return () => controller.abort();
  }, [memory.id, relatedKey]);
  const currentRelated = related?.key === relatedKey ? related : null;

  const openRelated = (next: Memory) => {
    if (busy || (dirty && !window.confirm("Discard your changes?"))) return;
    onOpen(next);
  };

  const browseKeyword = (keyword: string) => {
    if (busy || (dirty && !window.confirm("Discard your changes?"))) return;
    onBrowseKeyword(keyword);
  };

  const close = useCallback(() => {
    if (busy) return;
    if (dirty && !window.confirm("Discard your changes?")) return;
    onClose();
  }, [busy, dirty, onClose]);

  async function run(kind: Exclude<Busy, null>, action: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  function apply(updated: Memory) {
    setMemory(updated);
    onChanged(updated);
  }

  const saveBody = () => {
    // Valid unfinished keyword text is saved too; invalid text blocks the whole save so nothing changes partially.
    const committed = applyKeywordInput(pills.keywords, pills.input, true);
    if (committed.input) return;
    setPills(committed);
    return run("save", async () => {
      const updated = await updateMemory(memory.id, { body, customKeywords: committed.keywords });
      apply(updated);
      setBody(updated.body);
      setPills({ keywords: updated.customKeywords, input: "" });
    });
  };

  const cancelEdits = () => {
    setBody(memory.body);
    setPills({ keywords: memory.customKeywords, input: "" });
    setError(null);
  };

  const toggleArchived = () =>
    run("archive", async () => apply(await updateMemory(memory.id, { archived: !archived })));

  const togglePinned = () =>
    run("pin", async () => apply(await updateMemory(memory.id, { pinned: !memory.pinned })));

  const chooseCategory = (category: Category) =>
    run("category", async () => apply(await updateMemory(memory.id, { category })));

  const remove = () => {
    if (!window.confirm("Delete this memory for good? This can't be undone.")) return;
    void run("delete", async () => {
      await deleteMemory(memory.id);
      onDeleted(memory.id);
    });
  };

  const addFiles = (files: File[]) =>
    run("photo", async () => {
      const prepared = [];
      try {
        for (const file of files.slice(0, 10)) prepared.push(await preparePhoto(file));
        apply(await addPhotos(memory.id, prepared));
      } finally {
        prepared.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
      }
    });

  const removePhoto = (photo: Photo) => {
    if (!window.confirm("Remove this photo?")) return;
    void run("photo", async () => apply(await deletePhoto(photo.id)));
  };

  const edited = memory.updatedAt - memory.createdAt > 60_000;

  return (
    <Sheet title="Memory" onClose={close}>
      <p className="text-xs text-stone-500 dark:text-stone-400">
        Saved {formatFullDate(memory.createdAt)}
        {edited && ` · edited ${formatFullDate(memory.updatedAt)}`}
      </p>

      <button type="button" onClick={() => void togglePinned()} disabled={busy !== null}
        aria-pressed={memory.pinned}
        className="mt-3 rounded-full bg-stone-100 px-4 py-2 text-sm font-semibold disabled:opacity-50 dark:bg-stone-800">
        {busy === "pin" ? "Saving…" : memory.pinned ? "Unpin" : "Pin"}
      </button>

      {archived && (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
          Marked outdated. It’s kept, but hidden from search unless “Show outdated” is on.
        </p>
      )}

      <label htmlFor="memory-body" className="sr-only">
        Memory text
      </label>
      <textarea
        id="memory-body"
        ref={textarea}
        value={body}
        disabled={busy === "save"}
        onChange={(event) => setBody(event.target.value)}
        maxLength={10_000}
        placeholder="Add a note to this photo…"
        className="mt-3 block w-full resize-none rounded-xl bg-stone-50 px-3 py-2.5 text-base leading-relaxed ring-1 ring-stone-200 outline-none focus:ring-2 focus:ring-indigo-500 dark:bg-stone-950 dark:ring-stone-800"
      />
      <div className="mt-4">
        <KeywordPills
          id="memory-keywords"
          label="Custom keywords"
          value={pills}
          onChange={setPills}
          vocabulary={vocabulary}
          vocabularyError={vocabularyError}
          disabled={busy === "save"}
        />
      </div>
      {dirty && (
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={cancelEdits}
            disabled={busy !== null}
            className="rounded-full px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void saveBody()}
            disabled={busy !== null || keywordError !== null}
            className="rounded-full bg-indigo-700 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
          >
            {busy === "save" ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
      {memory.customKeywords.length > 0 && (
        <div className="mt-3">
          <p id="browse-keywords-label" className="mb-1 text-xs font-semibold text-stone-500 dark:text-stone-400">
            Browse memories with the same keyword
          </p>
          <ul aria-labelledby="browse-keywords-label" className="flex flex-wrap gap-2">
            {memory.customKeywords.map((keyword) => (
              <li key={keyword}>
                <button
                  type="button"
                  onClick={() => browseKeyword(keyword)}
                  disabled={busy !== null}
                  aria-label={`Show memories labeled ${keyword}`}
                  className="min-h-11 rounded-full bg-white px-3.5 text-sm font-medium text-indigo-800 ring-1 ring-indigo-200 hover:bg-indigo-50 disabled:opacity-50 dark:bg-stone-900 dark:text-indigo-200 dark:ring-indigo-800"
                >
                  {keyword}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {memory.photos.map((photo) => (
          <div key={photo.id} className="relative">
            <button type="button" onClick={() => setViewing(photo)} aria-label="View photo">
              <img
                src={photoUrl(photo.id, "thumb")}
                alt={photo.caption ?? ""}
                className="h-24 w-24 rounded-xl bg-stone-100 object-cover dark:bg-stone-800"
              />
            </button>
            <button
              type="button"
              onClick={() => removePhoto(photo)}
              disabled={busy !== null}
              className="absolute -top-1.5 -right-1.5 rounded-full bg-stone-900 p-1 text-xs text-white shadow disabled:opacity-50"
              aria-label="Remove photo"
            >
              <CloseIcon />
            </button>
          </div>
        ))}
        {busy === "photo" && <div className="h-24 w-24 animate-pulse rounded-xl bg-stone-200 dark:bg-stone-800" />}
      </div>
      {memory.photos.some((photo) => photo.caption) && (
        <ul className="mt-2 space-y-1 text-sm leading-relaxed text-stone-500 dark:text-stone-400">
          {memory.photos.map(
            (photo, index) =>
              photo.caption && (
                <li key={photo.id}>
                  {memory.photos.length > 1 ? `Photo ${index + 1}: ` : "Photo shows: "}
                  {photo.caption}
                </li>
              ),
          )}
        </ul>
      )}
      <div className="mt-2">
        <PhotoButton
          label={memory.photos.length ? "Add photo" : "Add a photo"}
          onFiles={(files) => void addFiles(files)}
          disabled={busy !== null}
        />
      </div>

      <div className="mt-5">
        <p id="category-label" className="mb-2 text-xs font-semibold text-stone-500 dark:text-stone-400">
          Category
          {memory.category && !memory.categorySetByUser && <span className="font-normal"> · sorted automatically</span>}
        </p>
        <div role="radiogroup" aria-labelledby="category-label" className="flex flex-wrap gap-2">
          {CATEGORIES.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={memory.category === option}
              onClick={() => void chooseCategory(option)}
              disabled={busy !== null}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition disabled:opacity-60 ${
                memory.category === option
                  ? "bg-indigo-700 text-white ring-indigo-700 dark:bg-indigo-600 dark:ring-indigo-600"
                  : "bg-white text-stone-700 ring-stone-200 hover:bg-stone-50 dark:bg-stone-900 dark:text-stone-300 dark:ring-stone-700"
              }`}
            >
              {CATEGORY_LABELS[option]}
            </button>
          ))}
        </div>
        {memory.tags.length > 0 && (
          <p className="mt-2 text-sm leading-relaxed text-stone-500 dark:text-stone-400">
            Also found by: {memory.tags.join(", ")}
          </p>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p>}

      <section aria-label="Related memories" className="mt-6 border-t border-stone-100 pt-4 dark:border-stone-800">
        <h2 className="mb-2 text-sm font-semibold">Related memories</h2>
        {!currentRelated ? <p role="status" className="text-sm text-stone-500">Finding related memories…</p>
          : currentRelated.error ? <div>
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">{currentRelated.error}</p>
            <button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-2 rounded-full px-4 py-2 text-sm font-semibold text-indigo-700 dark:text-indigo-300">Try again</button>
          </div>
          : currentRelated.results.length ? <MemoryList memories={currentRelated.results} onOpen={openRelated} />
          : <p className="text-sm text-stone-500">No related memories found.</p>}
      </section>

      <div className="mt-6 flex gap-2 border-t border-stone-100 pt-4 dark:border-stone-800">
        <button
          type="button"
          onClick={() => void toggleArchived()}
          disabled={busy !== null}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-stone-100 px-4 py-2.5 text-sm font-semibold text-stone-800 hover:bg-stone-200 disabled:opacity-50 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700"
        >
          <ArchiveIcon className="text-base" />
          {archived ? "Not outdated" : "Mark outdated"}
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={busy !== null}
          className="inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          <TrashIcon className="text-base" />
          Delete
        </button>
      </div>

      {viewing && <PhotoViewer photo={viewing} onClose={() => setViewing(null)} />}
    </Sheet>
  );
}
