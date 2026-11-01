import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Category, Memory } from "../../../shared/types";
import { errorMessage, listMemories, searchMemories } from "../api";

/** Newest memories first, a page at a time. Reloads from the top whenever `refreshKey` changes. */
export function useRecent({
  archived,
  refreshKey,
  limit = 30,
  category = null,
  photos = false,
}: {
  archived: boolean;
  refreshKey: number;
  limit?: number;
  category?: Category | null;
  photos?: boolean;
}) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    listMemories({ archived, limit, category, photos })
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
  }, [archived, refreshKey, limit, category, photos]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    const current = generation.current;
    setLoading(true);
    try {
      const page = await listMemories({ cursor, archived, limit, category, photos });
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
  }, [cursor, archived, limit, category, photos]);

  return { memories, hasMore: cursor !== null, loading, error, loadMore };
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
  { archived = false, strict = false, refreshKey = 0, delay = 120, limit, category = null }: {
    archived?: boolean;
    strict?: boolean;
    refreshKey?: number;
    delay?: number;
    limit?: number;
    category?: Category | null;
  } = {},
): SearchState {
  const [state, setState] = useState<SearchState>(IDLE);
  const trimmed = query.trim();

  useEffect(() => {
    if (!trimmed) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true }));
    const timer = setTimeout(() => {
      searchMemories(trimmed, { archived, strict, limit, category, signal: controller.signal })
        .then((response) => setState({ results: response.results, query: trimmed, loading: false, error: null }))
        .catch((caught: unknown) => {
          if (!controller.signal.aborted) setState((previous) => ({ ...previous, loading: false, error: errorMessage(caught) }));
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, archived, strict, refreshKey, delay, limit, category]);

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
