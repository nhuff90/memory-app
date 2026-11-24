import { join } from "node:path";
import Database from "better-sqlite3";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { KEYWORD_CAPTURE_CAPABILITY } from "../../shared/keywords.js";
import type { KeywordVocabulary, MeResponse, Memory, MemoryList, ReconcileResponse, SearchResponse } from "../../shared/types.js";
import { UsageLog } from "../src/ai.js";
import { openDb } from "../src/db.js";
import { Enricher } from "../src/enrich.js";
import { MemoryStore } from "../src/memories.js";
import { MIGRATIONS } from "../src/migrations/index.js";
import { TokenStore } from "../src/tokens.js";
import { FakeLlm } from "./fakeLlm.js";
import { client, DAY, login, makeContext, memoryForm, type TestContext } from "./helpers.js";

let ctx: TestContext;
afterEach(() => ctx?.cleanup());
const ids = (memories: Memory[]) => memories.map((memory) => memory.id);
const counts = () => Object.fromEntries(ctx.store.keywordVocabulary().map((entry) => [entry.key, entry.count]));
const usage = (key: string) => ctx.store.keywordVocabulary().find((entry) => entry.key === key);
const rowCount = (table: string) => (ctx.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

function keywordForm(fields: Parameters<typeof memoryForm>[0], keywords: string[]): FormData {
  const form = memoryForm(fields);
  for (const keyword of keywords) form.append("customKeywords", keyword);
  return form;
}

describe("capture with keywords", () => {
  it("saves text and photo captures with normalized keywords atomically over JSON and multipart", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const text = await api.postJson("/api/memories", {
      body: "Christmas lights are in the blue bin",
      clientId: "client-text-0001",
      customKeywords: [" Christmas , ,CHRISTMAS", "Garage"],
    });
    expect(text.status).toBe(201);
    const saved = (await text.json()) as Memory;
    expect(saved.customKeywords).toEqual(["Christmas", "Garage"]);
    const photo = await api.postForm("/api/memories", keywordForm({ body: "", clientId: "client-photo-001", photos: 2 }, ["Garage, shelf", "garage"]));
    expect(photo.status).toBe(201);
    const photoMemory = (await photo.json()) as Memory;
    expect(photoMemory.customKeywords).toEqual(["Garage", "shelf"]);
    expect(photoMemory.photos).toHaveLength(2);
    expect(counts()).toEqual({ christmas: 1, garage: 2, shelf: 1 });
    // Reopen through a fresh store: the keywords are durable and searchable immediately.
    const reopened = new MemoryStore(ctx.db, ctx.photos);
    expect(reopened.require(saved.id).customKeywords).toEqual(["Christmas", "Garage"]);
    expect((await ctx.search.search("shelf")).map((hit) => hit.id)).toEqual([photoMemory.id]);
    const files = unzipSync(new Uint8Array(await (await api.get("/api/export")).arrayBuffer()));
    const exported = JSON.parse(strFromU8(files["memories.json"]!)) as { memories: { id: number; customKeywords: string[]; tags: string[]; photos: unknown[] }[] };
    expect(exported.memories.find((memory) => memory.id === photoMemory.id)).toMatchObject({ customKeywords: ["Garage", "shelf"], tags: [] });
    expect(exported.memories.find((memory) => memory.id === photoMemory.id)!.photos).toHaveLength(2);
    expect(strFromU8(files["memories.md"]!)).toContain("Custom keywords: Christmas, Garage");
  });

  it("rejects invalid keyword lists without saving the recall, its photos or any usage", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const tooLong = await api.postForm("/api/memories", keywordForm({ body: "photo note", clientId: "client-bad-0001", photos: 1 }, ["x".repeat(41)]));
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { message: string }).message).toMatch(/40 characters/);
    const tooMany = await api.postJson("/api/memories", { body: "note", clientId: "client-bad-0002", customKeywords: Array.from({ length: 11 }, (_, i) => `k${i}`) });
    expect(tooMany.status).toBe(400);
    expect(((await tooMany.json()) as { message: string }).message).toMatch(/10 custom keywords/);
    expect((await api.postJson("/api/memories", { body: "note", customKeywords: "Garage" })).status).toBe(400);
    expect(rowCount("memories")).toBe(0);
    expect(rowCount("photos")).toBe(0);
    expect(rowCount("memory_keywords")).toBe(0);
    expect(rowCount("capture_receipts")).toBe(0);
    // The same clientId can then be saved once the input is fixed.
    const fixed = await api.postForm("/api/memories", keywordForm({ body: "photo note", clientId: "client-bad-0001", photos: 1 }, ["x".repeat(40)]));
    expect(fixed.status).toBe(201);
  });

  it("keeps the clientId retry contract: no duplicate recall and no double-counted keyword", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const form = () => keywordForm({ body: "interrupted upload", clientId: "client-retry-001", photos: 1 }, ["Garage"]);
    const first = await api.postForm("/api/memories", form());
    ctx.clock.now += DAY;
    const retry = await api.postForm("/api/memories", form());
    expect([first.status, retry.status]).toEqual([201, 200]);
    const [a, b] = [(await first.json()) as Memory, (await retry.json()) as Memory];
    expect(b.id).toBe(a.id);
    expect(rowCount("memories")).toBe(1);
    expect(rowCount("photos")).toBe(1);
    expect(usage("garage")).toMatchObject({ count: 1, lastAssignedAt: a.createdAt });
    // Repeating create cannot change an existing record either.
    const different = await api.postJson("/api/memories", { body: "other", clientId: "client-retry-001", customKeywords: ["Shed"] });
    expect(((await different.json()) as Memory).customKeywords).toEqual(["Garage"]);
  });

  it("treats older clients without the field as an empty keyword list in JSON and multipart", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const json = (await (await api.postJson("/api/memories", { body: "legacy json", clientId: "legacy-json-01" })).json()) as Memory;
    const form = (await (await api.postForm("/api/memories", memoryForm({ body: "legacy form", clientId: "legacy-form-01" }))).json()) as Memory;
    expect([json.customKeywords, form.customKeywords]).toEqual([[], []]);
    expect(ctx.store.keywordVocabulary()).toEqual([]);
  });

  it("advertises keyword capture so new clients can detect older servers", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const me = (await (await api.get("/api/me")).json()) as MeResponse;
    expect(me.capabilities).toContain(KEYWORD_CAPTURE_CAPABILITY);
  });
});

