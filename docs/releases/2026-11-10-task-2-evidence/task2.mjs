// Task 2 local rollout rehearsal helper, run from the repository root with the cached Playwright/Chromium.
//   node docs/releases/2026-11-10-task-2-evidence/task2.mjs <mode> [args]
// Modes, in rehearsal order:
//   preflight                 check plan hash, tools, port and roots; create temp/retained roots, fixture secrets,
//                             and verbatim extracts of the rollout document's two here-string scripts
//   seed                      old app: log in, add notes/photos through the UI, a Siri key and a Siri capture
//   baseline                  old app after fixture-enrich.mjs: record the v3 baseline and text/tag/caption search
//   http-down <label>         prove nothing answers HTTP on the task origin
//   archive <label> <sha256> <archive> <dir>   compare a copied-out archive hash, then extract it under the retained root
//   inspect <label> <dir>     read-only local inspection of an extracted database/photos set
//   migrate-time <dir>        time migration 004 alone on a scratch copy of the verified v3 database
//   candidate                 candidate app: cached old client, real update banner Reload, checks, pins and keywords
//   restored                  restored old app: fresh login, searches, photos, restored data and Siri key
//   cached-client [label]     same preserved profile; capture partial failures, then the real banner Reload
//   prepare-replay            verify retained hashes; copy quarantined v4 to a new task-owned scratch directory
//   verify-replay-scratch     validate the existing stopped replay scratch data before reuse; never recopy it
//   replay-client             warm a NEW profile from the real candidate; hold it open across the parent server switch
//   verify-replay-retention   recheck retained v3/v4 bytes before any disposable-resource cleanup
//   cleanup-temp              remove the validated Task 2 temp root (fixture secrets, env file, browser profile)
// Fictional data only. Passwords, session secrets and Siri key values are kept in the temp root and never printed.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, createServer } from "node:net";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync, gunzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const PREFIX = "recall-task2-20261110-6c4a91f2";
const TEMP = resolve("C:/Users/Nate/AppData/Local/Temp", PREFIX);
const RETAINED = resolve("C:/Users/Nate/.codex/visualizations/2026/11/05/01a1ac1a-f315-7de0-a1ed-cb6517f1fc06", `task2-20261110-6c4a91f2-retained`);
const PROFILE = join(TEMP, "browser-profile");
const REPLAY_PROFILE = join(TEMP, "browser-profile-replay-3");
const REPLAY_LABEL = "10-browser-replay-3";
const REPLAY_DATA = join(TEMP, "browser-replay-v4-1");
const ENV_FILE = join(TEMP, "runtime.env");
const SECRETS = join(TEMP, "fixture-secrets.json");
const PLAYWRIGHT = "C:/Users/Nate/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const CHROME = "C:/Users/Nate/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const PORT = 18766;
const ORIGIN = `http://localhost:${PORT}`;
const PLAN = join(repo, ".cursor/plans/recall_release_path_904186b3.plan.md");
const PLAN_SHA256 = "400795a7f4865d9f6516c1a1dacaeb3eb6dd4d3f56d6527a58d5a4c31df8af88";
const DOC = join(repo, "docs/pinned-keywords-related-rollout.md");
const EXTRACTED = join(here, "extracted");
const OBSERVATIONS = join(here, "observations");
const SCREENSHOTS = join(here, "screenshots");
const TABLES = ["memories", "photos", "embeddings", "api_tokens", "settings", "ai_usage"];

const NOTES = {
  heartworm: "Biscuit the beagle takes a heartworm tablet on the first of every month.",
  shed: "Spare key for the Larkspur Lane shed hangs behind the garden calendar.",
  oat: "Marisol prefers oat milk in her afternoon cortado.",
  recital: "Tessaly's cello recital is at Orchard Hall on Thursday evening.",
};
const EDITED_OAT = "Marisol prefers oat milk in her afternoon cortado, with no sugar.";
const KEYWORD = "Quillon";
const MEANING = "when does my dog get his medicine";
const SEARCHES = [
  { kind: "text", query: "heartworm", note: "heartworm" },
  { kind: "tag", query: "beverages", note: "oat" },
  { kind: "caption", query: "teal", note: "shed" },
];

const mode = process.argv[2];
const args = process.argv.slice(3);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function writeObservation(name, data) {
  mkdirSync(OBSERVATIONS, { recursive: true });
  const path = join(OBSERVATIONS, `${name}.json`);
  assert(!existsSync(path), `${path} already exists; observations are never overwritten`);
  writeFileSync(path, json(data));
  return path;
}
const readObservation = (name) => JSON.parse(readFileSync(join(OBSERVATIONS, `${name}.json`), "utf8"));
const inside = (root, path) => resolve(path).startsWith(resolve(root) + sep);

// ---------- fixtures ----------

/** A 16x16 fictional test card as a PNG; `variant` changes the colors so each photo hashes differently. */
function tinyPng(variant) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0);
  header.writeUInt32BE(16, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < 16; y++) {
    rows.push(0);
    for (let x = 0; x < 16; x++) rows.push(variant ? 200 : x * 16, y * 16, variant ? x * 16 : 128);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- archives ----------

/** Extracts a gzip'd tar of plain files and directories (GNU or ustar headers); refuses anything else. */
function extractTgz(archive, dest) {
  const data = gunzipSync(readFileSync(archive));
  const files = [];
  let offset = 0;
  let longName = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (from, to) => header.subarray(from, to).toString("utf8").replace(/\0[\s\S]*$/, "");
    const size = parseInt(text(124, 136).trim() || "0", 8);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const ustar = header.subarray(257, 263).toString("latin1") === "ustar\0";
    const name = longName ?? (ustar && text(345, 500) ? `${text(345, 500)}/${text(0, 100)}` : text(0, 100));
    longName = null;
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0[\s\S]*$/, "");
      continue;
    }
    const relative = name.replace(/^\.\//, "").replace(/\/$/, "");
    if (!relative || relative === ".") continue;
    const target = resolve(dest, relative);
    assert(inside(dest, target), `Archive entry escapes the destination: ${name}`);
    if (type === "5") mkdirSync(target, { recursive: true });
    else if (type === "0") {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body, { flag: "wx" });
      files.push({ path: relative, bytes: size, sha256: sha256(body) });
    } else throw Error(`Unsupported archive entry type ${type} for ${name}`);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Read-only inspection of an extracted recall.db and photos folder with the repository's SQLite dependency. */
