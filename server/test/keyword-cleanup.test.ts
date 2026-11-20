import { afterEach, describe, expect, it } from "vitest";
import { keywordsError, MAX_CUSTOM_KEYWORD_LENGTH } from "../../shared/keywords.js";
import { UsageLog } from "../src/ai.js";
import { Enricher } from "../src/enrich.js";
import type { MemoryChange } from "../src/memories.js";
import { FakeLlm } from "./fakeLlm.js";
import { DAY, makeContext, type TestContext } from "./helpers.js";

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

const usage = (key: string) => ctx.store.keywordVocabulary().find((entry) => entry.key === key);
const keywordsOf = (id: number) => ctx.store.require(id).customKeywords;
const updatedAt = (id: number) => ctx.store.require(id).updatedAt;
const listed = (keyword: string) =>
  ctx.store.list({ keyword, includeArchived: true }).memories.map((memory) => memory.id).sort((a, b) => a - b);
const found = async (text: string) =>
  (await ctx.search.search(text, { includeArchived: true })).map((hit) => hit.id).sort((a, b) => a - b);
const assignments = (id: number) =>
  ctx.db
    .prepare(`SELECT keyword, label, assigned_at FROM memory_keywords WHERE memory_id = ? ORDER BY keyword`)
    .all(id) as { keyword: string; label: string; assigned_at: number | null }[];
const assignedAt = (id: number, key: string) => assignments(id).find((row) => row.keyword === key)?.assigned_at;
const snapshot = () => ({
  memories: ctx.db.prepare(`SELECT * FROM memories ORDER BY id`).all(),
  keywords: ctx.db.prepare(`SELECT * FROM memory_keywords ORDER BY memory_id, keyword`).all(),
  receipts: ctx.db.prepare(`SELECT * FROM capture_receipts ORDER BY client_id`).all(),
});
/** What the schema v5 backfill stores for keywords saved before assignment times were recorded. */
const backfilled = (id: number, key: string) =>
  ctx.db.prepare(`UPDATE memory_keywords SET assigned_at = NULL WHERE memory_id = ? AND keyword = ?`).run(id, key);

async function make(body: string, customKeywords: string[]): Promise<number> {
  return (await ctx.store.create({ body, customKeywords })).memory.id;
}

function recordChanges(): MemoryChange[] {
  const changes: MemoryChange[] = [];
  ctx.store.onChange((change) => {
    changes.push(change);
  });
  return changes;
}

/** Every memory_keywords row matches the saved list: one row per recall and key, labelled with its spelling. */
function expectRowsMatchLists(): void {
  for (const memory of ctx.store.all()) {
    const fromList = memory.customKeywords.map((keyword) => [keyword.trim().toLowerCase(), keyword]).sort();
    const fromRows = assignments(memory.id).map((row) => [row.keyword, row.label]).sort();
    expect(fromRows).toEqual(fromList);
  }
}

