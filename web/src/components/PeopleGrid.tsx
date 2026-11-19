import { useCallback, useState } from "react";
import { photoUrl, type Memory } from "../../../shared/types";
import { personLabel } from "../lib/format";
import { useRecent } from "../lib/hooks";
import { PracticeSheet } from "./PracticeSheet";

/** Faces first: every People memory that has a photo, as a grid of thumbnails with names. */
export function PeopleGrid({
  archived,
  refreshKey,
  keyword = null,
  onOpen,
}: {
  archived: boolean;
  refreshKey: number;
  /** The active exact keyword filter, which this photo view respects too. */
  keyword?: string | null;
  onOpen: (memory: Memory) => void;
}) {
  const faces = useRecent({ archived, refreshKey, category: "people", photos: true, limit: 60, keyword });
  const [practicing, setPracticing] = useState(false);
  const stopPracticing = useCallback(() => setPracticing(false), []);
  if (faces.memories.length === 0) return null;
  const named = faces.memories.filter((memory) => memory.archivedAt === null && personLabel(memory.body)).length;

  return (
    <div className="mb-5">
      {named >= 2 && (
        <button
          type="button"
          onClick={() => setPracticing(true)}
          className="mb-3 w-full rounded-2xl bg-indigo-50 py-2.5 text-sm font-semibold text-indigo-800 ring-1 ring-indigo-100 hover:bg-indigo-100 dark:bg-indigo-950/40 dark:text-indigo-200 dark:ring-indigo-900"
        >
          Who’s this? Practice names
        </button>
      )}
      <ul className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4">
        {faces.memories.map((memory) => (
          <li key={memory.id}>
            <button type="button" onClick={() => onOpen(memory)} className="group block w-full text-left">
              <img
                src={photoUrl(memory.photos[0]!.id, "thumb")}
                alt=""
                loading="lazy"
                className="aspect-square w-full rounded-2xl bg-stone-200 object-cover ring-1 ring-stone-200 transition group-hover:opacity-90 dark:bg-stone-800 dark:ring-stone-800"
              />
              <span className="mt-1.5 line-clamp-2 text-sm leading-snug font-medium text-stone-800 dark:text-stone-200">
                {personLabel(memory.body) || "No name yet"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {faces.hasMore && (
        <button
          type="button"
          onClick={() => void faces.loadMore()}
          disabled={faces.loading}
          className="mt-3 w-full rounded-full py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-stone-900"
        >
          {faces.loading ? "Loading…" : "More faces"}
        </button>
      )}
      {practicing && <PracticeSheet onClose={stopPracticing} />}
    </div>
  );
}