function inspectSet(dir) {
  const Database = createRequire(join(repo, "package.json"))("better-sqlite3");
  const listing = readdirSync(dir).sort();
  // Every file's hash, taken before SQLite opens anything in this directory.
  const fileHashes = readdirSync(dir, { recursive: true }).map((entry) => String(entry)).sort()
    .filter((entry) => lstatSync(join(dir, entry)).isFile())
    .map((entry) => ({ path: entry.replaceAll("\\", "/"), bytes: lstatSync(join(dir, entry)).size, sha256: sha256(readFileSync(join(dir, entry))) }));
  const db = new Database(join(dir, "recall.db"), { readonly: true, fileMustExist: true });
  const columns = db.prepare("SELECT name FROM pragma_table_info('memories')").all().map((row) => row.name);
  const extra = columns.includes("pinned") ? ", pinned, custom_keywords" : "";
  const photos = join(dir, "photos");
  const result = {
    dir, listing, fileHashes,
    version: db.pragma("user_version", { simple: true }),
    integrity: db.pragma("integrity_check", { simple: true }),
    counts: Object.fromEntries(TABLES.map((table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n])),
    memories: db.prepare(`SELECT id, body, tags, captions${extra} FROM memories ORDER BY id`).all(),
    indexes: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all().map((row) => row.name),
    photos: db.prepare("SELECT id, file, thumb FROM photos ORDER BY id").all().map((row) => {
      const hash = (file) => {
        const path = resolve(photos, file);
        assert(inside(photos, path));
        return sha256(readFileSync(path));
      };
      return { id: row.id, file: row.file, full: hash(row.file), thumb: row.thumb, thumbSha256: hash(row.thumb) };
    }),
    embeddings: db.prepare("SELECT memory_id, model, vector FROM embeddings ORDER BY memory_id").all()
      .map((row) => ({ memoryId: row.memory_id, model: row.model, vectorSha256: sha256(row.vector) })),
  };
  db.close();
  return result;
}

// ---------- HTTP and browser ----------

async function waitHealthy(seconds) {
  const started = Date.now();
  for (;;) {
    const ok = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (ok) return { firstHealthyAt: new Date().toISOString(), pollStartedAt: new Date(started).toISOString(), waitedMs: Date.now() - started };
    assert(Date.now() - started < seconds * 1000, `${ORIGIN} never became healthy`);
    await sleep(250);
  }
}

/** What the server itself is serving right now, fetched outside any browser or service worker. */
async function serverIdentity() {
  const index = await (await fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(5000) })).text();
  const sw = Buffer.from(await (await fetch(`${ORIGIN}/sw.js`, { signal: AbortSignal.timeout(5000) })).arrayBuffer());
  return { indexAsset: index.match(/\/assets\/index-[\w-]+\.js/)?.[0] ?? null, swSha256: sha256(sw) };
}

const clientIdentity = (page) =>
  within(15_000, "Client worker/cache identity", () => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const cacheList = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      const urls = (await cache.keys()).map((request) => new URL(request.url));
      const assetHashes = [];
      for (const url of urls.filter((url) => url.pathname === "/index.html" || /^\/assets\/index-.*\.js$/.test(url.pathname))) {
        const response = await cache.match(url.href);
        if (response) {
          const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
          assetHashes.push({ path: url.pathname + url.search, sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("") });
        }
      }
      cacheList.push({
        name,
        entries: urls.length,
        indexHtml: urls.filter((url) => url.pathname === "/index.html").map((url) => url.pathname + url.search),
        indexScripts: urls.filter((url) => /^\/assets\/index-.*\.js$/.test(url.pathname)).map((url) => url.pathname),
        assetHashes,
      });
    }
    return {
      documentScript: document.querySelector('script[type="module"][src]')?.getAttribute("src") ?? null,
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      active: registration?.active?.scriptURL ?? null,
      waiting: registration?.waiting?.scriptURL ?? null,
      installing: registration?.installing?.scriptURL ?? null,
      scope: registration?.scope ?? null,
      workerStates: { controller: navigator.serviceWorker.controller?.state ?? null, active: registration?.active?.state ?? null, waiting: registration?.waiting?.state ?? null },
      caches: cacheList,
    };
  }));

async function playwright() {
  return (await import(pathToFileURL(PLAYWRIGHT).href)).chromium;
}
const DEVICE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };

/** The persistent profile keeps the real service worker, its caches and the session cookie between modes. */
async function persistentContext(profile = PROFILE) {
  const chromium = await playwright();
  return chromium.launchPersistentContext(profile, { executablePath: CHROME, headless: true, timeout: 60_000, serviceWorkers: "allow", ...DEVICE });
}

// page.evaluate has no Playwright timeout. Bound worker/cache inspection and update promises too.
async function within(ms, description, action) {
  let timer;
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${description} timed out after ${ms} ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function watch(page, log) {
  page.on("pageerror", (error) => {
    log.pageErrors.push(error.message);
    (log.pageErrorDetails ??= []).push({ message: error.message, stack: error.stack });
  });
  page.on("dialog", (dialog) => {
    log.dialogs.push(dialog.message());
    void dialog.accept();
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === ORIGIN && (url.pathname === "/" || url.pathname === "/sw.js" || url.pathname.startsWith("/assets/"))) {
      (log.assetResponses ??= []).push({ path: url.pathname, status: response.status(), fromServiceWorker: response.fromServiceWorker() });
    }
    if (url.origin === ORIGIN && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/photos/")) {
      log.api.push({ method: response.request().method(), path: url.pathname + url.search, status: response.status(), fromServiceWorker: response.fromServiceWorker() });
    }
  });
  return page;
}
const newLog = () => ({ pageErrors: [], dialogs: [], api: [] });

function ui(page) {
  const recall = page.locator("main > div:not([hidden])");
  const dialog = () => page.getByRole("dialog", { name: "Memory", exact: true });
  const card = (note) => recall.getByRole("button").filter({ hasText: NOTES[note] });
  return {
    recall, dialog, card,
    tab: (name) => page.getByRole("tab", { name, exact: true }).click(),
    filter: (name) => page.getByRole("group", { name: "Show only" }).getByRole("button", { name, exact: true }),
    query: () => page.getByRole("searchbox"),
    banner: () => page.getByText("A new version of Recall is ready.", { exact: true }),
    async shown() {
      const visible = [];
      for (const note of Object.keys(NOTES)) if (await card(note).count()) visible.push(note);
      return visible;
    },
    async open(note) {
      await card(note).first().click();
      await dialog().locator("#memory-body").waitFor();
    },
    async close() {
      await dialog().getByRole("button", { name: "Close", exact: true }).click();
      await dialog().waitFor({ state: "hidden" });
    },
  };
}

async function loginIfNeeded(page, password) {
  await page.locator('input[type="password"], [role="tab"]').first().waitFor({ timeout: 60_000 });
  if (await page.locator('input[type="password"]').count()) {
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await page.getByRole("tab", { name: "Recall", exact: true }).waitFor();
    return "logged in with the fixture password";
  }
  return "already signed in by the profile's session cookie";
}

const shot = (page, name) => page.screenshot({ path: join(SCREENSHOTS, `${name}.png`), fullPage: true });
const scriptIs = (page, asset) =>
  page.waitForFunction((expected) => document.querySelector('script[type="module"][src]')?.getAttribute("src") === expected, asset, { timeout: 90_000 });

