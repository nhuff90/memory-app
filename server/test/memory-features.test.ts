import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import type { Memory, MemoryList, SearchResponse } from "../../shared/types.js";
import { normalizeKeywords } from "../../shared/keywords.js";
import { UsageLog } from "../src/ai.js";
import { Enricher } from "../src/enrich.js";
import { MemoryStore } from "../src/memories.js";
import { TokenStore } from "../src/tokens.js";
import { FakeLlm } from "./fakeLlm.js";
import { client, fakeJpeg, login, makeContext, type TestContext } from "./helpers.js";

let ctx: TestContext;
afterEach(() => ctx?.cleanup());
const save = async (body: string) => (await ctx.store.create({ body })).memory;
const ids = (memories: Memory[]) => memories.map((memory) => memory.id);
const find = async (q: string) => (await ctx.search.search(q)).map((hit) => hit.id);

describe("pinned memories", () => {
  it("persists pin/unpin and filters before newest-first pagination and outdated handling", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const first = await save("compass first");
    await save("compass unpinned");
    const second = await save("compass second");
    const old = await save("compass outdated");
    for (const memory of [first, second, old]) expect((await api.patch(`/api/memories/${memory.id}`, { pinned: true })).status).toBe(200);
    await ctx.store.update(old.id, { archived: true });
    const restarted = new MemoryStore(ctx.db, ctx.photos);
    expect(restarted.require(first.id).pinned).toBe(true);
    const page = await (await api.get("/api/memories?pinned=1&limit=1")).json() as MemoryList;
    expect(ids(page.memories)).toEqual([second.id]);
    expect(page.nextCursor).not.toBeNull();
    const next = await (await api.get(`/api/memories?pinned=1&limit=1&cursor=${page.nextCursor}`)).json() as MemoryList;
    expect(ids(next.memories)).toEqual([first.id]);
    expect(next.nextCursor).toBeNull();
    const all = await (await api.get("/api/memories?pinned=1&archived=1")).json() as MemoryList;
    expect(ids(all.memories)).toEqual([old.id, second.id, first.id]);
    const search = await (await api.get("/api/search?q=compass&pinned=1")).json() as SearchResponse;
    expect(ids(search.results).sort()).toEqual([first.id, second.id]);
    const archivedSearch = await (await api.get("/api/search?q=compass&pinned=1&archived=1")).json() as SearchResponse;
    expect(ids(archivedSearch.results)).toContain(old.id);
    await api.patch(`/api/memories/${first.id}`, { pinned: false });
    expect(restarted.require(first.id).pinned).toBe(false);
    expect(ids(restarted.list({ pinned: true }).memories)).toEqual([second.id]);
  });

  it("filters keyword and semantic candidates before limits without boosting ordinary relevance", async () => {
    ctx = makeContext();
    const pinned = await save("compass");
    for (let i = 0; i < 185; i++) await save("compass");
    const before = await ctx.search.search("compass", { limit: 200 });
    await ctx.store.update(pinned.id, { pinned: true });
    expect(await ctx.search.search("compass", { limit: 200 })).toEqual(before);
    expect((await ctx.search.search("compass", { pinned: true })).map((hit) => hit.id)).toEqual([pinned.id]);
    // No matching literal word: this result must survive the semantic candidate limit too.
    const semantic = await save("ipad");
    await ctx.store.update(semantic.id, { pinned: true });
    for (let i = 0; i < 185; i++) await save("ipad");
    expect((await ctx.search.search("tablet", { pinned: true })).map((hit) => hit.id)).toEqual([semantic.id]);
  });
});

