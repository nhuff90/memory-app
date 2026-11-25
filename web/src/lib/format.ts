import { searchTerms } from "../../../shared/text";

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Short, friendly time for lists: "Today 3:42 PM", "Yesterday 9:05 AM", "Tuesday", "Mar 3", "Mar 3, 2024". */
export function formatWhen(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Full date for the memory sheet: "October 3, 2026 at 3:42 PM". */
export function formatFullDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
}

const LABEL_LENGTH = 40;

/** A short label for a person's note: the text before the first comma, colon, dash, bracket, or line break. */
export function personLabel(body: string): string {
  const lead = body.split(/[\n,;:(]|\s[-–—]\s/)[0]!.trim();
  if (lead.length <= LABEL_LENGTH) return lead;
  return `${lead.slice(0, LABEL_LENGTH).replace(/\s+\S*$/, "")}…`;
}

const NAME_WORD = /^\p{Lu}[\p{L}'’-]*\.?$/u;
const TITLES = new Set(["Dr.", "Mr.", "Mrs.", "Ms.", "Mx.", "Prof.", "Rev.", "Fr.", "Sr.", "Jr.", "St."]);
const NOT_NAMES = new Set(["The", "A", "An", "My", "Our", "Your", "His", "Her", "Their", "This", "That", "Met", "Saw"]);

/** The name a person's note starts with, like "Dr. Kim" or "Sarah Mitchell", or else its `personLabel`. */
export function personName(body: string): string {
  const label = personLabel(body);
  const name: string[] = [];
  for (const word of label.split(/\s+/)) {
    // "Emma's teacher" or "Sarah Mitchell's mom" is someone else's name.
    if (/['’]s$/.test(word)) return label;
    if (!NAME_WORD.test(word)) break;
    if (word.endsWith(".") && !TITLES.has(word)) {
      name.push(word.slice(0, -1));
      break;
    }
    name.push(word);
    if (name.length === 4) break;
  }
  return name.length === 0 || NOT_NAMES.has(name[0]!) ? label : name.join(" ");
}

export interface TextPart {
  text: string;
  match: boolean;
}

/**
 * Matches whole words that start with any of the query's search terms, at a word start, ignoring case. Null when the
 * query has no search terms.
 */
function termPattern(query: string): RegExp | null {
  const terms = searchTerms(query);
  if (terms.length === 0) return null;
  const alternatives = terms
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})[\\p{L}\\p{N}]*`, "giu");
}

/** Splits text so words starting with any search term can be highlighted, the way search matched them. */
export function highlightParts(text: string, query: string): TextPart[] {
  const pattern = termPattern(query);
  if (!pattern) return [{ text, match: false }];
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), match: false });
    parts.push({ text: match[0], match: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts;
}

/**
 * One line of photo text around the first word matching the query, by the same rule as `highlightParts`, for search
 * results. Line breaks and runs of whitespace become single spaces. The line is at most `maxLength` characters, not
 * counting ellipses, and is cut only between words, with "…" at each end that was cut. The matched word is never
 * cut: in a run without spaces longer than `maxLength`, the matched word alone is shown, whole. Null when the query
 * has no search terms or no word in the text matches.
 */
export function photoTextSnippet(text: string, query: string, maxLength = 160): string | null {
  const pattern = termPattern(query);
  if (!pattern) return null;
  const line = text.replace(/\s+/g, " ").trim();
  const match = pattern.exec(line);
  if (!match) return null;
  if (line.length <= maxLength) return line;
  const matchStart = match.index;
  const matchEnd = match.index + match[0].length;
  // Runs of non-spaces, with their positions in the line. The line has single spaces only.
  const words = Array.from(line.matchAll(/\S+/g), (word) => ({ start: word.index, end: word.index + word[0].length }));
  let first = words.findIndex((word) => word.end > matchStart);
  let last = first;
  let start = words[first]!.start;
  let end = words[first]!.end;
  if (end - start > maxLength) {
    start = matchStart;
    end = matchEnd;
  } else {
    for (;;) {
      const previous = words[first - 1];
      const next = words[last + 1];
      const before = previous !== undefined && end - previous.start <= maxLength ? previous : undefined;
      const after = next !== undefined && next.end - start <= maxLength ? next : undefined;
      if (!before && !after) break;
      // Grow the side with less context first, so the match stays near the middle.
      if (before && (!after || matchStart - start <= end - matchEnd)) {
        first -= 1;
        start = before.start;
      } else if (after) {
        last += 1;
        end = after.end;
      }
    }
  }
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}