/** UI search plus the same query through the API, so each match is attributable. */
async function searchCheck(page, request, { kind, query, note }) {
  const u = ui(page);
  await u.tab("Recall");
  await u.query().fill(query);
  await page.getByRole("heading", { name: "Results", exact: true }).waitFor();
  await u.card(note).first().waitFor({ timeout: 60_000 });
  const shown = await u.shown();
  await u.query().fill("");
  const response = await request.get(`${ORIGIN}/api/search?q=${encodeURIComponent(query)}`);
  assert(response.ok(), `search ${query} returned ${response.status()}`);
  const api = (await response.json()).results.map((memory) => memory.body);
  assert(api.includes(NOTES[note]));
  return { kind, query, expected: note, uiShown: shown, apiResults: api };
}

async function photoCheck(page, request, note) {
  const u = ui(page);
  await u.tab("Recall");
  await u.open(note);
  const image = u.dialog().locator('img[src*="/api/photos/"]').first();
  await image.waitFor();
  await page.waitForFunction((element) => element.complete && element.naturalWidth > 0, await image.elementHandle());
  const src = await image.getAttribute("src");
  await u.close();
  return { note, renderedSrc: src, rendered: true };
}

async function apiState(request) {
  const get = async (path) => {
    const response = await request.get(`${ORIGIN}${path}`);
    assert(response.ok(), `${path} returned ${response.status()}`);
    return response.json();
  };
  const memories = (await get("/api/memories?limit=100")).memories;
  const photoHashes = {};
  for (const photo of memories.flatMap((memory) => memory.photos)) {
    for (const size of ["full", "thumb"]) {
      const response = await request.get(`${ORIGIN}/api/photos/${photo.id}?size=${size}`);
      assert(response.ok());
      photoHashes[`${photo.id}:${size}`] = sha256(await response.body());
    }
  }
  return {
    memories: memories
      .map(({ id, body, tags, category, pinned, customKeywords, createdAt, updatedAt, photos }) =>
        ({ id, body, tags, category, pinned, customKeywords, createdAt, updatedAt, photos: photos.map((photo) => ({ id: photo.id, caption: photo.caption })) }))
      .sort((a, b) => a.id - b.id),
    photoHashes,
    tokens: (await get("/api/tokens")).tokens.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
    me: await get("/api/me"),
  };
}

/** Authenticates the fictional Siri key without saving anything: an empty capture is refused after authentication. */
async function sirikeyCheck(token) {
  const response = await fetch(`${ORIGIN}/api/capture`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "" }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, error: body.error ?? null, meaning: response.status === 400 ? "key accepted; empty capture refused, nothing saved" : "key not accepted" };
}

const secrets = () => JSON.parse(readFileSync(SECRETS, "utf8"));

// ---------- modes ----------

async function preflight() {
  const result = { at: new Date().toISOString(), node: process.version, checks: {} };
  result.checks.planSha256 = sha256(readFileSync(PLAN));
  assert.equal(result.checks.planSha256, PLAN_SHA256);
  for (const path of [PLAYWRIGHT, CHROME]) assert(existsSync(path), `${path} is missing`);
  result.checks.playwrightPackage = JSON.parse(readFileSync(join(dirname(PLAYWRIGHT), "package.json"), "utf8")).version;
  for (const root of [TEMP, RETAINED]) assert(!existsSync(root), `${root} already exists`);
  await new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(PORT, "127.0.0.1", () => server.close(done));
  });
  result.checks.ipv6Loopback = await new Promise((done) => {
    const socket = connect({ host: "::1", port: PORT });
    socket.once("connect", () => { socket.destroy(); done("something answers on [::1]"); });
    socket.once("error", (error) => done(error.code));
  });
  assert.notEqual(result.checks.ipv6Loopback, "something answers on [::1]");
  result.checks.port = `${PORT} free on 127.0.0.1`;
  const chromium = await playwright();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  result.checks.browser = `chromium ${browser.version()}`;
  await browser.close();

  // Verbatim extracts of the document's here-strings (the backup helper and the local verifier).
  const lines = readFileSync(DOC, "utf8").split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "@'") continue;
    const end = lines.findIndex((line, j) => j > i && line.startsWith("'@"));
    blocks.push({ start: i + 2, end, closing: lines[end], text: `${lines.slice(i + 1, end).join("\n")}\n` });
  }
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].closing, "'@ | Set-Content -Encoding utf8 -LiteralPath $backupScript");
  assert.equal(blocks[1].closing, "'@ | node --input-type=module - $verified");
  mkdirSync(EXTRACTED, { recursive: true });
  result.extracted = [];
  for (const [block, name] of [[blocks[0], "recall-backup.mjs"], [blocks[1], "local-verify.mjs"]]) {
    const path = join(EXTRACTED, name);
    assert(!existsSync(path), `${path} already exists`);
    writeFileSync(path, block.text);
    result.extracted.push({ file: `extracted/${name}`, docLines: `${block.start}-${block.end}`, sha256: sha256(block.text) });
  }
  result.rolloutDocSha256 = sha256(readFileSync(DOC));
  result.helpers = Object.fromEntries(["task2.mjs", "probe.mjs", "fixture-enrich.mjs", "quarantine-install.sh"]
    .map((name) => [name, sha256(readFileSync(join(here, name)))]));

  mkdirSync(PROFILE, { recursive: true });
  mkdirSync(RETAINED, { recursive: true });
  const { hashPasswordSync } = await import(pathToFileURL(join(repo, "dist/server/src/password.js")).href);
  const password = randomBytes(18).toString("hex");
  writeFileSync(ENV_FILE, [
    `RECALL_PASSWORD_HASH=${hashPasswordSync(password)}`,
    `RECALL_SESSION_SECRET=${randomBytes(32).toString("hex")}`,
    "HF_ENDPOINT=http://127.0.0.1:9",
    "",
  ].join("\n"));
  writeFileSync(SECRETS, json({ password }));
  result.created = { temp: TEMP, profile: PROFILE, retained: RETAINED, envFileVariableNames: ["RECALL_PASSWORD_HASH", "RECALL_SESSION_SECRET", "HF_ENDPOINT"] };
  writeObservation("01-preflight", result);
  console.log(json(result));
}

