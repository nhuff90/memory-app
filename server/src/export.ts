import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { ZipArchive, type ZipEntryData } from "archiver";
import { CATEGORY_LABELS, type Memory } from "../../shared/types.js";
import type { MemoryStore } from "./memories.js";

const photoName = (memoryId: number, photoId: number) => `photos/${memoryId}-${photoId}.jpg`;

export function exportFileName(now: number, timeZone: string): string {
  // en-CA formats dates as YYYY-MM-DD.
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return `recall-export-${day}.zip`;
}

export function exportJson(memories: Memory[], now: number, timeZone: string): string {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return JSON.stringify(
    {
      exportedAt: iso(now),
      timeZone,
      memories: memories.map((memory) => ({
        id: memory.id,
        body: memory.body,
        category: memory.category,
        tags: memory.tags,
        pinned: memory.pinned,
        customKeywords: memory.customKeywords,
        createdAt: iso(memory.createdAt),
        updatedAt: iso(memory.updatedAt),
        outdatedAt: iso(memory.archivedAt),
        photos: memory.photos.map((photo) => ({ file: photoName(memory.id, photo.id), caption: photo.caption })),
      })),
    },
    null,
    2,
  );
}

export function exportMarkdown(memories: Memory[], now: number, timeZone: string): string {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "long", timeStyle: "short" });
  const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
  const photos = memories.reduce((total, memory) => total + memory.photos.length, 0);
  const lines = [
    "# Recall export",
    "",
    `Exported ${format.format(now)} (${timeZone}): ${count(memories.length, "memory", "memories")}, ${count(photos, "photo", "photos")}. Newest first.`,
    "",
  ];
  for (const memory of memories) {
    lines.push("---", "", `## ${format.format(memory.createdAt)}`, "");
    if (memory.body) lines.push(memory.body, "");
    for (const photo of memory.photos) lines.push(`![${photo.caption ?? "Photo"}](${photoName(memory.id, photo.id)})`, "");
    lines.push(`Pinned: ${memory.pinned ? "yes" : "no"}`, "");
    if (memory.customKeywords.length) lines.push(`Custom keywords: ${memory.customKeywords.join(", ")}`, "");
    const details = [
      memory.archivedAt !== null ? "Outdated" : null,
      memory.category ? CATEGORY_LABELS[memory.category] : null,
      memory.tags.length ? `Tags: ${memory.tags.join(", ")}` : null,
    ].filter((detail) => detail !== null);
    if (details.length) lines.push(`*${details.join(" · ")}*`, "");
  }
  return lines.join("\n");
}

/** Streams a zip of every memory (JSON for machines, Markdown for people) plus full-size photos. */
export function exportZip(
  store: MemoryStore,
  now: number,
  timeZone: string,
  log: (message: string, error?: unknown) => void,
): ReadableStream<Uint8Array> {
  const memories = store.all();
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on("warning", (error) => log("Export warning", error));
  archive.on("error", (error) => log("Export failed", error));
  archive.append(exportJson(memories, now, timeZone), { name: "memories.json" });
  archive.append(exportMarkdown(memories, now, timeZone), { name: "memories.md" });
  for (const memory of memories) {
    for (const photo of memory.photos) {
      const file = store.photoPath(photo.id, "full");
      const path = file ? store.photos.resolve(file) : null;
      if (!path || !existsSync(path)) continue;
      // JPEGs are already compressed, so they are stored as-is.
      const entry: ZipEntryData = { name: photoName(memory.id, photo.id), store: true };
      archive.file(path, entry);
    }
  }
  void archive.finalize();
  return Readable.toWeb(archive) as ReadableStream<Uint8Array>;
}
