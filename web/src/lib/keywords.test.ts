import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeywordUsage } from "../../../shared/types";
import { ApiError, renameKeyword } from "../api";
import {
  applyKeywordInput,
  keywordFilterAfterRename,
  pendingKeywordError,
  planKeywordRename,
  readVocabulary,
  sameKeywordList,
  suggestKeywords,
  supportsKeywordRename,
} from "./keywords";

const usage = (keyword: string, count: number, lastAssignedAt: number | null = null): KeywordUsage => ({
  keyword,
  key: keyword.toLowerCase(),
  count,
  lastAssignedAt,
});
const names = (list: KeywordUsage[]) => list.map((entry) => entry.keyword);

describe("suggestKeywords", () => {
  const vocabulary = [
    usage("Garage", 9, 100),
    usage("Christmas", 2, 300),
    usage("Attic", 5, null),
    usage("Basement", 5, null),
    usage("Tools", 7, 200),
    usage("Shed", 1, 400),
    usage("Archive only", 0, null),
    usage("Garden", 3, null),
  ];

  it("reserves two recent slots, then fills by frequency with alphabetical ties", () => {
    expect(names(suggestKeywords(vocabulary, "", []))).toEqual(["Shed", "Christmas", "Garage", "Tools", "Attic"]);
    // Attic and Basement tie at 5: alphabetical, and the order is stable across calls.
    expect(names(suggestKeywords(vocabulary, "", [], 6))).toEqual(["Shed", "Christmas", "Garage", "Tools", "Attic", "Basement"]);
  });

  it("excludes selected (case-insensitively) and outdated-only keywords from defaults", () => {
    const result = names(suggestKeywords(vocabulary, "", ["shed", "CHRISTMAS"]));
    expect(result).toEqual(["Tools", "Garage", "Attic", "Basement", "Garden"]);
    expect(result).not.toContain("Archive only");
  });

  it("fills unused recent slots from frequency when no recency is known", () => {
    const legacy = [usage("b", 2), usage("a", 2), usage("c", 5)];
    expect(names(suggestKeywords(legacy, "", []))).toEqual(["c", "a", "b"]);
  });

  it("prioritizes text matches while typing and never exceeds five", () => {
    const many = [...vocabulary, usage("Gardening", 1), usage("Big garage", 4), usage("Garage door", 1), usage("Ga", 1)];
    expect(names(suggestKeywords(many, "ga", []))).toEqual(["Ga", "Garage", "Garden", "Garage door", "Gardening"]);
    expect(names(suggestKeywords(many, "garage", ["Garage"]))).toEqual(["Garage door", "Big garage"]);
    expect(names(suggestKeywords(many, "arch", []))).toEqual(["Archive only"]);
    expect(names(suggestKeywords(many, "Tools, ga", []))).toContain("Garage");
    expect(suggestKeywords(many, "zzz", [])).toEqual([]);
  });
});

describe("applyKeywordInput", () => {
  it("turns complete comma-separated parts into deduplicated pills and keeps the unfinished tail", () => {
    expect(applyKeywordInput(["Garage"], " Bike , ,BIKE, gar")).toEqual({ keywords: ["Garage", "Bike"], input: "gar" });
    expect(applyKeywordInput(["Garage"], "garage,")).toEqual({ keywords: ["Garage"], input: "" });
    expect(applyKeywordInput([], "Shed")).toEqual({ keywords: [], input: "Shed" });
    expect(applyKeywordInput([], "Shed", true)).toEqual({ keywords: ["Shed"], input: "" });
    expect(applyKeywordInput(["A"], "  ", true)).toEqual({ keywords: ["A"], input: "" });
  });

  it("adds nothing and keeps the text visible when the shared limits would be broken", () => {
    const long = "x".repeat(41);
    expect(applyKeywordInput(["A"], `B,${long},`)).toEqual({ keywords: ["A"], input: `B,${long},` });
    expect(pendingKeywordError(["A"], `B,${long},`)).toMatch(/40 characters/);
    const ten = Array.from({ length: 10 }, (_, i) => `k${i}`);
    expect(applyKeywordInput(ten, "extra", true)).toEqual({ keywords: ten, input: "extra" });
    expect(pendingKeywordError(ten, "extra")).toMatch(/10 custom keywords/);
    expect(pendingKeywordError(ten, "K3")).toBeNull();
    expect(pendingKeywordError([], "")).toBeNull();
  });
});

