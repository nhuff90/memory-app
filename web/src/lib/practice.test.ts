import { describe, expect, it } from "vitest";
import type { Memory } from "../../../shared/types";
import {
  buildRound,
  isDue,
  loadProgress,
  practiceCards,
  recordAnswer,
  saveProgress,
  type PracticeCard,
  type PracticeProgress,
} from "./practice";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 31, 12);

function person(id: number, body: string, { photos = 1, archivedAt = null }: { photos?: number; archivedAt?: number | null } = {}): Memory {
  return {
    id,
    body,
    category: "people",
    categorySetByUser: false,
    tags: [],
    pinned: false,
    customKeywords: [],
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt,
    enrichedAt: null,
    photos: Array.from({ length: photos }, (_, index) => ({ id: id * 10 + index, caption: null, createdAt: NOW })),
  };
}

function memoryStorage(saved?: string) {
  const items = new Map(saved === undefined ? [] : [["recall:practice", saved]]);
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

const ids = (round: PracticeCard[]) => round.map((card) => card.memoryId);

describe("practiceCards", () => {
  it("uses people who have a photo and a name, with their first photo", () => {
    const cards = practiceCards([
      person(1, "Sarah Mitchell, neighbor at #14. Kids Emma and Jake", { photos: 2 }),
      person(2, ""),
      person(3, "Dave from accounting", { photos: 0 }),
      person(4, "Coach Rivera", { archivedAt: NOW }),
    ]);
    expect(cards).toEqual([
      { memoryId: 1, photoId: 10, name: "Sarah Mitchell", note: "Sarah Mitchell, neighbor at #14. Kids Emma and Jake" },
    ]);
  });
});

describe("buildRound", () => {
  const cards = practiceCards([1, 2, 3, 4, 5].map((id) => person(id, `Person ${id}`)));

  it("puts new and missed people first, then the least known, then those resting", () => {
    const progress: PracticeProgress = {
      1: { box: 3, seenAt: NOW - 30 * DAY },
      2: { box: 0, seenAt: NOW - DAY },
      3: { box: 2, seenAt: NOW - 30 * DAY },
      5: { box: 4, seenAt: NOW - DAY },
    };
    expect(ids(buildRound(cards, progress, NOW, 10, () => 0.5))).toEqual([2, 4, 3, 1, 5]);
  });

  it("keeps rounds short and shuffles people who are equally known", () => {
    const shuffle = [0.9, 0.1, 0.5, 0.3, 0.7];
    expect(ids(buildRound(cards, {}, NOW, 3, () => shuffle.shift()!))).toEqual([2, 4, 3]);
  });
});

describe("recordAnswer", () => {
  it("moves someone up a box for each right answer, and back to the start on a miss", () => {
    let progress = recordAnswer({}, 1, true, NOW);
    expect(progress[1]).toEqual({ box: 1, seenAt: NOW });
    for (let answer = 0; answer < 10; answer++) progress = recordAnswer(progress, 1, true, NOW);
    expect(progress[1]!.box).toBe(5);
    progress = recordAnswer(progress, 1, false, NOW + DAY);
    expect(progress[1]).toEqual({ box: 0, seenAt: NOW + DAY });
  });

  it("rests people longer the better they're known", () => {
    expect(isDue(undefined, NOW)).toBe(true);
    expect(isDue({ box: 0, seenAt: NOW }, NOW)).toBe(true);
    expect(isDue({ box: 1, seenAt: NOW }, NOW + DAY - 1)).toBe(false);
    expect(isDue({ box: 1, seenAt: NOW }, NOW + DAY)).toBe(true);
    expect(isDue({ box: 5, seenAt: NOW }, NOW + 59 * DAY)).toBe(false);
  });
});

describe("progress storage", () => {
  it("survives a round trip and drops anything malformed", () => {
    const storage = memoryStorage();
    saveProgress(storage, { 1: { box: 2, seenAt: NOW } });
    expect(loadProgress(storage)).toEqual({ 1: { box: 2, seenAt: NOW } });

    expect(loadProgress(memoryStorage("not json"))).toEqual({});
    expect(loadProgress(memoryStorage("[1, 2]"))).toEqual({});
    const mixed = { 1: { box: 9, seenAt: NOW }, 2: { box: 1 }, 3: null, 4: { box: 1, seenAt: NOW } };
    expect(loadProgress(memoryStorage(JSON.stringify(mixed)))).toEqual({ 4: { box: 1, seenAt: NOW } });
  });

  it("keeps practice working when storage is full", () => {
    const full = {
      setItem: () => {
        throw new DOMException("Storage is full", "QuotaExceededError");
      },
    };
    expect(() => saveProgress(full, {})).not.toThrow();
  });
});
