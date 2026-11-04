export const MAX_CUSTOM_KEYWORDS = 10;
export const MAX_CUSTOM_KEYWORD_LENGTH = 40;

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
    const key = keyword.toLowerCase();
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