describe("keyword usage and recency", () => {
  it("counts active recalls once and records recency only for genuine new assignments", async () => {
    ctx = makeContext();
    const t0 = ctx.clock.now;
    const first = (await ctx.store.create({ body: "lights", customKeywords: ["Garage", "Christmas"] })).memory;
    ctx.clock.now = t0 + 1000;
    const second = (await ctx.store.create({ body: "rake", customKeywords: ["garage"] })).memory;
    expect(usage("garage")).toEqual({ keyword: "Garage", key: "garage", count: 2, lastAssignedAt: t0 + 1000 });
    expect(usage("christmas")).toMatchObject({ count: 1, lastAssignedAt: t0 });

    ctx.clock.now = t0 + 2000;
    await ctx.store.update(first.id, { pinned: true });
    await ctx.store.update(first.id, { body: "lights moved" });
    await ctx.store.update(first.id, { customKeywords: ["GARAGE", "Christmas"] }); // respelling only
    expect(usage("garage")!.lastAssignedAt).toBe(t0 + 1000);
    expect(usage("christmas")!.lastAssignedAt).toBe(t0);
    expect(usage("garage")!.count).toBe(2);

    ctx.clock.now = t0 + 3000;
    await ctx.store.update(first.id, { customKeywords: ["GARAGE", "Christmas", "Shed"] });
    expect(usage("shed")).toMatchObject({ count: 1, lastAssignedAt: t0 + 3000 });

    await ctx.store.update(second.id, { customKeywords: [] });
    expect(usage("garage")).toMatchObject({ count: 1, lastAssignedAt: t0, keyword: "GARAGE" });
    await ctx.store.update(first.id, { archived: true });
    // Outdated-only keywords stay known for typed matches but have no active count or recency.
    expect(usage("garage")).toMatchObject({ count: 0, lastAssignedAt: null });
    expect(ctx.store.require(first.id).customKeywords).toEqual(["GARAGE", "Christmas", "Shed"]);
    await ctx.store.update(first.id, { archived: false });
    expect(usage("garage")).toMatchObject({ count: 1, lastAssignedAt: t0 });
    await ctx.store.delete(first.id);
    expect(ctx.store.keywordVocabulary()).toEqual([]);
    expect(rowCount("memory_keywords")).toBe(0);
  });

  it("serves the vocabulary only to the logged-in session", async () => {
    ctx = makeContext();
    await ctx.store.create({ body: "note", customKeywords: ["Zephyr"] });
    const api = client(ctx.app, await login(ctx.app));
    const vocabulary = (await (await api.get("/api/keywords")).json()) as KeywordVocabulary;
    expect(vocabulary.keywords).toEqual([{ keyword: "Zephyr", key: "zephyr", count: 1, lastAssignedAt: ctx.clock.now }]);
  });
});

