import { afterEach, describe, expect, it } from "vitest";
import { searchTerms } from "../../shared/text.js";
import { matchQuery, SearchIndex, VectorIndex, type SearchOptions } from "../src/search.js";
import { FakeEmbedder } from "./fakeEmbedder.js";
import { client, DAY, fakeJpeg, login, makeContext, memoryForm, type TestContext } from "./helpers.js";

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

async function save(body: string, daysAgo = 0) {
  const { memory } = await ctx.store.create({ body, createdAt: ctx.clock.now - daysAgo * DAY });
  return memory;
}

async function find(query: string, options: SearchOptions = {}): Promise<string[]> {
  const hits = await ctx.search.search(query, options);
  return ctx.store.getMany(hits.map((hit) => hit.id)).map((memory) => memory.body);
}

describe("query cleanup", () => {
  it("keeps the words that matter", () => {
    expect(searchTerms("Where's the screwdriver?")).toEqual(["screwdriver"]);
    expect(searchTerms("What are Sarah's kids' names")).toEqual(["sarah", "kids"]);
    expect(searchTerms("bike stem bolts 5 Nm")).toEqual(["bike", "stem", "bolts", "5", "nm"]);
    expect(searchTerms("where is it?")).toEqual([]);
    expect(searchTerms("ipad IPAD iPad")).toEqual(["ipad"]);
  });

  it("matches every word as a prefix", () => {
    expect(matchQuery(["screwdriver", "box"])).toBe('"screwdriver"* OR "box"*');
  });
});

describe("vector index", () => {
  it("adds, replaces, and removes vectors", () => {
    const index = new VectorIndex();
    index.set(1, Float32Array.of(1, 0));
    index.set(2, Float32Array.of(0, 1));
    index.set(3, Float32Array.of(0.8, 0.6));
    index.set(1, Float32Array.of(0.6, 0.8));
    index.delete(2);
    expect(index.size).toBe(2);
    expect(index.nearest(Float32Array.of(1, 0), 10, 0).map((hit) => hit.id)).toEqual([3, 1]);
    expect(index.nearest(Float32Array.of(1, 0), 10, 0.7).map((hit) => hit.id)).toEqual([3]);
    index.delete(3);
    index.delete(3);
    expect(index.nearest(Float32Array.of(1, 0), 10, 0).map((hit) => hit.id)).toEqual([1]);
  });
});

