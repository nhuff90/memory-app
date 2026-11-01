import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../src/app.js";
import type { AppEnv } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { openDb, type DB } from "../src/db.js";
import { MemoryStore } from "../src/memories.js";
import { hashPasswordSync } from "../src/password.js";
import { PhotoStore } from "../src/photos.js";
import { SearchIndex } from "../src/search.js";
import { FakeEmbedder } from "./fakeEmbedder.js";

export const TEST_PASSWORD = "correct horse battery staple";
const TEST_PASSWORD_HASH = hashPasswordSync(TEST_PASSWORD);
export const START_TIME = Date.UTC(2026, 9, 31, 18, 0, 0);
export const DAY = 24 * 60 * 60 * 1000;

export function testConfig(dir: string, overrides: Partial<Config> = {}): Config {
  return {
    production: false,
    port: 0,
    dataDir: dir,
    modelDir: join(dir, "models"),
    webDist: join(dir, "web"),
    passwordHash: TEST_PASSWORD_HASH,
    usingDevPassword: false,
    sessionSecret: "test-session-secret-that-is-long-enough-123",
    anthropicApiKey: null,
    model: "claude-haiku-5-5",
    timeZone: "America/New_York",
    ...overrides,
  };
}

export interface TestContext {
  dir: string;
  config: Config;
  db: DB;
  photos: PhotoStore;
  store: MemoryStore;
  embedder: FakeEmbedder;
  search: SearchIndex;
  app: Hono<AppEnv>;
  clock: { now: number };
  cleanup: () => void;
}

export function makeContext(
  options: { config?: Partial<Config>; app?: Partial<AppDeps>; setup?: (ctx: Omit<TestContext, "app">) => Partial<AppDeps> } = {},
): TestContext {
  const dir = mkdtempSync(join(tmpdir(), "recall-test-"));
  const clock = { now: START_TIME };
  const now = () => clock.now;
  const config = testConfig(dir, options.config);
  const db = openDb(join(dir, "recall.db"));
  const photos = new PhotoStore(join(dir, "photos"));
  const store = new MemoryStore(db, photos, now, () => {});
  const embedder = new FakeEmbedder();
  const search = new SearchIndex(db, embedder, now, () => {});
  search.attach(store);
  const base = { dir, config, db, photos, store, embedder, search, clock, cleanup: () => {} };
  const extra = options.setup?.(base) ?? {};
  const app = createApp({ config, store, search, now, log: () => {}, accessLog: () => {}, ...extra, ...options.app });
  return {
    ...base,
    app,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function login(app: Hono<AppEnv>, password = TEST_PASSWORD): Promise<string> {
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.status !== 200) throw new Error(`Login failed with ${res.status}`);
  return sessionCookie(res);
}

export function sessionCookie(res: Response): string {
  const header = res.headers.get("set-cookie");
  if (!header) throw new Error("No Set-Cookie header");
  return header.split(";")[0]!;
}

export function fakeJpeg(label = "photo", size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  bytes.set(new TextEncoder().encode(label).slice(0, size - 4), 4);
  return bytes;
}

export function memoryForm(fields: { body?: string; clientId?: string; createdAt?: number; photos?: number }): FormData {
  const form = new FormData();
  if (fields.body !== undefined) form.set("body", fields.body);
  if (fields.clientId !== undefined) form.set("clientId", fields.clientId);
  if (fields.createdAt !== undefined) form.set("createdAt", String(fields.createdAt));
  for (let index = 0; index < (fields.photos ?? 0); index++) {
    form.append("photos", new File([fakeJpeg(`full-${index}`)], `photo-${index}.jpg`, { type: "image/jpeg" }));
    form.append("thumbs", new File([fakeJpeg(`thumb-${index}`)], `thumb-${index}.jpg`, { type: "image/jpeg" }));
  }
  return form;
}

/** A tiny client that sends the session cookie with every request. */
export function client(app: Hono<AppEnv>, cookie: string) {
  const send = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { cookie, ...(init.headers as Record<string, string> | undefined) } });
  return {
    get: (path: string) => send(path),
    postJson: (path: string, body: unknown) =>
      send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    postForm: (path: string, form: FormData) => send(path, { method: "POST", body: form }),
    patch: (path: string, body: unknown) =>
      send(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    delete: (path: string) => send(path, { method: "DELETE" }),
    send,
  };
}
