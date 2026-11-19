// Local-only browser acceptance checks. Requires a completed npm.cmd run build.
// node scripts/verify-memory-features.mjs --playwright <index.mjs> --browser <chrome.exe> [--baseline <commit>]
//
// Fictional data, fake embedding and LLM providers, no external requests. Context A blocks service workers and covers
// UI behavior; context B allows the real built service worker for offline/reload, activation/update and mixed-version
// recovery. The "old server" is the real baseline source (pre-keyword-pills commit) run through tsx on its own v4 DB.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { strFromU8, unzipSync } from "fflate";
import { createApp } from "../dist/server/src/app.js";
import { openDb } from "../dist/server/src/db.js";
import { MemoryStore } from "../dist/server/src/memories.js";
import { PhotoStore } from "../dist/server/src/photos.js";
import { SearchIndex } from "../dist/server/src/search.js";
import { hashPasswordSync } from "../dist/server/src/password.js";

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const playwrightPath = process.argv.includes("--playwright") ? arg("--playwright") : process.env.RECALL_PLAYWRIGHT_PATH;
const browserPath = process.argv.includes("--browser") ? arg("--browser") : process.env.RECALL_BROWSER_PATH;
// The prepared baseline before keyword pills: schema v4, create ignores customKeywords, no capability.
const BASELINE = process.argv.includes("--baseline") ? arg("--baseline") : "07a034d466ea1de6b1686bdde7eab54c3eca81dc";
const { chromium } = await import(playwrightPath ? pathToFileURL(resolve(playwrightPath)).href : "playwright");
const output = resolve("screenshots");
await mkdir(output, { recursive: true });
// All temporary files stay inside this ignored directory. Never load .env or the normal server entrypoint.
const dir = await mkdtemp(join(output, "memory-features-fixture-"));
const web = join(dir, "web");
await cp(resolve("dist/web"), web, { recursive: true });
const fixturePhoto = resolve("server/test/fixtures/xmas-lights-bin.jpg");
let lastTick = 0;
// Strictly increasing so every assignment time is distinct and suggestion recency is deterministic.
const now = () => (lastTick = Math.max(Date.now(), lastTick + 1));
const db = openDb(join(dir, "recall.db"));
const photos = new PhotoStore(join(dir, "photos"));
const store = new MemoryStore(db, photos, now);
const vocabulary = new Map();
const vector = (text) => {
  const result = new Float32Array(1024);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (!vocabulary.has(word)) vocabulary.set(word, vocabulary.size);
    result[vocabulary.get(word) % result.length]++;
  }
  const norm = Math.hypot(...result);
  return norm ? result.map((value) => value / norm) : result;
};
let documentCalls = 0;
const embedder = () => ({
  model: "local-browser-fictional",
  embedDocuments: async (texts) => { documentCalls += texts.length; return texts.map(vector); },
  embedQuery: async (text) => vector(text),
});
const search = new SearchIndex(db, embedder(), now);
search.attach(store);
const save = async (body, patch, extra = {}) => {
  const { memory } = await store.create({ body, ...extra });
  return patch ? store.update(memory.id, patch) : memory;
};
const source = await save("Amber toolbox is in the garage.", { category: "things", pinned: true, customKeywords: ["weekend kit"] });
const target = await save("Amber toolbox has a spare compass.", { category: "work" });
const third = await save("Amber toolbox inventory list.", { category: "hobbies", pinned: true });
const outdated = await save("Amber toolbox outdated location.", { archived: true, pinned: true });
const lonely = await save("Saffron origami cranes.");
await save("Mira likes the lake.", { category: "people" });
// Exact browsing fixtures: keyword-only matches and body/tag/similar-spelling non-matches.
const homeKey = await save("Front door spare key under the mat.", { category: "things" }, { customKeywords: ["Home"] });
const homePinned = await save("Router password hint card.", { category: "things", pinned: true }, { customKeywords: ["home"] });
const homeOld = await save("Old house key from the previous flat.", { archived: true }, { customKeywords: ["HOME"] });
await save("Homework folder for night class.", null, { customKeywords: ["Homework"] });
await save("Feels like home when the kettle sings.");
const tagOnly = await save("Tagged plant note.");
store.applyEnrichment(tagOnly.id, { body: tagOnly.body, captions: null }, { category: "things", tags: ["home"] });
const BULK_YEAR = Date.UTC(2020, 0, 1);
for (let i = 0; i < 35; i++) await save(`Bulk labeled note ${i}.`, null, { customKeywords: ["Bulk"], createdAt: BULK_YEAR + i * 1000 });
for (let i = 0; i < 65; i++) await save(`compass bulk ${i}`, null, { createdAt: Date.UTC(2021, 0, 1) + i * 1000 });
const compassLabeled = await save("compass labeled bulk", null, { customKeywords: ["Bulk"], createdAt: Date.UTC(2019, 0, 1) });
// Suggestion fixtures, oldest first: Garage x3, Tools x2, Attic/Basement x1, Holiday outdated-only, then recent ones.
await save("Rake hangs on the wall.", null, { customKeywords: ["Garage"] });
await save("Bike pump by the door.", null, { customKeywords: ["Garage", "Tools"] });
await save("Snow shovel behind the car.", null, { customKeywords: ["Garage", "Tools"] });
await save("Old photo albums upstairs.", null, { customKeywords: ["Attic"] });
await save("Paint cans on the shelf.", null, { customKeywords: ["Basement"] });
await save("Holiday cards from last year.", { archived: true }, { customKeywords: ["Holiday"] });
const lantern = await save("Lantern batteries in the drawer.", null, { customKeywords: ["Lantern"] });
await save("Ornament box is red.", null, { customKeywords: ["Christmas"] });

const llmRequests = [];
const config = {
  production: false, port: 0, dataDir: dir, modelDir: join(dir, "models"), webDist: web,
  passwordHash: hashPasswordSync("fictional-local-password"), usingDevPassword: false,
  sessionSecret: "fictional-browser-secret-at-least-32-characters", anthropicApiKey: null,
  model: "fake-browser-provider", timeZone: "America/New_York",
};
const llm = { model: "fake-browser-provider", complete: async (request) => {
  llmRequests.push(request);
  return { json: { answer: "The fictional toolbox has a spare compass.", used_ids: [target.id] },
    model: "fake-browser-provider", inputTokens: 0, outputTokens: 0, stopReason: "end_turn" };
} };
const newApp = createApp({ config, store, search, llm, now, log: () => {}, accessLog: () => {} });

// One origin, switchable versions, as during a deployment or rollback. Server-side only, not page routes.
const serverState = { active: newApp, oldApp: null, splitCreateToOld: false, rejectNextCreate: false, stripShapes: false,
  /** A stale old instance answering /api/me (capability lost mid-rollout or after a binary rollback). */
  meFrom: null,
  /** The next create is processed by the server, then the connection fails while sending the response. */
  dropNextCreateResponse: false };
let createRequests = 0;
const dispatch = async (request, env) => {
  const url = new URL(request.url);
  const isCreate = request.method === "POST" && url.pathname === "/api/memories";
  if (isCreate) createRequests++;
  if (url.pathname === "/api/me" && serverState.meFrom) return serverState.meFrom.fetch(request, env);
  const app = isCreate && serverState.splitCreateToOld ? serverState.oldApp : serverState.active;
  if (isCreate && serverState.dropNextCreateResponse) {
    serverState.dropNextCreateResponse = false;
    const processed = await app.fetch(request, env);
    await processed.arrayBuffer();
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error("fictional connection lost")); } }),
      { status: processed.status, headers: { "content-type": "application/json" } });
  }
  if (isCreate && serverState.rejectNextCreate) {
    serverState.rejectNextCreate = false;
    await request.arrayBuffer();
    return Response.json({ error: "too_large", message: "That upload is too large." }, { status: 413 });
  }
  const response = await app.fetch(request, env);
  if (serverState.stripShapes && request.method === "GET" && /^\/api\/(memories|search)/.test(url.pathname) && response.ok) {
    // An older response shape: no pins or custom keywords at all.
    const data = await response.json();
    const strip = (memory) => { const { pinned: _p, customKeywords: _k, ...rest } = memory; return rest; };
    if (Array.isArray(data.memories)) data.memories = data.memories.map(strip);
    if (Array.isArray(data.results)) data.results = data.results.map(strip);
    return Response.json(data);
  }
  return response;
};

