import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { Memory } from "../../shared/types.js";
import { UsageLog } from "../src/ai.js";
import { cleanTags, Enricher } from "../src/enrich.js";
import { FakeLlm } from "./fakeLlm.js";
import { client, login, makeContext, type TestContext } from "./helpers.js";

let ctx: TestContext;
let enricher: Enricher;
let logged: string[];
afterEach(() => {
  enricher?.stop();
  ctx?.cleanup();
});

const tags = (category: string, ...values: string[]) => ({ json: { category, tags: values } });

function setup(llm: FakeLlm, { attach = true } = {}) {
  ctx = makeContext();
  logged = [];
  enricher = new Enricher({
    store: ctx.store,
    llm,
    usage: new UsageLog(ctx.db, () => ctx.clock.now),
    log: (message) => logged.push(message),
  });
  if (attach) enricher.attach();
  return llm;
}

async function save(body: string, photos = 0): Promise<Memory> {
  const uploads = Array.from({ length: photos }, () => ({
    full: new Uint8Array([0xff, 0xd8, 0xff, 1]),
    thumb: new Uint8Array([0xff, 0xd8, 0xff, 2]),
  }));
  return (await ctx.store.create({ body, photos: uploads })).memory;
}

const reload = (id: number) => ctx.store.get(id)!;

