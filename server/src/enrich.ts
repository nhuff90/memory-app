import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { CATEGORIES } from "../../shared/types.js";
import type { LlmClient, LlmRequest, LlmResult, UsageLog } from "./ai.js";
import type { MemoryStore } from "./memories.js";

const SWEEP_EVERY_MS = 15 * 60 * 1000;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 40;
const MAX_CAPTION_LENGTH = 300;
const PAUSED = "Auto-tagging paused until the next sweep";

const TAGS_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...CATEGORIES] },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["category", "tags"],
  additionalProperties: false,
};

const CAPTION_SCHEMA = {
  type: "object",
  properties: { caption: { type: "string" } },
  required: ["caption"],
  additionalProperties: false,
};

const tagsShape = z.object({ category: z.enum(CATEGORIES), tags: z.array(z.string()) });
const captionShape = z.object({ caption: z.string() });

export const ENRICH_PROMPT = `You sort short personal notes for a memory app and add search tags.

Pick one category:
- people: about specific people (names, family, kids, jobs, birthdays, addresses)
- things: where an object is or was put, or facts about belongings
- work: the user's job, coworkers, work procedures
- hobbies: hobbies, sports, cooking, music, projects done for fun
- other: anything else

Then give up to ${MAX_TAGS} lowercase tags someone might search for that are not already words in the note: synonyms, broader terms, and closely related words. For "ipad in gym": tablet, apple, workout, exercise, fitness. For a person, add relationships like neighbor or coworker when the note says so. Never invent facts.`;

export const CAPTION_PROMPT = `You describe photos for a personal memory app, so the user can find them later by searching.

In one or two plain sentences, say what the photo shows: the main objects, the kind of place, and any readable text such as labels, signs, or handwriting (quote it exactly). Describe people only briefly, like "a smiling woman with curly hair", and never guess who they are. Don't mention anything you can't see. No markdown.`;

export function cleanTags(tags: string[]): string[] {
  const clean = new Set<string>();
  for (const tag of tags.flatMap((value) => value.split(","))) {
    const normalized = tag.toLowerCase().replace(/\s+/g, " ").trim();
    if (normalized && normalized.length <= MAX_TAG_LENGTH) clean.add(normalized);
    if (clean.size === MAX_TAGS) break;
  }
  return [...clean];
}

export function cleanCaption(caption: string): string | null {
  const text = caption.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= MAX_CAPTION_LENGTH) return text;
  return `${text.slice(0, MAX_CAPTION_LENGTH).replace(/\s+\S*$/, "")}…`;
}

/**
 * Works through new and edited memories one at a time in the background: describes their photos (when that's
 * turned on in Settings), then adds a category and synonym tags. Unfinished memories are swept up at startup
 * and every 15 minutes, so outages just delay the work.
 */
export class Enricher {
  private readonly queue = new Set<number>();
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Once a call has worked, a 400 means this item is the problem rather than the key or model. */
  private workedOnce = false;

  constructor(
    private readonly deps: {
      store: MemoryStore;
      llm: LlmClient;
      usage: UsageLog;
      /** Whether photos may be sent to Claude. Read before each photo, so turning it off takes effect at once. */
      captionsEnabled?: () => boolean;
      log?: (message: string, error?: unknown) => void;
    },
  ) {}

  attach(): void {
    this.deps.store.onChange((change) => {
      const wanted =
        change.kind === "created" ||
        change.kind === "photos-added" ||
        (change.kind === "updated" && change.bodyChanged) ||
        (change.kind === "photo-removed" && change.captionsChanged);
      if (wanted) this.enqueue([change.id]);
    });
  }

  start(): void {
    this.sweep();
    this.timer = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.queue.clear();
  }

  sweep(): void {
    const ids = this.deps.store.unenriched();
    if (this.captionsEnabled()) ids.push(...this.deps.store.uncaptioned());
    this.enqueue(ids);
  }

