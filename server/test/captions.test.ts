import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { MeResponse, Memory } from "../../shared/types.js";
import { UsageLog, type LlmRequest } from "../src/ai.js";
import {
  CAPTION_PROMPT,
  CAPTION_SCHEMA,
  cleanCaption,
  cleanPhotoText,
  Enricher,
  MAX_PHOTO_TEXT_LENGTH,
  PHOTO_PROMPT,
  PHOTO_SCHEMA,
} from "../src/enrich.js";
import { SettingsStore } from "../src/settings.js";
import { FakeLlm } from "./fakeLlm.js";
import { client, DAY, fakeJpeg, login, makeContext, type TestContext } from "./helpers.js";

let ctx: TestContext;
let enricher: Enricher;
let settings: SettingsStore;
afterEach(() => {
  enricher?.stop();
  ctx?.cleanup();
});

const imageOf = (request: LlmRequest) =>
  Array.isArray(request.content) ? request.content.find((part) => part.type === "image") : undefined;

/** The label `fakeJpeg` wrote into the photo, so each fake caption names the photo it came from. */
const labelOf = (jpegBase64: string) => Buffer.from(jpegBase64, "base64").subarray(4).toString().replace(/\0+$/, "");

/** What the fake reads in each photo: its label, then a line that appears nowhere else. */
const textOf = (label: string) => `${label}\nKeep upright`;

/** A fake Claude that describes each photo by its label, reads its text, and tags text with one word. */
function fakeClaude(): FakeLlm {
  return new FakeLlm((request) => {
    const image = imageOf(request);
    if (image?.type === "image") {
      const label = labelOf(image.jpegBase64);
      return { json: { caption: `A plastic bin labeled ${label}`, text: textOf(label) } };
    }
    return { json: { category: "things", tags: ["storage"] } };
  });
}

function setup(llm: FakeLlm | null, { captions = false } = {}) {
  ctx = makeContext({
    setup: (base) => {
      settings = new SettingsStore(base.db);
      settings.setPhotoCaptions(captions);
      if (!llm) return { settings };
      enricher = new Enricher({
        store: base.store,
        llm,
        usage: new UsageLog(base.db, () => base.clock.now),
        captionsEnabled: () => settings.photoCaptions(),
        log: () => {},
      });
      enricher.attach();
      return { llm, settings, enricher };
    },
  });
}

async function save(body: string, ...labels: string[]): Promise<Memory> {
  const photos = labels.map((label) => ({ full: fakeJpeg(label), thumb: fakeJpeg(`${label}-thumb`) }));
  return (await ctx.store.create({ body, photos })).memory;
}

const photoRequests = (llm: FakeLlm) => llm.requests.filter((request) => imageOf(request));
const reload = (id: number) => ctx.store.get(id)!;
const findIds = async (query: string) => (await ctx.search.search(query)).map((hit) => hit.id);
const usageKinds = () => ctx.db.prepare(`SELECT kind FROM ai_usage ORDER BY id`).all();
const photoIds = (memory: Memory) => memory.photos.map((photo) => photo.id);

function photoRow(photoId: number) {
  return ctx.db
    .prepare(`SELECT caption, captioned_at, extracted_text, text_read_at FROM photos WHERE id = ?`)
    .get(photoId) as { caption: string | null; captioned_at: number | null; extracted_text: string | null; text_read_at: number | null };
}

/** A photo that was read and given up on: no caption, no text, and marked done so it isn't sent again. */
const givenUp = () => ({ caption: null, captioned_at: ctx.clock.now, extracted_text: null, text_read_at: ctx.clock.now });

/** Records every text the search index embeds. */
function recordEmbeddings(): string[] {
  const documents: string[] = [];
  const embed = ctx.embedder.embedDocuments.bind(ctx.embedder);
  ctx.embedder.embedDocuments = async (texts: string[]) => {
    documents.push(...texts);
    return embed(texts);
  };
  return documents;
}

