export const MAX_CUSTOM_KEYWORDS = 10;
export const MAX_CUSTOM_KEYWORD_LENGTH = 40;

/** Advertised by `/api/me` once the create endpoint saves `customKeywords` together with the recall. */
export const KEYWORD_CAPTURE_CAPABILITY = "keyword-capture";

/** Advertised by `/api/me` once `POST /api/keywords/rename` renames or merges a custom keyword across the store. */
export const KEYWORD_RENAME_CAPABILITY = "keyword-rename";

/**
 * The identity of a keyword: case variants are the same keyword for deduplication, suggestions, counts and
 * filtering. Display spelling is kept separately. Distinct words and synonyms are never merged.
 */
export function keywordKey(value: string): string {
  return value.trim().toLowerCase();
}

/** The editor and server share the same comma-separated keyword rules. */
export function normalizeKeywords(values: readonly string[]): string[] {
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const value of values.flatMap((entry) => entry.split(","))) {
    const keyword = value.trim();
    if (!keyword) continue;
    if (keyword.length > MAX_CUSTOM_KEYWORD_LENGTH) {
      throw new Error(`Keep each custom keyword to ${MAX_CUSTOM_KEYWORD_LENGTH} characters or fewer.`);
    }
    const key = keywordKey(keyword);
    if (!seen.has(key)) {
      seen.add(key);
      keywords.push(keyword);
    }
  }
  if (keywords.length > MAX_CUSTOM_KEYWORDS) {
    throw new Error(`Use up to ${MAX_CUSTOM_KEYWORDS} custom keywords.`);
  }
  return keywords;
}

/** The validation message for these values, or null when they are acceptable. */
export function keywordsError(values: readonly string[]): string | null {
  try {
    normalizeKeywords(values);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Whether two keyword lists carry the same normalized keywords, ignoring order and spelling differences of case. */
export function sameKeywordSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(keywordKey).filter(Boolean));
  const right = new Set(b.map(keywordKey).filter(Boolean));
  return left.size === right.size && [...left].every((key) => right.has(key));
}
