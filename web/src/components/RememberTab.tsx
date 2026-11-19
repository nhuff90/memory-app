import { useEffect, useRef, useState, type RefObject } from "react";
import type { KeywordUsage, Memory } from "../../../shared/types";
import { errorMessage, updateMemory } from "../api";
import {
  DRAFT_TEXT_KEY,
  loadDraftKeywords,
  loadDraftPhotos,
  putDraftPhoto,
  removeDraftPhoto,
  saveDraftKeywords,
} from "../lib/draft";
import { useAutosize, useRecent, useSearch } from "../lib/hooks";
import { newClientId } from "../lib/ids";
import { preparePhoto, type PreparedPhoto } from "../lib/images";
import { keywordKey } from "../../../shared/keywords";
import { applyKeywordInput, pendingKeywordError, type PillInput } from "../lib/keywords";
import { canEditHeld, getOutbox, useOutbox, type OutboxItem, type Resolution } from "../lib/outbox";
import { AlreadySaved } from "./AlreadySaved";
import { CheckIcon, CloseIcon } from "./icons";
import { KeywordPills } from "./KeywordPills";
import { MemoryList } from "./MemoryCard";
import { PendingList } from "./PendingList";
import { PhotoButton } from "./PhotoButton";

const MAX_PHOTOS = 10;
const MAX_LENGTH = 10_000;
/** Shorter drafts match too loosely to be worth showing. */
const SIMILAR_MIN_LENGTH = 4;

interface PendingPhoto extends PreparedPhoto {
  key: string;
  addedAt: number;
}

type Status =
  | { kind: "saved" | "error" | "held"; message: string }
  | { kind: "outdated"; message: string; memoryId: number }
  | null;

