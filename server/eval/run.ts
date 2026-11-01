/**
 * Search quality check against the real model: `npm run eval`. Add `-- --sweep` to compare cutoffs,
 * `-- --similarities` to print raw scores, `-- --verbose` to print every query, and `-- --tags` to add
 * the hand-written tags in tags.json, which stand in for what auto-tagging would add.
 * Fails when fewer than 90% of queries find their note in the top 3.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { LocalEmbedder } from "../src/embed.js";
import { MemoryStore, type Enrichment } from "../src/memories.js";
import { PhotoStore } from "../src/photos.js";
import {
  MIN_SIMILARITY,
  RELATED_MARGIN,
  RELATED_SIMILARITY,
  STRICT_SIMILARITY,
  SearchIndex,
  type SearchHit,
} from "../src/search.js";

interface EvalNote {
  key: string;
  body: string;
  daysAgo: number;
  outdated?: boolean;
}
interface EvalCases {
  search: { query: string; expect: string[] }[];
  unrelated: string[];
  alreadySaved: { draft: string; expect: string[] }[];
}
interface Cutoffs {
  min: number;
  related: number;
  strict: number;
  margin: number;
}

const DAY = 24 * 60 * 60 * 1000;
const PASS_RATE = 0.9;
const here = dirname(fileURLToPath(import.meta.url));
const notes = JSON.parse(readFileSync(join(here, "notes.json"), "utf8")) as EvalNote[];
const cases = JSON.parse(readFileSync(join(here, "queries.json"), "utf8")) as EvalCases;
const tags = process.argv.includes("--tags")
  ? (JSON.parse(readFileSync(join(here, "tags.json"), "utf8")) as Record<string, Enrichment>)
  : null;
const verbose = process.argv.includes("--verbose");
const sweep = process.argv.includes("--sweep");

const keys = new Set(notes.map((note) => note.key));
for (const item of [...cases.search, ...cases.alreadySaved]) {
  for (const key of item.expect) if (!keys.has(key)) throw new Error(`Unknown note key "${key}" in queries.json`);
}
for (const key of Object.keys(tags ?? {})) if (!keys.has(key)) throw new Error(`Unknown note key "${key}" in tags.json`);

const dir = mkdtempSync(join(tmpdir(), "recall-eval-"));
const now = Date.UTC(2026, 9, 31, 18);
const db = openDb(join(dir, "recall.db"));
const store = new MemoryStore(db, new PhotoStore(join(dir, "photos")), () => now);
const embedder = new LocalEmbedder({
  cacheDir: resolve(process.env.RECALL_MODEL_DIR ?? "models"),
  allowDownload: true,
  remoteHost: process.env.HF_ENDPOINT,
});
const search = new SearchIndex(db, embedder, () => now);
search.attach(store);

const keyById = new Map<number, string>();
const started = performance.now();
for (const note of notes) {
  const { memory } = await store.create({ body: note.body, createdAt: now - note.daysAgo * DAY });
  if (note.outdated) await store.update(memory.id, { archived: true });
  const enrichment = tags?.[note.key];
  if (enrichment) store.applyEnrichment(memory.id, { body: memory.body, captions: null }, enrichment);
  keyById.set(memory.id, note.key);
}
console.log(
  `Embedded ${notes.length} notes${tags ? " with tags" : ""} in ${Math.round(performance.now() - started)} ms.\n`,
);

const describe = (hit: SearchHit) =>
  `${keyById.get(hit.id)} (${hit.similarity === null ? "no meaning match" : `sim ${hit.similarity.toFixed(2)}`}${
    hit.keywordRank === null ? "" : `, keyword #${hit.keywordRank}`
  })`;
const percent = (value: number) => `${Math.round(value * 100)}%`;

async function evaluate(cutoffs: Cutoffs, print: boolean) {
  let top1 = 0;
  let top3 = 0;
  let totalResults = 0;
  for (const item of cases.search) {
    const hits = await search.search(item.query, { minSimilarity: cutoffs.min, limit: 10 });
    const rank = hits.findIndex((hit) => item.expect.includes(keyById.get(hit.id)!));
    totalResults += hits.length;
    if (rank === 0) top1++;
    if (rank >= 0 && rank < 3) top3++;
    if (print && (verbose || rank !== 0)) {
      const mark = rank === 0 ? "ok  " : rank > 0 && rank < 3 ? `#${rank + 1}  ` : "MISS";
      console.log(`${mark} "${item.query}" -> ${hits.slice(0, 3).map(describe).join(", ") || "nothing"}`);
    }
  }

  let quiet = 0;
  for (const query of cases.unrelated) {
    const hits = await search.search(query, { minSimilarity: cutoffs.min, limit: 10 });
    if (hits.length === 0) quiet++;
    else if (print) console.log(`NOISE "${query}" -> ${hits.slice(0, 3).map(describe).join(", ")}`);
  }

  let saved = 0;
  let extras = 0;
  for (const item of cases.alreadySaved) {
    const hits = await search.search(item.draft, {
      strict: true,
      minSimilarity: cutoffs.related,
      strictSimilarity: cutoffs.strict,
      relatedMargin: cutoffs.margin,
      limit: 5,
    });
    const found = hits.map((hit) => keyById.get(hit.id)!);
    const ok = item.expect.every((key) => found.includes(key));
    const extra = found.filter((key) => !item.expect.includes(key)).length;
    if (ok && extra === 0) saved++;
    extras += extra;
    if (print && (verbose || !ok || extra > 0)) {
      console.log(`${ok ? (extra ? "EXTRA" : "ok   ") : "MISS "} saved? "${item.draft}" -> ${hits.map(describe).join(", ") || "nothing"}`);
    }
  }

  return {
    top1: top1 / cases.search.length,
    top3: top3 / cases.search.length,
    averageResults: totalResults / cases.search.length,
    quiet: quiet / cases.unrelated.length,
    saved: saved / cases.alreadySaved.length,
    extras,
  };
}

async function printSimilarities() {
  const top = async (text: string) => {
    const vector = await embedder.embedQuery(text);
    return search.vectors.nearest(vector, 4, -1).map((hit) => ({ key: keyById.get(hit.id)!, similarity: hit.similarity }));
  };
  const format = (hits: { key: string; similarity: number }[]) =>
    hits.map((hit) => `${hit.key} ${hit.similarity.toFixed(3)}`).join(", ");
  console.log("Raw meaning similarity (query: best notes):");
  for (const item of cases.search) {
    const hits = await top(item.query);
    const target = item.expect.includes(hits[0]!.key) ? "" : "   <-- expected note is not first";
    console.log(`  "${item.query}": ${format(hits)}${target}`);
  }
  for (const query of cases.unrelated) console.log(`  unrelated "${query}": ${format(await top(query))}`);
  for (const item of cases.alreadySaved) console.log(`  draft "${item.draft}": ${format(await top(item.draft))}`);
  console.log("");
}

try {
  if (process.argv.includes("--similarities")) await printSimilarities();
  if (sweep) {
    console.log("min   related margin | top-1 top-3 avg-results unrelated-empty | already-saved exact extras");
    for (const min of [0.5, 0.55, 0.56, 0.57, 0.58, 0.6, 0.65]) {
      for (const [related, margin] of [
        [0.58, 0.06],
        [0.6, 0.04],
        [0.6, 0.06],
        [0.6, 0.08],
        [0.62, 0.06],
      ] as const) {
        const result = await evaluate({ min, related, strict: STRICT_SIMILARITY, margin }, false);
        console.log(
          `${min.toFixed(2)}  ${related.toFixed(2)}    ${margin.toFixed(2)}  | ${percent(result.top1).padStart(5)} ${percent(result.top3).padStart(5)} ${result.averageResults.toFixed(1).padStart(11)} ${percent(result.quiet).padStart(15)} | ${percent(result.saved).padStart(19)} ${String(result.extras).padStart(6)}`,
        );
      }
    }
    console.log("");
  }

  const result = await evaluate(
    { min: MIN_SIMILARITY, related: RELATED_SIMILARITY, strict: STRICT_SIMILARITY, margin: RELATED_MARGIN },
    true,
  );
  console.log(
    `\nCutoffs: meaning ${MIN_SIMILARITY}; already-saved ${RELATED_SIMILARITY} sharing a word, ${STRICT_SIMILARITY} otherwise, within ${RELATED_MARGIN} of the best`,
  );
  console.log(`Search: ${percent(result.top1)} first, ${percent(result.top3)} in top 3 (${cases.search.length} queries)`);
  console.log(`Unrelated queries with no results: ${percent(result.quiet)} (${cases.unrelated.length} queries)`);
  console.log(`"Already saved" exactly right: ${percent(result.saved)} (${cases.alreadySaved.length} drafts, ${result.extras} extra)`);
  if (result.top3 < PASS_RATE) {
    console.error(`\nFAIL: top-3 hit rate is below ${percent(PASS_RATE)}.`);
    process.exitCode = 1;
  }
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
