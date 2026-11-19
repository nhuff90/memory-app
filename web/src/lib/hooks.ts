import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Category, KeywordUsage, Memory } from "../../../shared/types";
import { errorMessage, getKeywords, listMemories, searchMemories } from "../api";
import { readVocabulary } from "./keywords";

/** Newest memories first, a page at a time. Reloads from the top whenever `refreshKey` changes. */
export function useRecent({
  archived,
  refreshKey,
  limit = 30,
  category = null,
  photos = false,
  pinned = false,
  keyword = null,
}: {
  archived: boolean;
  refreshKey: number;
  limit?: number;
  category?: Category | null;
  photos?: boolean;
  pinned?: boolean;
  /** Exact custom keyword filter, applied by the server before pagination. */
  keyword?: string | null;
}) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scope = JSON.stringify([archived, category, photos, pinned, keyword]);
  const [listedScope, setListedScope] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setListedScope(scope);
    setLoading(true);
    setMemories([]);
    setCursor(null);
    setError(null);
    listMemories({ archived, limit, category, photos, pinned, keyword })
      .then((page) => {
        if (current !== generation.current) return;
        setMemories(page.memories);
        setCursor(page.nextCursor);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (current === generation.current) setError(errorMessage(caught));
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    return () => { generation.current++; };
  }, [archived, refreshKey, limit, category, photos, pinned, keyword, scope]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const current = generation.current;
    setLoading(true);
    try {
      const page = await listMemories({ cursor, archived, limit, category, photos, pinned, keyword });
      if (current !== generation.current) return;
      setMemories((previous) => {
        const seen = new Set(previous.map((memory) => memory.id));
        return [...previous, ...page.memories.filter((memory) => !seen.has(memory.id))];
      });
      setCursor(page.nextCursor);
    } catch (caught) {
      if (current === generation.current) setError(errorMessage(caught));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [cursor, archived, limit, category, photos, pinned, keyword]);

  // A new filter renders before its effect runs. Never expose the previous filter's cards in that render.
  return listedScope === scope
    ? { memories, hasMore: cursor !== null, loading, error, loadMore }
    : { memories: [], hasMore: false, loading: true, error: null, loadMore };
}

export interface SearchState {
  results: Memory[];
  /** The query these results belong to, which lags the input while a search is in flight. */
  query: string;
  loading: boolean;
  error: string | null;
}

const IDLE: SearchState = { results: [], query: "", loading: false, error: null };

/** Searches as the user types, cancelling outdated requests so results never arrive out of order. */
export function useSearch(
  query: string,
  { archived = false, strict = false, refreshKey = 0, delay = 120, limit, category = null, pinned = false, keyword = null }: {
    archived?: boolean;
    strict?: boolean;
    refreshKey?: number;
    delay?: number;
    limit?: number;
    category?: Category | null;
    pinned?: boolean;
    keyword?: string | null;
  } = {},
): SearchState {
  const trimmed = query.trim();
  const scope = JSON.stringify([trimmed, archived, strict, refreshKey, limit, category, pinned, keyword]);
  const [state, setState] = useState<SearchState & { scope: string }>({ ...IDLE, scope: "" });

  useEffect(() => {
    if (!trimmed) {
      setState({ ...IDLE, scope });
      return;
    }
    const controller = new AbortController();
    setState({ results: [], query: trimmed, loading: true, error: null, scope });
    const timer = setTimeout(() => {
      searchMemories(trimmed, { archived, strict, limit, category, pinned, keyword, signal: controller.signal })
        .then((response) => {
          if (!controller.signal.aborted) setState({ results: response.results, query: trimmed, loading: false, error: null, scope });
        })
        .catch((caught: unknown) => {
          if (!controller.signal.aborted) setState((previous) => ({ ...previous, loading: false, error: errorMessage(caught) }));
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, archived, strict, refreshKey, delay, limit, category, pinned, keyword, scope]);

  return state.scope === scope ? state : trimmed ? { ...IDLE, query: trimmed, loading: true } : IDLE;
}

const VOCABULARY_KEY = "recall:keyword-vocabulary";

function cachedVocabulary(): KeywordUsage[] {
  try {
    return readVocabulary(JSON.parse(localStorage.getItem(VOCABULARY_KEY) ?? "null"));
  } catch {
    return [];
  }
}

/**
 * The user's keyword vocabulary for suggestions, refreshed whenever memories change. Suggestions are optional:
 * on failure (offline, older server) the last cached vocabulary is used and capture keeps working.
 */
export function useKeywordVocabulary(refreshKey: number, active: boolean): { vocabulary: KeywordUsage[]; error: string | null } {
  const [state, setState] = useState(() => ({ vocabulary: cachedVocabulary(), error: null as string | null }));
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    getKeywords(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        const vocabulary = readVocabulary(data);
        try {
          localStorage.setItem(VOCABULARY_KEY, JSON.stringify({ keywords: vocabulary }));
        } catch {
          // Storage full or unavailable: suggestions still work for this session.
        }
        setState({ vocabulary, error: null });
      },
      (caught: unknown) => {
        if (!controller.signal.aborted) setState((previous) => ({ vocabulary: previous.vocabulary, error: errorMessage(caught) }));
      },
    );
    return () => controller.abort();
  }, [refreshKey, active]);
  return state;
}

/** Grows a textarea to fit its text. */
export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string, minHeight = 0): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.max(element.scrollHeight, minHeight)}px`;
  }, [ref, value, minHeight]);
}
