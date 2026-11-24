import { afterEach, describe, expect, it } from "vitest";
import type { Memory, MemoryList, SearchResponse } from "../../shared/types.js";
import type { MemoryChange } from "../src/memories.js";
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