describe("photo captions", () => {
  it("stay off until turned on, so no photo leaves the server", async () => {
    const llm = fakeClaude();
    setup(llm);
    const api = client(ctx.app, await login(ctx.app));
    const memory = await save("Christmas box", "XMAS");
    await enricher.idle();
    expect(photoRequests(llm)).toHaveLength(0);
    expect(reload(memory.id).photos[0]!.caption).toBeNull();
    expect(reload(memory.id).photos[0]!.text).toBeNull();
    expect(photoRow(memory.photos[0]!.id)).toEqual({ caption: null, captioned_at: null, extracted_text: null, text_read_at: null });
    expect(await findIds("upright")).toEqual([]);
    expect(((await (await api.get("/api/me")).json()) as MeResponse).photoCaptions).toBe(false);
  });

  it("can't be turned on without Claude", async () => {
    setup(null);
    const api = client(ctx.app, await login(ctx.app));
    const res = await api.patch("/api/settings", { photoCaptions: true });
    expect(res.status).toBe(400);
    expect(settings.photoCaptions()).toBe(false);
  });

  it("describe existing photos once turned on, so photo-only memories become findable", async () => {
    const llm = fakeClaude();
    setup(llm);
    const api = client(ctx.app, await login(ctx.app));
    const memory = await save("", "XMAS");
    await enricher.idle();
    expect(ctx.search.vectors.has(memory.id)).toBe(false);
    expect(await findIds("plastic")).toEqual([]);

    const res = await api.patch("/api/settings", { photoCaptions: true });
    expect(((await res.json()) as MeResponse).photoCaptions).toBe(true);
    await enricher.idle();

    const [request] = photoRequests(llm);
    expect(request!.system).toBe(PHOTO_PROMPT);
    expect(imageOf(request!)).toEqual({ type: "image", jpegBase64: Buffer.from(fakeJpeg("XMAS")).toString("base64") });
    expect(reload(memory.id)).toMatchObject({
      photos: [{ caption: "A plastic bin labeled XMAS", text: textOf("XMAS") }],
      category: "things",
      tags: ["storage"],
    });
    expect(llm.lastContent).toBe("Photo shows: A plastic bin labeled XMAS");
    expect(await findIds("plastic")).toEqual([memory.id]);
    expect(await findIds("storage")).toEqual([memory.id]);
    expect(await findIds("upright")).toEqual([memory.id]);
    expect(ctx.search.vectors.has(memory.id)).toBe(true);
    expect(usageKinds()).toEqual([{ kind: "caption" }, { kind: "enrich" }]);

    enricher.sweep();
    await enricher.idle();
    expect(llm.requests).toHaveLength(2);
  });

  it("follow photos as they're added and removed", async () => {
    const llm = fakeClaude();
    setup(llm, { captions: true });
    const memory = await save("garage shelf", "TOOLS");
    await enricher.idle();
    expect(llm.lastContent).toBe("Note: garage shelf\nPhoto shows: A plastic bin labeled TOOLS");

    const withTwo = await ctx.store.addPhotos(memory.id, [{ full: fakeJpeg("XMAS"), thumb: fakeJpeg("XMAS-thumb") }]);
    await enricher.idle();
    expect(reload(memory.id).photos.map((photo) => photo.caption)).toEqual([
      "A plastic bin labeled TOOLS",
      "A plastic bin labeled XMAS",
    ]);
    expect(await findIds("xmas")).toEqual([memory.id]);
    expect(llm.lastContent).toContain("TOOLS; A plastic bin labeled XMAS");

    await ctx.store.removePhoto(withTwo.photos[1]!.id);
    await enricher.idle();
    expect(await findIds("xmas")).toEqual([]);
    expect(llm.lastContent).toBe("Note: garage shelf\nPhoto shows: A plastic bin labeled TOOLS");
    expect(photoRequests(llm)).toHaveLength(2);
  });

  it("pause during outages and pick up where they left off", async () => {
    const llm = fakeClaude().reply(new Anthropic.APIConnectionError({ message: "offline" }));
    setup(llm, { captions: true });
    const memory = await save("", "XMAS");
    await enricher.idle();
    expect(reload(memory.id).photos[0]!.caption).toBeNull();
    expect(photoRow(memory.photos[0]!.id)).toEqual({ caption: null, captioned_at: null, extracted_text: null, text_read_at: null });
    expect(ctx.store.uncaptioned()).toEqual([memory.id]);
    expect(usageKinds()).toEqual([]);

    enricher.sweep();
    await enricher.idle();
    expect(photoRequests(llm)).toHaveLength(2);
    expect(reload(memory.id).photos[0]).toMatchObject({ caption: "A plastic bin labeled XMAS", text: textOf("XMAS") });
    expect(photoRow(memory.photos[0]!.id).text_read_at).toBe(ctx.clock.now);
    expect(ctx.store.uncaptioned()).toEqual([]);
  });

  it("give up on a photo Claude won't describe instead of retrying it", async () => {
    const llm = fakeClaude().reply({ json: null, stopReason: "refusal" });
    setup(llm, { captions: true });
    const memory = await save("", "XMAS");
    await enricher.idle();
    enricher.sweep();
    await enricher.idle();
    expect(reload(memory.id).photos[0]!.caption).toBeNull();
    expect(photoRow(memory.photos[0]!.id)).toEqual(givenUp());
    expect(photoRequests(llm)).toHaveLength(1);
  });

  it("stop at once when turned off", async () => {
    const llm = fakeClaude();
    setup(llm, { captions: true });
    const reply = llm.complete.bind(llm);
    llm.complete = async (request) => {
      settings.setPhotoCaptions(false);
      return reply(request);
    };
    await save("two photos", "ONE", "TWO");
    await enricher.idle();
    expect(photoRequests(llm)).toHaveLength(1);
  });

  it("are tidied before saving", () => {
    expect(cleanCaption("  A red\n toolbox. ")).toBe("A red toolbox.");
    expect(cleanCaption("   ")).toBeNull();
    const long = cleanCaption(`${"word ".repeat(80)}end`)!;
    expect(long.length).toBeLessThanOrEqual(301);
    expect(long).toMatch(/word…$/);
  });
});

