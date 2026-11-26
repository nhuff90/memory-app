import { z } from "zod";
import type { AskResponse, Memory, Photo } from "../../shared/types.js";
import { aiFailure, type LlmClient, type UsageLog } from "./ai.js";
import { HttpError } from "./errors.js";
import type { MemoryStore } from "./memories.js";
import type { SearchIndex } from "./search.js";

export const NOTHING_FOUND = "I don't have anything about that.";
const REFUSED = "I can't help with that one.";
/** Questions go to Claude with at most this many notes; with this many or fewer saved, all of them go. */
const MAX_NOTES = 50;
/** Looser than search: Claude reads the notes and ignores the ones that don't fit. */
const ASK_MIN_SIMILARITY = 0.5;
const MAX_RESULTS = 20;
/** Ask sends at most this many characters of a memory's photo text (plus "…" when it's cut). */
const MAX_PHOTO_TEXT = 1500;

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    used_ids: { type: "array", items: { type: "integer" } },
  },
  required: ["answer", "used_ids"],
  additionalProperties: false,
};

const answerShape = z.object({ answer: z.string(), used_ids: z.array(z.number().int()) });

function localDate(ms: number, timeZone: string): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

export function systemPrompt(now: number, timeZone: string): string {
  const today = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "full" }).format(now);
  return [
    "You answer questions using only the user's own saved notes, listed after the question.",
    `Today is ${today} (${localDate(now, timeZone)}).`,
    "",
    "Rules:",
    "- Use only facts from the notes. Never guess or add outside knowledge.",
    "- Start with a one-sentence direct answer. Add at most two short sentences of detail if they help.",
    "- When notes disagree, trust the most recently saved one.",
    "- Work out ages and how long ago something was from the note dates and today's date.",
    `- If the notes don't answer the question, reply exactly: "${NOTHING_FOUND}"`,
    "- used_ids lists the ids of the notes your answer relies on; leave it empty if none do.",
    "- Write plainly, like a helpful friend. No markdown.",
  ].join("\n");
}

/**
 * Every photo's text in photo order, on one line: line breaks (and the breaks between photos) become " / ", runs of
 * whitespace collapse to one space, and text longer than MAX_PHOTO_TEXT is cut at a word with "…" appended. Empty when
 * no photo has text.
 */
function photoTextLine(photos: Photo[]): string {
  const text = photos
    .flatMap((photo) => (photo.text ?? "").split(/\r\n?|\n/))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join(" / ");
  if (text.length <= MAX_PHOTO_TEXT) return text;
  // lastIndexOf from MAX_PHOTO_TEXT also finds a space just past the limit, when the cut already falls between words.
  const space = text.lastIndexOf(" ", MAX_PHOTO_TEXT);
  let end = space > 0 ? space : MAX_PHOTO_TEXT;
  // With no space to cut at, don't split an emoji or other surrogate pair.
  if (space <= 0 && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
  // A cut right after a separator would leave a dangling " /".
  return `${text.slice(0, end).replace(/(?: \/)+$/, "")}…`;
}

export function formatNotes(memories: Memory[], timeZone: string): string {
  return memories
    .map((memory) => {
      const details = [
        `#${memory.id}`,
        `saved ${localDate(memory.createdAt, timeZone)}`,
        memory.category,
        memory.photos.length ? `${memory.photos.length} photo${memory.photos.length === 1 ? "" : "s"}` : null,
      ].filter((detail) => detail !== null);
      const lines = [`[${details.join(" | ")}] ${memory.body || "(photo only)"}`];
      const captions = memory.photos.flatMap((photo) => (photo.caption ? [photo.caption] : []));
      if (captions.length) lines.push(`  photo shows: ${captions.join("; ")}`);
      const photoText = photoTextLine(memory.photos);
      if (photoText) lines.push(`  text in photo (transcribed, may have errors): ${photoText}`);
      if (memory.tags.length) lines.push(`  tags: ${memory.tags.join(", ")}`);
      if (memory.customKeywords.length) {
        lines.push(`  user-provided search metadata (custom keywords): ${memory.customKeywords.join(", ")}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

export class AskService {
  constructor(
    private readonly deps: {
      store: MemoryStore;
      search: SearchIndex;
      llm: LlmClient | null;
      usage: UsageLog;
      now: () => number;
      log: (message: string, error?: unknown) => void;
    },
  ) {}

  get enabled(): boolean {
    return this.deps.llm !== null;
  }

  async ask(question: string, timeZone: string): Promise<Omit<AskResponse, "message">> {
    const { store, search, llm, usage, now } = this.deps;
    if (!llm) throw new HttpError(503, "ai_disabled", "Ask needs an Anthropic API key. Search still works.");

    const hits = await search.search(question, { limit: MAX_NOTES, minSimilarity: ASK_MIN_SIMILARITY });
    const matches = store.getMany(hits.map((hit) => hit.id));
    const active = store.list({ limit: MAX_NOTES + 1 }).memories;
    // Small collections go in whole, so Claude can answer even when search misses the right note.
    const notes = active.length <= MAX_NOTES ? active : matches;
    if (notes.length === 0) return { answer: NOTHING_FOUND, usedIds: [], results: [] };
    notes.sort((a, b) => b.createdAt - a.createdAt);

    let result;
    try {
      result = await llm.complete({
        system: systemPrompt(now(), timeZone),
        content: `Question: ${question}\n\nNotes, newest first:\n${formatNotes(notes, timeZone)}`,
        schema: ANSWER_SCHEMA,
        maxTokens: 1024,
      });
    } catch (error) {
      this.deps.log("Ask failed", error);
      throw aiFailure(error);
    }
    usage.record("ask", result);

    if (result.stopReason === "refusal") return { answer: REFUSED, usedIds: [], results: matches.slice(0, MAX_RESULTS) };
    const parsed = answerShape.safeParse(result.json);
    if (!parsed.success || !parsed.data.answer.trim()) {
      this.deps.log(`Ask got an unusable reply (stop reason: ${result.stopReason})`);
      throw new HttpError(502, "ai_failed", "Claude couldn't answer this time. Try again in a moment.");
    }

    const sent = new Map(notes.map((memory) => [memory.id, memory]));
    const usedIds = [...new Set(parsed.data.used_ids)].filter((id) => sent.has(id));
    const used = usedIds.map((id) => sent.get(id)!);
    const rest = matches.filter((memory) => !usedIds.includes(memory.id));
    return { answer: parsed.data.answer.trim(), usedIds, results: [...used, ...rest].slice(0, MAX_RESULTS) };
  }
}