describe("custom keywords", () => {
  it("normalizes commas, whitespace, empties and case-insensitive duplicates, retaining spelling", () => {
    expect(normalizeKeywords(["  Bike , ,BIKE, Shed ", "shed", "工具"])).toEqual(["Bike", "Shed", "工具"]);
    expect(normalizeKeywords(Array(20).fill("bike"))).toEqual(["bike"]);
    expect(normalizeKeywords(["x".repeat(40)])).toEqual(["x".repeat(40)]);
    expect(() => normalizeKeywords(["x".repeat(41)])).toThrow(/40 characters/);
    expect(() => normalizeKeywords(Array.from({ length: 11 }, (_, i) => `key${i}`))).toThrow(/10 custom keywords/);
  });

  it("validates atomically and updates search immediately on addition, replacement and removal", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const note = await save("ordinary note");
    const path = `/api/memories/${note.id}`;
    const updated = await (await api.patch(path, { body: "edited note", customKeywords: ["  Zephyr, ,ZEPHYR "] })).json() as Memory;
    expect(updated.body).toBe("edited note");
    expect(updated.customKeywords).toEqual(["Zephyr"]);
    expect(updated.tags).toEqual([]);
    expect(await find("zephyr")).toEqual([note.id]);
    expect((await api.patch(path, { body: "must not save", customKeywords: ["x".repeat(41)] })).status).toBe(400);
    expect(ctx.store.require(note.id).body).toBe("edited note");
    const tooMany = await api.patch(path, { customKeywords: Array.from({ length: 11 }, (_, i) => `key${i}`) });
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json() as { message: string }).message).toMatch(/10 custom keywords/);
    expect((await api.patch(path, { customKeywords: "bad" })).status).toBe(400);
    expect((await api.patch(path, { pinned: "yes" })).status).toBe(400);
    await api.patch(path, { customKeywords: ["Nimbus"] });
    expect(await find("zephyr")).toEqual([]);
    expect(await find("nimbus")).toEqual([note.id]);
    await api.patch(path, { customKeywords: [] });
    expect(await find("nimbus")).toEqual([]);
  });

  it("does not enrich or embed metadata-only edits and preserves keywords through body enrichment", async () => {
    const llm = new FakeLlm(() => ({ json: { category: "things", tags: ["automatic"] } }));
    let enricher: Enricher;
    ctx = makeContext({ setup: ({ store, db }) => {
      enricher = new Enricher({ store, llm, usage: new UsageLog(db), log: () => {} });
      enricher.attach();
      return { llm };
    } });
    const note = await save("compass");
    await enricher!.idle();
    const calls = llm.requests.length;
    const embeds = ctx.embedder.documentCalls;
    const enrichedAt = ctx.store.require(note.id).enrichedAt;
    await ctx.store.update(note.id, { customKeywords: ["Zephyr"] });
    await ctx.store.update(note.id, { pinned: true });
    await ctx.store.update(note.id, { body: "compass", customKeywords: ["Nimbus"] });
    await enricher!.idle();
    expect(llm.requests).toHaveLength(calls);
    expect(ctx.embedder.documentCalls).toBe(embeds);
    expect(ctx.store.require(note.id).enrichedAt).toBe(enrichedAt);
    expect(await find("nimbus")).toEqual([note.id]);
    await ctx.store.update(note.id, { body: "compass cabinet" });
    await enricher!.idle();
    expect(llm.requests).toHaveLength(calls + 1);
    expect(ctx.embedder.documentCalls).toBe(embeds + 1);
    expect(llm.lastContent).not.toContain("Nimbus");
    expect(ctx.store.require(note.id)).toMatchObject({ customKeywords: ["Nimbus"], tags: ["automatic"], pinned: true });
    expect(await find("nimbus")).toEqual([note.id]);
    enricher!.stop();
  });

  it("retrieves keyword metadata for Ask in a large collection and labels it as user-provided", async () => {
    const llm = new FakeLlm(() => ({ json: { answer: "A fictional answer.", used_ids: [] } }));
    ctx = makeContext({ app: { llm } });
    const note = await save("special ordinary note");
    await ctx.store.update(note.id, { customKeywords: ["Zephyr"] });
    for (let i = 0; i < 51; i++) await save(`unrelated ${i}`);
    const api = client(ctx.app, await login(ctx.app));
    expect((await api.postJson("/api/ask", { question: "Zephyr" })).status).toBe(200);
    expect(llm.lastContent).toContain("special ordinary note");
    expect(llm.lastContent).toContain("user-provided search metadata (custom keywords): Zephyr");
    expect(llm.lastContent).not.toContain("unrelated");
  });

  it("exports pin state and keywords separately from tags in JSON and Markdown", async () => {
    ctx = makeContext();
    const note = await save("fictional travel box");
    await ctx.store.update(note.id, { pinned: true, customKeywords: ["Zephyr", "Map"] });
    const api = client(ctx.app, await login(ctx.app));
    const files = unzipSync(new Uint8Array(await (await api.get("/api/export")).arrayBuffer()));
    const json = JSON.parse(strFromU8(files["memories.json"]!));
    expect(json.memories[0]).toMatchObject({ pinned: true, customKeywords: ["Zephyr", "Map"], tags: [] });
    expect(strFromU8(files["memories.md"]!)).toContain("Pinned: yes");
    expect(strFromU8(files["memories.md"]!)).toContain("Custom keywords: Zephyr, Map");
  });
});

