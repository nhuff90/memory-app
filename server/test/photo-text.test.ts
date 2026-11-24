import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { KEYWORD_CAPTURE_CAPABILITY, KEYWORD_RENAME_CAPABILITY } from "../../shared/keywords.js";
import { PHOTO_TEXT_CAPABILITY, type MeResponse, type Memory, type MemoryList, type SearchResponse } from "../../shared/types.js";
import { UsageLog, type LlmRequest } from "../src/ai.js";
import { Enricher, PHOTO_PROMPT, PHOTO_SCHEMA } from "../src/enrich.js";
import type { MemoryChange } from "../src/memories.js";
import { SettingsStore } from "../src/settings.js";
import { TokenStore } from "../src/tokens.js";
import { FakeLlm } from "./fakeLlm.js";
import { client, DAY, fakeJpeg, login, makeContext, memoryForm, type TestContext } from "./helpers.js";

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

const RECIPE = "2 cups flour\n1 tsp salt";

async function withPhotos(body: string, count = 1): Promise<Memory> {
  const photos = Array.from({ length: count }, (_, index) => ({
    full: fakeJpeg(`full-${index}`),
    thumb: fakeJpeg(`thumb-${index}`),
  }));
  const { memory } = await ctx.store.create({ body, photos });
  return memory;
}

function photoRow(photoId: number) {
  return ctx.db
    .prepare(`SELECT caption, captioned_at, extracted_text, text_read_at FROM photos WHERE id = ?`)
    .get(photoId) as { caption: string | null; captioned_at: number | null; extracted_text: string | null; text_read_at: number | null };
}

function photoText(memoryId: number): string | null {
  return ctx.store.getRow(memoryId)!.photo_text;
}

function storedVector(memoryId: number): Buffer | undefined {
  const row = ctx.db.prepare(`SELECT vector FROM embeddings WHERE memory_id = ?`).get(memoryId) as { vector: Buffer } | undefined;
  return row?.vector;
}

async function foundIds(query: string): Promise<number[]> {
  return (await ctx.search.search(query)).map((hit) => hit.id);
}

function recordChanges(): MemoryChange[] {
  const changes: MemoryChange[] = [];
  ctx.store.onChange((change) => {
    changes.push(change);
  });
  return changes;
}

