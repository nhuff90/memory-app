import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { AskResponse, MeResponse, UsageSummary } from "../../shared/types.js";
import { aiFailure } from "../src/ai.js";
import { formatNotes, NOTHING_FOUND } from "../src/ask.js";
import { FakeLlm } from "./fakeLlm.js";
import { client, DAY, login, makeContext, START_TIME, type TestContext } from "./helpers.js";

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

async function setup(llm: FakeLlm | null = new FakeLlm()) {
  ctx = makeContext({ app: { llm } });
  return client(ctx.app, await login(ctx.app));
}

async function save(body: string, daysAgo = 0) {
  const { memory } = await ctx.store.create({ body, createdAt: ctx.clock.now - daysAgo * DAY });
  return memory;
}

describe("Ask", () => {
  it("is switched off without an API key, and says so", async () => {
    const api = await setup(null);
    const me = (await (await api.get("/api/me")).json()) as MeResponse;
    expect(me).toMatchObject({ aiEnabled: false, model: null });

    const res = await api.postJson("/api/ask", { question: "Where is the flashlight?" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "ai_disabled" });
  });

  it("reports the model when a key is set", async () => {
    const api = await setup();
    const me = (await (await api.get("/api/me")).json()) as MeResponse;
    expect(me).toMatchObject({ aiEnabled: true, model: "claude-haiku-5-5" });
  });

  it("needs a login and a question", async () => {
    const api = await setup();
    const anonymous = await ctx.app.request("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "hi" }),
    });
    expect(anonymous.status).toBe(401);
    expect((await api.postJson("/api/ask", { question: "   " })).status).toBe(400);
    expect((await api.postJson("/api/ask", { question: "x".repeat(501) })).status).toBe(400);
  });

  it("sends dated notes newest first and returns the cited ones first", async () => {
    const llm = new FakeLlm();
    const api = await setup(llm);
    const kids = await save("Sarah's kids are Emma (born March 2018) and Jake", 400);
    const flashlight = await save("flashlight is in the kitchen drawer", 2);
    const wife = await save("Sarah's husband is Tom, works at the hospital", 30);
    llm.reply({ json: { answer: "Emma is 8.", used_ids: [kids.id, kids.id, 9999] } });

    const res = await api.postJson("/api/ask", { question: "How old is Sarah's daughter Emma?" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AskResponse;
    expect(body.answer).toBe("Emma is 8.");
    expect(body.usedIds).toEqual([kids.id]);
    expect(body.results[0]!.id).toBe(kids.id);
    expect(body.results.map((m) => m.id)).toContain(wife.id);

    const request = llm.requests[0]!;
    expect(request.system).toContain("Today is Saturday, October 31, 2026 (2026-10-31)");
    expect(request.system).toContain(NOTHING_FOUND);
    expect(request.schema).toMatchObject({ required: ["answer", "used_ids"], additionalProperties: false });
    const content = llm.lastContent;
    expect(content).toMatch(/^Question: How old is Sarah's daughter Emma\?/);
    expect(content).toContain(`[#${kids.id} | saved 2025-09-26] Sarah's kids are Emma`);
    expect(content.indexOf(`#${flashlight.id}`)).toBeLessThan(content.indexOf(`#${wife.id}`));
    expect(content.indexOf(`#${wife.id}`)).toBeLessThan(content.indexOf(`#${kids.id}`));
  });

  it("never sends Outdated notes", async () => {
    const llm = new FakeLlm(() => ({ json: { answer: "In the garage.", used_ids: [] } }));
    const api = await setup(llm);
    const old = await save("flashlight is in the basement", 100);
    await ctx.store.update(old.id, { archived: true });
    await save("flashlight is in the garage");

    await api.postJson("/api/ask", { question: "where is the flashlight" });
    expect(llm.lastContent).toContain("garage");
    expect(llm.lastContent).not.toContain("basement");
  });

  it("answers without calling Claude when nothing is saved", async () => {
    const llm = new FakeLlm();
    const api = await setup(llm);
    const body = (await (await api.postJson("/api/ask", { question: "where is the flashlight" })).json()) as AskResponse;
    expect(body).toEqual({ answer: NOTHING_FOUND, message: NOTHING_FOUND, usedIds: [], results: [] });
    expect(llm.requests).toHaveLength(0);
  });

  it("sends only matching notes once there are more than 50", async () => {
    const llm = new FakeLlm(() => ({ json: { answer: "Kitchen drawer.", used_ids: [] } }));
    const api = await setup(llm);
    for (let index = 0; index < 55; index++) await save(`gym schedule note ${index}`, index + 1);
    const flashlight = await save("flashlight is in the kitchen drawer");

    const body = (await (await api.postJson("/api/ask", { question: "flashlight?" })).json()) as AskResponse;
    expect(body.answer).toBe("Kitchen drawer.");
    expect(llm.lastContent).toContain(`#${flashlight.id}`);
    expect(llm.lastContent).not.toContain("gym schedule");

    const none = (await (await api.postJson("/api/ask", { question: "zebra" })).json()) as AskResponse;
    expect(none.answer).toBe(NOTHING_FOUND);
    expect(llm.requests).toHaveLength(1);
  });

  it("uses the phone's time zone for today's date", async () => {
    const llm = new FakeLlm(() => ({ json: { answer: "ok", used_ids: [] } }));
    const api = await setup(llm);
    await save("anything");
    ctx.clock.now = Date.UTC(2026, 10, 1, 5, 0, 0);

    await api.postJson("/api/ask", { question: "what day is it", timeZone: "America/Los_Angeles" });
    expect(llm.requests[0]!.system).toContain("Saturday, October 31, 2026");
    await api.postJson("/api/ask", { question: "what day is it", timeZone: "Not/AZone" });
    expect(llm.requests[1]!.system).toContain("Sunday, November 1, 2026");
  });

  it("handles refusals, cut-off replies, and outages", async () => {
    const llm = new FakeLlm();
    const api = await setup(llm);
    await save("flashlight is in the kitchen drawer");

    llm.reply({ stopReason: "refusal" });
    const refused = (await (await api.postJson("/api/ask", { question: "flashlight" })).json()) as AskResponse;
    expect(refused.usedIds).toEqual([]);
    expect(refused.answer).toMatch(/can't help/);

    llm.reply({ json: null, stopReason: "max_tokens" });
    const cutOff = await api.postJson("/api/ask", { question: "flashlight" });
    expect(cutOff.status).toBe(502);
    expect(await cutOff.json()).toMatchObject({ error: "ai_failed" });

    llm.reply({ json: { answer: 42 } });
    expect((await api.postJson("/api/ask", { question: "flashlight" })).status).toBe(502);

    llm.reply(new Anthropic.APIConnectionError({ message: "socket hang up" }));
    const offline = await api.postJson("/api/ask", { question: "flashlight" });
    expect(offline.status).toBe(502);
    expect(await offline.json()).toMatchObject({ error: "ai_unreachable" });
  });

  it("turns SDK errors into plain messages", () => {
    const headers = new Headers();
    expect(aiFailure(Anthropic.APIError.generate(401, {}, "bad key", headers))).toMatchObject({
      status: 502,
      code: "ai_key_rejected",
    });
    expect(aiFailure(Anthropic.APIError.generate(429, {}, "slow down", headers))).toMatchObject({
      status: 429,
      code: "ai_busy",
    });
    expect(aiFailure(Anthropic.APIError.generate(500, {}, "oops", headers))).toMatchObject({ code: "ai_failed" });
    expect(aiFailure(new Error("anything"))).toMatchObject({ status: 502, code: "ai_failed" });
  });
});

describe("Usage", () => {
  it("counts this month's calls, tokens, and estimated cost", async () => {
    const llm = new FakeLlm(() => ({ json: { answer: "ok", used_ids: [] } }));
    const api = await setup(llm);
    await save("flashlight is in the kitchen drawer");
    ctx.db
      .prepare(`INSERT INTO ai_usage (at, kind, model, input_tokens, output_tokens) VALUES (?, 'ask', 'claude-haiku-5-5', 5000, 500)`)
      .run(START_TIME - 40 * DAY);

    await api.postJson("/api/ask", { question: "flashlight" });
    await api.postJson("/api/ask", { question: "flashlight" });
    const usage = (await (await api.get("/api/usage")).json()) as UsageSummary;
    expect(usage).toMatchObject({ month: "2026-10", asks: 2, enrichments: 0, inputTokens: 2000, outputTokens: 100 });
    expect(usage.estimatedCostUsd).toBeCloseTo((2000 * 0.1 + 100 * 0.5) / 1_000_000, 10);
  });

  it("starts the month at local midnight and leaves cost blank for unknown models", async () => {
    const api = await setup();
    const insert = ctx.db.prepare(
      `INSERT INTO ai_usage (at, kind, model, input_tokens, output_tokens) VALUES (?, 'enrich', ?, 100, 10)`,
    );
    insert.run(Date.UTC(2026, 10, 1, 2, 0, 0), "claude-haiku-5-5");
    insert.run(Date.UTC(2026, 10, 1, 12, 0, 0), "some-future-model");
    ctx.clock.now = Date.UTC(2026, 10, 1, 16, 0, 0);

    const local = (await (await api.get("/api/usage")).json()) as UsageSummary;
    expect(local).toMatchObject({ month: "2026-11", enrichments: 1, estimatedCostUsd: null });
    const utc = (await (await api.get("/api/usage?tz=UTC")).json()) as UsageSummary;
    expect(utc).toMatchObject({ month: "2026-11", enrichments: 2 });
  });
});

describe("formatNotes", () => {
  it("includes category, photo count, captions, and tags", async () => {
    ctx = makeContext();
    const memory = {
      ...(await save("Dave from accounting")),
      category: "people" as const,
      tags: ["coworker", "finance"],
      photos: [{ id: 1, caption: "man with a red beard", text: null, createdAt: START_TIME }],
    };
    const photoOnly = { ...memory, id: 99, body: "", category: null, tags: [], photos: [] };
    expect(formatNotes([memory, photoOnly], "America/New_York")).toBe(
      `[#${memory.id} | saved 2026-10-31 | people | 1 photo] Dave from accounting\n` +
        "  photo shows: man with a red beard\n" +
        "  tags: coworker, finance\n" +
        "[#99 | saved 2026-10-31] (photo only)",
    );
  });
});
