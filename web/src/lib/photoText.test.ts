import { afterEach, describe, expect, it, vi } from "vitest";
import type { Memory } from "../../../shared/types";
import { ApiError, normalizeMemory, readSavedPhotoText, searchMemories } from "../api";
import { addTextToNote, photoTextStatus, supportsPhotoText } from "./photoText";

const stubFetch = (status: number, body: unknown) => {
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeMemory photo text", () => {
  const memory = (photos: unknown) => ({ id: 1, body: "Recipe", createdAt: 1, updatedAt: 2, photos }) as unknown as Memory;
  const older = { id: 7, caption: "A recipe card", createdAt: 5 };

  it("gives photos from an older server, and malformed or blank text, text: null", () => {
    const photos = normalizeMemory(
      memory([older, { ...older, id: 8, text: 42 }, { ...older, id: 9, text: "  " }, { ...older, id: 10, text: "\n\t" }, { ...older, id: 11, text: null }]),
    ).photos;
    expect(photos).toEqual([
      { id: 7, caption: "A recipe card", createdAt: 5, text: null },
      { id: 8, caption: "A recipe card", createdAt: 5, text: null },
      { id: 9, caption: "A recipe card", createdAt: 5, text: null },
      { id: 10, caption: "A recipe card", createdAt: 5, text: null },
      { id: 11, caption: "A recipe card", createdAt: 5, text: null },
    ]);
  });

  it("keeps real text exactly, line breaks included, and leaves other photo fields alone", () => {
    const photo = { id: 3, caption: null, text: "Bake 350\nfor 10 min", createdAt: 9, extra: "kept" };
    expect(normalizeMemory(memory([photo])).photos).toEqual([photo]);
    expect(normalizeMemory(memory([{ ...photo, text: "  Bake 350\n" }])).photos[0]!.text).toBe("  Bake 350\n");
  });

  it("still turns a non-array photos value into an empty list", () => {
    expect(normalizeMemory(memory(undefined)).photos).toEqual([]);
    expect(normalizeMemory(memory({ text: "x" })).photos).toEqual([]);
    expect(normalizeMemory(memory("photo")).photos).toEqual([]);
  });

  it("normalizes photos in a server response", async () => {
    const fetch = stubFetch(200, {
      results: [
        { id: 1, body: "Old server", photos: [older] },
        { id: 2, body: "New server", photos: [{ id: 4, caption: "Card", text: "Bake 350\nfor 10 min", createdAt: 6 }] },
      ],
    });
    const { results } = await searchMemories("bake");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.photos)).toEqual([
      [{ ...older, text: null }],
      [{ id: 4, caption: "Card", text: "Bake 350\nfor 10 min", createdAt: 6 }],
    ]);
  });
});

describe("readSavedPhotoText", () => {
  const me = {
    aiEnabled: true,
    model: "claude",
    photoCaptions: true,
    counts: { memories: 3, photos: 4 },
    capabilities: ["photo-text"],
    photoText: { unread: 4, requested: true },
  };

  it("posts to /api/photo-text/read-saved and returns the /api/me response", async () => {
    const fetch = stubFetch(200, me);
    await expect(readSavedPhotoText()).resolves.toEqual(me);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/photo-text/read-saved");
    expect(init?.method).toBe("POST");
  });

  it("keeps the api helper's error handling when the server refuses", async () => {
    stubFetch(400, { error: "bad_request", message: "Turn on Describe photos first." });
    const error = await readSavedPhotoText().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: "bad_request", message: "Turn on Describe photos first." });
  });
});

