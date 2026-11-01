import type { Memory } from "../../../shared/types";
import { formatWhen } from "../lib/format";
import { Highlight } from "./Highlight";
import { ArchiveIcon } from "./icons";

/** Close matches for the note being typed, so an old answer can be retired in one tap. */
export function AlreadySaved({
  memories,
  query,
  disabled,
  onOpen,
  onOutdated,
}: {
  memories: Memory[];
  query: string;
  disabled: boolean;
  onOpen: (memory: Memory) => void;
  onOutdated: (memory: Memory) => void;
}) {
  if (memories.length === 0) return null;
  return (
    <section
      aria-label="Already saved"
      className="mt-3 rounded-2xl bg-amber-50 p-2.5 ring-1 ring-amber-200/80 dark:bg-amber-950/30 dark:ring-amber-900/50"
    >
      <p className="px-1.5 pb-2 text-xs font-semibold text-amber-900 dark:text-amber-200">
        Already saved. Mark it outdated if this replaces it.
      </p>
      <ul className="space-y-2">
        {memories.map((memory) => (
          <li key={memory.id} className="flex items-center gap-2 rounded-xl bg-white py-2.5 pr-2 pl-3 dark:bg-stone-900">
            <button type="button" onClick={() => onOpen(memory)} className="min-w-0 flex-1 text-left">
              <p className="line-clamp-2 text-[15px] leading-snug">
                <Highlight text={memory.body || "Photo"} query={query} />
              </p>
              <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{formatWhen(memory.createdAt)}</p>
            </button>
            <button
              type="button"
              onClick={() => onOutdated(memory)}
              disabled={disabled}
              aria-label={`Mark outdated: ${memory.body.slice(0, 60)}`}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-stone-100 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-200 disabled:opacity-50 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700"
            >
              <ArchiveIcon />
              Outdated
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