describe("photo text", () => {
  it("is read by the same call that describes the photo, and makes the memory findable by every word", async () => {
    const llm = fakeClaude().reply({
      json: { caption: "A handwritten recipe card", text: "Grandma's Pancakes  \r\n\r\n\r\n\r\n2 cups flour\r\n1 tsp salt\r\n" },
    });
    setup(llm, { captions: true });
    const documents = recordEmbeddings();
    const memory = await save("kitchen drawer", "CARD");
    await enricher.idle();

    expect(photoRequests(llm)).toEqual([
      {
        system: PHOTO_PROMPT,
        content: [
          { type: "image", jpegBase64: Buffer.from(fakeJpeg("CARD")).toString("base64") },
          { type: "text", text: "Describe this photo." },
        ],
        schema: PHOTO_SCHEMA,
        maxTokens: 4096,
      },
    ]);
    expect(PHOTO_SCHEMA).toEqual({
      type: "object",
      properties: { caption: { type: "string" }, text: { type: "string" } },
      required: ["caption", "text"],
      additionalProperties: false,
    });
    const text = "Grandma's Pancakes\n\n2 cups flour\n1 tsp salt";
    expect(photoRow(memory.photos[0]!.id)).toEqual({
      caption: "A handwritten recipe card",
      captioned_at: ctx.clock.now,
      extracted_text: text,
      text_read_at: ctx.clock.now,
    });
    expect(reload(memory.id).photos[0]!.text).toBe(text);
    // "flour" and "pancakes" appear only in the photo's text.
    expect(await findIds("flour")).toEqual([memory.id]);
    expect(await findIds("pancakes")).toEqual([memory.id]);
    expect(usageKinds()).toEqual([{ kind: "caption" }, { kind: "enrich" }]);

    // Tags and the meaning vector come from the note and the caption only.
    expect(llm.requests).toHaveLength(2);
    expect(llm.lastContent).toBe("Note: kitchen drawer\nPhoto shows: A handwritten recipe card");
    expect(documents.length).toBeGreaterThan(0);
    for (const document of documents) expect(document).not.toMatch(/flour|pancakes/i);

    // A change to the text alone doesn't re-tag or re-embed.
    const enrichedAt = reload(memory.id).enrichedAt;
    const embedded = documents.length;
    expect(enrichedAt).not.toBeNull();
    ctx.clock.now += DAY;
    await ctx.store.saveCaption(memory.photos[0]!.id, "A handwritten recipe card", "3 cups flour");
    await enricher.idle();
    expect(llm.requests).toHaveLength(2);
    expect(reload(memory.id).enrichedAt).toBe(enrichedAt);
    expect(documents).toHaveLength(embedded);
    expect(await findIds("pancakes")).toEqual([]);
    expect(await findIds("flour")).toEqual([memory.id]);
  });

  it("is saved as no text when the reply has none, while the caption is kept", async () => {
    const llm = fakeClaude().reply(
      { json: { caption: "A blank wall", text: "" } },
      { json: { caption: "A jar of buttons" } },
      { json: { caption: "A street sign", text: 42 } },
      { json: { caption: "An empty shelf", text: " \n\t\r\n " } },
    );
    setup(llm, { captions: true });
    const memory = await save("hallway", "ONE", "TWO", "THREE", "FOUR");
    await enricher.idle();

    expect(photoIds(memory).map(photoRow)).toEqual(
      ["A blank wall", "A jar of buttons", "A street sign", "An empty shelf"].map((caption) => ({
        caption,
        captioned_at: ctx.clock.now,
        extracted_text: null,
        text_read_at: ctx.clock.now,
      })),
    );
    expect(ctx.store.getRow(memory.id)!.photo_text).toBeNull();
    expect(await findIds("jar")).toEqual([memory.id]);

    enricher.sweep();
    await enricher.idle();
    expect(photoRequests(llm)).toHaveLength(4);
  });

  it("falls back to one caption-only call when the reply is cut off by the token limit", async () => {
    const llm = fakeClaude().reply(
      { json: null, stopReason: "max_tokens", outputTokens: 4096 },
      { json: { caption: "A page of printed text" } },
    );
    setup(llm, { captions: true });
    const memory = await save("", "PAGE");
    await enricher.idle();

    const [first, retry, ...rest] = photoRequests(llm);
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ system: PHOTO_PROMPT, schema: PHOTO_SCHEMA, maxTokens: 4096 });
    expect(retry).toEqual({ system: CAPTION_PROMPT, content: first!.content, schema: CAPTION_SCHEMA, maxTokens: 300 });
    expect(photoRow(memory.photos[0]!.id)).toEqual({
      caption: "A page of printed text",
      captioned_at: ctx.clock.now,
      extracted_text: null,
      text_read_at: ctx.clock.now,
    });
    expect(usageKinds()).toEqual([{ kind: "caption" }, { kind: "caption" }, { kind: "enrich" }]);
    const tokens = ctx.db.prepare(`SELECT output_tokens FROM ai_usage WHERE kind = 'caption' ORDER BY id`).all();
    expect(tokens).toEqual([{ output_tokens: 4096 }, { output_tokens: 50 }]);
    expect(await findIds("printed")).toEqual([memory.id]);

    enricher.sweep();
    await enricher.idle();
    expect(photoRequests(llm)).toHaveLength(2);
  });

  it("gives up after a cut-off reply when the caption-only call has nothing usable either", async () => {
    const llm = fakeClaude().reply({ json: null, stopReason: "max_tokens" }, { json: null, stopReason: "max_tokens" });
    setup(llm, { captions: true });
    const memory = await save("", "PAGE");
    await enricher.idle();
    expect(photoRequests(llm)).toHaveLength(2);
    expect(photoRow(memory.photos[0]!.id)).toEqual(givenUp());
    expect(usageKinds()).toEqual([{ kind: "caption" }, { kind: "caption" }]);
  });

  it("doesn't send a cut-off photo again once Describe photos is turned off", async () => {
    const llm = fakeClaude().reply({ json: null, stopReason: "max_tokens" });
    setup(llm, { captions: true });
    const reply = llm.complete.bind(llm);
    llm.complete = async (request) => {
      settings.setPhotoCaptions(false);
      return reply(request);
    };
    const memory = await save("a long letter", "PAGE");
    await enricher.idle();
    expect(photoRequests(llm)).toHaveLength(1);
    expect(photoRow(memory.photos[0]!.id)).toEqual({ caption: null, captioned_at: null, extracted_text: null, text_read_at: null });
  });

  it("is given up on, with the caption, for invalid replies, skipped photos and missing files", async () => {
    const llm = fakeClaude();
    setup(llm);
    // Tagged first with Describe photos off, so a call has worked and a 400 means this photo is the problem.
    const memory = await save("basement", "OK", "INVALID", "NO-CAPTION", "SKIPPED", "MISSING");
    await enricher.idle();
    const [ok, invalid, noCaption, skipped, missing] = photoIds(memory) as [number, number, number, number, number];
    await ctx.photos.remove([ctx.store.photoPath(missing, "full")!]);
    llm.reply(
      { json: { caption: "A plastic bin labeled OK", text: "OK" } },
      { json: null, stopReason: "end_turn" },
      { json: { text: "no caption" } },
      Anthropic.APIError.generate(400, {}, "Could not process image", new Headers()),
    );
    settings.setPhotoCaptions(true);
    enricher.sweep();
    await enricher.idle();

    expect(photoRequests(llm)).toHaveLength(4);
    expect(photoRow(ok)).toMatchObject({ caption: "A plastic bin labeled OK", extracted_text: "OK" });
    for (const photoId of [invalid, noCaption, skipped, missing]) expect(photoRow(photoId)).toEqual(givenUp());
    expect(usageKinds()).toEqual([
      { kind: "enrich" },
      { kind: "caption" },
      { kind: "caption" },
      { kind: "caption" },
      { kind: "enrich" },
    ]);
    expect(reload(memory.id).tags).toEqual(["storage"]);

    enricher.sweep();
    await enricher.idle();
    expect(photoRequests(llm)).toHaveLength(4);
  });

  it("is tidied before saving, keeping its lines", () => {
    expect(cleanPhotoText("2 cups flour\r\n1 tsp salt\rbake")).toBe("2 cups flour\n1 tsp salt\nbake");
    expect(cleanPhotoText("MILK  \t\nEGGS \n  indented")).toBe("MILK\nEGGS\n  indented");
    expect(cleanPhotoText("Page 1\n\n\n\n\nPage 2")).toBe("Page 1\n\nPage 2");
    expect(cleanPhotoText("Page 1\n  \n\t\n \n \nPage 2")).toBe("Page 1\n\nPage 2");
    expect(cleanPhotoText("\n\n  Title  \n\n")).toBe("Title");
    expect(cleanPhotoText("  \r\n\t \n ")).toBeNull();
    expect(cleanPhotoText("")).toBeNull();
  });

  it("is capped at a word or line boundary", () => {
    expect(MAX_PHOTO_TEXT_LENGTH).toBe(10_000);
    const words = "recipe card ".repeat(1000);
    const lines = "Line of text\n".repeat(924);
    expect(words).toHaveLength(12_000);
    expect(lines.length).toBeGreaterThanOrEqual(12_000);

    const cutWords = cleanPhotoText(words)!;
    expect(cutWords.length).toBeLessThanOrEqual(10_001);
    expect(cutWords).toMatch(/ card…$/);
    expect(words.startsWith(cutWords.slice(0, -1))).toBe(true);

    const cutLines = cleanPhotoText(lines)!;
    expect(cutLines.length).toBeLessThanOrEqual(10_001);
    expect(cutLines).toMatch(/\nLine of text…$/);
    expect(lines.startsWith(cutLines.slice(0, -1))).toBe(true);

    const unbroken = cleanPhotoText("x".repeat(12_000))!;
    expect(unbroken).toBe(`${"x".repeat(10_000)}…`);

    const exact = "y".repeat(10_000);
    expect(cleanPhotoText(exact)).toBe(exact);
  });
});