describe("photo text in the store", () => {
  it("saves the text with the caption and makes the memory findable by it", async () => {
    ctx = makeContext();
    const memory = await withPhotos("Grandma's card from the kitchen drawer");
    const photoId = memory.photos[0]!.id;
    ctx.clock.now += 1000;

    await ctx.store.saveCaption(photoId, "A recipe card", RECIPE);

    expect(photoRow(photoId)).toEqual({
      caption: "A recipe card",
      captioned_at: ctx.clock.now,
      extracted_text: RECIPE,
      text_read_at: ctx.clock.now,
    });
    expect(ctx.store.get(memory.id)!.photos[0]!.text).toBe(RECIPE);
    expect(photoText(memory.id)).toBe(RECIPE);
    const hits = await ctx.search.search("flour");
    expect(hits.map((hit) => hit.id)).toEqual([memory.id]);
    expect(hits[0]!.keywordRank).toBe(1);
    expect(await foundIds("salt")).toEqual([memory.id]);
  });

  it("joins every photo's text in photo id order and keeps it current as photos are removed", async () => {
    ctx = makeContext();
    const memory = await withPhotos("Notes from the fridge door", 3);
    const [first, second, third] = memory.photos.map((photo) => photo.id) as [number, number, number];

    // Saved out of order: the join still follows photo id order. A reading with no text adds nothing.
    await ctx.store.saveCaption(second, "A sticky note", "Plumber Friday\nbring keys");
    await ctx.store.saveCaption(third, "A fridge magnet", null);
    await ctx.store.saveCaption(first, "A calendar page", "Dentist Tuesday 3pm");
    expect(photoText(memory.id)).toBe("Dentist Tuesday 3pm\n\nPlumber Friday\nbring keys");
    expect(await foundIds("dentist")).toEqual([memory.id]);
    expect(await foundIds("plumber")).toEqual([memory.id]);

    await ctx.store.removePhoto(first);
    expect(photoText(memory.id)).toBe("Plumber Friday\nbring keys");
    expect(await foundIds("dentist")).toEqual([]);
    expect(await foundIds("plumber")).toEqual([memory.id]);

    await ctx.store.removePhoto(second);
    expect(photoText(memory.id)).toBeNull();
    expect(await foundIds("plumber")).toEqual([]);
    expect(await foundIds("fridge")).toEqual([memory.id]);
    expect(ctx.store.require(memory.id).photos).toEqual([
      { id: third, caption: "A fridge magnet", text: null, createdAt: memory.photos[2]!.createdAt },
    ]);
  });

  it("leaves the text alone when only a caption is saved, and records a reading that found no text", async () => {
    ctx = makeContext();
    const memory = await withPhotos("Shelf in the garage", 2);
    const [plain, blank] = memory.photos.map((photo) => photo.id) as [number, number];

    await ctx.store.saveCaption(plain, "A red toolbox");
    expect(photoRow(plain)).toEqual({ caption: "A red toolbox", captioned_at: ctx.clock.now, extracted_text: null, text_read_at: null });

    await ctx.store.saveCaption(blank, null, null);
    expect(photoRow(blank)).toEqual({ caption: null, captioned_at: ctx.clock.now, extracted_text: null, text_read_at: ctx.clock.now });
    expect(photoText(memory.id)).toBeNull();
    expect(ctx.store.require(memory.id).photos.map((photo) => photo.text)).toEqual([null, null]);

    // Text read earlier survives a later caption-only save.
    await ctx.store.saveCaption(plain, "A red toolbox", "ACME 12 piece");
    const readAt = ctx.clock.now;
    ctx.clock.now += DAY;
    await ctx.store.saveCaption(plain, "A blue toolbox");
    expect(photoRow(plain)).toEqual({
      caption: "A blue toolbox",
      captioned_at: ctx.clock.now,
      extracted_text: "ACME 12 piece",
      text_read_at: readAt,
    });
    expect(photoText(memory.id)).toBe("ACME 12 piece");
  });

  it("doesn't re-tag or re-embed when only the photo text changes", async () => {
    ctx = makeContext();
    const memory = await withPhotos("Recipe box on the top shelf");
    const photoId = memory.photos[0]!.id;
    await ctx.store.saveCaption(photoId, "A recipe card");
    ctx.store.markEnriched(memory.id);
    const before = ctx.store.getRow(memory.id)!;
    const vector = storedVector(memory.id);
    const calls = ctx.embedder.documentCalls;
    const changes = recordChanges();
    expect(before.enriched_at).not.toBeNull();
    expect(vector).toBeDefined();

    ctx.clock.now += DAY;
    await ctx.store.saveCaption(photoId, "A recipe card", RECIPE);
    await ctx.store.saveCaption(photoId, "A recipe card", "3 cups flour");

    expect(ctx.store.getRow(memory.id)).toEqual({ ...before, photo_text: "3 cups flour" });
    expect(ctx.embedder.documentCalls).toBe(calls);
    expect(storedVector(memory.id)).toEqual(vector);
    expect(changes).toEqual([]);
    expect(await foundIds("flour")).toEqual([memory.id]);
  });

  it("re-tags and re-embeds as before when the caption changes too, without embedding the text", async () => {
    ctx = makeContext();
    const documents: string[] = [];
    const embed = ctx.embedder.embedDocuments.bind(ctx.embedder);
    ctx.embedder.embedDocuments = async (texts: string[]) => {
      documents.push(...texts);
      return embed(texts);
    };
    // A photo-only memory: its meaning vector comes from the captions.
    const memory = await withPhotos("");
    const photoId = memory.photos[0]!.id;
    const changes = recordChanges();

    await ctx.store.saveCaption(photoId, "A recipe card", RECIPE);
    expect(changes).toEqual([{ kind: "captioned", id: memory.id }]);
    expect(ctx.store.getRow(memory.id)!.enriched_at).toBeNull();
    expect(documents).toEqual(["A recipe card"]);
    expect(ctx.search.vectors.has(memory.id)).toBe(true);

    ctx.store.markEnriched(memory.id);
    await ctx.store.saveCaption(photoId, "A handwritten recipe card", "2 cups flour\n1 tsp salt\n1 egg");
    expect(changes).toEqual([
      { kind: "captioned", id: memory.id },
      { kind: "captioned", id: memory.id },
    ]);
    expect(ctx.store.getRow(memory.id)!.enriched_at).toBeNull();
    expect(documents).toEqual(["A recipe card", "A handwritten recipe card"]);
  });
});

