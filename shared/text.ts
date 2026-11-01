const STOPWORDS = new Set(
  (
    "a about after all also am an and any are as at be been before being but by can could did do does doing " +
    "done for from get got had has have having he her here hers him his how i if in into is it its just know " +
    "let me mine my myself no nor not now of off on once only or our out over own put said she should so some " +
    "than that the their them then there these they this those to too under up us very was we were what " +
    "whats when where wheres which while who whom whos why will with would you your remember find tell name names " +
    "thing things stuff again ever"
  ).split(" "),
);

/** Words worth matching: lowercased, deduplicated, with filler words and stray letters dropped. */
export function searchTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms: string[] = [];
  for (const word of words) {
    if (STOPWORDS.has(word) || (word.length < 2 && !/\d/.test(word)) || terms.includes(word)) continue;
    terms.push(word);
  }
  return terms.slice(0, 12);
}
