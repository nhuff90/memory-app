import { afterEach, describe, expect, it } from "vitest";
import type { ApiToken, AskResponse, CaptureResponse, CreatedApiToken, Memory } from "../../shared/types.js";
import { FakeLlm } from "./fakeLlm.js";
import { client, login, makeContext, type TestContext } from "./helpers.js";

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

/** Sends JSON the way the Shortcuts app does: a Bearer key and no cookie or Origin. */
function shortcut(token: string) {
  return (path: string, body: unknown) =>
    ctx.app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
}

async function setup(llm: FakeLlm | null = null, keyRequest: object = { name: "iPhone" }) {
  ctx = makeContext({ app: { llm } });
  const api = client(ctx.app, await login(ctx.app));
  const key = (await (await api.postJson("/api/tokens", keyRequest)).json()) as CreatedApiToken;
  return { api, key, siri: shortcut(key.token) };
}

const listKeys = async (api: ReturnType<typeof client>) =>
  ((await (await api.get("/api/tokens")).json()) as { tokens: ApiToken[] }).tokens;

describe("Siri Shortcuts keys", () => {
  it("are shown once and stored only as a hash", async () => {
    const { api, key } = await setup();
    expect(key.token).toMatch(/^rc_[A-Za-z0-9_-]{43}$/);
    expect(await listKeys(api)).toEqual([{ id: key.id, name: "iPhone", createdAt: ctx.clock.now, lastUsedAt: null }]);
    const rows = JSON.stringify(ctx.db.prepare(`SELECT * FROM api_tokens`).all());
    expect(rows).not.toContain(key.token);
    expect(rows).toMatch(/"token_hash":"[0-9a-f]{64}"/);

    const unnamed = (await (await api.postJson("/api/tokens", {})).json()) as CreatedApiToken;
    expect(unnamed.name).toBe("Siri Shortcuts");
    expect((await api.postJson("/api/tokens", { name: "x".repeat(61) })).status).toBe(400);
  });

  it("save what Siri heard and say it back", async () => {
    const { api, key, siri } = await setup();
    ctx.clock.now += 60_000;
    const res = await siri("/api/capture", { text: "  iPad is in the gym " });
    expect(res.status).toBe(201);
    const saved = (await res.json()) as CaptureResponse;
    expect(saved.message).toBe("Saved: iPad is in the gym");

    const memory = (await (await api.get(`/api/memories/${saved.id}`)).json()) as Memory;
    expect(memory.body).toBe("iPad is in the gym");
    expect((await listKeys(api))[0]).toMatchObject({ id: key.id, lastUsedAt: ctx.clock.now });

    const long = await siri("/api/capture", { text: `Sarah's kids ${"are Emma and Jake ".repeat(8)}` });
    expect(((await long.json()) as CaptureResponse).message).toBe(
      "Saved: Sarah's kids are Emma and Jake are Emma and Jake are Emma and Jake are Emma and…",
    );
  });

  it("explain problems in words Siri can read out", async () => {
    const { siri } = await setup();
    const empty = await siri("/api/capture", { text: "  " });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { message: string }).message).toMatch(/nothing to save/);

    const wrongField = await siri("/api/capture", { body: "ipad in gym" });
    expect(wrongField.status).toBe(400);
    expect(((await wrongField.json()) as { message: string }).message).toContain('{"text": "ipad in gym"}');

    const noClaude = await siri("/api/ask", { question: "where's the ipad?" });
    expect(noClaude.status).toBe(503);
    expect(((await noClaude.json()) as { message: string }).message).toMatch(/Anthropic API key/);
  });

  it("answer questions with a message to speak", async () => {
    const llm = new FakeLlm();
    const { siri } = await setup(llm);
    const saved = (await (await siri("/api/capture", { text: "ipad in gym" })).json()) as CaptureResponse;
    llm.reply({ json: { answer: "It's in the gym.", used_ids: [saved.id] } });

    const res = await siri("/api/ask", { question: "where's the ipad?" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      answer: "It's in the gym.",
      message: "It's in the gym.",
      usedIds: [saved.id],
    } satisfies Partial<AskResponse>);
  });

  it("date answers in the time zone of the device that made the key", async () => {
    const llm = new FakeLlm(() => ({ json: { answer: "It's in the gym.", used_ids: [] } }));
    const { api, siri } = await setup(llm, { name: "iPhone", timeZone: "Asia/Tokyo" });
    await siri("/api/capture", { text: "ipad in gym" });

    // The test clock reads 2 PM Saturday in New York, the server's zone, which is already Sunday in Tokyo.
    await siri("/api/ask", { question: "where's the ipad?" });
    expect(llm.requests.at(-1)?.system).toContain("Today is Sunday, November 1, 2026");

    await siri("/api/ask", { question: "where's the ipad?", timeZone: "America/New_York" });
    expect(llm.requests.at(-1)?.system).toContain("Today is Saturday, October 31, 2026");

    const unzoned = await api.postJson("/api/tokens", { name: "Old phone", timeZone: "Mars/Olympus_Mons" });
    expect(unzoned.status).toBe(201);
    await shortcut(((await unzoned.json()) as CreatedApiToken).token)("/api/ask", { question: "where's the ipad?" });
    expect(llm.requests.at(-1)?.system).toContain("Today is Saturday, October 31, 2026");
  });

  it("open only saving and asking", async () => {
    const { key } = await setup();
    const routes: [string, string][] = [
      ["GET", "/api/me"],
      ["GET", "/api/memories"],
      ["POST", "/api/memories"],
      ["GET", "/api/search?q=ipad"],
      ["GET", "/api/export"],
      ["GET", "/api/tokens"],
      ["POST", "/api/tokens"],
      ["DELETE", `/api/tokens/${key.id}`],
      ["PATCH", "/api/settings"],
    ];
    for (const [method, path] of routes) {
      const res = await ctx.app.request(path, { method, headers: { authorization: `Bearer ${key.token}` } });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("stop working once removed, and made-up keys never work", async () => {
    const { api, key, siri } = await setup();
    expect((await api.delete(`/api/tokens/${key.id}`)).status).toBe(204);
    expect(await listKeys(api)).toEqual([]);

    for (const send of [siri, shortcut(`rc_${"a".repeat(43)}`), shortcut("not-a-key")]) {
      const res = await send("/api/capture", { text: "ipad in gym" });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "bad_token", message: expect.stringContaining("Settings") });
    }
    expect(ctx.store.counts().memories).toBe(0);
    expect((await api.delete(`/api/tokens/${key.id}`)).status).toBe(404);
  });
});