describe("photo text in search", () => {
  it("weights a match in photo text below the same match in the note's own words", async () => {
    ctx = makeContext();
    const { memory: note } = await ctx.store.create({ body: "flour" });
    ctx.clock.now += DAY;
    // Newer, and the same length: only the column weight puts it second.
    const photo = await withPhotos("");
    await ctx.store.saveCaption(photo.photos[0]!.id, null, "flour");

    const hits = await ctx.search.search("flour");
    expect(hits.map((hit) => [hit.id, hit.keywordRank])).toEqual([
      [note.id, 1],
      [photo.id, 2],
    ]);
  });
});

describe("photo text in API responses", () => {
  it("gives every photo a text field in list, search and get responses", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const res = await api.postForm("/api/memories", memoryForm({ body: "pantry shelf", photos: 2 }));
    expect(res.status).toBe(201);
    const created = (await res.json()) as Memory;
    expect(created.photos.map((photo) => photo.text)).toEqual([null, null]);
    expect(created.photos[1]).toHaveProperty("text", null);

    await ctx.store.saveCaption(created.photos[0]!.id, "A recipe card", RECIPE);
    const expected = [RECIPE, null];

    const list = (await (await api.get("/api/memories")).json()) as MemoryList;
    expect(list.memories.map((memory) => memory.id)).toEqual([created.id]);
    expect(list.memories[0]!.photos.map((photo) => photo.text)).toEqual(expected);

    const found = (await (await api.get("/api/search?q=flour")).json()) as SearchResponse;
    expect(found.results.map((memory) => memory.id)).toEqual([created.id]);
    expect(found.results[0]!.photos.map((photo) => photo.text)).toEqual(expected);

    const one = (await (await api.get(`/api/memories/${created.id}`)).json()) as Memory;
    expect(one.photos.map((photo) => photo.text)).toEqual(expected);
    expect(one.photos[1]).toHaveProperty("text", null);
  });
});

