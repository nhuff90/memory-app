import { useEffect, useRef, useState, type RefObject } from "react";
import type { Memory } from "../../../shared/types";
import { errorMessage, updateMemory } from "../api";
import { useAutosize, useRecent, useSearch } from "../lib/hooks";
import { newClientId } from "../lib/ids";
import { preparePhoto, type PreparedPhoto } from "../lib/images";
import { getOutbox, useOutbox, type OutboxItem } from "../lib/outbox";
import { AlreadySaved } from "./AlreadySaved";
import { CheckIcon, CloseIcon } from "./icons";
import { MemoryList } from "./MemoryCard";
import { PendingList } from "./PendingList";
import { PhotoButton } from "./PhotoButton";

const DRAFT_KEY = "recall:draft";
const MAX_PHOTOS = 10;
const MAX_LENGTH = 10_000;
/** Shorter drafts match too loosely to be worth showing. */
const SIMILAR_MIN_LENGTH = 4;

interface PendingPhoto extends PreparedPhoto {
  key: string;
}

type Status =
  | { kind: "saved" | "error"; message: string }
  | { kind: "outdated"; message: string; memoryId: number }
  | null;

export function RememberTab({
  inputRef,
  refreshKey,
  onOpen,
  onChanged,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  refreshKey: number;
  onOpen: (memory: Memory) => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(() => localStorage.getItem(DRAFT_KEY) ?? "");
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [saving, setSaving] = useState(false);
  const [marking, setMarking] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const pending = useOutbox();
  const recent = useRecent({ archived: false, refreshKey, limit: 20 });
  const similar = useSearch(draft.trim().length >= SIMILAR_MIN_LENGTH ? draft : "", {
    strict: true,
    limit: 3,
    delay: 400,
    refreshKey,
  });
  useAutosize(inputRef, draft, 112);

  useEffect(() => {
    if (draft) localStorage.setItem(DRAFT_KEY, draft);
    else localStorage.removeItem(DRAFT_KEY);
  }, [draft]);

  useEffect(() => () => photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.previewUrl)), []);

  useEffect(() => {
    if (status === null || status.kind === "error") return;
    const timer = setTimeout(() => setStatus(null), status.kind === "outdated" ? 6000 : 2500);
    return () => clearTimeout(timer);
  }, [status]);

  const canSave = (draft.trim().length > 0 || photos.length > 0) && preparing === 0 && !saving;

  async function addFiles(files: File[]) {
    setStatus(null);
    const room = MAX_PHOTOS - photos.length - preparing;
    if (files.length > room) setStatus({ kind: "error", message: `Up to ${MAX_PHOTOS} photos per memory.` });
    const accepted = files.slice(0, Math.max(0, room));
    setPreparing((count) => count + accepted.length);
    for (const file of accepted) {
      try {
        const prepared = await preparePhoto(file);
        setPhotos((list) => [...list, { ...prepared, key: newClientId() }]);
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

  function clearDraft() {
    photos.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
    setPhotos([]);
    setDraft("");
  }

  async function save() {
    if (!canSave) return;
    const body = draft;
    const sent = photos;
    setSaving(true);
    setStatus(null);
    try {
      const result = await getOutbox().save({
        clientId: newClientId(),
        body,
        createdAt: Date.now(),
        photos: sent.map(({ full, thumb }) => ({ full, thumb })),
      });
      // Anything typed or added while the upload was in flight belongs to the next memory.
      setDraft((current) => (current === body ? "" : current));
      setPhotos((list) => list.filter((photo) => !sent.includes(photo)));
      sent.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
      if (result === "sent") setStatus({ kind: "saved", message: "Saved." });
      else if (result === "queued") setStatus({ kind: "saved", message: "Saved on this phone. It will upload when you're online." });
      else setStatus({ kind: "error", message: "Recall couldn't save that. It's below, so you can fix it." });
      inputRef.current?.focus();
    } catch (error) {
      setStatus({ kind: "error", message: errorMessage(error) });
    } finally {
      setSaving(false);
    }
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

  function editPending(item: OutboxItem) {
    if ((draft.trim() || photos.length > 0) && !window.confirm("Replace what you're typing with this memory?")) return;
    clearDraft();
    setDraft(item.body);
    setPhotos(item.photos.map((photo) => ({ ...photo, previewUrl: URL.createObjectURL(photo.thumb), key: newClientId() })));
    setStatus(null);
    void getOutbox().discard(item.clientId);
    inputRef.current?.focus();
  }

  function discardPending(item: OutboxItem) {
    if (window.confirm("Discard this memory? It was never saved.")) void getOutbox().discard(item.clientId);
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
        {status?.kind === "error" && <p className="text-red-700 dark:text-red-400">{status.message}</p>}
      </div>

      <PendingList items={pending} onEdit={editPending} onDiscard={discardPending} />

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
