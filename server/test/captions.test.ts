import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { MeResponse, Memory } from "../../shared/types.js";
import { UsageLog, type LlmRequest } from "../src/ai.js";
import { CAPTION_PROMPT, cleanCaption, Enricher } from "../src/enrich.js";
import { SettingsStore } from "../src/settings.js";
import { FakeLlm } from "./fakeLlm.js";
import { client, fakeJpeg, login, makeContext, type TestContext } from "./helpers.js";

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

/** A fake Claude that describes each photo by its label and tags text with one word. */
function fakeClaude(): FakeLlm {
  return new FakeLlm((request) => {
    const image = imageOf(request);
    if (image?.type === "image") return { json: { caption: `A plastic bin labeled ${labelOf(image.jpegBase64)}` } };
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

describe("photo captions", () => {
  it("stay off until turned on, so no photo leaves the server", async () => {
    const llm = fakeClaude();
    setup(llm);
    const api = client(ctx.app, await login(ctx.app));
    const memory = await save("Christmas box", "XMAS");
    await enricher.idle();
    expect(photoRequests(llm)).toHaveLength(0);
    expect(reload(memory.id).photos[0]!.caption).toBeNull();
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
    expect(request!.system).toBe(CAPTION_PROMPT);
    expect(imageOf(request!)).toEqual({ type: "image", jpegBase64: Buffer.from(fakeJpeg("XMAS")).toString("base64") });
    expect(reload(memory.id)).toMatchObject({
      photos: [{ caption: "A plastic bin labeled XMAS" }],
      category: "things",
      tags: ["storage"],
    });
    expect(llm.lastContent).toBe("Photo shows: A plastic bin labeled XMAS");
    expect(await findIds("plastic")).toEqual([memory.id]);
    expect(await findIds("storage")).toEqual([memory.id]);
    expect(ctx.search.vectors.has(memory.id)).toBe(true);
    const kinds = ctx.db.prepare(`SELECT kind FROM ai_usage ORDER BY id`).all();
    expect(kinds).toEqual([{ kind: "caption" }, { kind: "enrich" }]);

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
    expect(ctx.store.uncaptioned()).toEqual([memory.id]);

    enricher.sweep();
    await enricher.idle();
    expect(reload(memory.id).photos[0]!.caption).toBe("A plastic bin labeled XMAS");
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