describe("exact keyword browsing", () => {
  it("matches whole normalized keywords only and intersects with every other filter before pagination", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const save = async (body: string, keywords: string[], patch: Parameters<MemoryStore["update"]>[1] = {}) => {
      ctx.clock.now += 1000;
      const { memory } = await ctx.store.create({ body, customKeywords: keywords });
      return ctx.store.update(memory.id, patch);
    };
    const home = await save("front door key", ["Home"], { category: "things" });
    const pinnedHome = await save("spare door key", ["home"], { category: "things", pinned: true });
    const work = await save("door key at the office", ["Home"], { category: "work" });
    const old = await save("old door key", ["HOME"], { archived: true });
    await save("homework folder", ["Homework"]);
    const bodyOnly = await save("home is where the key is", []);
    const tagOnly = await save("tagged note", []);
    ctx.store.applyEnrichment(tagOnly.id, { body: tagOnly.body, captions: null }, { category: "things", tags: ["home"] });
    expect(bodyOnly.customKeywords).toEqual([]);

    const list = async (query: string) => ids(((await (await api.get(`/api/memories?${query}`)).json()) as MemoryList).memories);
    expect(await list("keyword=home")).toEqual([work.id, pinnedHome.id, home.id]);
    expect(await list("keyword=%20HOME%20")).toEqual([work.id, pinnedHome.id, home.id]);
    expect(await list("keyword=Homework")).toHaveLength(1);
    expect(await list("keyword=hom")).toEqual([]);
    expect(await list("keyword=home&archived=1")).toEqual([old.id, work.id, pinnedHome.id, home.id]);
    expect(await list("keyword=home&category=things")).toEqual([pinnedHome.id, home.id]);
    expect(await list("keyword=home&pinned=1")).toEqual([pinnedHome.id]);
    expect(await list("keyword=nothing")).toEqual([]);

    const firstPage = (await (await api.get("/api/memories?keyword=home&limit=2")).json()) as MemoryList;
    expect(ids(firstPage.memories)).toEqual([work.id, pinnedHome.id]);
    const nextPage = (await (await api.get(`/api/memories?keyword=home&limit=2&cursor=${firstPage.nextCursor}`)).json()) as MemoryList;
    expect(ids(nextPage.memories)).toEqual([home.id]);
    expect(nextPage.nextCursor).toBeNull();

    const search = async (query: string) => ids(((await (await api.get(`/api/search?${query}`)).json()) as SearchResponse).results).sort();
    expect(await search("q=key&keyword=Home")).toEqual([home.id, pinnedHome.id, work.id].sort());
    expect(await search("q=key&keyword=Home&category=work")).toEqual([work.id]);
    expect(await search("q=key&keyword=Home&pinned=1")).toEqual([pinnedHome.id]);
    expect(await search("q=key&keyword=Home&archived=1")).toContain(old.id);
    expect(await search("q=folder&keyword=Home")).toEqual([]);
    expect(await search("q=folder&keyword=Homework")).toHaveLength(1);
  });

  it("filters before the lexical and semantic candidate limits", async () => {
    ctx = makeContext();
    const lexical = (await ctx.store.create({ body: "compass", customKeywords: ["Camping"] })).memory;
    for (let i = 0; i < 185; i++) await ctx.store.create({ body: "compass" });
    expect((await ctx.search.search("compass", { keyword: "camping" })).map((hit) => hit.id)).toEqual([lexical.id]);
    // No shared literal word: only the meaning search can find it, behind 185 closer unlabeled notes.
    const semantic = (await ctx.store.create({ body: "ipad", customKeywords: ["Gadgets"] })).memory;
    for (let i = 0; i < 185; i++) await ctx.store.create({ body: "ipad" });
    expect((await ctx.search.search("tablet", { keyword: "GADGETS" })).map((hit) => hit.id)).toEqual([semantic.id]);
    const page = ctx.store.list({ keyword: "camping", limit: 1 });
    expect(ids(page.memories)).toEqual([lexical.id]);
  });
});