  /** Resolves when the queue has drained or paused. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private captionsEnabled(): boolean {
    return this.deps.captionsEnabled?.() ?? false;
  }

  private log(message: string, error?: unknown): void {
    (this.deps.log ?? ((text, cause) => console.error(text, cause ?? "")))(message, error);
  }

  private enqueue(ids: number[]): void {
    if (this.stopped) return;
    for (const id of ids) this.queue.add(id);
    this.kick();
  }

  private kick(): void {
    if (this.running || this.stopped || this.queue.size === 0) return;
    this.running = this.drain().finally(() => {
      this.running = null;
      this.kick();
    });
  }

  private async drain(): Promise<void> {
    for (const id of this.queue) {
      if (this.stopped) return;
      this.queue.delete(id);
      let outcome: "next" | "pause";
      try {
        outcome = await this.process(id);
      } catch (error) {
        this.log(`Auto-tagging failed for memory ${id}`, error);
        outcome = "pause";
      }
      if (outcome === "pause") {
        this.queue.clear();
        return;
      }
    }
  }

  private async process(id: number): Promise<"next" | "pause"> {
    // Captions come first so the tags can draw on what the photos show.
    for (const photoId of this.deps.store.uncaptionedPhotos(id)) {
      if (!this.captionsEnabled()) break;
      if ((await this.caption(photoId)) === "pause") return "pause";
    }
    return this.tag(id);
  }

  /** Calls Claude and decides what a failure means: skip this item, or pause until the next sweep. */
  private async call(request: LlmRequest, item: string): Promise<LlmResult | "skip" | "pause"> {
    try {
      const result = await this.deps.llm.complete(request);
      this.workedOnce = true;
      return result;
    } catch (error) {
      if (this.workedOnce && error instanceof Anthropic.BadRequestError) {
        this.log(`Skipping ${item}`, error);
        return "skip";
      }
      this.log(PAUSED, error);
      return "pause";
    }
  }

  private async caption(photoId: number): Promise<"next" | "pause"> {
    const { store, usage } = this.deps;
    const path = store.photoPath(photoId, "full");
    const bytes = path ? await store.photos.read(path).catch(() => null) : null;
    if (!bytes) {
      await store.saveCaption(photoId, null);
      return "next";
    }
    const result = await this.call(
      {
        system: CAPTION_PROMPT,
        content: [
          { type: "image", jpegBase64: bytes.toString("base64") },
          { type: "text", text: "Describe this photo." },
        ],
        schema: CAPTION_SCHEMA,
        maxTokens: 300,
      },
      `the caption for photo ${photoId}`,
    );
    if (result === "pause") return "pause";
    if (result === "skip") {
      await store.saveCaption(photoId, null);
      return "next";
    }
    usage.record("caption", result);
    const reply = captionShape.safeParse(result.json);
    if (!reply.success) this.log(`No caption for photo ${photoId}: unusable reply (stop reason: ${result.stopReason})`);
    await store.saveCaption(photoId, reply.success ? cleanCaption(reply.data.caption) : null);
    return "next";
  }

  private async tag(id: number): Promise<"next" | "pause"> {
    const { store, usage } = this.deps;
    const row = store.getRow(id);
    if (!row || row.enriched_at !== null) return "next";
    if (!row.body && !row.captions) {
      store.markEnriched(id);
      return "next";
    }

    const content = [row.body && `Note: ${row.body}`, row.captions && `Photo shows: ${row.captions}`]
      .filter(Boolean)
      .join("\n");
    const result = await this.call(
      { system: ENRICH_PROMPT, content, schema: TAGS_SCHEMA, maxTokens: 400 },
      `tags for memory ${id}`,
    );
    if (result === "pause") return "pause";
    if (result === "skip") {
      store.markEnriched(id);
      return "next";
    }
    usage.record("enrich", result);

    const reply = tagsShape.safeParse(result.json);
    if (!reply.success) {
      this.log(`Skipping tags for memory ${id}: unusable reply (stop reason: ${result.stopReason})`);
      store.markEnriched(id);
      return "next";
    }
    store.applyEnrichment(
      id,
      { body: row.body, captions: row.captions },
      { category: reply.data.category, tags: cleanTags(reply.data.tags) },
    );
    return "next";
  }
}
