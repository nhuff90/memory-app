import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { CATEGORY_LABELS, type Category, type Memory } from "../../../shared/types";
import { askQuestion, errorMessage } from "../api";
import { useRecent, useSearch } from "../lib/hooks";
import { AnswerCard, type AnswerState } from "./AnswerCard";
import { CloseIcon, SearchIcon, SparkIcon } from "./icons";
import { MemoryList } from "./MemoryCard";
import { PeopleGrid } from "./PeopleGrid";

const FILTERS: (Category | null)[] = [null, "people", "things", "work", "hobbies"];

function orList(items: string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")}${items.length > 2 ? "," : ""} or ${items.at(-1)}`;
}

export function RecallTab({
  inputRef,
  refreshKey,
  aiEnabled,
  onOpen,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  refreshKey: number;
  aiEnabled: boolean;
  onOpen: (memory: Memory) => void;
}) {
  const [query, setQuery] = useState("");
  const [showOutdated, setShowOutdated] = useState(false);
  const [category, setCategory] = useState<Category | null>(null);
  // Tagged with the refresh count it was asked at: once any memory changes, the answer may be stale.
  const [asked, setAsked] = useState<{ state: AnswerState; refreshKey: number } | null>(null);
  const asking = useRef<AbortController | null>(null);
  const search = useSearch(query, { archived: showOutdated, refreshKey, category });
  const recent = useRecent({ archived: showOutdated, refreshKey, category });
  const trimmed = query.trim();
  const searching = trimmed.length > 0;
  const showFaces = category === "people" && !searching;
  // Faces already appear in the grid above the list.
  const recentMemories = showFaces ? recent.memories.filter((memory) => memory.photos.length === 0) : recent.memories;
  const answer = asked && asked.refreshKey === refreshKey && asked.state.question === trimmed ? asked.state : null;
  const answered = answer?.status === "done" ? answer.response : null;
  const usedIds = useMemo(() => new Set(answered?.usedIds ?? []), [answered]);

  useEffect(() => () => asking.current?.abort(), []);

  function ask() {
    if (!trimmed) return;
    asking.current?.abort();
    const controller = new AbortController();
    asking.current = controller;
    const question = trimmed;
    const settle = (state: AnswerState) => {
      if (!controller.signal.aborted) setAsked({ state, refreshKey });
    };
    settle({ question, status: "loading" });
    askQuestion(question, controller.signal).then(
      (response) => settle({ question, status: "done", response }),
      (error: unknown) => settle({ question, status: "error", message: errorMessage(error) }),
    );
  }

  function changeQuery(next: string) {
    setQuery(next);
    if (asked && next.trim() !== asked.state.question) {
      asking.current?.abort();
      setAsked(null);
    }
  }

  return (
    <section className="pt-4">
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (aiEnabled) ask();
          inputRef.current?.blur();
        }}
        className="relative"
      >
        <SearchIcon className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-lg text-stone-400" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => changeQuery(event.target.value)}
          placeholder={aiEnabled ? "Search or ask a question" : "Search your memories"}
          aria-label={aiEnabled ? "Search or ask a question" : "Search your memories"}
          enterKeyHint={aiEnabled && searching ? "go" : "search"}
          autoComplete="off"
          autoCorrect="off"
          className={`w-full rounded-2xl bg-white py-3 pl-11 text-base shadow-sm ring-1 ring-stone-200 outline-none placeholder:text-stone-400 focus:ring-2 focus:ring-indigo-500 dark:bg-stone-900 dark:ring-stone-800 [&::-webkit-search-cancel-button]:hidden ${
            aiEnabled && searching ? "pr-28" : "pr-11"
          }`}
        />
        {query && (
          <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center">
            <button
              type="button"
              onClick={() => {
                changeQuery("");
                inputRef.current?.focus();
              }}
              className="rounded-full p-2 text-stone-400 hover:text-stone-600"
              aria-label="Clear search"
            >
              <CloseIcon />
            </button>
            {aiEnabled && searching && (
              <button
                type="submit"
                disabled={answer?.status === "loading"}
                className="flex items-center gap-1 rounded-xl bg-indigo-700 py-1.5 pr-3 pl-2.5 text-sm font-semibold text-white hover:bg-indigo-800 disabled:opacity-60"
              >
                <SparkIcon />
                Ask
              </button>
            )}
          </div>
        )}
      </form>

      <div role="group" aria-label="Show only" className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none]">
        {FILTERS.map((filter) => (
          <button
            key={filter ?? "all"}
            type="button"
            aria-pressed={category === filter}
            onClick={() => setCategory(filter)}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 transition ${
              category === filter
                ? "bg-indigo-700 text-white ring-indigo-700 dark:bg-indigo-600 dark:ring-indigo-600"
                : "bg-white text-stone-700 ring-stone-200 hover:bg-stone-50 dark:bg-stone-900 dark:text-stone-300 dark:ring-stone-800"
            }`}
          >
            {filter ? CATEGORY_LABELS[filter] : "All"}
          </button>
        ))}
      </div>

      {answer && <AnswerCard state={answer} onRetry={ask} />}

      <div className="mt-3 mb-2 flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold text-stone-500 dark:text-stone-400">
          {searching
            ? search.loading && search.results.length === 0
              ? "Searching…"
              : "Results"
            : category
              ? CATEGORY_LABELS[category]
              : "Recent"}
        </h2>
        <label className="flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
          <input
            type="checkbox"
            checked={showOutdated}
            onChange={(event) => setShowOutdated(event.target.checked)}
            className="h-4 w-4 accent-indigo-700"
          />
          Show outdated
        </label>
      </div>

      {answered && answered.results.length > 0 ? (
        <MemoryList memories={answered.results} query={trimmed} highlightIds={usedIds} onOpen={onOpen} />
      ) : searching ? (
        search.error ? (
          <p className="px-1 text-sm text-red-700 dark:text-red-400">{search.error}</p>
        ) : search.results.length > 0 ? (
          <MemoryList memories={search.results} query={search.query} onOpen={onOpen} />
        ) : (
          !search.loading &&
          !answered && (
            <p className="px-1 text-sm leading-relaxed text-stone-500">
              Nothing found for “{trimmed}”{category ? ` in ${CATEGORY_LABELS[category]}` : ""}.{" "}
              {orList([
                "Try a different word",
                ...(category ? ["tap All"] : []),
                ...(showOutdated ? [] : ["turn on Show outdated"]),
                ...(aiEnabled ? ["tap Ask"] : []),
              ])}
              .
            </p>
          )
        )
      ) : recent.error && recent.memories.length === 0 ? (
        <p className="px-1 text-sm text-stone-500">{recent.error}</p>
      ) : (
        <>
          {showFaces && <PeopleGrid archived={showOutdated} refreshKey={refreshKey} onOpen={onOpen} />}
          <MemoryList memories={recentMemories} onOpen={onOpen} />
          {!recent.loading && recent.memories.length === 0 && (
            <p className="px-1 text-sm leading-relaxed text-stone-500">
              {category
                ? `Nothing in ${CATEGORY_LABELS[category]} yet. ${
                    aiEnabled ? "New memories are sorted automatically." : "Open any memory to choose its category."
                  }`
                : "Nothing saved yet."}
            </p>
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
        </>
      )}
    </section>
  );
}