/** Loads the real baseline server source from git into the fixture directory and runs it through tsx. */
async function loadBaseline(target) {
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", BASELINE, "server/src", "shared"], { encoding: "utf8" })
    .split("\n").filter((file) => file.endsWith(".ts"));
  assert(files.includes("server/src/app.ts"));
  for (const file of files) {
    const out = join(target, file);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, execFileSync("git", ["show", `${BASELINE}:${file}`]));
  }
  await writeFile(join(target, "entry.ts"), [
    `export { createApp } from "./server/src/app.js";`, `export { openDb } from "./server/src/db.js";`,
    `export { MemoryStore } from "./server/src/memories.js";`, `export { PhotoStore } from "./server/src/photos.js";`,
    `export { SearchIndex } from "./server/src/search.js";`, `export { MIGRATIONS } from "./server/src/migrations/index.js";`,
  ].join("\n"));
  const { tsImport } = await import("tsx/esm/api");
  return tsImport(pathToFileURL(join(target, "entry.ts")).href, import.meta.url);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const until = async (check, label, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for: ${label}`);
};
const byBody = (memoryStore, body) => memoryStore.all().filter((memory) => memory.body === body);
const usage = (memoryStore, key) => memoryStore.keywordVocabulary().find((entry) => entry.key === key);

/** Every other database opened by the rehearsal, closed in cleanup. */
const extraDbs = [];
let server;
let browser;
let page;
let pageB;
const observations = [];
const screenshots = [];
const record = (text) => { observations.push(text); console.log(`PASS ${text}`); };
const shot = async (target, name) => {
  const path = join(output, `memory-features-${name}.png`);
  await target.screenshot({ path, fullPage: true });
  screenshots.push(`screenshots/memory-features-${name}.png`);
};
try {
  server = serve({ fetch: dispatch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: resolve(browserPath) } : {}) });
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
  const context = await browser.newContext({ ...phone, serviceWorkers: "block" });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Prevent any external page requests; providers above are deterministic and local.
  // A request cancelled by a reload may reject continue(); that must not crash the rehearsal.
  const localOnly = (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.route("**/*", localOnly);
  await page.goto(origin);
  await page.getByLabel("Password", { exact: true }).fill("fictional-local-password");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  assert.equal(await page.evaluate(() => window.innerWidth), 390);
  assert.equal(await page.evaluate(() => navigator.maxTouchPoints > 0), true);

  // ---------- Remember: pill capture, suggestions, keyboard, invalid input, photos, in-flight typing ----------
  const remember = page.locator("#remember-input");
  const kw = page.locator("#remember-keywords");
  const rememberForm = page.locator("form").filter({ has: remember });
  const removeLabel = "Remove keyword ";
  const pillsIn = (scope) => scope.getByRole("button", { name: /^Remove keyword / })
    .evaluateAll((els, prefix) => els.map((el) => el.getAttribute("aria-label").slice(prefix.length)), removeLabel);
  const optionNames = (target = page) => target.getByRole("listbox", { name: "Keyword suggestions" }).getByRole("option")
    .evaluateAll((els) => els.map((el) => el.querySelector("span")?.textContent ?? ""));
  await remember.waitFor();
  await kw.focus();
  await until(async () => (await optionNames()).length === 5, "five default suggestions");
  // Active counts: Bulk 36, Garage 3, Home 2 (HOME is outdated), Tools 2, then 1s. Holiday is outdated-only.
  assert.deepEqual(await optionNames(), ["Christmas", "Lantern", "Bulk", "Garage", "Home"]);
  assert.equal(await kw.getAttribute("aria-expanded"), "true");
  await shot(page, "keyword-suggestions");
  record("Default suggestions: two most recent assignments (Christmas, Lantern), then frequency (Bulk 36, Garage 3), alphabetical tie at 2 (Home before Tools; outdated HOME not counted); outdated-only Holiday excluded; five maximum.");

  const firstBody = "Christmas lights are in the blue bin";
  await remember.fill(firstBody);
  await kw.click();
  await kw.pressSequentially("gar");
  await until(async () => (await optionNames())[0] === "Garage", "typed match first");
  await kw.press("ArrowDown");
  await kw.press("Enter");
  await kw.pressSequentially("Christmas");
  await until(async () => (await optionNames())[0] === "Christmas", "exact match first");
  await kw.press("ArrowDown");
  await kw.press("Enter");
  await kw.pressSequentially("Blue Bin");
  await until(async () => (await optionNames()).includes("Create “Blue Bin”"), "create option");
  await kw.press("Enter");
  await kw.pressSequentially("GARAGE,");
  assert.deepEqual(await pillsIn(rememberForm), ["Garage", "Christmas", "Blue Bin"]);
  assert.equal(await kw.inputValue(), "");
  assert.equal(byBody(store, firstBody).length, 0, "Enter in the keyword input must not submit the recall");
  // Keyboard removal through a labeled remove button, then re-add, then leave unfinished text for Save.
  await rememberForm.getByRole("button", { name: "Remove keyword Blue Bin", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await pillsIn(rememberForm), ["Garage", "Christmas"]);
  await kw.pressSequentially("Blue Bin");
  await kw.press("Enter");
  const removeBox = await rememberForm.getByRole("button", { name: "Remove keyword Garage", exact: true }).boundingBox();
  assert(removeBox.width >= 44 && removeBox.height >= 44, `remove target ${removeBox.width}x${removeBox.height}`);
  await kw.pressSequentially("Lights");
  await shot(page, "keyword-capture");
  await rememberForm.getByRole("button", { name: "Save", exact: true }).click();
  await until(() => byBody(store, firstBody).length === 1, "text capture saved");
  assert.deepEqual(byBody(store, firstBody)[0].customKeywords, ["Garage", "Christmas", "Blue Bin", "Lights"]);
  await until(async () => (await pillsIn(rememberForm)).length === 0 && (await remember.inputValue()) === "" && (await kw.inputValue()) === "", "form cleared");
  record("Remember pills: keyboard selection (ArrowDown/Enter), explicit Create, comma dedupe (GARAGE), labeled 44px remove targets, keyboard removal; Enter never submits; unfinished valid text is committed on Save; body and keywords saved together.");

  const secondBody = "Spare bulbs for the porch light";
  await remember.fill(secondBody);
  await kw.fill("x".repeat(41));
  await rememberForm.getByRole("alert").filter({ hasText: "40 characters" }).waitFor();
  assert(await rememberForm.getByRole("button", { name: "Save", exact: true }).isDisabled());
  await kw.press("Enter");
  assert.equal(await kw.inputValue(), "x".repeat(41));
  await kw.fill(`${Array.from({ length: 11 }, (_, i) => `k${i}`).join(", ")},`);
  await rememberForm.getByRole("alert").filter({ hasText: "10 custom keywords" }).waitFor();
  assert.deepEqual(await pillsIn(rememberForm), []);
  await shot(page, "keyword-invalid");
  await kw.fill("Spare, Porch,");
  assert.deepEqual(await pillsIn(rememberForm), ["Spare", "Porch"]);
  assert.equal(await rememberForm.getByRole("alert").count(), 0);
  await rememberForm.getByRole("button", { name: "Save", exact: true }).click();
  await until(() => byBody(store, secondBody).length === 1, "second capture saved");
  assert.deepEqual(byBody(store, secondBody)[0].customKeywords, ["Spare", "Porch"]);
  record("Invalid keyword input (41 characters, an eleventh keyword by comma paste) stays visible with an explanation, adds nothing and disables Save; valid comma paste becomes pills.");

  await page.locator('main input[type="file"]').first().setInputFiles(fixturePhoto);
  await rememberForm.locator("img").first().waitFor();
  await kw.pressSequentially("Garage");
  await kw.press("Enter");
  const photoCount = store.all().filter((memory) => memory.photos.length > 0).length;
  await rememberForm.getByRole("button", { name: "Save", exact: true }).click();
  await until(() => store.all().filter((memory) => memory.photos.length > 0).length === photoCount + 1, "photo capture saved");
  const photoMemory = store.all().find((memory) => memory.photos.length > 0 && memory.body === "");
  assert.deepEqual(photoMemory.customKeywords, ["Garage"]);
  const exported = unzipSync(new Uint8Array(await (await page.request.get(`${origin}/api/export`)).body()));
  const exportedJson = JSON.parse(strFromU8(exported["memories.json"]));
  const exportedText = exportedJson.memories.find((memory) => memory.body === firstBody);
  const exportedPhoto = exportedJson.memories.find((memory) => memory.id === photoMemory.id);
  assert.deepEqual(exportedText.customKeywords, ["Garage", "Christmas", "Blue Bin", "Lights"]);
  assert.deepEqual(exportedPhoto.customKeywords, ["Garage"]);
  assert.equal(exportedPhoto.photos.length, 1);
  assert(exported[exportedPhoto.photos[0].file]);
  assert(strFromU8(exported["memories.md"]).includes("Custom keywords: Garage, Christmas, Blue Bin, Lights"));
  record("Photo-only capture saves its photo and pills in one request; JSON/Markdown export keeps readable customKeywords separate from tags, with the photo file.");

  // Continued typing during an in-flight capture belongs to the next memory.
  let releaseCreate;
  const createGate = new Promise((resolveGate) => { releaseCreate = resolveGate; });
  let createSeen;
  const seen = new Promise((resolveSeen) => { createSeen = resolveSeen; });
  await page.route("**/api/memories", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    createSeen();
    await createGate;
    await route.fallback();
  }, { times: 1 });
  const slowBody = "First capture during a slow upload";
  await remember.fill(slowBody);
  await kw.pressSequentially("Inflight");
  await kw.press("Enter");
  await rememberForm.getByRole("button", { name: "Save", exact: true }).click();
  await seen;
  // The capture is stored on this phone before the upload starts, so the form is already clear for the next memory.
  await until(async () => (await remember.inputValue()) === "", "form cleared once stored");
  assert.deepEqual(await pillsIn(rememberForm), []);
  await remember.fill("Next capture typed while saving");
  await kw.pressSequentially("NextKey");
  await kw.press("Enter");
  // The sent keyword selected again (same normalized keyword) belongs to the next capture.
  await kw.pressSequentially("inflight");
  await kw.press("Enter");
  await kw.pressSequentially("unfinished");
  assert.deepEqual(await pillsIn(rememberForm), ["NextKey", "inflight"]);
  releaseCreate();
  await until(() => byBody(store, slowBody).length === 1, "slow capture saved");
  await until(async () => !(await rememberForm.getByRole("button", { name: "Saving…" }).count()), "save finished");
  assert.deepEqual(byBody(store, slowBody)[0].customKeywords, ["Inflight"]);
  assert.equal(await remember.inputValue(), "Next capture typed while saving");
  assert.deepEqual(await pillsIn(rememberForm), ["NextKey", "inflight"]);
  assert.equal(await kw.inputValue(), "unfinished");
  await sleep(200);
  await page.reload();
  await remember.waitFor();
  await until(async () => (await remember.inputValue()) === "Next capture typed while saving", "next draft after reload");
  assert.deepEqual(await pillsIn(rememberForm), ["NextKey", "inflight"]);
  assert.equal(await kw.inputValue(), "unfinished");
  await rememberForm.getByRole("button", { name: "Remove keyword NextKey", exact: true }).click();
  await rememberForm.getByRole("button", { name: "Remove keyword inflight", exact: true }).click();
  await kw.fill("");
  await remember.fill("");
  record("A completing save clears only what it sent: text, a new pill, a sent keyword removed and selected again (inflight), and unfinished keyword input typed during the in-flight upload all stay for the next memory, including across a reload.");

  // Interrupted upload whose first request reached the server: the retry with the same clientId is exactly-once.
  let dropped = false;
  const interrupt = async (route) => {
    if (route.request().method() !== "POST" || dropped) return route.fallback();
    dropped = true;
    await route.fetch();
    await route.abort("connectionreset");
  };
  await page.route("**/api/memories", interrupt);
  const interruptedBody = "Interrupted upload capture";
  await remember.fill(interruptedBody);
  await kw.pressSequentially("Retry");
  await kw.press("Enter");
  await rememberForm.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("listitem", { name: "Waiting to upload" }).filter({ hasText: interruptedBody }).waitFor();
  // The card appears once stored locally; wait until the first request reached the server and the save settled as queued.
  await until(() => dropped && byBody(store, interruptedBody).length === 1, "first upload reached the server");
  await page.getByText("Saved on this phone. It will upload when you're online.", { exact: false }).waitFor();
  assert.equal(byBody(store, interruptedBody).length, 1);
  const retryUsage = usage(store, "retry");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByRole("listitem", { name: "Waiting to upload" }).filter({ hasText: interruptedBody }).waitFor({ state: "hidden" });
  assert.equal(byBody(store, interruptedBody).length, 1);
  assert.deepEqual(usage(store, "retry"), retryUsage);
  assert.deepEqual(byBody(store, interruptedBody)[0].customKeywords, ["Retry"]);
  await page.unroute("**/api/memories", interrupt);
  record("Interrupted upload: the first request created the recall but the response was lost; the queued retry with the same clientId cleared it without a duplicate, a second count or new recency.");

  // Count/recency: archive, restore and delete change counts; pin and body edits change nothing.
  const recallTab = page.getByRole("tab", { name: "Recall", exact: true });
  const rememberTab = page.getByRole("tab", { name: "Remember", exact: true });
  const dialog = () => page.getByRole("dialog", { name: "Memory", exact: true });
  const body = () => dialog().getByLabel("Memory text", { exact: true });
  const keywords = () => dialog().getByLabel("Custom keywords", { exact: true });
  const related = () => dialog().getByRole("region", { name: "Related memories" });
  const recall = page.locator("main > div:not([hidden])");
  const open = async (text) => {
    await recall.getByRole("button").filter({ has: page.getByText(text, { exact: true }) }).first().click();
    await body().waitFor();
    assert.equal(await body().inputValue(), text);
  };
  const close = async () => { await dialog().getByRole("button", { name: "Close", exact: true }).click(); await dialog().waitFor({ state: "hidden" }); };
  const typedOptions = async (text) => {
    await kw.fill(text);
    await sleep(50);
    const names = await optionNames();
    await kw.fill("");
    return names;
  };
  await open(lantern.body);
  const before = JSON.stringify(store.keywordVocabulary());
  await dialog().getByRole("button", { name: "Pin", exact: true }).click();
  await dialog().getByRole("button", { name: "Unpin", exact: true }).waitFor();
  await body().fill("Lantern batteries in the kitchen drawer.");
  await dialog().getByRole("button", { name: "Save changes", exact: true }).click();
  await dialog().getByRole("button", { name: /^(Save changes|Saving…)$/ }).waitFor({ state: "hidden" });
  assert.equal(JSON.stringify(store.keywordVocabulary()), before);
  await dialog().getByRole("button", { name: "Mark outdated", exact: true }).click();
  await dialog().getByRole("button", { name: "Not outdated", exact: true }).waitFor();
  assert.deepEqual(usage(store, "lantern"), { keyword: "Lantern", key: "lantern", count: 0, lastAssignedAt: null });
  await close();
  await kw.focus();
  await until(async () => (await optionNames()).length === 5 && !(await optionNames()).includes("Lantern"), "Lantern leaves defaults");
  assert.deepEqual(await typedOptions("lant"), ["Lantern", "Create “lant”"]);
  await recallTab.click();
  await page.getByLabel("Show outdated").check();
  await open("Lantern batteries in the kitchen drawer.");
  await dialog().getByRole("button", { name: "Not outdated", exact: true }).click();
  await dialog().getByRole("button", { name: "Mark outdated", exact: true }).waitFor();
  assert.equal(usage(store, "lantern").count, 1);
  assert.equal(usage(store, "lantern").lastAssignedAt, JSON.parse(before).find((entry) => entry.key === "lantern").lastAssignedAt);
  page.once("dialog", (prompt) => void prompt.accept());
  await dialog().getByRole("button", { name: "Delete", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  await page.getByLabel("Show outdated").uncheck();
  assert.equal(usage(store, "lantern"), undefined);
  await rememberTab.click();
  assert.deepEqual(await typedOptions("lant"), ["Create “lant”"]);
  record("Counts: pin/unpin and a body edit change neither count nor recency; Mark outdated drops Lantern from defaults (typed match still offered), restore brings back its count with its original recency, delete removes it.");

  // Suggestion failures leave manual capture usable (cached vocabulary may still suggest).
  await page.route("**/api/keywords", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture", message: "Fictional suggestion failure." }) }));
  await page.reload();
  await remember.waitFor();
  const failureBody = "Manual keyword while suggestions fail";
  await remember.fill(failureBody);
  await kw.pressSequentially("Handmade");
  await kw.press("Enter");
  await rememberForm.getByRole("button", { name: "Save", exact: true }).click();
  await until(() => byBody(store, failureBody).length === 1, "capture with failing suggestions");
  assert.deepEqual(byBody(store, failureBody)[0].customKeywords, ["Handmade"]);
  await page.unroute("**/api/keywords");
  await page.reload();
  await remember.waitFor();
  record("Suggestion loading failure (HTTP 503): typing and saving keywords still work; selected pills are kept.");

  // ---------- Existing pinned, editor and related checks (selectors adapted to pills) ----------
  await recallTab.click();
  const filter = (name) => page.getByRole("group", { name: "Show only" }).getByRole("button", { name, exact: true });
  const query = page.getByRole("searchbox");
  const waitResults = async () => {
    await page.getByRole("heading", { name: "Results", exact: true }).waitFor();
  };
  await filter("Pinned").click();
  await recall.getByText(source.body, { exact: true }).waitFor();
  assert.equal(await recall.getByText(target.body, { exact: true }).count(), 0);
  assert.equal(await recall.getByText(outdated.body, { exact: true }).count(), 0);
  assert.equal(await filter("All").getAttribute("aria-pressed"), "false");
  await page.getByLabel("Show outdated").check();
  await recall.getByText(outdated.body, { exact: true }).waitFor();
  await page.getByLabel("Show outdated").uncheck();
  await recall.getByText(outdated.body, { exact: true }).waitFor({ state: "hidden" });
  await query.fill("Amber");
  await waitResults();
  await recall.getByText(source.body, { exact: true }).waitFor();
  assert.equal(await recall.getByText(target.body, { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Ask all memories", exact: true }).waitFor();
  await shot(page, "pinned-search");
  await page.getByRole("button", { name: "Ask all memories", exact: true }).click();
  await page.getByText("The fictional toolbox has a spare compass.", { exact: true }).waitFor();
  assert(llmRequests.at(-1).content.includes(target.body));
  record("Pinned browsing/search hides unpinned and outdated notes; Show outdated restores old pins; Ask all memories retrieves an unpinned note.");
  await filter("Things").click();
  assert.equal(await filter("Pinned").getAttribute("aria-pressed"), "false");
  assert.equal(await filter("Things").getAttribute("aria-pressed"), "true");
  await filter("Pinned").click();
  assert.equal(await filter("Things").getAttribute("aria-pressed"), "false");
  await query.fill("");
  await open(source.body);
  await related().getByText(target.body, { exact: true }).waitFor();
  const savedCalls = documentCalls;
  await body().fill("Amber toolbox draft text.");
  await keywords().fill("draft keyword");
  await dialog().getByRole("button", { name: "Unpin", exact: true }).click();
  await dialog().getByRole("button", { name: "Pin", exact: true }).waitFor();
  assert.equal(await body().inputValue(), "Amber toolbox draft text.");
  assert.equal(await keywords().inputValue(), "draft keyword");
  assert.deepEqual(await pillsIn(dialog()), ["weekend kit"]);
  assert.equal(store.require(source.id).body, source.body);
  assert.deepEqual(store.require(source.id).customKeywords, ["weekend kit"]);
  assert.equal(documentCalls, savedCalls);
  await dialog().getByRole("button", { name: "Pin", exact: true }).click();
  await dialog().getByRole("button", { name: "Unpin", exact: true }).waitFor();
  await dialog().getByRole("button", { name: "Remove keyword weekend kit", exact: true }).click();
  assert.deepEqual(await pillsIn(dialog()), []);
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await body().inputValue(), source.body);
  assert.equal(await keywords().inputValue(), "");
  assert.deepEqual(await pillsIn(dialog()), ["weekend kit"]);
  assert.deepEqual(store.require(source.id).customKeywords, ["weekend kit"]);
  record("Pin and Unpin persist without saving or losing dirty text, unfinished keyword text or pills, or recomputing embeddings; a removed pill is only a draft; Cancel restores body, pills and input.");

  await keywords().fill("x".repeat(41));
  await dialog().getByRole("alert").filter({ hasText: "40 characters" }).waitFor();
  assert(await dialog().getByRole("button", { name: "Save changes", exact: true }).isDisabled());
  await keywords().fill(Array.from({ length: 11 }, (_, i) => `key${i}`).join(","));
  await dialog().getByRole("alert").filter({ hasText: "10 custom keywords" }).waitFor();
  assert(await dialog().getByRole("button", { name: "Save changes", exact: true }).isDisabled());
  assert.deepEqual(store.require(source.id).customKeywords, ["weekend kit"]);
  await body().fill("Amber toolbox is in the studio.");
  await dialog().getByRole("button", { name: "Remove keyword weekend kit", exact: true }).click();
  await keywords().fill(" Star Map, ,STAR MAP,  Workshop ");
  assert.deepEqual(await pillsIn(dialog()), ["Star Map"]);
  await shot(page, "keyword-editor");
  await dialog().getByRole("button", { name: "Save changes", exact: true }).click();
  await dialog().getByRole("button", { name: /^(Save changes|Saving…)$/ }).waitFor({ state: "hidden" });
  assert.equal(store.require(source.id).body, "Amber toolbox is in the studio.");
  assert.deepEqual(store.require(source.id).customKeywords, ["Star Map", "Workshop"]);
  assert.deepEqual(await pillsIn(dialog()), ["Star Map", "Workshop"]);
  assert.equal(await keywords().inputValue(), "");
  assert.equal(usage(store, "workshop").count, 1);
  await related().getByText(target.body, { exact: true }).waitFor();
  await close();
  await query.fill("Workshop");
  await waitResults();
  await recall.getByText("Amber toolbox is in the studio.", { exact: true }).waitFor();
  await open("Amber toolbox is in the studio.");
  const keywordCalls = documentCalls;
  await dialog().getByRole("button", { name: "Remove keyword Workshop", exact: true }).click();
  await dialog().getByRole("button", { name: "Save changes", exact: true }).click();
  await dialog().getByRole("button", { name: /^(Save changes|Saving…)$/ }).waitFor({ state: "hidden" });
  assert.equal(documentCalls, keywordCalls);
  assert.equal(usage(store, "workshop"), undefined);
  await close();
  await page.getByText("Nothing found for", { exact: false }).waitFor();
  record("Editor validation blocks both limits without partial saves; Save changes commits valid unfinished text, normalizes/deduplicates and saves body/keywords together; pill removal updates Pinned search and usage counts without embedding.");

  await query.fill("");
  await open("Amber toolbox is in the studio.");
  await related().getByText(target.body, { exact: true }).waitFor();
  // Keyword-only dirtiness (unfinished input) blocks close; combined dirtiness blocks related navigation.
  await keywords().fill("unsaved keyword");
  page.once("dialog", (prompt) => { assert.equal(prompt.message(), "Discard your changes?"); void prompt.dismiss(); });
  await dialog().getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(await keywords().inputValue(), "unsaved keyword");
  page.once("dialog", (prompt) => { assert.equal(prompt.message(), "Discard your changes?"); void prompt.dismiss(); });
  await dialog().getByRole("button", { name: "Show memories labeled Star Map", exact: true }).click();
  assert.equal(await keywords().inputValue(), "unsaved keyword");
  await body().fill("unsaved text");
  page.once("dialog", (prompt) => { assert.equal(prompt.message(), "Discard your changes?"); void prompt.dismiss(); });
  await related().getByRole("button").filter({ hasText: target.body }).click();
  assert.equal(await body().inputValue(), "unsaved text");
  assert.equal(await keywords().inputValue(), "unsaved keyword");
  page.once("dialog", (prompt) => void prompt.accept());
  await related().getByRole("button").filter({ hasText: target.body }).click();
  await page.waitForFunction((text) => document.querySelector("#memory-body")?.value === text, target.body);
  assert.equal(await body().inputValue(), target.body);
  assert.equal(await page.getByRole("dialog").count(), 1);
  assert.equal(store.require(source.id).body, "Amber toolbox is in the studio.");
  await related().getByText("Amber toolbox is in the studio.", { exact: true }).waitFor();
  await shot(page, "related-navigation");
  await close();
  record("Unfinished keyword text alone blocks close and keyword navigation; combined text/keyword related navigation prompts; declining preserves edits; accepting replaces the existing sheet with one dialog.");

  // A real delayed API request exposes loading; fail one response and retry the same real endpoint.
  let mode = "error";
  const relatedRoute = `**/api/memories/${source.id}/related`;
  let release;
  let ready;
  const requestReady = new Promise((resolveReady) => { ready = resolveReady; });
  let routeDone;
  const pendingDone = new Promise((resolveDone) => { routeDone = resolveDone; });
  const handler = async (route) => {
    if (mode === "error") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture", message: "Fictional temporary failure. Try again." }) });
    } else if (mode === "delay") {
      const response = await route.fetch();
      await new Promise((resolveRelease) => { release = resolveRelease; ready(); });
      try { await route.fulfill({ response }); } catch { /* The component aborts on close. */ }
      routeDone();
    } else await route.continue();
  };
  await page.route(relatedRoute, handler);
  await open("Amber toolbox is in the studio.");
  await related().getByRole("alert").waitFor();
  assert.equal(await body().inputValue(), "Amber toolbox is in the studio.");
  assert(await body().isEnabled());
  await keywords().fill("editable during related failure");
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await shot(page, "related-error");
  mode = "normal";
  await related().getByRole("button", { name: "Try again", exact: true }).click();
  await related().getByText(target.body, { exact: true }).waitFor();
  await close();
  mode = "delay";
  await open("Amber toolbox is in the studio.");
  await related().getByRole("status").waitFor();
  assert.equal(await body().inputValue(), "Amber toolbox is in the studio.");
  assert(await body().isEnabled());
  assert(await keywords().isEnabled());
  await shot(page, "related-loading");
  await requestReady;
  await close();
  await filter("All").click();
  await open(lonely.body);
  await related().getByText("No related memories found.", { exact: true }).waitFor();
  assert.equal(typeof release, "function");
  release();
  await pendingDone;
  assert.equal(await body().inputValue(), lonely.body);
  assert.equal(await related().getByRole("button").count(), 0);
  await shot(page, "related-empty");
  await close();
  await page.unroute(relatedRoute, handler);
  await open("Amber toolbox is in the studio.");
  await related().getByText(target.body, { exact: true }).waitFor();
  await related().getByRole("button").filter({ hasText: target.body }).click();
  assert.equal(await body().inputValue(), target.body);
  await close();
  record("Related loading/error leaves the memory usable; retry recovers; empty state renders; a late response from a closed memory cannot replace another memory; subsequent related navigation recovers.");

  // ---------- Exact keyword browsing ----------
  const keywordChip = () => page.getByRole("group", { name: "Keyword filter" });
  const visibleBodies = async () => recall.locator("ul > li > button > p:first-child").allInnerTexts();
  await open(homeKey.body);
  await dialog().getByRole("button", { name: "Show memories labeled Home", exact: true }).click();
  await dialog().waitFor({ state: "hidden" });
  await keywordChip().getByText("Home", { exact: true }).waitFor();
  assert.equal(await recallTab.getAttribute("aria-selected"), "true");
  await until(async () => (await visibleBodies()).length === 2, "home results");
  assert.deepEqual(await visibleBodies(), [homePinned.body, homeKey.body]);
  await shot(page, "keyword-browse");
  await page.getByLabel("Show outdated").check();
  await until(async () => (await visibleBodies()).includes(homeOld.body), "outdated home visible");
  assert.equal((await visibleBodies()).length, 3);
  await page.getByLabel("Show outdated").uncheck();
  await filter("Pinned").click();
  await until(async () => JSON.stringify(await visibleBodies()) === JSON.stringify([homePinned.body]), "pinned home");
  await filter("Hobbies").click();
  await page.getByText("No current memories in Hobbies are labeled “Home”.", { exact: false }).waitFor();
  await shot(page, "keyword-browse-empty");
  await filter("Things").click();
  await until(async () => (await visibleBodies()).length === 2, "things home");
  await query.fill("spare");
  await waitResults();
  await until(async () => JSON.stringify(await visibleBodies()) === JSON.stringify([homeKey.body]), "search with keyword");
  await page.getByRole("button", { name: "Ask all memories", exact: true }).click();
  await page.getByText("The fictional toolbox has a spare compass.", { exact: true }).waitFor();
  assert(llmRequests.at(-1).content.includes(target.body), "Ask is not scoped to the keyword view");
  await keywordChip().getByRole("button", { name: "Clear keyword filter Home", exact: true }).click();
  await keywordChip().waitFor({ state: "hidden" });
  assert.equal(await query.inputValue(), "spare");
  assert.equal(await filter("Things").getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Ask", exact: true }).waitFor();
  record("Keyword browsing: exact whole normalized keyword (Home/home/HOME) excludes Homework, body-only and tag-only notes; intersects with Show outdated, Pinned, category and search text; clear empty state; Ask says Ask all memories and is not scoped; clearing keeps query/category and restores Ask.");

  await query.fill("Bulk labeled note 3.");
  await waitResults();
  await filter("All").click();
  await open("Bulk labeled note 3.");
  await dialog().getByRole("button", { name: "Show memories labeled Bulk", exact: true }).click();
  await recall.getByRole("button", { name: "Clear search", exact: true }).click();
  const bulkCards = () => recall.getByRole("button").filter({ hasText: "Bulk labeled note" });
  await until(async () => (await bulkCards().count()) === 30, "first page of bulk");
  await recall.getByRole("button", { name: "Show more", exact: true }).click();
  await until(async () => (await bulkCards().count()) === 35, "second page of bulk");
  await recall.getByText(compassLabeled.body, { exact: true }).waitFor();
  await shot(page, "keyword-pagination");
  await filter("Things").click();
  await page.getByText("No current memories in Things are labeled “Bulk”.", { exact: false }).waitFor();
  await filter("All").click();
  await until(async () => (await bulkCards().count()) === 30, "pagination reset");
  assert.equal(await recall.getByText(compassLabeled.body, { exact: true }).count(), 0);
  await query.fill("compass");
  await waitResults();
  await until(async () => JSON.stringify(await visibleBodies()) === JSON.stringify([compassLabeled.body]), "keyword search before candidate limit");
  await keywordChip().getByRole("button", { name: "Clear keyword filter Bulk", exact: true }).click();
  // Without the filter the old labeled note is crowded out by newer unlabeled matches again.
  await until(async () => (await visibleBodies()).some((text) => text.startsWith("compass bulk")), "compass without keyword");
  assert(!(await visibleBodies()).includes(compassLabeled.body));
  await query.fill("");
  record("Keyword filter applies before pagination (30 + Show more = 36 Bulk) and resets pagination on filter change; search text + keyword finds the oldest labeled compass note behind 65 newer unlabeled matches (beyond the 60-candidate limit).");
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.innerWidth), 390);
  assert.equal(await page.evaluate(() => window.innerHeight), 844);
  // Reported, not asserted: Chromium's emulated maxTouchPoints may read 0 after page.reload(); touch was asserted at start.
  const touchAfterReload = await page.evaluate(() => ({ maxTouchPoints: navigator.maxTouchPoints, ontouchstart: "ontouchstart" in window,
    coarse: matchMedia("(pointer: coarse)").matches }));

  // ---------- Context B: real service worker, offline/reload, rejected edit, mixed versions, update ----------
  const contextB = await browser.newContext({ ...phone, serviceWorkers: "allow" });
  pageB = await contextB.newPage();
  const errorsB = [];
  pageB.on("pageerror", (error) => errorsB.push(error.message));
  let workerStarts = 0;
  contextB.on("serviceworker", () => { workerStarts++; });
  await pageB.goto(origin);
  await pageB.getByLabel("Password", { exact: true }).fill("fictional-local-password");
  await pageB.getByRole("button", { name: "Unlock", exact: true }).click();
  await pageB.locator("#remember-input").waitFor();
  let swState = null;
  const readSw = () => pageB.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return { registered: Boolean(registration), installing: registration?.installing?.state ?? null,
      waiting: registration?.waiting?.state ?? null, active: registration?.active?.state ?? null,
      controller: Boolean(navigator.serviceWorker.controller) };
  });
  await until(async () => (swState = await readSw()).active === "activated", "service worker activated", 30000)
    .catch((error) => { throw new Error(`${error.message}: ${JSON.stringify(swState)}`); });
  await pageB.reload();
  await pageB.waitForFunction(() => navigator.serviceWorker.controller !== null);
  assert(contextB.serviceWorkers().length >= 1);
  record("Service worker: the built sw.js registers, activates, and controls the page after reload (serviceWorkers: allow).");

  const rememberB = pageB.locator("#remember-input");
  const kwB = pageB.locator("#remember-keywords");
  const formB = pageB.locator("form").filter({ has: rememberB });
  const addKeywordB = async (...values) => { for (const value of values) { await kwB.pressSequentially(value); await kwB.press("Enter"); } };
  const fileB = () => pageB.locator('main input[type="file"]').first();
  const card = (name, text) => pageB.getByRole("listitem", { name }).filter({ hasText: text });
  await contextB.setOffline(true);
  await pageB.reload();
  await rememberB.waitFor();
  const offlineBody = "Offline capture in the basement";
  await rememberB.fill(offlineBody);
  await addKeywordB("Basement", "Offline");
  await fileB().setInputFiles(fixturePhoto);
  await formB.locator("img").first().waitFor();
  await formB.getByRole("button", { name: "Save", exact: true }).click();
  await card("Waiting to upload", offlineBody).waitFor();
  await card("Waiting to upload", offlineBody).getByText("Offline", { exact: true }).waitFor();
  const draftBody = "Draft kept across an offline reload";
  await rememberB.fill(draftBody);
  await addKeywordB("Draftkey");
  await kwB.pressSequentially("half");
  await fileB().setInputFiles(fixturePhoto);
  await formB.locator("img").first().waitFor();
  await sleep(300);
  await pageB.reload();
  await rememberB.waitFor();
  await until(async () => (await rememberB.inputValue()) === draftBody, "draft text restored");
  await until(async () => (await formB.locator("img").count()) === 1, "draft photo restored");
  assert.deepEqual(await pillsIn(formB), ["Draftkey"]);
  assert.equal(await kwB.inputValue(), "half");
  await card("Waiting to upload", offlineBody).waitFor();
  await shot(pageB, "sw-offline-reload");
  record("Offline (service worker serving the app): a capture with photo and pills is queued; reloading offline restores the queued item and the unfinished draft's text, pills, keyword input and photo.");

  const createsBefore = createRequests;
  serverState.rejectNextCreate = true;
  await contextB.setOffline(false);
  await pageB.evaluate(() => window.dispatchEvent(new Event("online")));
  await card("Not saved", offlineBody).waitFor();
  assert.equal(byBody(store, offlineBody).length, 0);
  pageB.once("dialog", (prompt) => void prompt.accept());
  await card("Not saved", offlineBody).getByRole("button", { name: "Edit", exact: true }).click();
  await until(async () => (await rememberB.inputValue()) === offlineBody, "rejected item in form");
  assert.deepEqual(await pillsIn(formB), ["Basement", "Offline"]);
  assert.equal(await formB.locator("img").count(), 1);
  await pageB.reload();
  await until(async () => (await rememberB.inputValue()) === offlineBody, "edited rejected item survives reload");
  assert.deepEqual(await pillsIn(formB), ["Basement", "Offline"]);
  await until(async () => (await formB.locator("img").count()) === 1, "rejected photo survives reload");
  await rememberB.fill(`${offlineBody}, shelf 2`);
  await addKeywordB("Shelf");
  await formB.getByRole("button", { name: "Save", exact: true }).click();
  await until(() => byBody(store, `${offlineBody}, shelf 2`).length === 1, "corrected capture saved");
  const corrected = byBody(store, `${offlineBody}, shelf 2`)[0];
  assert.deepEqual(corrected.customKeywords, ["Basement", "Offline", "Shelf"]);
  assert.equal(corrected.photos.length, 1);
  assert.equal(createRequests, createsBefore + 2);
  record("Reconnect: the server refused the queued upload (413); Edit restored body, photo and pills into the durable draft (surviving a reload); the corrected capture arrived once with photo and keywords together.");

  const legacy = { clientId: "legacy-old-client-0001", body: "Legacy queued from the old client", createdAt: Date.now(), photos: [] };
  await pageB.evaluate((item) => new Promise((resolveDb, rejectDb) => {
    const request = indexedDB.open("recall");
    request.onerror = () => rejectDb(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const tx = database.transaction("outbox", "readwrite");
      tx.objectStore("outbox").put(item, item.clientId);
      tx.oncomplete = () => { database.close(); resolveDb(); };
      tx.onerror = () => rejectDb(tx.error);
    };
  }), legacy);
  await pageB.reload();
  await until(() => byBody(store, legacy.body).length === 1, "legacy queued item uploaded");
  assert.deepEqual(byBody(store, legacy.body)[0].customKeywords, []);
  record("An old client's queued record (no customKeywords field) loads in the new client and uploads once as an empty keyword list.");

  // Mixed versions: the real baseline server (schema v4, ignores customKeywords, no capability).
  const old = await loadBaseline(join(dir, "baseline"));
  const oldFile = join(dir, "old-v4.db");
  const oldDb = old.openDb(oldFile);
  extraDbs.push(oldDb);
  assert.equal(oldDb.pragma("user_version", { simple: true }), 4);
  const oldStore = new old.MemoryStore(oldDb, new old.PhotoStore(join(dir, "old-photos")), now);
  const oldSearch = new old.SearchIndex(oldDb, embedder(), now);
  oldSearch.attach(oldStore);
  serverState.oldApp = old.createApp({ config, store: oldStore, search: oldSearch, now, log: () => {}, accessLog: () => {} });
  serverState.active = serverState.oldApp;
  const unsupportedBody = "Held while the server is old";
  await rememberB.fill(unsupportedBody);
  await addKeywordB("Garage");
  const createsOld = createRequests;
  await formB.getByRole("button", { name: "Save", exact: true }).click();
  await card("Needs reconciliation", unsupportedBody).waitFor();
  assert.equal(createRequests, createsOld, "nothing uploaded to a server without keyword capture");
  serverState.active = newApp;
  serverState.splitCreateToOld = true;
  const mixedBody = "Mixed rollout capture";
  await rememberB.fill(mixedBody);
  await addKeywordB("Christmas", "Ornaments");
  await fileB().setInputFiles(fixturePhoto);
  await formB.locator("img").first().waitFor();
  await formB.getByRole("button", { name: "Save", exact: true }).click();
  await card("Needs reconciliation", mixedBody).waitFor();
  await card("Needs reconciliation", mixedBody).getByRole("button", { name: "Recover keywords", exact: true }).waitFor();
  assert.equal(createRequests, createsOld + 1);
  const oldRecord = oldStore.all().find((memory) => memory.body === mixedBody);
  assert.deepEqual(oldRecord.customKeywords, []);
  assert.equal(oldRecord.photos.length, 1);
  serverState.splitCreateToOld = false;
  for (let i = 0; i < 3; i++) {
    await pageB.evaluate(() => { window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); });
    await sleep(300);
  }
  assert.equal(createRequests, createsOld + 1, "held items are never retried automatically");
  await card("Needs reconciliation", mixedBody).getByText("Ornaments", { exact: true }).waitFor();
  await shot(pageB, "sw-held");
  // KP-03: recovering the possibly-saved capture while the server is old again must not turn it into an
  // editable "never uploaded" item; it stays reconcilable by its original clientId, also after a reload.
  serverState.active = serverState.oldApp;
  const createsDowngrade = createRequests;
  await card("Needs reconciliation", mixedBody).getByRole("button", { name: "Recover keywords", exact: true }).click();
  await pageB.getByText("Still held on this phone. Nothing was lost; see the note below.", { exact: true }).waitFor();
  const assertNotEditable = async () => {
    await card("Needs reconciliation", mixedBody).getByText("Recall may already have this memory", { exact: false }).waitFor();
    assert.equal(await card("Needs reconciliation", mixedBody).getByRole("button", { name: "Edit", exact: true }).count(), 0);
    assert.equal(await card("Needs reconciliation", mixedBody).getByRole("button", { name: "Try again", exact: true }).count(), 0);
    await card("Needs reconciliation", mixedBody).getByRole("button", { name: "Recover keywords", exact: true }).waitFor();
    // The never-uploaded capture remains the only editable one.
    await card("Needs reconciliation", unsupportedBody).getByRole("button", { name: "Edit", exact: true }).waitFor();
  };
  await assertNotEditable();
  await pageB.reload();
  await rememberB.waitFor();
  await assertNotEditable();
  assert.equal(createRequests, createsDowngrade, "no upload while recovering against an old server");
  serverState.active = newApp;
  await pageB.reload();
  await rememberB.waitFor();
  record("Recovering the possibly-saved (unverified) capture against the old server again keeps it Needs reconciliation with only Recover keywords (no Edit, no new clientId, no upload), also after a reload; only the never-uploaded capture offers Edit.");

  // KP-02: during a split rollout the old instance creates the recall but its response is lost. The recall is then
  // edited elsewhere (Garage added with Shelf, then Garage removed) and the retry receives 200 with that edited record.
  const lostOldBody = "Split rollout capture with a lost response";
  serverState.splitCreateToOld = true;
  serverState.dropNextCreateResponse = true;
  const createsLostOld = createRequests;
  await rememberB.fill(lostOldBody);
  await addKeywordB("Garage", "Porch");
  await fileB().setInputFiles(fixturePhoto);
  await formB.locator("img").first().waitFor();
  await formB.getByRole("button", { name: "Save", exact: true }).click();
  await card("Waiting to upload", lostOldBody).waitFor();
  // The card appears once stored locally; wait for the lost first request to reach the old instance and settle.
  await until(() => !serverState.dropNextCreateResponse && oldStore.all().some((memory) => memory.body === lostOldBody), "lost create reached the old instance");
  await pageB.getByText("Saved on this phone. It will upload when you're online.", { exact: false }).waitFor();
  const lostOld = oldStore.all().find((memory) => memory.body === lostOldBody);
  assert(lostOld && lostOld.photos.length === 1 && lostOld.customKeywords.length === 0, "the old instance saved it without keywords");
  await oldStore.update(lostOld.id, { customKeywords: ["Garage", "Shelf"] });
  await oldStore.update(lostOld.id, { body: `${lostOldBody}, moved to the attic`, customKeywords: ["Shelf"] });
  await pageB.evaluate(() => window.dispatchEvent(new Event("online")));
  const lostOldCard = () => card("Needs reconciliation", lostOldBody);
  await lostOldCard().getByRole("button", { name: "Recover keywords", exact: true }).waitFor();
  serverState.splitCreateToOld = false;
  assert.equal(createRequests, createsLostOld + 2, "the lost create and one same-clientId retry");
  assert.equal(oldStore.all().filter((memory) => memory.body.startsWith(lostOldBody)).length, 1);
  assert.equal(await lostOldCard().getByRole("button", { name: "Edit", exact: true }).count(), 0);
  await pageB.reload();
  await rememberB.waitFor();
  await lostOldCard().getByText("Porch", { exact: true }).waitFor();
  await lostOldCard().getByRole("button", { name: "Recover keywords", exact: true }).waitFor();
  assert.equal(await lostOldCard().locator("img").count(), 1);
  record("Split rollout with a lost response: the old instance saved body+photo, the recall was edited elsewhere (Garage added, then removed; Shelf kept), and the retry's 200 returned the edited record; the capture is held as Needs reconciliation (no Edit) with body, photo and Garage/Porch kept across a reload.");
  serverState.stripShapes = true;
  await pageB.getByRole("tab", { name: "Recall", exact: true }).click();
  await pageB.locator("main > div:not([hidden])").getByText(corrected.body, { exact: true }).waitFor();
  await pageB.locator("main > div:not([hidden])").getByRole("button").filter({ hasText: corrected.body }).first().click();
  await pageB.getByRole("dialog", { name: "Memory", exact: true }).getByLabel("Custom keywords", { exact: true }).waitFor();
  await pageB.getByRole("dialog", { name: "Memory", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  serverState.stripShapes = false;
  await pageB.getByRole("tab", { name: "Remember", exact: true }).click();
  assert.deepEqual(errorsB, []);
  record("Mixed versions: against the real baseline server the keyword capture is held (nothing uploaded); during a split rollout the old version saved body+photo but dropped keywords on a 201, so the client held it as Needs reconciliation; no automatic retries on online/visibility events; responses without pinned/customKeywords render without errors.");

  // Server upgrade: forward-migrate the old server's v4 database, plus a later edit from another device.
  oldDb.close();
  const upgradedDb = openDb(oldFile);
  extraDbs.push(upgradedDb);
  assert.equal(upgradedDb.pragma("user_version", { simple: true }), 5);
  const upgradedStore = new MemoryStore(upgradedDb, new PhotoStore(join(dir, "old-photos")), now);
  const upgradedSearch = new SearchIndex(upgradedDb, embedder(), now);
  upgradedSearch.attach(upgradedStore);
  await upgradedSearch.init();
  serverState.active = createApp({ config, store: upgradedStore, search: upgradedSearch, now, log: () => {}, accessLog: () => {} });
  await upgradedStore.update(oldRecord.id, { body: "Mixed rollout capture, moved to the hall closet", customKeywords: ["Shelf"] });

  // A new client deployment: a changed sw.js installs, the banner offers Reload, and local data survives it.
  await rememberB.fill("Draft that must survive the update");
  await addKeywordB("Survivor");
  await sleep(300);
  const startsBeforeUpdate = workerStarts;
  await appendFile(join(web, "sw.js"), `\n// fictional deployment ${Date.now()}\n`);
  await pageB.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
  await pageB.getByText("A new version of Recall is ready.", { exact: true }).waitFor();
  await shot(pageB, "sw-update-banner");
  await pageB.getByRole("button", { name: "Reload", exact: true }).click();
  await until(async () => {
    try {
      return await pageB.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return Boolean(navigator.serviceWorker.controller) && registration?.waiting === null && registration?.active?.state === "activated"
          && document.querySelector("#remember-input") !== null;
      });
    } catch { return false; }
  }, "updated worker controls the reloaded page");
  await pageB.getByText("A new version of Recall is ready.", { exact: true }).waitFor({ state: "hidden" });
  assert(workerStarts > startsBeforeUpdate, "a new service worker started");
  await until(async () => (await rememberB.inputValue()) === "Draft that must survive the update", "draft after update");
  assert.deepEqual(await pillsIn(formB), ["Survivor"]);
  await card("Needs reconciliation", unsupportedBody).waitFor();
  await card("Needs reconciliation", mixedBody).waitFor();
  await card("Needs reconciliation", lostOldBody).waitFor();
  record("Service worker update: a changed sw.js installed and waited, the real update banner appeared, Reload activated the new worker; the held items and the draft survived without clearing site storage.");

  const createsRecover = createRequests;
  // KP-02: the recall changed after the old server saved it without keywords, so recovery asks instead of merging.
  await card("Needs reconciliation", mixedBody).getByRole("button", { name: "Recover keywords", exact: true }).click();
  const conflictCard = card("Needs reconciliation", mixedBody);
  await conflictCard.getByRole("button", { name: "Add missing keywords", exact: true }).waitFor();
  await conflictCard.getByText("Christmas, Ornaments", { exact: true }).waitFor();
  await conflictCard.getByRole("definition").filter({ hasText: /^Shelf$/ }).waitFor();
  assert.deepEqual(upgradedStore.require(oldRecord.id).customKeywords, ["Shelf"]);
  assert.equal(await conflictCard.getByRole("button", { name: "Edit", exact: true }).count(), 0);
  await shot(pageB, "sw-conflict");
  await conflictCard.getByRole("button", { name: "Add missing keywords", exact: true }).click();
  await card("Needs reconciliation", mixedBody).waitFor({ state: "hidden" });
  const reconciled = upgradedStore.all().filter((memory) => memory.photos.length === 1 && memory.id === oldRecord.id);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].body, "Mixed rollout capture, moved to the hall closet");
  assert.deepEqual(reconciled[0].customKeywords, ["Shelf", "Christmas", "Ornaments"]);
  assert.equal(upgradedStore.all().filter((memory) => memory.body.startsWith("Mixed rollout capture")).length, 1);
  assert.equal(usage(upgradedStore, "christmas").count, 1);
  await card("Needs reconciliation", unsupportedBody).getByRole("button", { name: "Try again", exact: true }).click();
  await card("Needs reconciliation", unsupportedBody).waitFor({ state: "hidden" });
  assert.equal(byBody(upgradedStore, unsupportedBody).length, 1);
  assert.deepEqual(byBody(upgradedStore, unsupportedBody)[0].customKeywords, ["Garage"]);
  assert.equal(createRequests, createsRecover + 1, "only the never-uploaded capture was created");
  assert.equal(await rememberB.inputValue(), "Draft that must survive the update");
  await shot(pageB, "sw-recovered");
  assert.deepEqual(errorsB, []);
  record("Recovery after the upgrade (v4 database forward-migrated to v5): the recall had been edited since the old server saved it, so Recover keywords showed an explicit conflict (Recall has Shelf; missing Christmas, Ornaments) without changing it; Add missing keywords then reconciled the original clientId once, keeping the later body edit; Try again uploaded the never-sent capture exactly once with its keyword.");

  // KP-02 after the upgrade: the retry's 200 timestamp is not proof, so recovery must ask instead of restoring Garage.
  const lostRow = upgradedDb.prepare(`SELECT client_id FROM memories WHERE id = ?`).get(lostOld.id);
  const lostEdited = upgradedStore.require(lostOld.id);
  const createsKeep = createRequests;
  const reconcileDirect = async (extra) => (await pageB.request.post(`${origin}/api/memories/reconcile`, {
    headers: { origin }, data: { clientId: lostRow.client_id, customKeywords: ["Garage", "Porch"], ...extra } })).json();
  await lostOldCard().getByRole("button", { name: "Recover keywords", exact: true }).click();
  await lostOldCard().getByRole("button", { name: "Keep Recall's version", exact: true }).waitFor();
  await lostOldCard().getByText("Garage, Porch", { exact: true }).waitFor();
  await lostOldCard().getByRole("definition").filter({ hasText: /^Shelf$/ }).waitFor();
  assert.deepEqual(upgradedStore.require(lostOld.id), lostEdited, "no silent restoration of Garage");
  // A repeated recovery, even offering the edited record's current updatedAt, is still only a conflict.
  const repeated = await reconcileDirect({ expectedUpdatedAt: lostEdited.updatedAt });
  assert.equal(repeated.status, "conflict");
  assert.deepEqual(upgradedStore.require(lostOld.id), lostEdited);
  await shot(pageB, "sw-conflict-lost-response");
  await lostOldCard().getByRole("button", { name: "Keep Recall's version", exact: true }).click();
  await lostOldCard().waitFor({ state: "hidden" });
  const kept = upgradedStore.require(lostOld.id);
  assert.deepEqual(kept.customKeywords, ["Shelf"]);
  assert.equal(kept.body, `${lostOldBody}, moved to the attic`);
  assert.equal(kept.photos.length, 1);
  assert.equal(upgradedStore.all().filter((memory) => memory.body.startsWith(lostOldBody)).length, 1);
  assert.equal((await reconcileDirect({})).status, "already-saved");
  assert.deepEqual(upgradedStore.require(lostOld.id).customKeywords, ["Shelf"]);
  assert.equal(createRequests, createsKeep, "recovery never created another recall");
  assert.deepEqual(errorsB, []);
  record("Lost-response capture after the upgrade: Recover keywords showed an explicit conflict (Recall has Shelf; missing Garage, Porch) without restoring the removed Garage, also on a repeated recovery offering the retry's timestamp; Keep Recall's version kept the later body, Shelf and photo with one recall, and a further recovery is already-saved.");

  // KP-03: an upload that reached the server but lost its response, followed by capability loss (a stale old
  // instance answers /api/me), is held as reconcilable rather than editable, then resolves without a duplicate.
  const staleDb = old.openDb(join(dir, "old-stale-v4.db"));
  extraDbs.push(staleDb);
  const staleStore = new old.MemoryStore(staleDb, new old.PhotoStore(join(dir, "old-stale-photos")), now);
  const staleSearch = new old.SearchIndex(staleDb, embedder(), now);
  serverState.meFrom = null;
  const lostBody = "Interrupted then capability lost";
  const createsLost = createRequests;
  await formB.getByRole("button", { name: "Remove keyword Survivor", exact: true }).click();
  serverState.dropNextCreateResponse = true;
  await rememberB.fill(lostBody);
  await addKeywordB("Lamp");
  await formB.getByRole("button", { name: "Save", exact: true }).click();
  await card("Waiting to upload", lostBody).waitFor();
  await until(() => !serverState.dropNextCreateResponse && byBody(upgradedStore, lostBody).length === 1, "first request reached the server");
  await pageB.getByText("Saved on this phone. It will upload when you're online.", { exact: false }).waitFor();
  assert.equal(byBody(upgradedStore, lostBody).length, 1, "the first request reached the server");
  serverState.meFrom = old.createApp({ config, store: staleStore, search: staleSearch, now, log: () => {}, accessLog: () => {} });
  await pageB.evaluate(() => window.dispatchEvent(new Event("online")));
  const lostCard = () => card("Needs reconciliation", lostBody);
  await lostCard().getByRole("button", { name: "Recover keywords", exact: true }).waitFor();
  assert.equal(await lostCard().getByRole("button", { name: "Edit", exact: true }).count(), 0);
  await pageB.reload();
  await rememberB.waitFor();
  await lostCard().getByRole("button", { name: "Recover keywords", exact: true }).waitFor();
  assert.equal(await lostCard().getByRole("button", { name: "Edit", exact: true }).count(), 0);
  assert.equal(createRequests, createsLost + 1);
  serverState.meFrom = null;
  await lostCard().getByRole("button", { name: "Recover keywords", exact: true }).click();
  await lostCard().waitFor({ state: "hidden" });
  assert.equal(byBody(upgradedStore, lostBody).length, 1);
  assert.deepEqual(byBody(upgradedStore, lostBody)[0].customKeywords, ["Lamp"]);
  assert.equal(usage(upgradedStore, "lamp").count, 1);
  assert.equal(createRequests, createsLost + 1, "recovery reconciled instead of uploading again");
  assert.deepEqual(errorsB, []);
  staleDb.close();
  record("Interrupted upload (server saved it, response lost) followed by capability loss: held as Needs reconciliation with Recover keywords and no Edit, across a reload; recovery reconciled the original clientId (already saved) with one recall, one count and no second upload.");
  upgradedDb.close();

  console.log(JSON.stringify({ viewport: "390x844", mobile: true, touch: true, touchAfterReload, observations, pageErrors: [...errors, ...errorsB],
    baseline: BASELINE, screenshots,
    limitation: "Chromium 390x844 mobile/touch emulation; not a physical iPhone or Safari test. No external or paid providers used. The mixed rollout routes one create to the baseline server at the HTTP layer of this harness." }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: join(output, "memory-features-failure.png"), fullPage: true }).catch(() => {});
  if (pageB) await pageB.screenshot({ path: join(output, "memory-features-failure-b.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  for (const database of [db, ...extraDbs]) if (database.open) database.close();
  // Resolve and verify our own unique fixture directory before recursive cleanup.
  const targetDir = resolve(dir);
  assert(targetDir.startsWith(output + sep) && targetDir !== output);
  // A cleanup problem is reported but must never hide the rehearsal's own result or error.
  await rm(targetDir, { recursive: true, force: true }).catch((error) => console.error(`Cleanup failed: ${error.message}`));
}