describe("photos described before photo text, in the store", () => {
  it("lists and counts only described photos never read, and saves just their text", async () => {
    ctx = makeContext();
    const older = await withPhotos("Older shelf", 2);
    ctx.clock.now += 1000;
    const newer = await withPhotos("Newer shelf", 3);
    const [o1, o2] = older.photos.map((photo) => photo.id) as [number, number];
    const [n1, n2] = newer.photos.map((photo) => photo.id) as [number, number, number];
    // Described by the call from before photo text: a caption and no reading.
    await ctx.store.saveCaption(o2, "An old caption");
    await ctx.store.saveCaption(o1, "Another old caption");
    await ctx.store.saveCaption(n2, "A third old caption");
    // Read by the new call already. The newer memory's third photo was never described, so it isn't offered.
    await ctx.store.saveCaption(n1, "A new caption", "Read already");
    // Outdated memories are included.
    await ctx.store.update(older.id, { archived: true });

    expect(ctx.store.photosWithoutText()).toEqual([newer.id, older.id]);
    expect(ctx.store.photosWithoutText(1)).toEqual([newer.id]);
    expect(ctx.store.photosWithoutTextIn(older.id)).toEqual([o1, o2]);
    expect(ctx.store.photosWithoutTextIn(newer.id)).toEqual([n2]);
    expect(ctx.store.countPhotosWithoutText()).toBe(3);

    ctx.store.markEnriched(older.id);
    const before = ctx.store.getRow(older.id)!;
    const photosBefore = [photoRow(o1), photoRow(o2)];
    const vector = storedVector(older.id);
    const calls = ctx.embedder.documentCalls;
    const changes = recordChanges();
    expect(vector).toBeDefined();

    ctx.clock.now += DAY;
    ctx.store.savePhotoText(o2, "Line one\nLine two");
    expect(photoRow(o2)).toEqual({ ...photosBefore[1], extracted_text: "Line one\nLine two", text_read_at: ctx.clock.now });
    expect(ctx.store.getRow(older.id)).toEqual({ ...before, photo_text: "Line one\nLine two" });
    expect(ctx.store.photosWithoutTextIn(older.id)).toEqual([o1]);
    expect(ctx.store.countPhotosWithoutText()).toBe(2);

    // A reading that found nothing is still done.
    ctx.store.savePhotoText(o1, null);
    expect(photoRow(o1)).toEqual({ ...photosBefore[0], extracted_text: null, text_read_at: ctx.clock.now });
    expect(ctx.store.getRow(older.id)).toEqual({ ...before, photo_text: "Line one\nLine two" });
    expect(ctx.store.photosWithoutText()).toEqual([newer.id]);
    expect(ctx.store.countPhotosWithoutText()).toBe(1);

    // A photo removed in the meantime: nothing happens.
    ctx.store.savePhotoText(999_999, "ghost");
    expect(ctx.store.countPhotosWithoutText()).toBe(1);

    expect(changes).toEqual([]);
    expect(ctx.embedder.documentCalls).toBe(calls);
    expect(storedVector(older.id)).toEqual(vector);
    expect((await ctx.search.search("line", { includeArchived: true })).map((hit) => hit.id)).toEqual([older.id]);
  });
});

