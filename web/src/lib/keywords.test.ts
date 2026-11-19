import { describe, expect, it } from "vitest";
import type { KeywordUsage } from "../../../shared/types";
import { applyKeywordInput, pendingKeywordError, readVocabulary, sameKeywordList, suggestKeywords } from "./keywords";

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