describe("auto-tagging", () => {
  it("tags new notes in the background so search finds them by synonym", async () => {
    const llm = setup(new FakeLlm().reply(tags("things", "Tablet", "workout, fitness", "tablet", "  Apple  ")));
    const memory = await save("ipad in gym");
    await enricher.idle();

    expect(reload(memory.id)).toMatchObject({
      category: "things",
      categorySetByUser: false,
      tags: ["tablet", "workout", "fitness", "apple"],
      enrichedAt: ctx.clock.now,
    });
    expect(llm.lastContent).toBe("Note: ipad in gym");
    expect(llm.requests[0]!.schema).toMatchObject({ required: ["category", "tags"] });
    const hits = await ctx.search.search("workout", {});
    expect(hits.map((hit) => hit.id)).toEqual([memory.id]);
    // Tags are keywords only; the meaning vector from saving still stands.
    expect(ctx.embedder.documentCalls).toBe(1);
    const usage = ctx.db.prepare(`SELECT kind, input_tokens FROM ai_usage`).all();
    expect(usage).toEqual([{ kind: "enrich", input_tokens: 1000 }]);
  });

  it("never replaces a category picked by hand", async () => {
    setup(new FakeLlm(() => tags("things", "tablet")), { attach: false });
    const memory = await save("ipad in gym");
    await ctx.store.update(memory.id, { category: "work" });
    enricher.sweep();
    await enricher.idle();
    expect(reload(memory.id)).toMatchObject({ category: "work", categorySetByUser: true, tags: ["tablet"] });
  });

  it("re-tags after the text is edited", async () => {
    const llm = setup(new FakeLlm().reply(tags("things", "tablet"), tags("things", "torch")));
    const memory = await save("ipad in gym");
    await enricher.idle();
    await ctx.store.update(memory.id, { archived: true });
    expect(reload(memory.id).enrichedAt).not.toBeNull();

    await ctx.store.update(memory.id, { body: "flashlight in gym" });
    await enricher.idle();
    expect(reload(memory.id).tags).toEqual(["torch"]);
    expect(llm.requests).toHaveLength(2);
  });

  it("clears the done mark only when the text changes", async () => {
    setup(new FakeLlm(), { attach: false });
    const memory = await save("ipad in gym");
    ctx.store.markEnriched(memory.id);
    await ctx.store.update(memory.id, { archived: true, category: "things" });
    expect(reload(memory.id).enrichedAt).not.toBeNull();
    await ctx.store.update(memory.id, { body: "ipad in the office" });
    expect(reload(memory.id).enrichedAt).toBeNull();
  });

  it("throws away tags for text that changed during the call", async () => {
    const llm = setup(new FakeLlm().reply(tags("things", "stale"), tags("things", "fresh")));
    const reply = llm.complete.bind(llm);
    llm.complete = async (request) => {
      const result = await reply(request);
      if (llm.requests.length === 1) {
        // The note is edited while Claude is still working on the old text.
        const { id } = ctx.db.prepare(`SELECT id FROM memories`).get() as { id: number };
        await ctx.store.update(id, { body: "box cutter in the garage" });
      }
      return result;
    };
    const memory = await save("box cutter in the kitchen");
    await enricher.idle();
    expect(reload(memory.id)).toMatchObject({ body: "box cutter in the garage", tags: ["fresh"] });
    expect(llm.requests.map((request) => request.content)).toEqual([
      "Note: box cutter in the kitchen",
      "Note: box cutter in the garage",
    ]);
  });

  it("pauses on outages and catches up on the next sweep", async () => {
    const llm = setup(
      new FakeLlm(() => tags("things", "ok")).reply(new Anthropic.APIConnectionError({ message: "offline" })),
      { attach: false },
    );
    const first = await save("ipad in gym");
    const second = await save("flashlight in the kitchen drawer");
    enricher.sweep();
    await enricher.idle();
    expect(llm.requests).toHaveLength(1);
    expect(reload(first.id).enrichedAt).toBeNull();
    expect(reload(second.id).enrichedAt).toBeNull();
    expect(logged).toEqual(["Auto-tagging paused until the next sweep"]);

    enricher.sweep();
    await enricher.idle();
    expect(reload(first.id).tags).toEqual(["ok"]);
    expect(reload(second.id).tags).toEqual(["ok"]);
  });

  it("skips a note Claude rejects only after other notes have worked", async () => {
    const badRequest = () => Anthropic.APIError.generate(400, {}, "bad request", new Headers());
    const llm = setup(new FakeLlm(() => tags("things", "ok")).reply(badRequest()), { attach: false });
    const first = await save("ipad in gym");
    enricher.sweep();
    await enricher.idle();
    expect(reload(first.id).enrichedAt).toBeNull();

    const second = await save("flashlight in the kitchen drawer");
    llm.reply(tags("things", "ok"), badRequest());
    enricher.sweep();
    await enricher.idle();
    expect(reload(second.id).tags).toEqual(["ok"]);
    expect(reload(first.id)).toMatchObject({ tags: [], enrichedAt: ctx.clock.now });
  });

  it("marks unusable replies and photo-only notes as done without retrying", async () => {
    const llm = setup(new FakeLlm().reply({ json: null, stopReason: "max_tokens" }));
    const text = await save("ipad in gym");
    const photoOnly = await save("", 1);
    await enricher.idle();
    expect(reload(text.id)).toMatchObject({ tags: [], category: null });
    expect(reload(text.id).enrichedAt).not.toBeNull();
    expect(reload(photoOnly.id).enrichedAt).not.toBeNull();
    expect(llm.requests).toHaveLength(1);

    enricher.sweep();
    await enricher.idle();
    expect(llm.requests).toHaveLength(1);
  });

  it("sweeps up untagged notes newest first", async () => {
    const llm = setup(new FakeLlm(() => tags("other")), { attach: false });
    await ctx.store.create({ body: "oldest", createdAt: ctx.clock.now - 3000 });
    await ctx.store.create({ body: "newest", createdAt: ctx.clock.now });
    await ctx.store.create({ body: "middle", createdAt: ctx.clock.now - 1000 });
    enricher.sweep();
    await enricher.idle();
    expect(llm.requests.map((request) => request.content)).toEqual(["Note: newest", "Note: middle", "Note: oldest"]);
  });

  it("cleans up tags", () => {
    expect(cleanTags(["A, B", "a", " ", "x".repeat(41), "Two  Words", "c", "d", "e", "f", "g", "h", "i"])).toEqual([
      "a",
      "b",
      "two words",
      "c",
      "d",
      "e",
      "f",
      "g",
    ]);
  });
});

describe("choosing a category by hand", () => {
  it("is saved through the API and filters lists", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const sarah = await save("Sarah's kids are Emma and Jake");
    await save("ipad in gym");

    const res = await api.patch(`/api/memories/${sarah.id}`, { category: "people" });
    expect(await res.json()).toMatchObject({ category: "people", categorySetByUser: true });
    expect((await api.patch(`/api/memories/${sarah.id}`, { category: "pets" })).status).toBe(400);

    const people = (await (await api.get("/api/memories?category=people")).json()) as { memories: Memory[] };
    expect(people.memories.map((memory) => memory.id)).toEqual([sarah.id]);
  });
});