describe("reading the text in photos described before photo text", () => {
  const READ_SAVED = "/api/photo-text/read-saved";
  const OLD_CAPTION = "An old description";
  let enricher: Enricher | undefined;
  let settings: SettingsStore;
  afterEach(() => {
    enricher?.stop();
    enricher = undefined;
  });

  const imageOf = (request: LlmRequest) =>
    Array.isArray(request.content) ? request.content.find((part) => part.type === "image") : undefined;
  /** The label `fakeJpeg` wrote into the photo. */
  const labelOf = (jpegBase64: string) => Buffer.from(jpegBase64, "base64").subarray(4).toString().replace(/\0+$/, "");
  const photoRequests = (llm: FakeLlm) => llm.requests.filter((request) => imageOf(request));
  const photoLabels = (llm: FakeLlm) =>
    photoRequests(llm).map((request) => {
      const image = imageOf(request);
      return image?.type === "image" ? labelOf(image.jpegBase64) : null;
    });
  const usageKinds = () => (ctx.db.prepare(`SELECT kind FROM ai_usage ORDER BY id`).all() as { kind: string }[]).map((row) => row.kind);
  /** What the fake reads in each photo: a shared line, then its label, which appears nowhere else. */
  const textOf = (label: string) => `Printed label\n${label}`;
  const requestFor = (label: string) => ({
    system: PHOTO_PROMPT,
    content: [
      { type: "image", jpegBase64: Buffer.from(fakeJpeg(label)).toString("base64") },
      { type: "text", text: "Describe this photo." },
    ],
    schema: PHOTO_SCHEMA,
    maxTokens: 4096,
  });
  const readSaved = (api: ReturnType<typeof client>) => api.send(READ_SAVED, { method: "POST" });
  const meOf = async (api: ReturnType<typeof client>) => (await (await api.get("/api/me")).json()) as MeResponse;

  /** A fake Claude that reads each photo's label (with a caption that must never be saved) and tags text. */
  function fakeClaude(): FakeLlm {
    return new FakeLlm((request) => {
      const image = imageOf(request);
      if (image?.type === "image") {
        const label = labelOf(image.jpegBase64);
        return { json: { caption: `A new caption for ${label}`, text: textOf(label) } };
      }
      return { json: { category: "things", tags: ["paperwork"] } };
    });
  }

  /** Describe photos starts off, so the photos can be described the old way first. */
  function setup(llm: FakeLlm | null) {
    ctx = makeContext({
      setup: (base) => {
        settings = new SettingsStore(base.db);
        if (!llm) return { settings };
        enricher = new Enricher({
          store: base.store,
          llm,
          usage: new UsageLog(base.db, () => base.clock.now),
          captionsEnabled: () => settings.photoCaptions(),
          readSavedPhotoText: () => settings.readSavedPhotoText(),
          log: () => {},
        });
        enricher.attach();
        return { llm, settings, enricher };
      },
    });
  }

  /** A memory whose photos were described by the call from before photo text existed: a caption and no text. */
  async function described(body: string, ...labels: string[]): Promise<{ id: number; photoIds: number[] }> {
    ctx.clock.now += 1000;
    const photos = labels.map((label) => ({ full: fakeJpeg(label), thumb: fakeJpeg(`${label}-thumb`) }));
    const { memory } = await ctx.store.create({ body, photos });
    await enricher?.idle();
    for (const photo of memory.photos) await ctx.store.saveCaption(photo.id, OLD_CAPTION);
    return { id: memory.id, photoIds: memory.photos.map((photo) => photo.id) };
  }

  /** Turns Describe photos on and lets every memory be tagged, as on a server that has been running a while. */
  async function settle(): Promise<void> {
    settings.setPhotoCaptions(true);
    enricher!.sweep();
    await enricher!.idle();
  }

  /** Everything reading a saved photo must leave alone (the memory row's `photo_text` aside). */
  function snapshot(ids: number[]) {
    return ids.map((id) => ({
      row: ctx.store.getRow(id),
      photos: ctx.db.prepare(`SELECT id, caption, captioned_at FROM photos WHERE memory_id = ? ORDER BY id`).all(id),
      vector: storedVector(id),
    }));
  }

  it("reads them only once asked, one request per photo, saving just their text", async () => {
    const llm = fakeClaude();
    setup(llm);
    const api = client(ctx.app, await login(ctx.app));
    const invoice = await described("Paperwork from the bank", "INVOICE");
    const postcard = await described("Stuck on the fridge", "POSTCARD");
    ctx.clock.now += 1000;
    const { memory: letter } = await ctx.store.create({
      body: "Letter from Sam",
      photos: [{ full: fakeJpeg("LETTER"), thumb: fakeJpeg("LETTER-thumb") }],
    });
    await enricher!.idle();
    await ctx.store.saveCaption(letter.photos[0]!.id, "A handwritten letter", "Dear Sam\nSee you soon");
    await settle();
    expect(photoRequests(llm)).toEqual([]);

    const me = await meOf(api);
    expect(me.photoText).toEqual({ unread: 2, requested: false });
    expect(PHOTO_TEXT_CAPABILITY).toBe("photo-text");
    expect(me.capabilities).toEqual(
      expect.arrayContaining([KEYWORD_CAPTURE_CAPABILITY, KEYWORD_RENAME_CAPABILITY, PHOTO_TEXT_CAPABILITY]),
    );

    // Describe photos is on, but nobody asked: a sweep sends neither photo.
    enricher!.sweep();
    await enricher!.idle();
    expect(photoRequests(llm)).toEqual([]);
    expect(await foundIds("invoice")).toEqual([]);
    expect(await foundIds("postcard")).toEqual([]);

    const ids = [invoice.id, postcard.id, letter.id];
    const before = snapshot(ids);
    const requests = llm.requests.length;
    const embedded = ctx.embedder.documentCalls;
    const usage = usageKinds();
    for (const memory of before) {
      expect(memory.row!.enriched_at).not.toBeNull();
      expect(memory.row!.tags).toBe("paperwork");
      expect(memory.vector).toBeDefined();
    }

    ctx.clock.now += DAY;
    const res = await readSaved(api);
    expect(res.status).toBe(200);
    expect(((await res.json()) as MeResponse).photoText).toMatchObject({ requested: true });
    await enricher!.idle();

    // One request per unread photo, newest first, the same request as a new photo. No tagging request.
    expect(llm.requests.slice(requests)).toEqual([requestFor("POSTCARD"), requestFor("INVOICE")]);
    for (const [memory, label] of [
      [invoice, "INVOICE"],
      [postcard, "POSTCARD"],
    ] as const) {
      expect(photoRow(memory.photoIds[0]!)).toMatchObject({
        caption: OLD_CAPTION,
        extracted_text: textOf(label),
        text_read_at: ctx.clock.now,
      });
      expect(ctx.store.require(memory.id).photos[0]).toMatchObject({ caption: OLD_CAPTION, text: textOf(label) });
    }

    // Captions, tags, category, enriched_at, updated_at and embeddings are as they were.
    expect(snapshot(ids)).toEqual([
      { ...before[0], row: { ...before[0]!.row, photo_text: textOf("INVOICE") } },
      { ...before[1], row: { ...before[1]!.row, photo_text: textOf("POSTCARD") } },
      before[2],
    ]);
    expect(ctx.embedder.documentCalls).toBe(embedded);
    expect(usageKinds()).toEqual([...usage, "caption", "caption"]);
    expect(photoRow(letter.photos[0]!.id).extracted_text).toBe("Dear Sam\nSee you soon");

    expect(await foundIds("invoice")).toEqual([invoice.id]);
    expect(await foundIds("postcard")).toEqual([postcard.id]);
    expect((await meOf(api)).photoText).toEqual({ unread: 0, requested: true });
  });

  it("reads the photos of outdated memories too", async () => {
    const llm = fakeClaude();
    setup(llm);
    const api = client(ctx.app, await login(ctx.app));
    const warranty = await described("Kept for the warranty", "RECEIPT");
    await ctx.store.update(warranty.id, { archived: true });
    await settle();
    expect((await meOf(api)).photoText).toEqual({ unread: 1, requested: false });

    expect((await readSaved(api)).status).toBe(200);
    await enricher!.idle();

    expect(photoLabels(llm)).toEqual(["RECEIPT"]);
    expect(photoRow(warranty.photoIds[0]!)).toMatchObject({
      caption: OLD_CAPTION,
      extracted_text: textOf("RECEIPT"),
      text_read_at: ctx.clock.now,
    });
    expect(ctx.store.getRow(warranty.id)!.archived_at).not.toBeNull();
    expect((await ctx.search.search("receipt", { includeArchived: true })).map((hit) => hit.id)).toEqual([warranty.id]);
    expect((await meOf(api)).photoText).toEqual({ unread: 0, requested: true });
  });

  it("gives up on a photo that is skipped, refused, cut off, invalid or missing, keeping its caption", async () => {
    const llm = fakeClaude();
    setup(llm);
    const api = client(ctx.app, await login(ctx.app));
    const labels = ["OK", "REFUSED", "CUTOFF", "SKIPPED", "INVALID", "MISSING"];
    // Tagged first, so a call has worked and a 400 means this photo is the problem.
    const memory = await described("Shoebox of papers", ...labels);
    await settle();
    const [ok, refused, cutOff, skipped, invalid, missing] = memory.photoIds as [number, number, number, number, number, number];
    await ctx.photos.remove([ctx.store.photoPath(missing, "full")!]);
    const before = snapshot([memory.id]);
    const requests = llm.requests.length;
    const usage = usageKinds();
    llm.reply(
      { json: { caption: "A new caption", text: "Kept in a shoebox" } },
      { json: null, stopReason: "refusal" },
      { json: null, stopReason: "max_tokens", outputTokens: 4096 },
      Anthropic.APIError.generate(400, {}, "Could not process image", new Headers()),
      { json: null, stopReason: "end_turn" },
    );

    ctx.clock.now += DAY;
    expect((await readSaved(api)).status).toBe(200);
    await enricher!.idle();

    // No caption-only retry for the cut-off reply, no request for the missing file and no tagging request.
    expect(llm.requests.slice(requests)).toEqual(["OK", "REFUSED", "CUTOFF", "SKIPPED", "INVALID"].map(requestFor));
    expect(photoRow(ok)).toMatchObject({ caption: OLD_CAPTION, extracted_text: "Kept in a shoebox", text_read_at: ctx.clock.now });
    for (const photoId of [refused, cutOff, skipped, invalid, missing]) {
      expect(photoRow(photoId)).toMatchObject({ caption: OLD_CAPTION, extracted_text: null, text_read_at: ctx.clock.now });
    }
    expect(snapshot([memory.id])).toEqual([{ ...before[0], row: { ...before[0]!.row, photo_text: "Kept in a shoebox" } }]);
    expect(usageKinds()).toEqual([...usage, "caption", "caption", "caption", "caption"]);
    expect((await meOf(api)).photoText).toEqual({ unread: 0, requested: true });

    enricher!.sweep();
    await enricher!.idle();
    expect(llm.requests).toHaveLength(requests + 5);
  });

  it("pauses during an outage and reads the photo on a later sweep", async () => {
    const llm = fakeClaude();
    setup(llm);
    const api = client(ctx.app, await login(ctx.app));
    const memory = await described("Garage wall", "FUSES");
    await settle();
    const usage = usageKinds();
    llm.reply(new Anthropic.APIConnectionError({ message: "offline" }));

    expect((await readSaved(api)).status).toBe(200);
    await enricher!.idle();
    expect(photoLabels(llm)).toEqual(["FUSES"]);
    expect(photoRow(memory.photoIds[0]!)).toMatchObject({ caption: OLD_CAPTION, extracted_text: null, text_read_at: null });
    expect(usageKinds()).toEqual(usage);
    expect((await meOf(api)).photoText).toEqual({ unread: 1, requested: true });
    expect(await foundIds("fuses")).toEqual([]);

    ctx.clock.now += DAY;
    enricher!.sweep();
    await enricher!.idle();
    expect(photoLabels(llm)).toEqual(["FUSES", "FUSES"]);
    expect(photoRow(memory.photoIds[0]!)).toMatchObject({
      caption: OLD_CAPTION,
      extracted_text: textOf("FUSES"),
      text_read_at: ctx.clock.now,
    });
    expect(usageKinds()).toEqual([...usage, "caption"]);
    expect(await foundIds("fuses")).toEqual([memory.id]);
    expect((await meOf(api)).photoText).toEqual({ unread: 0, requested: true });
  });

  it("stops while Describe photos is off, remembers the request, and resumes when it's turned on again", async () => {
    const llm = fakeClaude();
    setup(llm);
    const api = client(ctx.app, await login(ctx.app));
    const older = await described("Dryer instructions", "MANUAL");
    const newer = await described("Bills drawer", "BILL");
    await settle();
    const reply = llm.complete.bind(llm);
    let turnOff = true;
    llm.complete = async (request) => {
      if (turnOff && imageOf(request)) {
        turnOff = false;
        expect((await api.patch("/api/settings", { photoCaptions: false })).status).toBe(200);
      }
      return reply(request);
    };

    expect((await readSaved(api)).status).toBe(200);
    await enricher!.idle();
    expect(photoLabels(llm)).toEqual(["BILL"]);
    expect(photoRow(newer.photoIds[0]!).extracted_text).toBe(textOf("BILL"));
    expect(photoRow(older.photoIds[0]!).text_read_at).toBeNull();
    const paused = await meOf(api);
    expect(paused.photoCaptions).toBe(false);
    expect(paused.photoText).toEqual({ unread: 1, requested: true });

    enricher!.sweep();
    await enricher!.idle();
    expect(photoRequests(llm)).toHaveLength(1);

    const res = await api.patch("/api/settings", { photoCaptions: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as MeResponse).photoText).toMatchObject({ requested: true });
    await enricher!.idle();
    expect(photoLabels(llm)).toEqual(["BILL", "MANUAL"]);
    expect(photoRow(older.photoIds[0]!).extracted_text).toBe(textOf("MANUAL"));
    expect((await meOf(api)).photoText).toEqual({ unread: 0, requested: true });
  });

  it("is harmless to ask twice: nothing is read twice", async () => {
    const llm = fakeClaude();
    setup(llm);
    const api = client(ctx.app, await login(ctx.app));
    await described("Top drawer", "WARRANTY");
    await described("Bottom drawer", "TICKET");
    await settle();

    // Asked again straight away, without waiting for the reading to finish.
    expect((await readSaved(api)).status).toBe(200);
    expect((await readSaved(api)).status).toBe(200);
    await enricher!.idle();
    expect(photoLabels(llm)).toEqual(["TICKET", "WARRANTY"]);

    const again = await readSaved(api);
    expect(again.status).toBe(200);
    expect(((await again.json()) as MeResponse).photoText).toEqual({ unread: 0, requested: true });
    await enricher!.idle();
    expect(photoLabels(llm)).toEqual(["TICKET", "WARRANTY"]);
    expect(usageKinds().filter((kind) => kind === "caption")).toHaveLength(2);
  });

  it("needs Claude on the server, and changes nothing without it", async () => {
    setup(null);
    settings.setPhotoCaptions(true);
    const api = client(ctx.app, await login(ctx.app));
    const memory = await described("Shoebox", "NOCLAUDE");
    const before = snapshot([memory.id]);

    const res = await readSaved(api);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_request",
      message: "Reading text in photos needs an Anthropic API key on the server.",
    });
    expect(settings.readSavedPhotoText()).toBe(false);
    expect(snapshot([memory.id])).toEqual(before);
    expect(photoRow(memory.photoIds[0]!).text_read_at).toBeNull();
    expect((await meOf(api)).photoText).toEqual({ unread: 1, requested: false });
  });

  it("needs Describe photos on, and changes nothing while it's off", async () => {
    const llm = fakeClaude();
    setup(llm);
    const api = client(ctx.app, await login(ctx.app));
    const memory = await described("Shoebox", "OFF");
    enricher!.sweep();
    await enricher!.idle();
    const before = snapshot([memory.id]);
    const requests = llm.requests.length;

    const res = await readSaved(api);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request", message: "Turn on Describe photos first." });
    await enricher!.idle();
    expect(llm.requests).toHaveLength(requests);
    expect(settings.readSavedPhotoText()).toBe(false);
    expect(snapshot([memory.id])).toEqual(before);
    expect((await meOf(api)).photoText).toEqual({ unread: 1, requested: false });

    // Nothing was remembered: turning Describe photos on later doesn't read the photo either.
    expect((await api.patch("/api/settings", { photoCaptions: true })).status).toBe(200);
    await enricher!.idle();
    expect(photoRequests(llm)).toEqual([]);
    expect(photoRow(memory.photoIds[0]!).text_read_at).toBeNull();
  });

  it("is session only: 401 without a session and 401 with a Siri Shortcuts key", async () => {
    const llm = fakeClaude();
    setup(llm);
    await described("Shoebox", "SIRI");
    await settle();
    const token = new TokenStore(ctx.db).create("fictional Siri").token;

    const anonymous = await ctx.app.request(READ_SAVED, { method: "POST" });
    expect(anonymous.status).toBe(401);
    const siri = await ctx.app.request(READ_SAVED, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(siri.status).toBe(401);

    await enricher!.idle();
    expect(photoRequests(llm)).toEqual([]);
    expect(settings.readSavedPhotoText()).toBe(false);
    expect(ctx.store.countPhotosWithoutText()).toBe(1);
  });
});
