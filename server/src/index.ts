import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { AnthropicLlm, UsageLog } from "./ai.js";
import { createApp } from "./app.js";
import { DEV_PASSWORD, loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { LocalEmbedder } from "./embed.js";
import { Enricher } from "./enrich.js";
import { MemoryStore } from "./memories.js";
import { PhotoStore } from "./photos.js";
import { SearchIndex } from "./search.js";
import { SettingsStore } from "./settings.js";
import { TokenStore } from "./tokens.js";

if (process.env.NODE_ENV !== "production") {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env file: defaults apply.
  }
}

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const db = openDb(join(config.dataDir, "recall.db"));
const photos = new PhotoStore(join(config.dataDir, "photos"));
const store = new MemoryStore(db, photos);
const settings = new SettingsStore(db);
const tokens = new TokenStore(db);
const embedder = new LocalEmbedder({
  cacheDir: config.modelDir,
  allowDownload: true,
  remoteHost: process.env.HF_ENDPOINT,
});
const search = new SearchIndex(db, embedder);
search.attach(store);
const llm = config.anthropicApiKey ? new AnthropicLlm(config.anthropicApiKey, config.model) : null;
const usage = new UsageLog(db);
const enricher = llm
  ? new Enricher({
      store,
      llm,
      usage,
      captionsEnabled: () => settings.photoCaptions(),
      readSavedPhotoText: () => settings.readSavedPhotoText(),
    })
  : null;
enricher?.attach();
enricher?.start();

const app = createApp({ config, store, search, llm, usage, enricher, settings, tokens });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Recall is listening on http://localhost:${info.port}`);
  if (config.usingDevPassword) console.log(`Dev mode: the password is "${DEV_PASSWORD}".`);
  if (!llm) console.log("No ANTHROPIC_API_KEY: Ask and auto-tagging are off. Everything else works.");
});

search
  .init()
  .then((embedded) => {
    if (embedded > 0) console.log(`Indexed ${embedded} memories for meaning search.`);
  })
  .catch((error: unknown) => console.error("Meaning search could not start; keyword search still works.", error));

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down.`);
  enricher?.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