async function seed() {
  const { password } = secrets();
  const health = await waitHealthy(180);
  const server = await serverIdentity();
  const context = await persistentContext();
  const log = newLog();
  try {
    const page = watch(context.pages()[0] ?? (await context.newPage()), log);
    const u = ui(page);
    await page.goto(ORIGIN);
    const signIn = await loginIfNeeded(page, password);
    await u.tab("Remember");
    const create = async (text, variant) => {
      const form = u.recall.locator("form");
      await page.locator("#remember-input").fill(text);
      if (variant !== null) {
        await form.locator('input[type="file"]').setInputFiles({ name: `fictional-card-${variant}.png`, mimeType: "image/png", buffer: tinyPng(variant) });
        await form.getByRole("button", { name: "Remove photo" }).waitFor();
      }
      await form.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByText("Saved.", { exact: true }).waitFor({ timeout: 120_000 });
      await page.locator("#remember-input").and(page.locator(":not(:disabled)")).waitFor();
    };
    await create(NOTES.heartworm, 0);
    await create(NOTES.shed, 1);
    await create(NOTES.oat, null);

    const created = await context.request.post(`${ORIGIN}/api/tokens`, { data: { name: "Task 2 fictional Siri key", timeZone: "America/New_York" } });
    assert.equal(created.status(), 201);
    const key = await created.json();
    writeFileSync(SECRETS, json({ password, sirikey: key.token }));
    const capture = await fetch(`${ORIGIN}/api/capture`, {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: NOTES.recital }),
    });
    assert.equal(capture.status, 201);

    // Each save awaits its embedding; meaning search confirms the real baked model indexed them.
    let meaning = [];
    for (let attempt = 0; attempt < 60 && !meaning.includes(NOTES.heartworm); attempt++) {
      if (attempt) await sleep(1000);
      const response = await context.request.get(`${ORIGIN}/api/search?q=${encodeURIComponent(MEANING)}`);
      meaning = (await response.json()).results.map((memory) => memory.body);
    }
    assert(meaning.includes(NOTES.heartworm), "Meaning search never found the heartworm note");

    // The first visit installs the old app's worker; a navigation lets it control the page.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) await page.reload();
    await page.getByRole("tab", { name: "Recall", exact: true }).waitFor();
    const client = await clientIdentity(page);
    assert(client.controller, "The old app's service worker does not control the page");
    await u.tab("Recall");
    await u.card("recital").first().waitFor();
    mkdirSync(SCREENSHOTS, { recursive: true });
    await shot(page, "seed-old-app");
    const state = await apiState(context.request);
    const result = {
      at: new Date().toISOString(), origin: ORIGIN, userAgent: await page.evaluate(() => navigator.userAgent), health, server, client, signIn,
      created: ["heartworm (photo variant 0)", "shed (photo variant 1)", "oat (no photo)", "recital (Siri key capture)"],
      sirikey: { id: key.id, name: key.name, captureStatus: capture.status },
      meaningSearch: { query: MEANING, results: meaning },
      state, log,
    };
    writeObservation("02-seed", result);
    console.log(json({ ...result, state: { memories: state.memories.length, photoHashes: state.photoHashes, tokens: state.tokens } }));
  } finally {
    await context.close();
  }
}

/** After the fictional tags/caption fixture: the v3 baseline every later state is compared against. */
async function baseline() {
  const { password } = secrets();
  const seedState = readObservation("02-seed");
  const health = await waitHealthy(180);
  const server = await serverIdentity();
  const context = await persistentContext();
  const log = newLog();
  try {
    const page = watch(context.pages()[0] ?? (await context.newPage()), log);
    await page.goto(ORIGIN);
    const signIn = await loginIfNeeded(page, password);
    const client = await clientIdentity(page);
    const searches = [];
    for (const search of SEARCHES) searches.push(await searchCheck(page, context.request, search));
    const photos = [await photoCheck(page, context.request, "heartworm"), await photoCheck(page, context.request, "shed")];
    await shot(page, "baseline-old-app-v3");
    const state = await apiState(context.request);
    const result = {
      at: new Date().toISOString(), health, server, client, signIn,
      sameServerAsSeed: server.indexAsset === seedState.server.indexAsset,
      bodiesMatchSeed: JSON.stringify(state.memories.map(({ id, body, createdAt }) => [id, body, createdAt]))
        === JSON.stringify(seedState.state.memories.map(({ id, body, createdAt }) => [id, body, createdAt])),
      photoHashesMatchSeed: JSON.stringify(state.photoHashes) === JSON.stringify(seedState.state.photoHashes),
      searches, photos, state, log,
    };
    writeObservation("03-baseline", result);
    console.log(json({ ...result, state: { memories: state.memories, photoHashes: state.photoHashes, tokens: state.tokens } }));
    assert(result.sameServerAsSeed && result.bodiesMatchSeed && result.photoHashesMatchSeed);
    assert.deepEqual(log.pageErrors, []);
  } finally {
    await context.close();
  }
}

async function httpDown(label) {
  const attempts = [];
  for (const url of [`${ORIGIN}/api/health`, `http://127.0.0.1:${PORT}/api/health`]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      attempts.push({ url, status: response.status });
    } catch (error) {
      attempts.push({ url, error: error.cause?.code ?? error.name });
    }
  }
  const result = { at: new Date().toISOString(), label, attempts, unavailable: attempts.every((attempt) => attempt.error) };
  writeObservation(`http-down-${label}`, result);
  console.log(json(result));
  assert(result.unavailable, "Something still answers HTTP on the task origin");
}

function archive(label, expected, archivePath, dir) {
  assert(/^[0-9a-f]{64}$/.test(expected));
  assert(inside(RETAINED, archivePath) && inside(RETAINED, dir), "Archive and extraction must stay under the retained root");
  assert(!existsSync(dir), `${dir} already exists`);
  const local = sha256(readFileSync(archivePath));
  const result = { at: new Date().toISOString(), label, archive: archivePath, bytes: lstatSync(archivePath).size, containerSha256: expected, localSha256: local, match: local === expected };
  assert(result.match, "Archive hash differs from the container's sha256sum");
  mkdirSync(dir);
  result.extractedTo = dir;
  result.files = extractTgz(archivePath, dir);
  writeFileSync(`${archivePath}.sha256.json`, json(result));
  writeObservation(`archive-${label}`, result);
  console.log(json(result));
}

function inspect(label, dir) {
  assert(inside(RETAINED, dir));
  const result = { at: new Date().toISOString(), label, ...inspectSet(dir) };
  writeFileSync(join(RETAINED, `${label}.inspect.json`), json(result));
  writeObservation(`inspect-${label}`, result);
  console.log(json(result));
}

