import { photoUrl, type Memory } from "../../../shared/types";
import { formatWhen } from "../lib/format";
import { Highlight } from "./Highlight";

export function MemoryCard({
  memory,
  query = "",
  onOpen,
  highlighted = false,
}: {
  memory: Memory;
  query?: string;
  onOpen: (memory: Memory) => void;
  highlighted?: boolean;
}) {
  const extraPhotos = memory.photos.length - 4;
  const captions = memory.body
    ? ""
    : memory.photos
        .map((photo) => photo.caption)
        .filter(Boolean)
        .join(" ");
  return (
    <button
      type="button"
      onClick={() => onOpen(memory)}
      className={`block w-full rounded-2xl bg-white p-3.5 text-left shadow-sm ring-1 transition active:scale-[0.99] dark:bg-stone-900 ${
        highlighted ? "ring-2 ring-indigo-500" : "ring-stone-200 dark:ring-stone-800"
      }`}
    >
      {memory.body && (
        <p className="line-clamp-5 text-[15px] leading-snug break-words whitespace-pre-wrap">
          <Highlight text={memory.body} query={query} />
        </p>
      )}
      {captions && (
        <p className="line-clamp-3 text-[15px] leading-snug break-words text-stone-500 dark:text-stone-400">
          <Highlight text={captions} query={query} />
        </p>
      )}
      {memory.photos.length > 0 && (
        <div className={`flex gap-2 ${memory.body || captions ? "mt-2.5" : ""}`}>
          {memory.photos.slice(0, 4).map((photo) => (
            <img
              key={photo.id}
              src={photoUrl(photo.id, "thumb")}
              alt=""
              loading="lazy"
              className="h-16 w-16 rounded-lg bg-stone-100 object-cover dark:bg-stone-800"
            />
          ))}
          {extraPhotos > 0 && (
            <span className="flex h-16 w-12 items-center justify-center text-sm text-stone-500">+{extraPhotos}</span>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
        <span>{formatWhen(memory.createdAt)}</span>
        {memory.pinned && <span aria-label="Pinned" title="Pinned">📌</span>}
        {(memory.customKeywords ?? []).map((keyword) => (
          <span key={keyword} className="rounded-full bg-indigo-50 px-2 py-0.5 font-medium text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200">
            {keyword}
          </span>
        ))}
        {memory.archivedAt !== null && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
            Outdated
          </span>
        )}
      </div>
    </button>
  );
}

export function MemoryList({
  memories,
  query,
  onOpen,
  highlightIds,
}: {
  memories: Memory[];
  query?: string;
  onOpen: (memory: Memory) => void;
  highlightIds?: ReadonlySet<number>;
}) {
  return (
    <ul className="space-y-2.5">
      {memories.map((memory) => (
        <li key={memory.id}>
          <MemoryCard memory={memory} query={query} onOpen={onOpen} highlighted={highlightIds?.has(memory.id)} />
        </li>
      ))}
    </ul>
  );
}
