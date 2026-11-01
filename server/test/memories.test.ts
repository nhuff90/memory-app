import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Memory, MemoryList } from "../../shared/types.js";
import { client, DAY, fakeJpeg, login, makeContext, memoryForm, START_TIME, type TestContext } from "./helpers.js";

let ctx: TestContext;
let api: ReturnType<typeof client>;

beforeEach(async () => {
  ctx = makeContext();
  api = client(ctx.app, await login(ctx.app));
});

afterEach(() => ctx.cleanup());

async function save(fields: Parameters<typeof memoryForm>[0]): Promise<Memory> {
  const res = await api.postForm("/api/memories", memoryForm(fields));
  expect(res.status).toBe(201);
  return (await res.json()) as Memory;
}

function photoFilesOnDisk(): string[] {
  const root = join(ctx.dir, "photos");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

describe("saving memories", () => {
  it("saves exactly what was typed, trimmed", async () => {
    const memory = await save({ body: "  ipad in gym \n" });
    expect(memory.body).toBe("ipad in gym");
    expect(memory.createdAt).toBe(START_TIME);
    expect(memory.archivedAt).toBeNull();
    expect(memory.photos).toEqual([]);
  });

  it("accepts JSON for text-only saves", async () => {
    const res = await api.postJson("/api/memories", { body: "flashlight in kitchen drawer" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Memory).body).toBe("flashlight in kitchen drawer");
  });

  it("stores photos on disk and serves them back", async () => {
    const memory = await save({ body: "Sarah Jones", photos: 2 });
    expect(memory.photos).toHaveLength(2);
    expect(photoFilesOnDisk()).toHaveLength(4);

    const full = await api.get(`/api/photos/${memory.photos[0]!.id}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("image/jpeg");
    expect(full.headers.get("cache-control")).toContain("private");
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(fakeJpeg("full-0"));

    const thumb = await api.get(`/api/photos/${memory.photos[0]!.id}?size=thumb`);
    expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(fakeJpeg("thumb-0"));
  });

  it("allows a photo with no text", async () => {
    const memory = await save({ body: "", photos: 1 });
    expect(memory.body).toBe("");
    expect(memory.photos).toHaveLength(1);
  });

  it("rejects an empty memory", async () => {
    const res = await api.postForm("/api/memories", memoryForm({ body: "   " }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: "Type something or add a photo first." });
  });

  it("rejects files that are not JPEG photos", async () => {
    const form = memoryForm({ body: "not a photo" });
    form.append("photos", new File(["hello"], "note.txt", { type: "text/plain" }));
    form.append("thumbs", new File(["hello"], "note.txt", { type: "text/plain" }));
    const res = await api.postForm("/api/memories", form);
    expect(res.status).toBe(400);
    expect(photoFilesOnDisk()).toEqual([]);
  });

  it("rejects a photo without a thumbnail", async () => {
    const form = memoryForm({ body: "missing thumb" });
    form.append("photos", new File([fakeJpeg()], "a.jpg", { type: "image/jpeg" }));
    expect((await api.postForm("/api/memories", form)).status).toBe(400);
  });

  it("never saves the same phone save twice", async () => {
    const first = await api.postForm("/api/memories", memoryForm({ body: "box cutter", clientId: "phone-save-0001", photos: 1 }));
    const second = await api.postForm("/api/memories", memoryForm({ body: "box cutter", clientId: "phone-save-0001", photos: 1 }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(((await second.json()) as Memory).id).toBe(((await first.json()) as Memory).id);
    expect(photoFilesOnDisk()).toHaveLength(2);
    expect(ctx.store.counts()).toEqual({ memories: 1, photos: 1 });
  });

  it("keeps the time a memory was captured offline", async () => {
    const earlier = START_TIME - 3 * 60 * 60 * 1000;
    expect((await save({ body: "saved in the basement", createdAt: earlier })).createdAt).toBe(earlier);
    expect((await save({ body: "clock way ahead", createdAt: START_TIME + 2 * DAY })).createdAt).toBe(START_TIME);
  });
});

describe("browsing memories", () => {
  it("lists newest first, one page at a time", async () => {
    for (const [index, body] of ["oldest", "middle", "newest"].entries()) {
      ctx.clock.now = START_TIME + index * 1000;
      await save({ body });
    }
    const first = (await (await api.get("/api/memories?limit=2")).json()) as MemoryList;
    expect(first.memories.map((memory) => memory.body)).toEqual(["newest", "middle"]);
    expect(first.nextCursor).not.toBeNull();

    const second = (await (await api.get(`/api/memories?limit=2&cursor=${first.nextCursor}`)).json()) as MemoryList;
    expect(second.memories.map((memory) => memory.body)).toEqual(["oldest"]);
    expect(second.nextCursor).toBeNull();
  });

  it("can list only memories that have photos", async () => {
    await save({ body: "no photo" });
    await save({ body: "with photo", photos: 1 });
    const list = (await (await api.get("/api/memories?photos=1")).json()) as MemoryList;
    expect(list.memories.map((memory) => memory.body)).toEqual(["with photo"]);
  });

  it("returns 404 for memories that do not exist", async () => {
    expect((await api.get("/api/memories/999")).status).toBe(404);
    expect((await api.get("/api/memories/abc")).status).toBe(404);
    expect((await api.get("/api/photos/999")).status).toBe(404);
  });
});

describe("changing memories", () => {
  it("edits the text", async () => {
    const memory = await save({ body: "ipad in gym" });
    ctx.clock.now += 5000;
    const res = await api.patch(`/api/memories/${memory.id}`, { body: "ipad in the home gym" });
    const updated = (await res.json()) as Memory;
    expect(updated.body).toBe("ipad in the home gym");
    expect(updated.updatedAt).toBe(START_TIME + 5000);
    expect(updated.createdAt).toBe(START_TIME);
  });

  it("will not erase the only content of a memory", async () => {
    const memory = await save({ body: "ipad in gym" });
    expect((await api.patch(`/api/memories/${memory.id}`, { body: "" })).status).toBe(400);
  });

  it("rejects unknown fields", async () => {
    const memory = await save({ body: "ipad in gym" });
    expect((await api.patch(`/api/memories/${memory.id}`, { colour: "red" })).status).toBe(400);
  });

  it("hides Outdated memories from the list until restored", async () => {
    const memory = await save({ body: "ipad in gym" });
    const archived = (await (await api.patch(`/api/memories/${memory.id}`, { archived: true })).json()) as Memory;
    expect(archived.archivedAt).toBe(START_TIME);

    expect(((await (await api.get("/api/memories")).json()) as MemoryList).memories).toEqual([]);
    const withArchived = (await (await api.get("/api/memories?archived=1")).json()) as MemoryList;
    expect(withArchived.memories.map((item) => item.id)).toEqual([memory.id]);

    const restored = (await (await api.patch(`/api/memories/${memory.id}`, { archived: false })).json()) as Memory;
    expect(restored.archivedAt).toBeNull();
  });

  it("deletes a memory and its photo files", async () => {
    const memory = await save({ body: "Christmas box", photos: 1 });
    expect((await api.delete(`/api/memories/${memory.id}`)).status).toBe(204);
    expect((await api.get(`/api/memories/${memory.id}`)).status).toBe(404);
    expect(photoFilesOnDisk()).toEqual([]);
    expect((await api.delete(`/api/memories/${memory.id}`)).status).toBe(404);
  });

  it("adds and removes photos", async () => {
    const memory = await save({ body: "garage shelf" });
    const form = new FormData();
    form.append("photos", new File([fakeJpeg("shelf")], "shelf.jpg", { type: "image/jpeg" }));
    form.append("thumbs", new File([fakeJpeg("shelf-thumb")], "shelf-thumb.jpg", { type: "image/jpeg" }));
    const withPhoto = (await (await api.postForm(`/api/memories/${memory.id}/photos`, form)).json()) as Memory;
    expect(withPhoto.photos).toHaveLength(1);

    const withoutPhoto = (await (await api.delete(`/api/photos/${withPhoto.photos[0]!.id}`)).json()) as Memory;
    expect(withoutPhoto.photos).toEqual([]);
    expect(photoFilesOnDisk()).toEqual([]);
  });

  it("keeps the last photo of a memory that has no text", async () => {
    const memory = await save({ body: "", photos: 1 });
    const res = await api.delete(`/api/photos/${memory.photos[0]!.id}`);
    expect(res.status).toBe(400);
    expect(photoFilesOnDisk()).toHaveLength(2);
  });
});
