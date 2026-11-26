import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import type { Memory } from "../../shared/types.js";
import { client, fakeJpeg, login, makeContext, memoryForm, type TestContext } from "./helpers.js";

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

describe("GET /api/export", () => {
  it("requires login", async () => {
    ctx = makeContext();
    expect((await ctx.app.request("/api/export")).status).toBe(401);
  });

  it("downloads every memory and full-size photo as a zip", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const sarah = (await (await api.postForm("/api/memories", memoryForm({ body: "Sarah's kids are Emma and Jake", photos: 1 }))).json()) as Memory;
    const flashlight = (await (await api.postJson("/api/memories", { body: "flashlight in the garage" })).json()) as Memory;
    await api.patch(`/api/memories/${flashlight.id}`, { archived: true });

    const res = await api.get("/api/export?tz=America/Chicago");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="recall-export-2026-10-31.zip"');
    expect(res.headers.get("cache-control")).toBe("no-store");

    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const photoFile = `photos/${sarah.id}-${sarah.photos[0]!.id}.jpg`;
    expect(Object.keys(files).sort()).toEqual(["memories.json", "memories.md", photoFile]);
    expect(files[photoFile]).toEqual(fakeJpeg("full-0"));

    const json = JSON.parse(strFromU8(files["memories.json"]!)) as {
      timeZone: string;
      memories: { body: string; outdatedAt: string | null; photos: { file: string }[] }[];
    };
    expect(json.timeZone).toBe("America/Chicago");
    expect(json.memories.map((memory) => memory.body)).toEqual(["flashlight in the garage", "Sarah's kids are Emma and Jake"]);
    expect(json.memories[0]!.outdatedAt).not.toBeNull();
    expect(json.memories[1]!.photos).toEqual([{ file: photoFile, caption: null, text: null }]);

    const markdown = strFromU8(files["memories.md"]!);
    expect(markdown).toContain("## October 31, 2026 at 1:00 PM");
    expect(markdown).toContain("Sarah's kids are Emma and Jake");
    expect(markdown).toContain(`![Photo](${photoFile})`);
    expect(markdown).toContain("*Outdated*");
  });

  it("keeps the text read from photos in both files, quoted in Markdown", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const card = (await (await api.postForm("/api/memories", memoryForm({ body: "Grandma's recipe card", photos: 2 }))).json()) as Memory;
    const [read, unread] = card.photos.map((photo) => photo.id) as [number, number];
    ctx.store.savePhotoText(read, "Saffron rice\n\n2 cups water");
    const readFile = `photos/${card.id}-${read}.jpg`;
    const unreadFile = `photos/${card.id}-${unread}.jpg`;

    const files = unzipSync(new Uint8Array(await (await api.get("/api/export")).arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["memories.json", "memories.md", readFile, unreadFile]);
    const json = JSON.parse(strFromU8(files["memories.json"]!)) as {
      memories: { body: string; photos: { file: string; caption: string | null; text: string | null }[] }[];
    };
    expect(json.memories[0]!.photos).toEqual([
      { file: readFile, caption: null, text: "Saffron rice\n\n2 cups water" },
      { file: unreadFile, caption: null, text: null },
    ]);

    const markdown = strFromU8(files["memories.md"]!);
    expect(markdown).toContain(
      "Grandma's recipe card\n\n" +
        `![Photo](${readFile})\n\n` +
        "Text in photo:\n" +
        "> Saffron rice\n" +
        ">\n" +
        "> 2 cups water\n\n" +
        // A photo without text gets exactly the lines it always did.
        `![Photo](${unreadFile})\n\n` +
        "Pinned: no\n",
    );
    expect(markdown.match(/Text in photo:/g)).toHaveLength(1);
  });

  it("uses the server's time zone when the requested one is unknown", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    await api.postJson("/api/memories", { body: "ipad in gym" });
    const res = await api.get("/api/export?tz=Mars/Olympus");
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(JSON.parse(strFromU8(files["memories.json"]!)).timeZone).toBe("America/New_York");
    expect(strFromU8(files["memories.md"]!)).toContain("at 2:00 PM");
  });
});
