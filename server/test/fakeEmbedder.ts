import type { Embedder } from "../src/embed.js";

const DIMENSIONS = 2048;
/** Shared by every instance so vectors from different embedders line up. */
const vocabulary = new Map<string, number>();
const SYNONYMS: Record<string, string> = {
  tablet: "ipad",
  torch: "flashlight",
  xmas: "christmas",
  holiday: "christmas",
  decorations: "christmas",
  boss: "manager",
  children: "kids",
  loft: "attic",
};
const IGNORED = new Set(["where", "is", "my", "the", "a", "in", "of", "did", "i", "put", "what", "are", "s"]);

function dimension(word: string): number {
  let index = vocabulary.get(word);
  if (index === undefined) {
    index = vocabulary.size % DIMENSIONS;
    vocabulary.set(word, index);
  }
  return index;
}

/**
 * A deterministic stand-in for the real model: each word (after a small synonym table) gets its own
 * dimension, so "tablet" lands on "ipad" and notes sharing no words score zero.
 */
export class FakeEmbedder implements Embedder {
  readonly model = "fake-embedder";
  documentCalls = 0;
  failQueries = false;

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    this.documentCalls += texts.length;
    return texts.map((text) => this.vector(text));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    if (this.failQueries) throw new Error("model unavailable");
    return this.vector(text);
  }

  private vector(text: string): Float32Array {
    const vector = new Float32Array(DIMENSIONS);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (IGNORED.has(word)) continue;
      vector[dimension(SYNONYMS[word] ?? word)]! += 1;
    }
    const length = Math.hypot(...vector);
    if (length > 0) for (let i = 0; i < DIMENSIONS; i++) vector[i]! /= length;
    return vector;
  }
}
