import { resolve } from "node:path";
import { LocalEmbedder } from "../src/embed.js";

const cacheDir = resolve(process.env.RECALL_MODEL_DIR ?? "models");
const embedder = new LocalEmbedder({ cacheDir, allowDownload: true, remoteHost: process.env.HF_ENDPOINT });
const [vector] = await embedder.embedDocuments(["ipad in gym"]);
console.log(`Embedding model ready in ${cacheDir} (${vector?.length ?? 0} numbers per note).`);