describe("held capture reconciliation", () => {
  /** What the older server did: it saved body/photos with the clientId and ignored customKeywords. */
  const oldServerCreate = (clientId: string, body: string) =>
    Number(ctx.db.prepare(`INSERT INTO memories (client_id, body, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(clientId, body, ctx.clock.now, ctx.clock.now).lastInsertRowid);

  const reconcileVia = (api: ReturnType<typeof client>) =>
    async (clientId: string, customKeywords: string[], extra: { expectedUpdatedAt?: number | null; resolution?: "add" | "keep" } = {}) => {
      const response = await api.postJson("/api/memories/reconcile", { clientId, customKeywords, ...extra });
      return { status: response.status, body: (await response.json()) as ReconcileResponse & { message?: string } };
    };

  it("adds missing keywords to a recall untouched since the old-server capture, once and without enrichment", async () => {
    const llm = new FakeLlm(() => ({ json: { category: "things", tags: ["automatic"] } }));
    let enricher: Enricher;
    ctx = makeContext({ setup: ({ store, db }) => {
      enricher = new Enricher({ store, llm, usage: new UsageLog(db), log: () => {} });
      enricher.attach();
      return { llm };
    } });
    const reconcile = reconcileVia(client(ctx.app, await login(ctx.app)));
    const id = oldServerCreate("held-capture-01", "blue bin");
    const savedUpdatedAt = ctx.store.require(id).updatedAt; // what the old server's 201 response carried
    await enricher!.idle();
    const calls = llm.requests.length;
    const embeds = ctx.embedder.documentCalls;
    ctx.clock.now += DAY;
    const result = await reconcile("held-capture-01", ["Christmas", "Garage"], { expectedUpdatedAt: savedUpdatedAt });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("reconciled");
    expect(result.body.memory).toMatchObject({ id, body: "blue bin", customKeywords: ["Christmas", "Garage"] });
    expect(usage("christmas")).toMatchObject({ count: 1, lastAssignedAt: ctx.clock.now });
    await enricher!.idle();
    expect(llm.requests).toHaveLength(calls);
    expect(ctx.embedder.documentCalls).toBe(embeds);
    // Reconciling again (a retried recovery) changes nothing and counts nothing twice.
    const again = await reconcile("held-capture-01", ["Christmas", "Garage"], { expectedUpdatedAt: savedUpdatedAt });
    expect(again.body).toMatchObject({ status: "already-saved", memory: { customKeywords: ["Christmas", "Garage"] } });
    expect(rowCount("memories")).toBe(1);
    expect(usage("christmas")!.count).toBe(1);
    // Repeating create alone returns the record unchanged.
    const api = client(ctx.app, await login(ctx.app));
    const recreate = (await (await api.postJson("/api/memories", { body: "blue bin", clientId: "held-capture-01", customKeywords: ["New"] })).json()) as Memory;
    expect(recreate.customKeywords).toEqual(["Christmas", "Garage"]);
    enricher!.stop();
  });

  it("never reverses later keyword removals on receipt-less recalls: it reports a conflict for the user to resolve", async () => {
    ctx = makeContext();
    const reconcile = reconcileVia(client(ctx.app, await login(ctx.app)));
    const id = oldServerCreate("old-server-edit", "blue bin");
    const savedUpdatedAt = ctx.store.require(id).updatedAt;
    ctx.clock.now += 1000;
    await ctx.store.update(id, { customKeywords: ["Garage", "Shelf"] }); // later, on the old server or another device
    ctx.clock.now += 1000;
    await ctx.store.update(id, { body: "blue bin, top shelf", customKeywords: ["Shelf"], pinned: true }); // Garage removed on purpose
    const before = ctx.store.require(id);
    // Neither an automatic recovery nor a repeated one restores Garage.
    for (const extra of [{ expectedUpdatedAt: savedUpdatedAt }, {}, { expectedUpdatedAt: savedUpdatedAt }]) {
      const result = await reconcile("old-server-edit", ["Garage", "Christmas"], extra);
      expect(result.body).toMatchObject({ status: "conflict", missingKeywords: ["Garage", "Christmas"], memory: { customKeywords: ["Shelf"] } });
    }
    expect(ctx.store.require(id)).toEqual(before);
    expect(rowCount("capture_receipts")).toBe(0);
    // The user keeps Recall's version: recorded, nothing changes, later recoveries are no-ops.
    expect((await reconcile("old-server-edit", ["Garage", "Christmas"], { resolution: "keep" })).body).toMatchObject({ status: "kept", memory: { customKeywords: ["Shelf"] } });
    expect((await reconcile("old-server-edit", ["Garage", "Christmas"], { expectedUpdatedAt: savedUpdatedAt })).body.status).toBe("already-saved");
    expect(ctx.store.require(id)).toEqual(before);

    // Explicit "add" uses the updatedAt the user saw; a newer edit in between turns it back into a conflict.
    const other = oldServerCreate("old-server-add1", "lantern shelf");
    ctx.clock.now += 1000;
    await ctx.store.update(other, { body: "lantern shelf, left side", customKeywords: ["Shelf"] });
    const conflict = await reconcile("old-server-add1", ["Lantern"]);
    expect(conflict.body.status).toBe("conflict");
    const seen = conflict.body.memory!.updatedAt;
    ctx.clock.now += 1000;
    await ctx.store.update(other, { customKeywords: ["Shelf", "Porch"] });
    const stale = await reconcile("old-server-add1", ["Lantern"], { resolution: "add", expectedUpdatedAt: seen });
    expect(stale.body).toMatchObject({ status: "conflict", memory: { customKeywords: ["Shelf", "Porch"] } });
    const added = await reconcile("old-server-add1", ["Lantern"], { resolution: "add", expectedUpdatedAt: stale.body.memory!.updatedAt });
    expect(added.body).toMatchObject({ status: "reconciled", memory: { body: "lantern shelf, left side", customKeywords: ["Shelf", "Porch", "Lantern"] } });
    expect((await reconcile("old-server-add1", ["Lantern"])).body.status).toBe("already-saved");
    expect(rowCount("memories")).toBe(2);
  });

  it("does not treat a retry's current updatedAt as proof the recall is untouched (lost response, later add/remove)", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const reconcile = reconcileVia(api);
    // The old server created it, but the device never saw that response.
    const id = oldServerCreate("lost-response-1", "blue bin");
    ctx.clock.now += 1000;
    await ctx.store.update(id, { customKeywords: ["Garage", "Shelf"] });
    ctx.clock.now += 1000;
    await ctx.store.update(id, { body: "blue bin, hall closet", customKeywords: ["Shelf"] }); // Garage removed on purpose
    // The device's same-clientId retry gets 200 with the current, edited record.
    const retry = await api.postJson("/api/memories", { body: "blue bin", clientId: "lost-response-1", customKeywords: ["Garage", "Porch"] });
    expect(retry.status).toBe(200);
    const current = (await retry.json()) as Memory;
    expect(current.customKeywords).toEqual(["Shelf"]);
    const before = ctx.store.require(id);
    // Even if a client offered that timestamp as its anchor, nothing is restored silently, on any repetition.
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await reconcile("lost-response-1", ["Garage", "Porch"], { expectedUpdatedAt: current.updatedAt });
      expect(result.body).toMatchObject({ status: "conflict", missingKeywords: ["Garage", "Porch"], memory: { customKeywords: ["Shelf"] } });
    }
    expect(ctx.store.require(id)).toEqual(before);
    expect(rowCount("capture_receipts")).toBe(0);
    // Explicit Keep, then a repeated recovery: unchanged, one recall.
    expect((await reconcile("lost-response-1", ["Garage", "Porch"], { resolution: "keep" })).body.status).toBe("kept");
    expect((await reconcile("lost-response-1", ["Garage", "Porch"], { expectedUpdatedAt: current.updatedAt })).body.status).toBe("already-saved");
    expect(ctx.store.require(id)).toEqual(before);
    expect(rowCount("memories")).toBe(1);
  });

  it("reports missing records, leaves captures this server saved alone, and refuses over-limit merges", async () => {
    ctx = makeContext();
    const reconcile = reconcileVia(client(ctx.app, await login(ctx.app)));
    expect((await reconcile("never-arrived-01", ["Garage"])).body).toEqual({ status: "missing", memory: null });
    const { memory } = await ctx.store.create({ body: "saved", clientId: "new-server-001", customKeywords: ["Garage", "Shed"] });
    await ctx.store.update(memory.id, { customKeywords: ["Shed"] }); // the user removed Garage later
    const kept = await reconcile("new-server-001", ["Garage", "Shed"], { resolution: "add", expectedUpdatedAt: ctx.store.require(memory.id).updatedAt });
    expect(kept.body).toMatchObject({ status: "already-saved", memory: { customKeywords: ["Shed"] } });
    const full = oldServerCreate("old-server-full", "busy note");
    await ctx.store.update(full, { customKeywords: Array.from({ length: 9 }, (_, i) => `k${i}`) });
    const over = await reconcile("old-server-full", ["a", "b"], { resolution: "add", expectedUpdatedAt: ctx.store.require(full).updatedAt });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/already has 9 keywords/);
    expect(ctx.store.require(full).customKeywords).toHaveLength(9);
    expect((await reconcile("bad id!", ["a"])).status).toBe(400);
  });
});

it("keeps keyword routes behind the login session and denies restricted Siri keys", async () => {
  ctx = makeContext();
  const token = new TokenStore(ctx.db).create("fictional Siri").token;
  const api = client(ctx.app, "");
  const bearer = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  for (const route of ["/api/keywords", "/api/memories?keyword=home", "/api/search?q=a&keyword=home"]) {
    expect((await ctx.app.request(route)).status).toBe(401);
    expect((await api.send(route, { headers: bearer })).status).toBe(401);
  }
  const body = JSON.stringify({ clientId: "held-capture-01", customKeywords: ["a"] });
  expect((await api.send("/api/memories/reconcile", { method: "POST", headers: bearer, body })).status).toBe(401);
  expect((await api.send("/api/memories", { method: "POST", headers: bearer, body: JSON.stringify({ body: "x", customKeywords: ["a"] }) })).status).toBe(401);
  // Siri capture still works and still has no keywords.
  expect((await api.send("/api/capture", { method: "POST", headers: bearer, body: JSON.stringify({ text: "ipad in gym" }) })).status).toBe(201);
  expect(ctx.store.keywordVocabulary()).toEqual([]);
});

it("forward-migrates version 4 keywords into assignments without rewriting migration 004", () => {
  ctx = makeContext();
  const file = join(ctx.dir, "v4.db");
  const old = new Database(file);
  for (const sql of MIGRATIONS.slice(0, 4)) old.exec(sql);
  old.pragma("user_version = 4");
  old.prepare(`INSERT INTO memories (id, body, custom_keywords, created_at, updated_at) VALUES (1, 'a', 'Garage, Über', 1, 1), (2, 'b', 'garage', 2, 2), (3, 'c', '', 3, 3)`).run();
  old.close();
  const db = openDb(file);
  try {
    // Through 005 and every later forward migration (006 photo text).
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    const store = new MemoryStore(db, ctx.photos);
    expect(store.keywordVocabulary()).toEqual([
      { keyword: "Garage", key: "garage", count: 2, lastAssignedAt: null },
      { keyword: "Über", key: "über", count: 1, lastAssignedAt: null },
    ]);
    expect(ids(store.list({ keyword: "ÜBER" }).memories)).toEqual([1]);
    expect(store.require(1).customKeywords).toEqual(["Garage", "Über"]);
  } finally {
    db.close();
  }
});