async function migrateTime(dir) {
  assert(inside(RETAINED, dir));
  const scratch = join(TEMP, "migrate-timing");
  mkdirSync(scratch);
  copyFileSync(join(dir, "recall.db"), join(scratch, "recall.db"));
  const Database = createRequire(join(repo, "package.json"))("better-sqlite3");
  const { migrate } = await import(pathToFileURL(join(repo, "dist/server/src/db.js")).href);
  const db = new Database(join(scratch, "recall.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const before = db.pragma("user_version", { simple: true });
  const started = process.hrtime.bigint();
  migrate(db);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const result = {
    at: new Date().toISOString(), node: process.version, scope: "migrate() alone (migration 004 SQL incl. FTS rebuild) on a scratch copy of the verified v3 database, on this Windows host; excludes process start, model load and listen",
    before, after: db.pragma("user_version", { simple: true }), elapsedMs, integrity: db.pragma("integrity_check", { simple: true }),
    memories: db.prepare("SELECT count(*) AS n FROM memories").get().n,
    migration004Sha256: sha256(readFileSync(join(repo, "dist/server/src/migrations/004_pinned_keywords.js"))),
  };
  db.close();
  writeObservation("migrate-time", result);
  console.log(json(result));
}

async function candidate() {
  const { password, sirikey } = secrets();
  const seedState = readObservation("03-baseline");
  const health = await waitHealthy(300);
  const server = await serverIdentity();
  const context = await persistentContext();
  const log = newLog();
  try {
    const page = watch(context.pages()[0] ?? (await context.newPage()), log);
    const u = ui(page);
    await page.goto(ORIGIN);
    await page.locator('input[type="password"], [role="tab"]').first().waitFor({ timeout: 60_000 });
    const beforeReload = await clientIdentity(page);
    await u.banner().waitFor({ timeout: 120_000 });
    const withBanner = await clientIdentity(page);
    await shot(page, "candidate-1-update-banner-on-cached-old-app");
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await scriptIs(page, server.indexAsset);
    const signIn = await loginIfNeeded(page, password);
    const afterReload = await clientIdentity(page);
    assert.equal(await u.filter("Pinned").count(), 1, "The candidate's Pinned filter is missing after Reload");
    await shot(page, "candidate-2-after-reload");

    const searches = [];
    for (const search of SEARCHES) searches.push(await searchCheck(page, context.request, search));
    const photos = [await photoCheck(page, context.request, "heartworm"), await photoCheck(page, context.request, "shed")];

    // Post-backup v4 changes: pins and a custom keyword (expected to be lost by a v3 restore).
    const pin = async (note) => {
      await u.open(note);
      await u.dialog().getByRole("button", { name: "Pin", exact: true }).click();
      await u.dialog().getByRole("button", { name: "Unpin", exact: true }).waitFor();
      await u.close();
    };
    await u.tab("Recall");
    await pin("heartworm");
    await pin("recital");
    await u.open("shed");
    await u.dialog().getByLabel("Custom keywords", { exact: true }).fill(KEYWORD);
    await u.dialog().getByRole("button", { name: "Save changes", exact: true }).click();
    await u.dialog().getByRole("button", { name: /^(Save changes|Saving…)$/ }).waitFor({ state: "hidden" });
    await u.close();
    await u.filter("Pinned").click();
    await page.getByRole("heading", { name: "Pinned", exact: true }).waitFor();
    await u.card("heartworm").first().waitFor();
    const pinnedShown = await u.shown();
    await shot(page, "candidate-3-pinned-filter");
    await u.filter("All").click();
    const keyword = await searchCheck(page, context.request, { kind: "custom keyword", query: KEYWORD, note: "shed" });
    const state = await apiState(context.request);
    const key = await sirikeyCheck(sirikey);

    // Fields both versions return must equal the v3 baseline, apart from the edits made above.
    const common = (memories) => JSON.stringify(memories.map(({ id, body, tags, category, createdAt, photos }) => ({ id, body, tags, category, createdAt, photos })));
    const preserved = common(state.memories) === common(seedState.state.memories);
    const result = {
      at: new Date().toISOString(), userAgent: await page.evaluate(() => navigator.userAgent), health, server, signIn,
      upgrade: { beforeReload, withBanner, afterReload, servedOldBeforeReload: beforeReload.documentScript === seedState.server.indexAsset, candidateAfterReload: afterReload.documentScript === server.indexAsset },
      searches, photos, pinnedShown, keyword, sirikey: key,
      v4Changes: ["pinned heartworm", "pinned recital", `custom keyword ${KEYWORD} on shed`],
      preservedFromSeed: preserved, photoHashesMatchSeed: JSON.stringify(state.photoHashes) === JSON.stringify(seedState.state.photoHashes),
      state, log,
    };
    writeObservation("05-candidate", result);
    console.log(json({ ...result, state: undefined, upgrade: { ...result.upgrade, beforeReload: beforeReload.documentScript, withBanner: { script: withBanner.documentScript, waiting: withBanner.waiting }, afterReload: afterReload.documentScript } }));
    assert(result.upgrade.servedOldBeforeReload && result.upgrade.candidateAfterReload && preserved && result.photoHashesMatchSeed);
    assert.deepEqual(pinnedShown.sort(), ["heartworm", "recital"]);
    assert.equal(key.status, 400);
  } finally {
    await context.close();
  }
}

async function restored() {
  const { password, sirikey } = secrets();
  const seedState = readObservation("03-baseline");
  const health = await waitHealthy(180);
  const server = await serverIdentity();
  const chromium = await playwright();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const log = newLog();
  try {
    // A separate, fresh context: the persistent profile keeps its cached candidate untouched for cached-client.
    const context = await browser.newContext({ ...DEVICE, serviceWorkers: "block" });
    const page = watch(await context.newPage(), log);
    await page.goto(ORIGIN);
    const signIn = await loginIfNeeded(page, password);
    const searches = [];
    for (const search of SEARCHES) searches.push(await searchCheck(page, context.request, search));
    const photos = [await photoCheck(page, context.request, "heartworm"), await photoCheck(page, context.request, "shed")];
    await shot(page, "restored-1-old-app-fresh-login");
    const keywordSearch = (await (await context.request.get(`${ORIGIN}/api/search?q=${KEYWORD}`)).json()).results.map((memory) => memory.body);
    const state = await apiState(context.request);
    const key = await sirikeyCheck(sirikey);
    const result = {
      at: new Date().toISOString(), browser: `chromium ${browser.version()}`, comparedWith: "03-baseline", health, server, signIn,
      sameServerAsSeed: server.indexAsset === seedState.server.indexAsset && server.swSha256 === seedState.server.swSha256,
      searches, photos, keywordSearchAfterRestore: { query: KEYWORD, results: keywordSearch },
      memoriesMatchSeed: JSON.stringify(state.memories) === JSON.stringify(seedState.state.memories),
      photoHashesMatchSeed: JSON.stringify(state.photoHashes) === JSON.stringify(seedState.state.photoHashes),
      tokensMatchSeed: JSON.stringify(state.tokens) === JSON.stringify(seedState.state.tokens),
      pinnedFieldPresent: state.memories.some((memory) => memory.pinned !== undefined),
      sirikey: key, state, log,
    };
    writeObservation("08-restored", result);
    console.log(json({ ...result, state: undefined }));
    assert(result.sameServerAsSeed && result.memoriesMatchSeed && result.photoHashesMatchSeed && result.tokensMatchSeed);
    assert(!result.pinnedFieldPresent && !keywordSearch.includes(NOTES.shed));
    assert.equal(key.status, 400);
    assert.deepEqual(log.pageErrors, []);
  } finally {
    await browser.close();
  }
}

async function cachedClient(label = "09-cached-client", replay = null) {
  assert(/^[a-z0-9-]+$/.test(label), "Use a unique simple evidence label");
  assert(!existsSync(join(OBSERVATIONS, `${label}.json`)), "Never overwrite a prior attempt");
  assert(existsSync(PROFILE), "The original persistent profile is required; do not create a replacement");
  mkdirSync(SCREENSHOTS, { recursive: true });
  for (const name of readdirSync(SCREENSHOTS)) {
    const thisReplayWarmup = replay && name === basename(replay.warm.screenshot);
    assert(thisReplayWarmup || !name.startsWith(`${label}-`), "Screenshot label already used");
  }
  const { password } = secrets();
  const candidateObservation = readObservation("05-candidate");
  const main = newLog();
  const result = {
    startedAt: new Date().toISOString(), label, status: "running", phase: "inspect-preserved-profile",
    viewport: DEVICE.viewport, profile: replay ? REPLAY_PROFILE : PROFILE,
    candidateAsset: candidateObservation.server.indexAsset, log: main, replay: replay?.warm ?? null,
  };
  let context;
  let page;
  const snapshot = async (name) => {
    const filename = `${label}-${name}`;
    await shot(page, filename);
    (result.screenshots ??= []).push(`screenshots/${filename}.png`);
  };
  try {
    const server = result.server = await serverIdentity();
    assert.equal(server.indexAsset, readObservation("03-baseline").server.indexAsset, "Restored old server required");
    context = replay?.context ?? await persistentContext();
    result.browser = `chromium ${context.browser()?.version() ?? "unknown"}`;
    result.workersAtContextOpen = context.serviceWorkers().map((worker) => worker.url());
    page = watch(replay?.page ?? context.pages()[0] ?? (await context.newPage()), main);
    // Replay keeps the already-controlled candidate tab open throughout the actual server switch.
    if (!replay) await page.goto(ORIGIN);
    result.loaded = await clientIdentity(page);
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    await snapshot("01-initial-worker-and-assets");
    if (result.loaded.documentScript !== result.candidateAsset) {
      result.status = "prerequisite_lost";
      throw Error("The preserved profile no longer serves the cached candidate. The waiting old worker may have activated when the prior context closed. No cache clearing, rewarming, server switch or replacement Reload proof was performed; coordinator disposition is required.");
    }
    assert(result.loaded.controller, "The candidate must be controlled by the real service worker");
    result.signIn = await loginIfNeeded(page, password);
    let u = ui(page);
    result.initialBannerVisible = await u.banner().isVisible();
    result.initialState = await apiState(context.request);

    result.phase = "candidate-compatibility";
    await u.tab("Recall");
    const filtered = page.waitForResponse((response) => response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/memories" && new URL(response.url()).searchParams.get("pinned") === "1");
    await u.filter("Pinned").click();
    const filteredResponse = await filtered;
    const filteredMemories = (await filteredResponse.json()).memories;
    await page.getByRole("heading", { name: "Pinned", exact: true }).waitFor();
    for (const memory of filteredMemories) await u.recall.getByRole("button").filter({ hasText: memory.body }).first().waitFor();
    result.pinnedBefore = { shown: await u.shown(), status: filteredResponse.status(), returnedIds: filteredMemories.map((memory) => memory.id) };
    await snapshot("02-candidate-pinned-against-old");
    await u.filter("All").click();
    const edit = result.editBefore = { attempted: EDITED_OAT };
    await u.card("oat").first().click();
    edit.sheetOpened = await u.dialog().locator("#memory-body").waitFor({ timeout: 10_000 }).then(() => true, () => false);
    if (edit.sheetOpened) {
      await u.dialog().locator("#memory-body").fill(EDITED_OAT);
      const patch = page.waitForResponse((response) => response.request().method() === "PATCH", { timeout: 30_000 });
      await u.dialog().getByRole("button", { name: "Save changes", exact: true }).click();
      const response = await patch;
      edit.status = response.status();
      edit.responseBody = await response.json().catch(() => null);
      edit.visibleError = await u.dialog().locator("p.text-red-700").allInnerTexts().catch(() => []);
    }
    edit.appRootChildren = await page.evaluate(() => document.getElementById("root")?.childElementCount ?? null);
    edit.patchRequestsObserved = main.api.filter((entry) => entry.method === "PATCH");
    result.afterEditIdentity = await clientIdentity(page);
    await snapshot("03-edit-outcome");
    result.bodyOnServerAfterAttempt = (await apiState(context.request)).memories.find((memory) => memory.body.startsWith("Marisol"))?.body;
    if (edit.sheetOpened) {
      // The failed edit is still a dirty draft: closing it shows the discard prompt (accepted and logged).
      await u.close();
    } else if (edit.appRootChildren === 0) {
      result.phase = "recover-crashed-root-in-new-tab";
      // Keep the crashed controlled tab open: closing the last client could activate the waiting worker.
      // This navigation only recovers a React root. It is NOT the required update-banner Reload.
      page = watch(await context.newPage(), main);
      await page.goto(ORIGIN);
      result.recoveryNavigation = { action: "opened a new tab while retaining the crashed controlled tab", identity: await clientIdentity(page) };
      await snapshot("04-new-tab-before-reload");
      if (result.recoveryNavigation.identity.documentScript !== result.candidateAsset) {
        result.status = "prerequisite_lost";
        throw Error("New tab already loaded old assets; banner Reload has not been demonstrated. Stop without rewarming.");
      }
      await loginIfNeeded(page, password);
      u = ui(page);
    } else {
      throw Error("Memory sheet did not open, but the root is not empty; inspect partial evidence before continuing");
    }

    result.phase = "real-update-banner";
    // Real update discovery only; activation remains the application's Reload button below.
    result.updateCheck = await within(60_000, "Service worker update discovery", () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return "no registration";
      await registration.update();
      return "checked the restored server through the real registration.update()";
    }));
    await u.banner().waitFor({ timeout: 120_000 });
    result.withBanner = await clientIdentity(page);
    assert.equal(result.withBanner.documentScript, result.candidateAsset);
    assert(result.withBanner.waiting, "A real waiting worker is required before Reload");
    await snapshot("05-real-update-banner");
    result.reloadAction = { action: "clicked the application's Reload button", at: new Date().toISOString() };
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await scriptIs(page, server.indexAsset);
    result.signInAfter = await loginIfNeeded(page, password);
    result.afterReloadIdentity = await clientIdentity(page);
    assert(result.afterReloadIdentity.controller, "Old app must still use a real service worker");
    await u.tab("Recall");
    const pinnedFilterAfter = await u.filter("Pinned").count();
    await snapshot("06-old-app-after-banner-reload");
    result.phase = "verify-old-client-after-reload";
    await u.open("oat");
    const sheetControls = result.oldSheetControls = {
      pinButtons: await u.dialog().getByRole("button", { name: /^(Pin|Unpin)$/ }).count(),
      keywordFields: await u.dialog().getByLabel("Custom keywords", { exact: true }).count(),
      relatedSections: await u.dialog().getByRole("region", { name: "Related memories" }).count(),
    };
    result.pinnedFilterAfter = pinnedFilterAfter;
    assert.equal(pinnedFilterAfter, 0);
    assert.equal(sheetControls.pinButtons + sheetControls.keywordFields + sheetControls.relatedSections, 0);
    await u.dialog().locator("#memory-body").fill(EDITED_OAT);
    const patch = page.waitForResponse((response) => response.request().method() === "PATCH", { timeout: 30_000 });
    await u.dialog().getByRole("button", { name: "Save changes", exact: true }).click();
    const saved = await patch;
    result.editAfterStatus = saved.status();
    assert.equal(saved.status(), 200);
    await u.dialog().getByRole("button", { name: /^(Save changes|Saving…)$/ }).waitFor({ state: "hidden" });
    await snapshot("07-old-edit-saved");
    await u.close();
    NOTES.oat = EDITED_OAT;
    result.searchesAfter = [];
    for (const search of [...SEARCHES, { kind: "edited text", query: "sugar", note: "oat" }]) {
      result.searchesAfter.push(await searchCheck(page, context.request, search));
    }
    result.photosAfter = [await photoCheck(page, context.request, "heartworm"), await photoCheck(page, context.request, "shed")];
    const finalState = await apiState(context.request);
    result.photoHashesUnchanged = JSON.stringify(finalState.photoHashes) === JSON.stringify(result.initialState.photoHashes);
    result.savedBody = finalState.memories.find((memory) => memory.body.startsWith("Marisol"))?.body;
    assert(result.photoHashesUnchanged);
    assert.equal(result.savedBody, EDITED_OAT);
    result.status = "passed";
    result.phase = "complete";
  } catch (error) {
    if (result.status !== "prerequisite_lost") result.status = "failed";
    result.failure = { message: error.message, stack: error.stack };
    if (page && !page.isClosed()) {
      result.failureIdentity = await clientIdentity(page).catch(() => null);
      await snapshot("failure").catch(() => {});
    }
    throw error;
  } finally {
    // Save the partial result BEFORE context.close, which may activate a waiting worker.
    result.finishedAt = new Date().toISOString();
    writeObservation(label, result);
    console.log(json(result));
    await context?.close();
  }
}

// These modes are prepared for parent execution only. They never invoke Docker or change the retained sets.
function retainedHashes() {
  const expected = readObservation("inspect-quarantine-v4");
  const source = join(RETAINED, "quarantine-v4-20261110-090500");
  assert.equal(resolve(expected.dir), source);
  assert.equal(realpathSync(RETAINED), RETAINED, "Retained root must not redirect through a link");
  assert.equal(realpathSync(source), source);
  const files = expected.fileHashes.map((file) => {
    const path = resolve(source, file.path);
    assert(inside(source, path));
    assert.equal(realpathSync(path), path, "Retained file must not redirect through a link");
    assert(lstatSync(path).isFile());
    const bytes = readFileSync(path);
    assert.equal(bytes.length, file.bytes);
    assert.equal(sha256(bytes), file.sha256);
    return file;
  });
  assert.equal(files.length, 7);
  const actual = readdirSync(source, { recursive: true }).map(String)
    .filter((path) => !lstatSync(join(source, path)).isDirectory()).map((path) => path.replaceAll("\\", "/")).sort();
  assert.deepEqual(actual, files.map((file) => file.path).sort(), "Unexpected retained file");
  const archive = join(RETAINED, "recall-v3-20261110-090000.tgz");
  assert.equal(realpathSync(archive), archive);
  const archiveSha256 = sha256(readFileSync(archive));
  assert.equal(archiveSha256, "d302184711d797d27c6164099e1642c93d1738129f5d05aa26e97160907d00aa");
  return { source, archive, archiveSha256, files };
}

function prepareReplay() {
  assert.equal(realpathSync(TEMP), TEMP, "Task temp root must not redirect through a link");
  assert(inside(TEMP, REPLAY_DATA) && inside(TEMP, REPLAY_PROFILE));
  assert(!existsSync(REPLAY_DATA) && !existsSync(REPLAY_PROFILE), "Replay destinations must be unused");
  assert(!existsSync(join(OBSERVATIONS, "10-browser-replay-prepared.json")));
  const before = retainedHashes();
  mkdirSync(REPLAY_DATA);
  for (const file of before.files) {
    const target = resolve(REPLAY_DATA, file.path);
    assert(inside(REPLAY_DATA, target));
    mkdirSync(dirname(target), { recursive: true });
    assert.equal(realpathSync(dirname(target)), dirname(target));
    writeFileSync(target, readFileSync(join(before.source, file.path)), { flag: "wx" });
    assert.equal(sha256(readFileSync(target)), file.sha256);
  }
  // SQLite inspection is confined to the disposable COPY, never the retained recovery set.
  const copied = inspectSet(REPLAY_DATA);
  const expected = readObservation("inspect-quarantine-v4");
  assert.equal(copied.version, 4);
  assert.equal(copied.integrity, "ok");
  for (const field of ["counts", "memories", "photos", "embeddings"]) assert.deepEqual(copied[field], expected[field]);
  assert.deepEqual(retainedHashes(), before);
  const result = { at: new Date().toISOString(), status: "prepared", scratch: REPLAY_DATA,
    profileToCreate: REPLAY_PROFILE, retained: before, copied,
    boundary: "Only a copy was made; no server change, migration, reseed, browser or original-profile access" };
  writeObservation("10-browser-replay-prepared", result);
  console.log(json(result));
}

function verifyReplayScratch() {
  assert.equal(realpathSync(TEMP), TEMP);
  assert(inside(TEMP, REPLAY_DATA));
  assert.equal(realpathSync(REPLAY_DATA), REPLAY_DATA);
  assert.equal(readObservation("10-browser-replay-prepared").scratch, REPLAY_DATA);
  assert(!existsSync(REPLAY_PROFILE), "Replay-3 uses a new profile; preserve replay-1 and replay-2");
  for (const entry of readdirSync(REPLAY_DATA, { recursive: true })) {
    const path = resolve(REPLAY_DATA, String(entry));
    assert(inside(REPLAY_DATA, path));
    assert.equal(realpathSync(path), path, "Scratch entries must not redirect through links");
  }
  const retained = retainedHashes();
  const scratch = inspectSet(REPLAY_DATA);
  const expected = readObservation("inspect-quarantine-v4");
  assert.equal(scratch.version, 4);
  assert.equal(scratch.integrity, "ok");
  for (const field of ["counts", "memories", "photos", "embeddings"]) assert.deepEqual(scratch[field], expected[field]);
  const result = { at: new Date().toISOString(), status: "verified_for_reuse", scratch: REPLAY_DATA,
    inspected: scratch, retained, profileToCreate: REPLAY_PROFILE,
    boundary: "Read-only inspection of existing scratch; no recopy, migration, reseed, browser or server change" };
  writeObservation(`${REPLAY_LABEL}-reuse`, result);
  console.log(json(result));
}

async function replayClient() {
  const label = REPLAY_LABEL;
  assert(!existsSync(REPLAY_PROFILE), "Use the new replay profile once; never clear or reuse it");
  assert(!existsSync(join(OBSERVATIONS, `${label}.json`)));
  assert(!existsSync(join(OBSERVATIONS, `${label}-ready.json`)));
  mkdirSync(SCREENSHOTS, { recursive: true });
  assert(!readdirSync(SCREENSHOTS).some((name) => name.startsWith(`${label}-`)), "Never overwrite replay screenshots");
  assert.equal(readObservation("10-browser-replay-prepared").scratch, REPLAY_DATA);
  assert.equal(readObservation(`${label}-reuse`).status, "verified_for_reuse");
  const candidate = readObservation("05-candidate").server;
  const old = readObservation("03-baseline").server;
  const warm = { startedAt: new Date().toISOString(), phase: "warm-real-candidate", status: "running",
    profile: REPLAY_PROFILE, scratch: REPLAY_DATA, viewport: DEVICE.viewport, log: newLog() };
  let context;
  let page;
  try {
    warm.health = await waitHealthy(180);
    warm.server = await serverIdentity();
    assert.deepEqual(warm.server, candidate, "Real fixed candidate must be served before warming");
    warm.phase = "launch-browser";
    context = await persistentContext(REPLAY_PROFILE);
    context.setDefaultTimeout(60_000);
    context.setDefaultNavigationTimeout(60_000);
    page = watch(context.pages()[0] ?? await context.newPage(), warm.log);
    warm.phase = "authenticate-before-worker-registration";
    await page.goto(ORIGIN);
    // UpdateBanner/useRegisterSW is mounted only inside the authenticated App.
    warm.signIn = await loginIfNeeded(page, secrets().password);
    warm.authenticatedAt = new Date().toISOString();
    warm.phase = "wait-for-authenticated-worker";
    const workerDeadline = Date.now() + 60_000;
    for (;;) {
      const remaining = workerDeadline - Date.now();
      assert(remaining > 0, "Authenticated worker did not activate within 60 seconds");
      // Await each snapshot explicitly: an async waitForFunction predicate can resolve false without polling.
      warm.workerRegistration = await within(remaining, "Authenticated worker registration", () => page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        const worker = (value) => value ? { scriptURL: value.scriptURL, state: value.state } : null;
        return { active: worker(registration?.active), installing: worker(registration?.installing), waiting: worker(registration?.waiting) };
      }));
      if (warm.workerRegistration.active?.state === "activated") break;
      await sleep(Math.min(250, Math.max(0, workerDeadline - Date.now())));
    }
    warm.postLoginWorker = await clientIdentity(page);
    assert.equal(warm.postLoginWorker.workerStates.active, "activated", "Confirm activation before controlled navigation");
    assert(warm.postLoginWorker.active, "Activated worker must have a script identity");
    warm.workerReadyAt = new Date().toISOString();
    warm.phase = "warm-controlled-navigation";
    // First-load control can require navigation; this occurs while BOTH server and client are candidate.
    // It is recorded only as cache warming, never as the rollback banner Reload proof.
    await page.goto(ORIGIN);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 60_000 });
    warm.signInAfterWarming = await loginIfNeeded(page, secrets().password);
    warm.identity = await clientIdentity(page);
    warm.browser = `chromium ${context.browser()?.version() ?? "unknown"}`;
    assert.equal(warm.identity.documentScript, candidate.indexAsset);
    assert(warm.identity.controller && !warm.identity.waiting);
    const u = ui(page);
    await u.tab("Recall");
    await u.card("oat").first().waitFor();
    warm.state = await apiState(context.request);
    assert.deepEqual(warm.state.memories.filter((memory) => memory.pinned).map((memory) => memory.id), [1, 4]);
    assert(warm.state.memories.find((memory) => memory.id === 2).customKeywords.includes(KEYWORD));
    await shot(page, `${label}-00-candidate-controlled`);
    warm.screenshot = `screenshots/${label}-00-candidate-controlled.png`;
    warm.readyAt = new Date().toISOString();
    warm.status = "ready_for_parent_server_switch";
    warm.phase = "hold-controlled-tab-open";
    writeObservation(`${label}-ready`, warm);
    console.log(json({ status: warm.status, readyAt: warm.readyAt, origin: ORIGIN, profile: REPLAY_PROFILE }));
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const identity = await serverIdentity().catch(() => null);
      if (identity?.indexAsset === old.indexAsset && identity.swSha256 === old.swSha256) break;
      assert(Date.now() < deadline, "Parent did not switch to restored old server within ten minutes; preserve evidence");
      await sleep(500);
    }
    warm.oldServerObservedAt = new Date().toISOString();
    warm.identityBeforeCompatibility = await clientIdentity(page);
    assert.equal(warm.identityBeforeCompatibility.documentScript, candidate.indexAsset);
    warm.status = "server_switched_with_tab_held_open";
    await cachedClient(label, { context, page, warm });
  } catch (error) {
    // cachedClient writes its own partial result before context close; preserve earlier warming failures too.
    if (!existsSync(join(OBSERVATIONS, `${label}.json`))) {
      warm.status = "failed";
      warm.failure = { message: error.message, stack: error.stack };
      warm.finishedAt = new Date().toISOString();
      if (page && !page.isClosed()) {
        warm.failureIdentity = await clientIdentity(page).catch(() => null);
        const failureShot = `${label}-warmup-failure`;
        assert(!existsSync(join(SCREENSHOTS, `${failureShot}.png`)));
        await shot(page, failureShot).then(() => { warm.failureScreenshot = `screenshots/${failureShot}.png`; },
          (captureError) => { warm.failureScreenshotError = captureError.message; });
      }
      writeObservation(label, warm);
      console.log(json(warm));
    }
    throw error;
  } finally {
    await context?.close();
  }
}