it("compares exact lists and tolerates malformed vocabulary responses", () => {
  expect(sameKeywordList(["A", "b"], ["A", "b"])).toBe(true);
  expect(sameKeywordList(["A", "b"], ["a", "b"])).toBe(false);
  expect(readVocabulary(null)).toEqual([]);
  expect(readVocabulary({ memories: [] })).toEqual([]);
  expect(readVocabulary({ keywords: [{ keyword: "Shed" }, { keyword: 3 }, null, { keyword: "Tools", key: "tools", count: 2, lastAssignedAt: 5 }] })).toEqual([
    { keyword: "Shed", key: "shed", count: 0, lastAssignedAt: null },
    { keyword: "Tools", key: "tools", count: 2, lastAssignedAt: 5 },
  ]);
});

describe("planKeywordRename", () => {
  const garage = usage("Garage", 4, 10);
  const vocabulary = [garage, usage("Tools", 7, 20), usage("Old shed", 0, null)];

  it("refuses empty text, commas and text over the shared length limit", () => {
    expect(planKeywordRename(vocabulary, garage, "")).toEqual({ kind: "invalid", message: "Type the new keyword." });
    expect(planKeywordRename(vocabulary, garage, "   ")).toEqual({ kind: "invalid", message: "Type the new keyword." });
    const comma = planKeywordRename(vocabulary, garage, "Bike, Shed");
    expect(comma.kind).toBe("invalid");
    expect(comma.kind === "invalid" && comma.message).toMatch(/one keyword at a time/i);
    expect(planKeywordRename(vocabulary, garage, "x".repeat(41))).toEqual({
      kind: "invalid",
      message: "Keep each custom keyword to 40 characters or fewer.",
    });
    // Exactly 40 characters after trimming is fine.
    expect(planKeywordRename(vocabulary, garage, `  ${"x".repeat(40)}  `)).toEqual({ kind: "rename", to: "x".repeat(40) });
  });

  it("is unchanged for the same spelling and a respelling when only the case differs", () => {
    expect(planKeywordRename(vocabulary, garage, "Garage")).toEqual({ kind: "unchanged" });
    expect(planKeywordRename(vocabulary, garage, "  Garage ")).toEqual({ kind: "unchanged" });
    expect(planKeywordRename(vocabulary, garage, " GARAGE ")).toEqual({ kind: "respell", to: "GARAGE" });
  });

  it("merges into another vocabulary entry with the same key, outdated-only entries included", () => {
    expect(planKeywordRename(vocabulary, garage, "tools")).toEqual({ kind: "merge", to: "tools", target: vocabulary[1] });
    expect(planKeywordRename(vocabulary, garage, "OLD SHED")).toEqual({ kind: "merge", to: "OLD SHED", target: vocabulary[2] });
  });

  it("renames to a keyword that is not in the vocabulary", () => {
    expect(planKeywordRename(vocabulary, garage, " Workshop ")).toEqual({ kind: "rename", to: "Workshop" });
    expect(planKeywordRename([], garage, "Tools")).toEqual({ kind: "rename", to: "Tools" });
  });
});

describe("supportsKeywordRename", () => {
  it("is false for older or malformed /api/me responses", () => {
    expect(supportsKeywordRename(null)).toBe(false);
    expect(supportsKeywordRename(undefined)).toBe(false);
    expect(supportsKeywordRename("keyword-rename")).toBe(false);
    expect(supportsKeywordRename({})).toBe(false);
    expect(supportsKeywordRename({ aiEnabled: false })).toBe(false);
    expect(supportsKeywordRename({ capabilities: "keyword-rename" })).toBe(false);
    expect(supportsKeywordRename({ capabilities: ["keyword-capture"] })).toBe(false);
  });

  it("is true when keyword-rename is listed", () => {
    expect(supportsKeywordRename({ capabilities: ["keyword-capture", "keyword-rename"] })).toBe(true);
    expect(supportsKeywordRename({ capabilities: ["keyword-rename"] })).toBe(true);
  });
});

