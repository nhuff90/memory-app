export const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
const DTYPE = "fp32";
/** From the bge-small model card: queries get this prefix, stored passages do not. */
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const BATCH_SIZE = 16;
/** After a failed load (for example, no network to fetch the model), wait this long before trying again. */
const RETRY_AFTER_MS = 5 * 60 * 1000;

export interface Embedder {
  /** Identifies the vectors this embedder makes; stored vectors from any other model get recomputed. */
  readonly model: string;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

type Extractor = (
  texts: string[],
  options: { pooling: "cls"; normalize: boolean },
) => Promise<{ data: ArrayLike<number>; dims: number[] }>;

/** Runs bge-small inside this process, so search needs no outside service. */
export class LocalEmbedder implements Embedder {
  readonly model = `${EMBEDDING_MODEL}@${DTYPE}`;
  private extractor: Promise<Extractor> | null = null;
  private failure: { error: unknown; at: number } | null = null;

  constructor(
    private readonly options: { cacheDir: string; allowDownload: boolean; remoteHost?: string | undefined },
  ) {}

  load(): Promise<Extractor> {
    if (this.failure && Date.now() - this.failure.at < RETRY_AFTER_MS) return Promise.reject(this.failure.error);
    if (!this.extractor) {
      this.extractor = (async () => {
        const { env, pipeline } = await import("@huggingface/transformers");
        env.cacheDir = this.options.cacheDir;
        env.allowRemoteModels = this.options.allowDownload;
        if (this.options.remoteHost) env.remoteHost = this.options.remoteHost.replace(/\/?$/, "/");
        const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: DTYPE });
        return extractor as unknown as Extractor;
      })();
      this.extractor.then(
        () => {
          this.failure = null;
        },
        (error: unknown) => {
          this.extractor = null;
          this.failure = { error, at: Date.now() };
        },
      );
    }
    return this.extractor;
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);
      // BGE is trained on the [CLS] token embedding; mean pooling noticeably hurts retrieval.
      const output = await extractor(batch, { pooling: "cls", normalize: true });
      const width = output.dims.at(-1)!;
      const data = Float32Array.from(output.data);
      for (let row = 0; row < batch.length; row++) vectors.push(data.slice(row * width, (row + 1) * width));
    }
    return vectors;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.embedDocuments([QUERY_PREFIX + text]);
    return vector!;
  }
}