function cleanupTemp() {
  assert.equal(TEMP, resolve("C:/Users/Nate/AppData/Local/Temp/recall-task2-20261110-6c4a91f2"));
  assert.equal(basename(TEMP), PREFIX);
  assert(!lstatSync(TEMP).isSymbolicLink());
  assert.equal(realpathSync(TEMP), TEMP, "Cleanup root must not redirect through a link");
  assert(!inside(TEMP, RETAINED) && !inside(TEMP, repo));
  assert.equal(readObservation(REPLAY_LABEL).status, "passed", "Finish real banner recovery before cleanup");
  assert(existsSync(join(OBSERVATIONS, "11-replay-retention.json")), "Record retained custody before cleanup");
  assert(!existsSync(join(OBSERVATIONS, "12-cleanup-temp.json")), "Cleanup evidence must be new");
  retainedHashes();
  const removed = readdirSync(TEMP).sort();
  rmSync(TEMP, { recursive: true });
  const result = { at: new Date().toISOString(), removed: TEMP, entries: removed, exists: existsSync(TEMP), retainedStillPresent: existsSync(RETAINED) };
  writeObservation("12-cleanup-temp", result);
  console.log(json(result));
}

switch (mode) {
  case "preflight": await preflight(); break;
  case "seed": await seed(); break;
  case "baseline": await baseline(); break;
  case "http-down": await httpDown(args[0]); break;
  case "archive": archive(args[0], args[1], resolve(args[2]), resolve(args[3])); break;
  case "inspect": inspect(args[0], resolve(args[1])); break;
  case "migrate-time": await migrateTime(resolve(args[0])); break;
  case "candidate": await candidate(); break;
  case "restored": await restored(); break;
  case "cached-client": await cachedClient(args[0]); break;
  case "prepare-replay": prepareReplay(); break;
  case "verify-replay-scratch": verifyReplayScratch(); break;
  case "replay-client": await replayClient(); break;
  case "verify-replay-retention": {
    const result = { at: new Date().toISOString(), retained: retainedHashes() };
    writeObservation("11-replay-retention", result);
    console.log(json(result));
    break;
  }
  case "cleanup-temp": cleanupTemp(); break;
  default: throw Error(`Unknown mode ${mode}`);
}