describe("renameKeyword", () => {
  it("renames a keyword on every recall, active and outdated, in place and keeping assignment times", async () => {
    ctx = makeContext();
    const t0 = ctx.clock.now;
    const a = await make("blue bin by the door", ["Christmas", "garage", "Lights"]);
    ctx.clock.now = t0 + DAY;
    const b = await make("rake hangs on the wall", ["Garage"]);
    const untouched = await make("passport in the desk", ["Documents"]);
    await ctx.store.update(b, { archived: true });
    const before = { a: updatedAt(a), b: updatedAt(b), untouched: updatedAt(untouched) };
    const changes = recordChanges();

    ctx.clock.now = t0 + 5 * DAY;
    const result = await ctx.store.renameKeyword("  GARAGE ", "  Workshop ");

    expect(result).toEqual({ status: "renamed", keyword: "Workshop", key: "workshop", affected: 2 });
    expect(keywordsOf(a)).toEqual(["Christmas", "Workshop", "Lights"]);
    expect(keywordsOf(b)).toEqual(["Workshop"]);
    expect(keywordsOf(untouched)).toEqual(["Documents"]);
    expect([updatedAt(a), updatedAt(b), updatedAt(untouched)]).toEqual([ctx.clock.now, ctx.clock.now, before.untouched]);
    expect(before.a).not.toBe(ctx.clock.now);
    expect(ctx.store.require(b).archivedAt).not.toBeNull();
    expect(assignments(a)).toEqual([
      { keyword: "christmas", label: "Christmas", assigned_at: t0 },
      { keyword: "lights", label: "Lights", assigned_at: t0 },
      { keyword: "workshop", label: "Workshop", assigned_at: t0 },
    ]);
    expect(assignments(b)).toEqual([{ keyword: "workshop", label: "Workshop", assigned_at: t0 + DAY }]);
    expectRowsMatchLists();
    expect(changes).toEqual([
      { kind: "updated", id: a, bodyChanged: false },
      { kind: "updated", id: b, bodyChanged: false },
    ]);

    // Only the active recall counts; recency is the kept time, not the rename.
    expect(usage("garage")).toBeUndefined();
    expect(usage("workshop")).toEqual({ keyword: "Workshop", key: "workshop", count: 1, lastAssignedAt: t0 });
    expect(listed("garage")).toEqual([]);
    expect(listed("Workshop")).toEqual([a, b]);
    expect(await found("workshop")).toEqual([a, b]);
    expect(await found("garage")).toEqual([]);
  });

  it("respells a keyword by case on every recall and only touches recalls whose text changes", async () => {
    ctx = makeContext();
    const t0 = ctx.clock.now;
    const lower = await make("drill", ["garage", "Tools"]);
    const already = await make("saw", ["Garage"]);
    ctx.clock.now = t0 + DAY;
    const upper = await make("ladder", ["Paint", "GARAGE"]);
    await ctx.store.update(upper, { archived: true });
    const keptAt = updatedAt(already);
    const changes = recordChanges();

    ctx.clock.now = t0 + 3 * DAY;
    const result = await ctx.store.renameKeyword("garage", "Garage");

    expect(result).toEqual({ status: "respelled", keyword: "Garage", key: "garage", affected: 2 });
    expect([keywordsOf(lower), keywordsOf(already), keywordsOf(upper)]).toEqual([
      ["Garage", "Tools"],
      ["Garage"],
      ["Paint", "Garage"],
    ]);
    expect([updatedAt(lower), updatedAt(already), updatedAt(upper)]).toEqual([ctx.clock.now, keptAt, ctx.clock.now]);
    expect([assignedAt(lower, "garage"), assignedAt(already, "garage"), assignedAt(upper, "garage")]).toEqual([t0, t0, t0 + DAY]);
    expectRowsMatchLists();
    expect(changes.map((change) => change.id)).toEqual([lower, upper]);
    expect(usage("garage")).toEqual({ keyword: "Garage", key: "garage", count: 2, lastAssignedAt: t0 });
  });

  it("reports unchanged and writes nothing when every recall already uses that exact spelling", async () => {
    ctx = makeContext();
    await make("drill", ["Garage", "Tools"]);
    const outdated = await make("saw", ["Garage"]);
    await ctx.store.update(outdated, { archived: true });
    const before = snapshot();
    const changes = recordChanges();
    ctx.clock.now += DAY;

    expect(await ctx.store.renameKeyword("GARAGE", " Garage ")).toEqual({
      status: "unchanged",
      keyword: "Garage",
      key: "garage",
      affected: 0,
    });
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });

  it("merges into an existing keyword: the target keeps its position and a recall with both keeps one", async () => {
    ctx = makeContext();
    const both = await make("shelf one", ["garage", "Tools", "workshop"]);
    const fromOnly = await make("shelf two", ["Paint", "Garage"]);
    const targetOtherCase = await make("shelf three", ["WORKSHOP", "Paint"]);
    const targetExact = await make("shelf four", ["Workshop"]);
    const neither = await make("shelf five", ["Paint"]);
    const before = { targetExact: updatedAt(targetExact), neither: updatedAt(neither) };
    const changes = recordChanges();
    ctx.clock.now += DAY;

    const result = await ctx.store.renameKeyword("Garage", "Workshop");

    expect(result).toEqual({ status: "merged", keyword: "Workshop", key: "workshop", affected: 3 });
    expect(keywordsOf(both)).toEqual(["Tools", "Workshop"]);
    expect(keywordsOf(fromOnly)).toEqual(["Paint", "Workshop"]);
    expect(keywordsOf(targetOtherCase)).toEqual(["Workshop", "Paint"]);
    expect(keywordsOf(targetExact)).toEqual(["Workshop"]);
    expect(keywordsOf(neither)).toEqual(["Paint"]);
    expect([updatedAt(both), updatedAt(fromOnly), updatedAt(targetOtherCase)]).toEqual([
      ctx.clock.now,
      ctx.clock.now,
      ctx.clock.now,
    ]);
    expect([updatedAt(targetExact), updatedAt(neither)]).toEqual([before.targetExact, before.neither]);
    expect(changes).toEqual(
      [both, fromOnly, targetOtherCase].map((id) => ({ kind: "updated", id, bodyChanged: false })),
    );
    expectRowsMatchLists();
    expect(ctx.db.prepare(`SELECT count(*) AS n FROM memory_keywords WHERE keyword = 'garage'`).get()).toEqual({ n: 0 });

    // Each recall is counted once under the merged keyword.
    expect(usage("garage")).toBeUndefined();
    expect(usage("workshop")).toMatchObject({ keyword: "Workshop", count: 4 });
    expect(usage("paint")).toMatchObject({ keyword: "Paint", count: 3 });
    expect(listed("garage")).toEqual([]);
    expect(listed("workshop")).toEqual([both, fromOnly, targetOtherCase, targetExact]);
    expect(await found("Workshop")).toEqual([both, fromOnly, targetOtherCase, targetExact]);
  });

  it("merges when the target exists only on outdated recalls, and changes outdated recalls too", async () => {
    ctx = makeContext();
    const t0 = ctx.clock.now;
    const active = await make("bike pump", ["garage"]);
    ctx.clock.now = t0 + DAY;
    const outdatedTarget = await make("old bike pump", ["workshop"]);
    const outdatedFrom = await make("older bike pump", ["Garage", "Bikes"]);
    await ctx.store.update(outdatedTarget, { archived: true });
    await ctx.store.update(outdatedFrom, { archived: true });
    expect(usage("workshop")).toMatchObject({ count: 0 });
    ctx.clock.now = t0 + 4 * DAY;

    const result = await ctx.store.renameKeyword("garage", "Workshop");

    expect(result).toEqual({ status: "merged", keyword: "Workshop", key: "workshop", affected: 3 });
    expect([keywordsOf(active), keywordsOf(outdatedTarget), keywordsOf(outdatedFrom)]).toEqual([
      ["Workshop"],
      ["Workshop"],
      ["Workshop", "Bikes"],
    ]);
    expect([assignedAt(active, "workshop"), assignedAt(outdatedTarget, "workshop"), assignedAt(outdatedFrom, "workshop")])
      .toEqual([t0, t0 + DAY, t0 + DAY]);
    expectRowsMatchLists();
    expect(usage("workshop")).toEqual({ keyword: "Workshop", key: "workshop", count: 1, lastAssignedAt: t0 });
    expect(usage("garage")).toBeUndefined();
    expect(ctx.store.list({ keyword: "workshop" }).memories.map((memory) => memory.id)).toEqual([active]);
    expect(listed("workshop")).toEqual([active, outdatedTarget, outdatedFrom]);
    expect(listed("garage")).toEqual([]);
  });

  it("keeps assignment times: the later non-null time of the two, NULL only when both are NULL", async () => {
    ctx = makeContext();
    const t0 = ctx.clock.now;
    // Target assigned later than the old keyword.
    const targetLater = await make("one", ["garage"]);
    // Old keyword assigned later than the target.
    const fromLater = await make("two", ["workshop"]);
    // Both backfilled with unknown times.
    const bothNull = await make("three", ["garage", "workshop"]);
    // Only the old keyword's time is unknown, then only the target's.
    const fromNull = await make("four", ["garage", "workshop"]);
    const targetNull = await make("five", ["garage"]);
    // A rename (no target) keeps an unknown time unknown.
    const renamedNull = await make("six", ["Garage"]);
    ctx.clock.now = t0 + DAY;
    await ctx.store.update(targetLater, { customKeywords: ["garage", "workshop"] });
    await ctx.store.update(targetNull, { customKeywords: ["garage", "workshop"] });
    ctx.clock.now = t0 + 2 * DAY;
    await ctx.store.update(fromLater, { customKeywords: ["workshop", "garage"] });
    backfilled(bothNull, "garage");
    backfilled(bothNull, "workshop");
    backfilled(fromNull, "garage");
    backfilled(targetNull, "workshop");
    backfilled(renamedNull, "garage");
    expect([assignedAt(fromNull, "workshop"), assignedAt(targetNull, "garage")]).toEqual([t0, t0]);
    ctx.clock.now = t0 + 10 * DAY;

    expect((await ctx.store.renameKeyword("garage", "workshop")).status).toBe("merged");

    expect(assignedAt(targetLater, "workshop")).toBe(t0 + DAY);
    expect(assignedAt(fromLater, "workshop")).toBe(t0 + 2 * DAY);
    expect(assignedAt(bothNull, "workshop")).toBeNull();
    expect(assignedAt(fromNull, "workshop")).toBe(t0);
    expect(assignedAt(targetNull, "workshop")).toBe(t0);
    expect(assignedAt(renamedNull, "workshop")).toBeNull();
    expect(assignments(renamedNull)).toEqual([{ keyword: "workshop", label: "workshop", assigned_at: null }]);
    expectRowsMatchLists();
    // Recency follows the kept times, never the time of the rename.
    expect(usage("workshop")).toEqual({ keyword: "workshop", key: "workshop", count: 6, lastAssignedAt: t0 + 2 * DAY });
  });

  it("throws not found and changes nothing when no recall carries the keyword", async () => {
    ctx = makeContext();
    const id = await make("drill", ["Garage"]);
    ctx.store.applyEnrichment(id, { body: "drill", captions: null }, { category: "things", tags: ["shed"] });
    const before = snapshot();
    const changes = recordChanges();

    await expect(ctx.store.renameKeyword("Workshop", "Garage")).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(ctx.store.renameKeyword("   ", "Garage")).rejects.toMatchObject({ status: 404 });
    // Automatic tags are not custom keywords.
    await expect(ctx.store.renameKeyword("shed", "Garage")).rejects.toMatchObject({ status: 404 });
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
  });

  it("rejects an empty, comma-separated or too-long new keyword and changes nothing", async () => {
    ctx = makeContext();
    await make("drill", ["Garage", "Tools"]);
    const before = snapshot();
    const changes = recordChanges();
    const tooLong = "x".repeat(MAX_CUSTOM_KEYWORD_LENGTH + 1);

    for (const to of ["", "   ", "Workshop, Shed", ",", tooLong, ` ${tooLong} `]) {
      await expect(ctx.store.renameKeyword("garage", to)).rejects.toMatchObject({ status: 400 });
    }
    await expect(ctx.store.renameKeyword("garage", tooLong)).rejects.toThrow(keywordsError([tooLong])!);
    expect(keywordsError([tooLong])).toBe(`Keep each custom keyword to ${MAX_CUSTOM_KEYWORD_LENGTH} characters or fewer.`);
    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);

    // Exactly the maximum length (after trimming) is accepted.
    const longest = "y".repeat(MAX_CUSTOM_KEYWORD_LENGTH);
    expect(await ctx.store.renameKeyword("garage", `  ${longest}  `)).toMatchObject({ status: "renamed", keyword: longest });
  });

  it("leaves every row as it was when a write fails partway", async () => {
    ctx = makeContext();
    const first = await make("drill", ["garage"]);
    const second = await make("saw", ["Workshop", "garage"]);
    const third = await make("ladder", ["Garage"]);
    // Fails the second recall's write, after the first recall's rows were already rewritten.
    ctx.db.exec(`CREATE TRIGGER fail_rename BEFORE UPDATE OF custom_keywords ON memories WHEN new.id = ${second}
      BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    const before = snapshot();
    const changes = recordChanges();
    ctx.clock.now += DAY;

    await expect(ctx.store.renameKeyword("garage", "Workshop")).rejects.toThrow("simulated failure");

    expect(snapshot()).toEqual(before);
    expect(changes).toEqual([]);
    expect([keywordsOf(first), keywordsOf(second), keywordsOf(third)]).toEqual([["garage"], ["Workshop", "garage"], ["Garage"]]);
    expect(listed("garage")).toEqual([first, second, third]);
    expect(await found("garage")).toEqual([first, second, third]);
    expect(await found("workshop")).toEqual([second]);

    // Once the cause is gone the same rename succeeds.
    ctx.db.exec(`DROP TRIGGER fail_rename`);
    expect(await ctx.store.renameKeyword("garage", "Workshop")).toMatchObject({ status: "merged", affected: 3 });
  });

  it("starts no enrichment and no re-embedding", async () => {
    const llm = new FakeLlm(() => ({ json: { category: "things", tags: ["automatic"] } }));
    let enricher: Enricher;
    ctx = makeContext({
      setup: ({ store, db }) => {
        enricher = new Enricher({ store, llm, usage: new UsageLog(db), log: () => {} });
        enricher.attach();
        return { llm };
      },
    });
    const a = await make("blue bin by the door", ["garage"]);
    const b = await make("rake on the wall", ["Workshop", "Garage"]);
    await enricher!.idle();
    const calls = llm.requests.length;
    const embeds = ctx.embedder.documentCalls;
    const enriched = [ctx.store.require(a).enrichedAt, ctx.store.require(b).enrichedAt];
    expect(enriched.every((time) => time !== null)).toBe(true);
    const embeddings = ctx.db.prepare(`SELECT * FROM embeddings ORDER BY memory_id`).all();
    const changes = recordChanges();
    ctx.clock.now += DAY;

    expect(await ctx.store.renameKeyword("garage", "workshop")).toMatchObject({ status: "merged", affected: 2 });
    await enricher!.idle();

    expect(changes).toEqual([
      { kind: "updated", id: a, bodyChanged: false },
      { kind: "updated", id: b, bodyChanged: false },
    ]);
    expect(llm.requests).toHaveLength(calls);
    expect(ctx.embedder.documentCalls).toBe(embeds);
    expect([ctx.store.require(a).enrichedAt, ctx.store.require(b).enrichedAt]).toEqual(enriched);
    expect(ctx.store.require(a).tags).toEqual(["automatic"]);
    expect(ctx.db.prepare(`SELECT * FROM embeddings ORDER BY memory_id`).all()).toEqual(embeddings);
    enricher!.stop();
  });
});