describe("keywordFilterAfterRename", () => {
  const renamed = { status: "renamed", keyword: "Workshop", key: "workshop", affected: 3 } as const;
  const merged = { status: "merged", keyword: "tools", key: "tools", affected: 4 } as const;
  const respelled = { status: "respelled", keyword: "GARAGE", key: "garage", affected: 2 } as const;

  it("follows the renamed keyword to its new spelling", () => {
    expect(keywordFilterAfterRename("Garage", "garage", renamed)).toBe("Workshop");
    expect(keywordFilterAfterRename("garage", "garage", respelled)).toBe("GARAGE");
    expect(keywordFilterAfterRename("GARAGE", "garage", merged)).toBe("tools");
  });

  it("uses the new spelling when the filter was on the merge target", () => {
    expect(keywordFilterAfterRename("Tools", "garage", merged)).toBe("tools");
  });

  it("leaves other filters, and no filter, alone", () => {
    expect(keywordFilterAfterRename("Shed", "garage", renamed)).toBe("Shed");
    expect(keywordFilterAfterRename("Shed", "garage", merged)).toBe("Shed");
    expect(keywordFilterAfterRename("Workshop", "garage", renamed)).toBe("Workshop");
    expect(keywordFilterAfterRename(null, "garage", renamed)).toBeNull();
    expect(keywordFilterAfterRename(null, "garage", merged)).toBeNull();
  });
});

describe("renameKeyword", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (status: number, body: unknown) => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  it("posts { from, to } as JSON and returns the normalized result", async () => {
    const fetch = stubFetch(200, { status: "merged", keyword: "Tools", key: "tools", affected: 3 });
    await expect(renameKeyword("Garage", "Tools")).resolves.toEqual({ status: "merged", keyword: "Tools", key: "tools", affected: 3 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/keywords/rename");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ from: "Garage", to: "Tools" });
  });

  it("fills a missing key and count from a sparse but valid reply", async () => {
    stubFetch(200, { status: "renamed", keyword: "Workshop" });
    await expect(renameKeyword("Garage", "Workshop")).resolves.toEqual({ status: "renamed", keyword: "Workshop", key: "workshop", affected: 0 });
  });

  it("throws a readable error for a malformed reply instead of returning it", async () => {
    for (const body of [null, {}, { ok: true }, { status: "done", keyword: "Tools" }, { status: "renamed", keyword: 3 }, { status: "renamed", keyword: " " }]) {
      stubFetch(200, body);
      await expect(renameKeyword("Garage", "Tools")).rejects.toThrow(/unexpected reply to the rename/);
    }
  });

  it("rejects a reply whose key does not match its spelling before it can move an unrelated filter", async () => {
    stubFetch(200, { status: "merged", keyword: "Tools", key: "shed", affected: 3 });
    let result: Parameters<typeof keywordFilterAfterRename>[2] | undefined;
    await expect(
      renameKeyword("Garage", "Tools").then((value) => {
        result = value;
      }),
    ).rejects.toThrow(/unexpected reply to the rename/);
    expect(result).toBeUndefined();
    // Had the reply been trusted, the unrelated "Shed" filter would have become "Tools".
    expect(keywordFilterAfterRename("Shed", "garage", { status: "merged", keyword: "Tools", key: "tools" })).toBe("Shed");
  });

  it("rejects a reply spelling that is not one valid keyword", async () => {
    for (const body of [
      { status: "renamed", keyword: "A,B", key: "a,b", affected: 1 },
      { status: "renamed", keyword: "A,B", affected: 1 },
      { status: "renamed", keyword: "x".repeat(41), key: "x".repeat(41), affected: 1 },
      { status: "renamed", keyword: "Tools", key: 7, affected: 1 },
    ]) {
      stubFetch(200, body);
      await expect(renameKeyword("Garage", "Tools")).rejects.toThrow(/unexpected reply to the rename/);
    }
    stubFetch(200, { status: "respelled", keyword: "x".repeat(40), key: "x".repeat(40), affected: 1 });
    await expect(renameKeyword("X".repeat(40), "x".repeat(40))).resolves.toEqual({
      status: "respelled",
      keyword: "x".repeat(40),
      key: "x".repeat(40),
      affected: 1,
    });
  });

  it("keeps the api helper's error handling for refused renames", async () => {
    stubFetch(404, { error: "not_found", message: "No memory has that keyword." });
    const error = await renameKeyword("Nothing", "Tools").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: "not_found", message: "No memory has that keyword." });
  });
});