describe("related memories", () => {
  it("caps at three across categories/pins, excludes self/outdated, and hydrates results", async () => {
    ctx = makeContext();
    const source = await save("compass cabinet");
    for (let i = 0; i < 5; i++) {
      const note = await save("compass cabinet");
      await ctx.store.update(note.id, { category: i % 2 ? "work" : "things", pinned: i % 2 === 0 });
    }
    const old = await save("compass cabinet");
    await ctx.store.update(old.id, { archived: true });
    const api = client(ctx.app, await login(ctx.app));
    const response = await api.get(`/api/memories/${source.id}/related`);
    expect(response.status).toBe(200);
    const { results } = await response.json() as SearchResponse;
    expect(results).toHaveLength(3);
    expect(ids(results)).not.toContain(source.id);
    expect(ids(results)).not.toContain(old.id);
    expect(results.every((note) => Array.isArray(note.photos) && Array.isArray(note.customKeywords))).toBe(true);
    expect(new Set(results.map((note) => note.category)).size).toBe(2);
    expect(new Set(results.map((note) => note.pinned)).size).toBe(2);
  });

  it("excludes self/outdated before keyword and semantic candidate limits", async () => {
    ctx = makeContext();
    const source = await save("ipad");
    const keywordTarget = await save("ipad");
    const semanticTarget = await save("tablet");
    // More excluded notes than either search's candidate window, all closer than the eligible semantic hit.
    for (let i = 0; i < 185; i++) {
      const note = await save("ipad");
      await ctx.store.update(note.id, { archived: true });
    }
    expect(ids(await ctx.search.related(ctx.store, source.id)).sort()).toEqual([keywordTarget.id, semanticTarget.id]);
  });

  it("uses semantic relevance thresholds and retains keyword fallback on model failure", async () => {
    ctx = makeContext();
    const source = await save("ipad");
    const target = await save("tablet");
    await save("garden watering schedule");
    expect(ids(await ctx.search.related(ctx.store, source.id))).toEqual([target.id]);
    const keyword = await save("ipad cabinet");
    ctx.embedder.failQueries = true;
    expect(ids(await ctx.search.related(ctx.store, source.id))).toEqual([keyword.id]);
  });

  it("handles missing/empty/photo-only sources and uses captions then keyword fallback", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    expect((await api.get("/api/memories/999/related")).status).toBe(404);
    const { memory: photo } = await ctx.store.create({ body: "", photos: [{ full: fakeJpeg(), thumb: fakeJpeg() }] });
    expect(await ctx.search.related(ctx.store, photo.id)).toEqual([]);
    const target = await save("amber toolbox");
    await ctx.store.saveCaption(photo.photos[0]!.id, "amber toolbox");
    expect(ids(await ctx.search.related(ctx.store, photo.id))).toEqual([target.id]);
    await ctx.store.saveCaption(photo.photos[0]!.id, null);
    await ctx.store.update(photo.id, { customKeywords: ["amber toolbox"] });
    expect(ids(await ctx.search.related(ctx.store, photo.id))).toEqual([target.id]);
    const punctuation = await save("... !");
    expect(await ctx.search.related(ctx.store, punctuation.id)).toEqual([]);
    await ctx.store.update(punctuation.id, { customKeywords: ["amber"] });
    expect(ids(await ctx.search.related(ctx.store, punctuation.id))).toContain(target.id);
  });

  it("bounds the query and makes no LLM requests", async () => {
    const llm = new FakeLlm();
    ctx = makeContext({ app: { llm } });
    const source = await save("compass ".repeat(1000));
    const queries: string[] = [];
    const original = ctx.embedder.embedQuery.bind(ctx.embedder);
    ctx.embedder.embedQuery = async (query) => { queries.push(query); return original(query); };
    await ctx.search.related(ctx.store, source.id);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.length).toBeLessThanOrEqual(500);
    expect(llm.requests).toHaveLength(0);
  });
});

it("keeps new endpoints and edits behind session auth and denies restricted Siri keys", async () => {
  ctx = makeContext();
  const note = await save("fictional compass");
  const path = `/api/memories/${note.id}`;
  expect((await ctx.app.request(`${path}/related`)).status).toBe(401);
  expect((await ctx.app.request(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: true }) })).status).toBe(401);
  const token = new TokenStore(ctx.db).create("fictional Siri").token;
  const api = client(ctx.app, "");
  for (const route of [`${path}/related`, "/api/memories?pinned=1", "/api/search?q=compass&pinned=1"]) {
    expect((await api.send(route, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  }
  expect((await api.send(path, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ customKeywords: ["bad"] }) })).status).toBe(401);
  expect(ctx.store.require(note.id)).toMatchObject({ pinned: false, customKeywords: [] });
});