describe("search", () => {
  it("finds a note from a half-typed word", async () => {
    ctx = makeContext();
    await save("I put the screwdriver in the basement next to the washer");
    await save("ipad in gym");
    expect(await find("screwdr")).toEqual(["I put the screwdriver in the basement next to the washer"]);
  });

  it("finds a note by meaning when no words match", async () => {
    ctx = makeContext();
    await save("ipad in gym");
    await save("I put the screwdriver in the basement next to the washer");
    expect(await find("where is my tablet")).toEqual(["ipad in gym"]);
  });

  it("ranks notes that match by words and by meaning first", async () => {
    ctx = makeContext();
    await save("torch in the garage");
    await save("flashlight in the kitchen drawer");
    expect(await find("flashlight")).toEqual(["flashlight in the kitchen drawer", "torch in the garage"]);
  });

  it("ranks notes containing the typed word above notes that only seem related", async () => {
    ctx = makeContext();
    await save("christmas lights in the attic behind the old luggage", 300);
    await save("tools in the loft", 0);
    expect(await find("attic")).toEqual(["christmas lights in the attic behind the old luggage", "tools in the loft"]);
  });

  it("prefers the newer note when two match equally well", async () => {
    ctx = makeContext();
    await save("ipad in gym", 30);
    await save("ipad in kitchen", 1);
    expect(await find("ipad")).toEqual(["ipad in kitchen", "ipad in gym"]);
  });

  it("hides Outdated notes unless asked", async () => {
    ctx = makeContext();
    const memory = await save("christmas boxes in the attic");
    await ctx.store.update(memory.id, { archived: true });
    expect(await find("christmas")).toEqual([]);
    expect(await find("christmas", { includeArchived: true })).toEqual(["christmas boxes in the attic"]);
  });

  it("filters by category", async () => {
    ctx = makeContext();
    const sarah = await save("Sarah's kids are Emma and Jake");
    await save("kids bikes are in the shed");
    ctx.db.prepare(`UPDATE memories SET category = 'people' WHERE id = ?`).run(sarah.id);
    expect(await find("kids", { category: "people" })).toEqual(["Sarah's kids are Emma and Jake"]);
  });

  it("strict mode returns only close matches", async () => {
    ctx = makeContext();
    await save("ipad in gym");
    await save("gym bag is in the car");
    expect(await find("ipad in gym", { strict: true })).toEqual(["ipad in gym"]);
    expect(await find("ipad in gym")).toHaveLength(2);
  });

  it("strict mode doesn't promote a weaker match once the close one is outdated", async () => {
    ctx = makeContext();
    const old = await save("flashlight in the garage cabinet");
    await save("box cutter in the garage");
    const loose = { strict: true, minSimilarity: 0.25 };
    expect(await find("flashlight moved to the garage cabinet", loose)).toEqual(["flashlight in the garage cabinet"]);
    await ctx.store.update(old.id, { archived: true });
    expect(await find("flashlight moved to the garage cabinet", loose)).toEqual([]);
    expect(await find("box cutter in the garage", loose)).toEqual(["box cutter in the garage"]);
  });

  it("stays current as notes are edited and deleted", async () => {
    ctx = makeContext();
    const memory = await save("ipad in gym");
    await ctx.store.update(memory.id, { body: "ipad in office" });
    expect(await find("office")).toEqual(["ipad in office"]);
    expect(await find("tablet gym")).toEqual([]);
    expect(await find("tablet office")).toEqual(["ipad in office"]);
    await ctx.store.delete(memory.id);
    expect(await find("ipad")).toEqual([]);
    expect(ctx.search.vectors.has(memory.id)).toBe(false);
  });

  it("doesn't re-embed archived notes or photo changes", async () => {
    ctx = makeContext();
    const memory = await save("ipad in gym");
    const calls = ctx.embedder.documentCalls;
    await ctx.store.update(memory.id, { archived: true });
    await ctx.store.update(memory.id, { archived: false, body: "ipad in gym" });
    expect(ctx.embedder.documentCalls).toBe(calls);
  });

  it("loads saved vectors at startup and embeds only what's missing", async () => {
    ctx = makeContext();
    await save("ipad in gym");
    await save("flashlight in the kitchen drawer");
    const fresh = new FakeEmbedder();
    const restarted = new SearchIndex(ctx.db, fresh, () => ctx.clock.now, () => {});
    expect(await restarted.init()).toBe(0);
    expect(fresh.documentCalls).toBe(0);
    expect(restarted.vectors.size).toBe(2);

    ctx.db.prepare(`DELETE FROM embeddings`).run();
    const again = new SearchIndex(ctx.db, fresh, () => ctx.clock.now, () => {});
    expect(await again.init()).toBe(2);
    expect(fresh.documentCalls).toBe(2);
    expect(again.vectors.size).toBe(2);
  });

  it("re-embeds everything when the model changes", async () => {
    ctx = makeContext();
    await save("ipad in gym");
    const upgraded = Object.assign(new FakeEmbedder(), { model: "fake-embedder-v2" });
    const restarted = new SearchIndex(ctx.db, upgraded, () => ctx.clock.now, () => {});
    expect(await restarted.init()).toBe(1);
    const stored = ctx.db.prepare(`SELECT model FROM embeddings`).all();
    expect(stored).toEqual([{ model: "fake-embedder-v2" }]);
  });

  it("falls back to keywords when the model fails", async () => {
    ctx = makeContext();
    await save("ipad in gym");
    ctx.embedder.failQueries = true;
    expect(await find("ipad")).toEqual(["ipad in gym"]);
  });

  it("treats search syntax as plain words", async () => {
    ctx = makeContext();
    await save("ipad in gym");
    expect(await find('"ipad" AND (gym* OR -NEAR')).toEqual(["ipad in gym"]);
    expect(await find("***")).toEqual([]);
    expect(await find("   ")).toEqual([]);
  });

  it("skips vectors for notes with only a photo", async () => {
    ctx = makeContext();
    const { memory } = await ctx.store.create({ body: "", photos: [{ full: fakeJpeg("full"), thumb: fakeJpeg("thumb") }] });
    expect(ctx.search.vectors.has(memory.id)).toBe(false);
  });
});

describe("GET /api/search", () => {
  it("requires login", async () => {
    ctx = makeContext();
    const res = await ctx.app.request("/api/search?q=ipad");
    expect(res.status).toBe(401);
  });

  it("returns full memories, best first", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    await api.postForm("/api/memories", memoryForm({ body: "ipad in gym", photos: 1 }));
    await api.postJson("/api/memories", { body: "screwdriver in the basement" });
    const res = await api.get("/api/search?q=tablet");
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: { body: string; photos: unknown[] }[] };
    expect(results.map((memory) => memory.body)).toEqual(["ipad in gym"]);
    expect(results[0]!.photos).toHaveLength(1);
  });

  it("returns nothing for an empty query", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    await api.postJson("/api/memories", { body: "ipad in gym" });
    expect(await (await api.get("/api/search?q=")).json()).toEqual({ results: [] });
  });

  it("honors the archived and strict flags", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const created = (await (await api.postJson("/api/memories", { body: "ipad in gym" })).json()) as { id: number };
    await api.postJson("/api/memories", { body: "gym bag is in the car" });
    await api.patch(`/api/memories/${created.id}`, { archived: true });
    const visible = (await (await api.get("/api/search?q=ipad+gym")).json()) as { results: { body: string }[] };
    expect(visible.results.map((memory) => memory.body)).toEqual(["gym bag is in the car"]);
    const all = (await (await api.get("/api/search?q=ipad+gym&archived=1&strict=1")).json()) as {
      results: { body: string }[];
    };
    expect(all.results.map((memory) => memory.body)).toEqual(["ipad in gym"]);
  });

  it("rejects bad parameters", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    expect((await api.get("/api/search?q=ipad&limit=0")).status).toBe(400);
    expect((await api.get("/api/search?q=ipad&category=pets")).status).toBe(400);
  });
});
