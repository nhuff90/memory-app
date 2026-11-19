import { keywordKey, keywordsError, normalizeKeywords } from "../../../shared/keywords";
import type { KeywordUsage } from "../../../shared/types";

export const MAX_SUGGESTIONS = 5;
/** With an empty input, up to this many slots go to recently assigned keywords; the rest to frequent ones. */
export const RECENT_SLOTS = 2;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable alphabetical tie-break, so suggestions never move unpredictably. */
function alphabetical(a: KeywordUsage, b: KeywordUsage): number {
  return compareText(a.key, b.key) || compareText(a.keyword, b.keyword);
}

function matchRank(entry: KeywordUsage, typed: string): number {
  if (entry.key === typed) return 0;
  if (entry.key.startsWith(typed)) return 1;
  if (entry.key.split(/\s+/).some((word) => word.startsWith(typed))) return 2;
  if (entry.key.includes(typed)) return 3;
  return -1;
}

/**
 * At most five suggestions, never one already selected. While typing, matches only: exact, then prefix, then
 * word-start, then anywhere, with active usage before outdated-only keywords. With an empty input, up to two
 * recently assigned keywords, then the most used; unused recent slots are filled by frequency. Keywords found
 * only on outdated recalls (count 0) are never default suggestions.
 */
export function suggestKeywords(
  vocabulary: readonly KeywordUsage[],
  input: string,
  selected: readonly string[],
  limit = MAX_SUGGESTIONS,
): KeywordUsage[] {
  const chosen = new Set(selected.map(keywordKey));
  const available = vocabulary.filter((entry) => entry.key && !chosen.has(entry.key));
  const typed = keywordKey(input.split(",").at(-1) ?? "");
  if (typed) {
    return available
      .map((entry) => ({ entry, rank: matchRank(entry, typed) }))
      .filter((match) => match.rank >= 0)
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          Number(b.entry.count > 0) - Number(a.entry.count > 0) ||
          b.entry.count - a.entry.count ||
          alphabetical(a.entry, b.entry),
      )
      .slice(0, limit)
      .map((match) => match.entry);
  }
  const active = available.filter((entry) => entry.count > 0);
  const recent = active
    .filter((entry) => entry.lastAssignedAt !== null)
    .sort((a, b) => (b.lastAssignedAt ?? 0) - (a.lastAssignedAt ?? 0) || alphabetical(a, b))
    .slice(0, Math.min(RECENT_SLOTS, limit));
  const recentKeys = new Set(recent.map((entry) => entry.key));
  const frequent = active.filter((entry) => !recentKeys.has(entry.key)).sort((a, b) => b.count - a.count || alphabetical(a, b));
  return [...recent, ...frequent].slice(0, limit);
}

/** The explanation for unfinished keyword text that could not be added, or null when it is fine (or empty). */
export function pendingKeywordError(selected: readonly string[], input: string): string | null {
  if (!input.trim()) return null;
  return keywordsError([...selected, ...input.split(",")]);
}

export interface PillInput {
  keywords: string[];
  input: string;
}

/**
 * Applies typed or pasted text. Every complete comma-separated part becomes a pill and the unfinished tail stays
 * in the input; with `commitAll` (Enter, Save) the tail is added too. If the result would break the shared rules
 * (length, ten keywords), nothing is added and the text stays visible so its error can be shown and fixed.
 */
export function applyKeywordInput(selected: readonly string[], text: string, commitAll = false): PillInput {
  const parts = text.split(",");
  const rest = commitAll ? "" : parts.pop()!;
  const complete = parts.map((part) => part.trim()).filter(Boolean);
  if (complete.length === 0) return { keywords: [...selected], input: commitAll ? "" : rest };
  try {
    return { keywords: normalizeKeywords([...selected, ...complete]), input: rest.trimStart() };
  } catch {
    return { keywords: [...selected], input: text };
  }
}

/** Whether two lists are the same keywords with the same spelling and order (unsaved-change detection). */
export function sameKeywordList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((keyword, index) => keyword === b[index]);
}

/** Accepts anything an older or newer server might send, keeping only well-formed entries. */
export function readVocabulary(data: unknown): KeywordUsage[] {
  const list = (data as { keywords?: unknown } | null)?.keywords;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw): KeywordUsage[] => {
    const entry = raw as Partial<KeywordUsage> | null;
    if (!entry || typeof entry.keyword !== "string" || !entry.keyword.trim()) return [];
    return [{
      keyword: entry.keyword,
      key: typeof entry.key === "string" && entry.key ? entry.key : keywordKey(entry.keyword),
      count: typeof entry.count === "number" && entry.count > 0 ? entry.count : 0,
      lastAssignedAt: typeof entry.lastAssignedAt === "number" ? entry.lastAssignedAt : null,
    }];
  });
}