export function RememberTab({
  inputRef,
  refreshKey,
  vocabulary,
  vocabularyError,
  onOpen,
  onChanged,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  refreshKey: number;
  vocabulary: readonly KeywordUsage[];
  vocabularyError: string | null;
  onOpen: (memory: Memory) => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(() => localStorage.getItem(DRAFT_TEXT_KEY) ?? "");
  const [pills, setPills] = useState<PillInput>(loadDraftKeywords);
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [photosLoaded, setPhotosLoaded] = useState(false);
  const [preparing, setPreparing] = useState(0);
  const [saving, setSaving] = useState(false);
  const [marking, setMarking] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const persistedPhotos = useRef(new Set<string>());
  const pillsRef = useRef(pills);
  pillsRef.current = pills;
  /** The keywords of the capture being uploaded, and which of them the user selected again meanwhile. */
  const inFlight = useRef<{ keys: Set<string>; readded: Set<string> } | null>(null);
  const pending = useOutbox();
  const recent = useRecent({ archived: false, refreshKey, limit: 20 });
  const similar = useSearch(draft.trim().length >= SIMILAR_MIN_LENGTH ? draft : "", {
    strict: true,
    limit: 3,
    delay: 400,
    refreshKey,
  });
  useAutosize(inputRef, draft, 112);
  const keywordError = pendingKeywordError(pills.keywords, pills.input);

  useEffect(() => {
    if (draft) localStorage.setItem(DRAFT_TEXT_KEY, draft);
    else localStorage.removeItem(DRAFT_TEXT_KEY);
  }, [draft]);

  useEffect(() => saveDraftKeywords(pills), [pills]);

  // Draft photos live in IndexedDB so a reload or a closed app keeps them with the text and keywords.
  useEffect(() => {
    let cancelled = false;
    void loadDraftPhotos().then((stored) => {
      if (cancelled) return;
      stored.forEach((photo) => persistedPhotos.current.add(photo.key));
      const restored = stored.map((photo) => ({ ...photo, previewUrl: URL.createObjectURL(photo.thumb) }));
      setPhotos((list) => [...restored, ...list.filter((photo) => !persistedPhotos.current.has(photo.key))]);
      setPhotosLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!photosLoaded) return;
    const current = new Set(photos.map((photo) => photo.key));
    for (const photo of photos) {
      if (persistedPhotos.current.has(photo.key)) continue;
      persistedPhotos.current.add(photo.key);
      void putDraftPhoto({ key: photo.key, full: photo.full, thumb: photo.thumb, addedAt: photo.addedAt });
    }
    for (const key of [...persistedPhotos.current]) {
      if (current.has(key)) continue;
      persistedPhotos.current.delete(key);
      void removeDraftPhoto(key);
    }
  }, [photos, photosLoaded]);

  useEffect(() => () => photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.previewUrl)), []);

  useEffect(() => {
    if (status === null || status.kind === "error" || status.kind === "held") return;
    const timer = setTimeout(() => setStatus(null), status.kind === "outdated" ? 6000 : 2500);
    return () => clearTimeout(timer);
  }, [status]);

  const canSave = (draft.trim().length > 0 || photos.length > 0) && preparing === 0 && !saving && keywordError === null;

  async function addFiles(files: File[]) {
    setStatus(null);
    const room = MAX_PHOTOS - photos.length - preparing;
    if (files.length > room) setStatus({ kind: "error", message: `Up to ${MAX_PHOTOS} photos per memory.` });
    const accepted = files.slice(0, Math.max(0, room));
    setPreparing((count) => count + accepted.length);
    for (const file of accepted) {
      try {
        const prepared = await preparePhoto(file);
        setPhotos((list) => [...list, { ...prepared, key: newClientId(), addedAt: Date.now() }]);
      } catch (error) {
        setStatus({ kind: "error", message: errorMessage(error) });
      } finally {
        setPreparing((count) => count - 1);
      }
    }
  }

  function removePhoto(key: string) {
    setPhotos((list) => {
      const photo = list.find((item) => item.key === key);
      if (photo) URL.revokeObjectURL(photo.previewUrl);
      return list.filter((item) => item.key !== key);
    });
  }

  async function save() {
    if (!canSave) return;
    // Valid unfinished keyword text is added before saving; invalid text blocks the save (and stays visible).
    const committed = applyKeywordInput(pills.keywords, pills.input, true);
    if (committed.input) return;
    const body = draft;
    const sent = photos;
    const sentKeywords = committed.keywords;
    const flight = { keys: new Set(sentKeywords.map(keywordKey)), readded: new Set<string>() };
    inFlight.current = flight;
    pillsRef.current = committed;
    setPills(committed);
    setSaving(true);
    setStatus(null);
    try {
      const result = await getOutbox().save({
        clientId: newClientId(),
        body,
        createdAt: Date.now(),
        photos: sent.map(({ full, thumb }) => ({ full, thumb })),
        customKeywords: sentKeywords,
      });
      // Anything typed, selected or added while the upload was in flight belongs to the next memory.
      setDraft((current) => (current === body ? "" : current));
      // The saved memory's keywords leave the form, except any the user removed and selected again meanwhile;
      // pills added and text typed during the upload stay for the next one.
      const leaving = (keyword: string) => flight.keys.has(keywordKey(keyword)) && !flight.readded.has(keywordKey(keyword));
      setPills((current) => ({ keywords: current.keywords.filter((keyword) => !leaving(keyword)), input: current.input }));
      setPhotos((list) => list.filter((photo) => !sent.includes(photo)));
      sent.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
      if (result === "sent") setStatus({ kind: "saved", message: "Saved." });
      else if (result === "queued") setStatus({ kind: "saved", message: "Saved on this phone. It will upload when you're online." });
      else if (result === "held") {
        setStatus({
          kind: "held",
          message: "Kept on this phone: Recall couldn't confirm its keywords. It's below, held until you recover it.",
        });
      } else setStatus({ kind: "error", message: "Recall couldn't save that. It's below, so you can fix it." });
      inputRef.current?.focus();
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    } finally {
      inFlight.current = null;
      setSaving(false);
    }
  }

  /** Pill changes from the user. During an upload, notes keywords of the sent memory that were selected again. */
  function changePills(next: PillInput) {
    const flight = inFlight.current;
    if (flight) {
      const before = new Set(pillsRef.current.keywords.map(keywordKey));
      for (const keyword of next.keywords) {
        const key = keywordKey(keyword);
        if (!before.has(key) && flight.keys.has(key)) flight.readded.add(key);
      }
    }
    pillsRef.current = next;
    setPills(next);
  }

  async function setOutdated(memoryId: number, archived: boolean) {
    setMarking(true);
    try {
      await updateMemory(memoryId, { archived });
      onChanged();
      setStatus(archived ? { kind: "outdated", message: "Marked outdated.", memoryId } : null);
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    } finally {
      setMarking(false);
    }
  }

  async function editPending(item: OutboxItem) {
    // A capture that may already be on the server is only resolvable by its original clientId, never re-saved.
    if (!canEditHeld(item)) return;
    const hasDraft = draft.trim() || photos.length > 0 || pills.keywords.length > 0 || pills.input.trim();
    if (hasDraft && !window.confirm("Replace what you're typing with this memory?")) return;
    photos.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
    const restored = item.photos.map((photo, index) => ({
      ...photo,
      previewUrl: URL.createObjectURL(photo.thumb),
      key: newClientId(),
      addedAt: Date.now() + index,
    }));
    const keywords = { keywords: item.customKeywords ?? [], input: "" };
    // Write the draft durably before the queued copy is removed, so nothing is lost if the app closes now.
    localStorage.setItem(DRAFT_TEXT_KEY, item.body);
    saveDraftKeywords(keywords);
    await Promise.all(restored.map((photo) => putDraftPhoto({ key: photo.key, full: photo.full, thumb: photo.thumb, addedAt: photo.addedAt })));
    restored.forEach((photo) => persistedPhotos.current.add(photo.key));
    setDraft(item.body);
    setPills(keywords);
    setPhotos(restored);
    setStatus(null);
    await getOutbox().discard(item.clientId);
    inputRef.current?.focus();
  }

  async function recoverPending(item: OutboxItem, resolution?: Resolution) {
    const result = await getOutbox().recover(item.clientId, resolution);
    setStatus(
      result === "recovered"
        ? {
            kind: "saved",
            message: resolution === "keep" ? "Kept Recall's version of the memory." : "Recovered. The memory is saved with its keywords.",
          }
        : { kind: "held", message: "Still held on this phone. Nothing was lost; see the note below." },
    );
  }

  function discardPending(item: OutboxItem) {
    const message =
      item.held && !canEditHeld(item)
        ? "Recall may already have this memory without these keywords. Discard the copy kept on this phone?"
        : "Discard this memory? It was never saved.";
    if (window.confirm(message)) void getOutbox().discard(item.clientId);
  }

  return (
    <section className="pt-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="rounded-2xl bg-white shadow-sm ring-1 ring-stone-200 focus-within:ring-2 focus-within:ring-indigo-500 dark:bg-stone-900 dark:ring-stone-800"
      >
        <label htmlFor="remember-input" className="sr-only">
          What do you want to remember?
        </label>
        <textarea
          id="remember-input"
          ref={inputRef}
          value={draft}
          maxLength={MAX_LENGTH}
          placeholder="What do you want to remember?"
          onChange={(event) => {
            setDraft(event.target.value);
            if (status?.kind === "error") setStatus(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
          className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-base leading-relaxed outline-none placeholder:text-stone-400"
        />
        {(photos.length > 0 || preparing > 0) && (
          <div className="flex flex-wrap gap-2 px-4 pb-2">
            {photos.map((photo) => (
              <div key={photo.key} className="relative">
                <img src={photo.previewUrl} alt="" className="h-20 w-20 rounded-xl object-cover" />
                <button
                  type="button"
                  onClick={() => removePhoto(photo.key)}
                  className="absolute -top-1.5 -right-1.5 rounded-full bg-stone-900 p-1 text-xs text-white shadow"
                  aria-label="Remove photo"
                >
                  <CloseIcon />
                </button>
              </div>
            ))}
            {Array.from({ length: preparing }, (_, index) => (
              <div key={`preparing-${index}`} className="h-20 w-20 animate-pulse rounded-xl bg-stone-200 dark:bg-stone-800" />
            ))}
          </div>
        )}
        <div className="px-4 pb-3">
          <KeywordPills
            id="remember-keywords"
            label="Keywords"
            value={pills}
            onChange={changePills}
            vocabulary={vocabulary}
            vocabularyError={vocabularyError}
          />
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-stone-100 px-2 py-2 dark:border-stone-800">
          <PhotoButton onFiles={(files) => void addFiles(files)} disabled={photos.length + preparing >= MAX_PHOTOS} />
          <button
            type="submit"
            disabled={!canSave}
            className="rounded-full bg-indigo-700 px-6 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-800 disabled:bg-stone-300 disabled:text-stone-500 dark:disabled:bg-stone-800 dark:disabled:text-stone-500"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>

      {draft.trim().length >= SIMILAR_MIN_LENGTH && (
        <AlreadySaved
          memories={similar.results}
          query={similar.query}
          disabled={marking}
          onOpen={onOpen}
          onOutdated={(memory) => void setOutdated(memory.id, true)}
        />
      )}

      <div className="mt-2 min-h-6 px-1 text-sm" aria-live="polite">
        {status?.kind === "saved" && (
          <p className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            <CheckIcon /> {status.message}
          </p>
        )}
        {status?.kind === "outdated" && (
          <p className="text-stone-600 dark:text-stone-300">
            {status.message}{" "}
            <button
              type="button"
              onClick={() => void setOutdated(status.memoryId, false)}
              className="font-semibold text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300"
            >
              Undo
            </button>
          </p>
        )}
        {status?.kind === "held" && <p className="text-amber-800 dark:text-amber-300">{status.message}</p>}
        {status?.kind === "error" && <p className="text-red-700 dark:text-red-400">{status.message}</p>}
      </div>

      <PendingList
        items={pending}
        onEdit={(item) => void editPending(item)}
        onDiscard={discardPending}
        onRecover={(item, resolution) => recoverPending(item, resolution)}
      />

      <h2 className="mt-3 mb-2 px-1 text-sm font-semibold text-stone-500 dark:text-stone-400">Recent</h2>
      {recent.error && recent.memories.length === 0 ? (
        <p className="px-1 text-sm text-stone-500">{recent.error}</p>
      ) : !recent.loading && recent.memories.length === 0 && pending.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-stone-300 p-4 text-sm leading-relaxed text-stone-500 dark:border-stone-700">
          Nothing saved yet. Jot down anything, even a fragment like “ipad in gym” or “Sarah’s kids are Emma and Jake.”
        </p>
      ) : (
        <MemoryList memories={recent.memories} onOpen={onOpen} />
      )}
      {recent.hasMore && (
        <button
          type="button"
          onClick={() => void recent.loadMore()}
          disabled={recent.loading}
          className="mt-3 w-full rounded-full py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-stone-900"
        >
          {recent.loading ? "Loading…" : "Show more"}
        </button>
      )}
    </section>
  );
}
