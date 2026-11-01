import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { AskResponse } from "../../shared/types.js";
import { AnthropicLlm, UsageLog } from "../src/ai.js";
import { Enricher } from "../src/enrich.js";
import { SettingsStore } from "../src/settings.js";
import { client, DAY, login, makeContext, type TestContext } from "./helpers.js";

// Calls the real Claude API: run with `npm run test:live` and ANTHROPIC_API_KEY in the environment or .env.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file.
}
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.RECALL_MODEL || "claude-haiku-5-5";

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

async function setup(notes: { body: string; daysAgo?: number }[]) {
  ctx = makeContext({ app: { llm: new AnthropicLlm(apiKey!, model) } });
  const ids: number[] = [];
  for (const note of notes) {
    const { memory } = await ctx.store.create({ body: note.body, createdAt: ctx.clock.now - (note.daysAgo ?? 0) * DAY });
    ids.push(memory.id);
  }
  const api = client(ctx.app, await login(ctx.app));
  const ask = async (question: string) => {
    const res = await api.postJson("/api/ask", { question });
    expect(res.status).toBe(200);
    return (await res.json()) as AskResponse;
  };
  return { ids, ask };
}

describe.skipIf(!apiKey)(`Ask with ${model}`, { timeout: 60_000 }, () => {
  it("works out ages from today's date and cites the note", async () => {
    const { ids, ask } = await setup([
      { body: "Sarah's kids are Emma (born March 2018) and Jake (born June 2021)", daysAgo: 200 },
      { body: "flashlight in the kitchen drawer" },
      { body: "ipad in gym" },
    ]);
    const reply = await ask("How old is Emma?");
    expect(reply.answer).toMatch(/\b8\b|eight/i);
    expect(reply.usedIds).toEqual([ids[0]]);
  });

  it("says it doesn't know instead of guessing", async () => {
    const { ask } = await setup([{ body: "flashlight in the kitchen drawer" }, { body: "ipad in gym" }]);
    const reply = await ask("What's my dentist's name?");
    expect(reply.answer).toMatch(/don't have anything/i);
    expect(reply.usedIds).toEqual([]);
  });

  it("trusts the newest note when two disagree", async () => {
    const { ids, ask } = await setup([
      { body: "flashlight is in the basement by the washer", daysAgo: 120 },
      { body: "moved the flashlight to the garage shelf", daysAgo: 3 },
    ]);
    const reply = await ask("Where is the flashlight?");
    expect(reply.answer).toMatch(/garage/i);
    expect(reply.usedIds).toContain(ids[1]);
  });
});

describe.skipIf(!apiKey)(`Auto-tagging with ${model}`, { timeout: 60_000 }, () => {
  it("adds a category and search synonyms", async () => {
    ctx = makeContext();
    const enricher = new Enricher({ store: ctx.store, llm: new AnthropicLlm(apiKey!, model), usage: new UsageLog(ctx.db) });
    enricher.attach();
    const gym = (await ctx.store.create({ body: "ipad in gym" })).memory;
    const sarah = (await ctx.store.create({ body: "Sarah next door: kids Emma and Jake, she's a nurse" })).memory;
    await enricher.idle();
    enricher.stop();

    expect(ctx.store.get(gym.id)).toMatchObject({ category: "things" });
    expect(ctx.store.get(gym.id)!.tags.join(" ")).toMatch(/tablet/);
    expect(ctx.store.get(sarah.id)).toMatchObject({ category: "people" });
  });
});

describe.skipIf(!apiKey)(`Photo descriptions with ${model}`, { timeout: 60_000 }, () => {
  it("reads what's in a photo, so a photo with no note can be found", async () => {
    ctx = makeContext();
    const settings = new SettingsStore(ctx.db);
    settings.setPhotoCaptions(true);
    const enricher = new Enricher({
      store: ctx.store,
      llm: new AnthropicLlm(apiKey!, model),
      usage: new UsageLog(ctx.db),
      captionsEnabled: () => settings.photoCaptions(),
    });
    enricher.attach();
    const photo = readFileSync(new URL("./fixtures/xmas-lights-bin.jpg", import.meta.url));
    const { memory } = await ctx.store.create({ body: "", photos: [{ full: photo, thumb: photo }] });
    await enricher.idle();
    enricher.stop();

    const caption = ctx.store.get(memory.id)!.photos[0]!.caption;
    expect(caption).toMatch(/XMAS LIGHTS/i);
    expect(caption).toMatch(/bin|box|container|tote|crate/i);
    expect(ctx.store.get(memory.id)!.enrichedAt).not.toBeNull();
    expect((await ctx.search.search("christmas lights")).map((hit) => hit.id)).toContain(memory.id);
  });
});