describe("addTextToNote", () => {
  it("uses the text as the note when the note is empty", () => {
    expect(addTextToNote("", "abc")).toEqual({ ok: true, body: "abc" });
    expect(addTextToNote("  \n ", "Bake 350\nfor 10 min")).toEqual({ ok: true, body: "Bake 350\nfor 10 min" });
  });

  it("adds the text after a blank line, trimming only the end of the note", () => {
    expect(addTextToNote("Recipe  \n", "abc")).toEqual({ ok: true, body: "Recipe\n\nabc" });
    expect(addTextToNote("  Recipe", "Bake 350\nfor 10 min")).toEqual({ ok: true, body: "  Recipe\n\nBake 350\nfor 10 min" });
  });

  it("refuses text that is already in the note", () => {
    const already = { ok: false, message: "This text is already in the note." };
    expect(addTextToNote("Recipe\n\nBake 350\nfor 10 min", "Bake 350\nfor 10 min")).toEqual(already);
    expect(addTextToNote("Recipe: Bake 350\nfor 10 min, then cool", " Bake 350\nfor 10 min\n")).toEqual(already);
  });

  it("refuses a result over the length limit", () => {
    const tooLong = { ok: false, message: "Adding this text would make the note longer than 10,000 characters." };
    expect(addTextToNote("x".repeat(9_990), "y".repeat(9))).toEqual(tooLong);
    expect(addTextToNote("", "y".repeat(10_001))).toEqual(tooLong);
    // Exactly at the limit is fine.
    expect(addTextToNote("x".repeat(9_989), "y".repeat(9))).toEqual({ ok: true, body: `${"x".repeat(9_989)}\n\n${"y".repeat(9)}` });
    expect(addTextToNote("Note", "abcdef", 10)).toEqual({ ok: false, message: "Adding this text would make the note longer than 10 characters." });
  });
});

describe("supportsPhotoText", () => {
  it("is false for older or malformed /api/me responses", () => {
    expect(supportsPhotoText(null)).toBe(false);
    expect(supportsPhotoText(undefined)).toBe(false);
    expect(supportsPhotoText("photo-text")).toBe(false);
    expect(supportsPhotoText({})).toBe(false);
    expect(supportsPhotoText({ capabilities: "photo-text" })).toBe(false);
    expect(supportsPhotoText({ capabilities: ["keyword-rename"] })).toBe(false);
  });

  it("is true when photo-text is listed", () => {
    expect(supportsPhotoText({ capabilities: ["keyword-rename", "photo-text"] })).toBe(true);
    expect(supportsPhotoText({ capabilities: ["photo-text"] })).toBe(true);
  });
});

describe("photoTextStatus", () => {
  const base = { aiEnabled: true, model: "claude", photoCaptions: true, counts: { memories: 3, photos: 4 } };
  const withText = (photoText: unknown, photoCaptions: unknown) => ({ ...base, photoCaptions, capabilities: ["photo-text"], photoText });

  it("is null for an older /api/me response", () => {
    expect(photoTextStatus(base)).toBeNull();
    expect(photoTextStatus({ ...base, capabilities: ["keyword-rename"] })).toBeNull();
    // Without the capability, a photoText field is not trusted.
    expect(photoTextStatus({ ...base, photoText: { unread: 2, requested: false } })).toBeNull();
    expect(photoTextStatus(null)).toBeNull();
  });

  it("is null when photoText is missing or malformed", () => {
    for (const photoText of [
      undefined,
      null,
      "4",
      [],
      { unread: -1, requested: true },
      { unread: 1.5, requested: true },
      { unread: "3", requested: true },
      { unread: Number.NaN, requested: false },
      { unread: Number.POSITIVE_INFINITY, requested: false },
      { unread: 3 },
      { unread: 3, requested: "yes" },
      { requested: true },
    ]) {
      expect(photoTextStatus(withText(photoText, true))).toBeNull();
    }
  });

  it("computes reading and paused for every combination", () => {
    for (const requested of [true, false]) {
      for (const photoCaptions of [true, false, undefined, "true"]) {
        for (const unread of [0, 3]) {
          const pending = requested && unread > 0;
          expect(photoTextStatus(withText({ unread, requested }, photoCaptions))).toEqual({
            unread,
            requested,
            reading: pending && photoCaptions === true,
            paused: pending && photoCaptions !== true,
          });
        }
      }
    }
    expect(photoTextStatus(withText({ unread: 3, requested: true }, true))).toEqual({ unread: 3, requested: true, reading: true, paused: false });
    expect(photoTextStatus(withText({ unread: 3, requested: true }, false))).toEqual({ unread: 3, requested: true, reading: false, paused: true });
    expect(photoTextStatus(withText({ unread: 0, requested: true }, true))).toEqual({ unread: 0, requested: true, reading: false, paused: false });
    expect(photoTextStatus(withText({ unread: 3, requested: false }, false))).toEqual({ unread: 3, requested: false, reading: false, paused: false });
  });
});
