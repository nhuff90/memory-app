// Local-only browser acceptance checks. Requires a completed npm.cmd run build.
// node scripts/verify-memory-features.mjs --playwright <index.mjs> --browser <chrome.exe>
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "../dist/server/src/app.js";
import { openDb } from "../dist/server/src/db.js";
import { MemoryStore } from "../dist/server/src/memories.js";
import { PhotoStore } from "../dist/server/src/photos.js";
import { SearchIndex } from "../dist/server/src/search.js";
import { hashPasswordSync } from "../dist/server/src/password.js";

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const playwrightPath = process.argv.includes("--playwright") ? arg("--playwright") : process.env.RECALL_PLAYWRIGHT_PATH;
const browserPath = process.argv.includes("--browser") ? arg("--browser") : process.env.RECALL_BROWSER_PATH;
const { chromium } = await import(playwrightPath ? pathToFileURL(resolve(playwrightPath)).href : "playwright");
const output = resolve("screenshots");
await mkdir(output, { recursive: true });
// All temporary files stay inside this ignored directory. Never load .env or the normal server entrypoint.
const dir = await mkdtemp(join(output, "memory-features-fixture-"));
const db = openDb(join(dir, "recall.db"));
const photos = new PhotoStore(join(dir, "photos"));
const store = new MemoryStore(db, photos);
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
const search = new SearchIndex(db, {
  model: "local-browser-fictional",
  embedDocuments: async (texts) => { documentCalls += texts.length; return texts.map(vector); },
  embedQuery: async (text) => vector(text),
});
search.attach(store);
const save = async (body, patch) => {
  const { memory } = await store.create({ body });
  return patch ? store.update(memory.id, patch) : memory;
};
const source = await save("Amber toolbox is in the garage.", { category: "things", pinned: true, customKeywords: ["weekend kit"] });
const target = await save("Amber toolbox has a spare compass.", { category: "work" });
const third = await save("Amber toolbox inventory list.", { category: "hobbies", pinned: true });
const outdated = await save("Amber toolbox outdated location.", { archived: true, pinned: true });
const lonely = await save("Saffron origami cranes.");
await save("Mira likes the lake.", { category: "people" });
const llmRequests = [];
const app = createApp({
  config: {
    production: false, port: 0, dataDir: dir, modelDir: join(dir, "models"), webDist: resolve("dist/web"),
    passwordHash: hashPasswordSync("fictional-local-password"), usingDevPassword: false,
    sessionSecret: "fictional-browser-secret-at-least-32-characters", anthropicApiKey: null,
    model: "fake-browser-provider", timeZone: "America/New_York",
  }, store, search,
  llm: { model: "fake-browser-provider", complete: async (request) => {
    llmRequests.push(request);
    return { json: { answer: "The fictional toolbox has a spare compass.", used_ids: [target.id] },
      model: "fake-browser-provider", inputTokens: 0, outputTokens: 0, stopReason: "end_turn" };
  } },
  log: () => {}, accessLog: () => {},
});
let server;
let browser;
let page;
const observations = [];
const record = (text) => { observations.push(text); console.log(`PASS ${text}`); };
try {
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: resolve(browserPath) } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
    isMobile: true, hasTouch: true, serviceWorkers: "block" });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Prevent any external page requests; providers above are deterministic and local.
  await page.route("**/*", (route) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(origin);
  await page.getByLabel("Password", { exact: true }).fill("fictional-local-password");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.getByRole("tab", { name: "Recall", exact: true }).click();
  const filter = (name) => page.getByRole("group", { name: "Show only" }).getByRole("button", { name, exact: true });
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
  await page.screenshot({ path: join(output, "memory-features-pinned-search.png"), fullPage: true });
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
  assert.equal(store.require(source.id).body, source.body);
  assert.deepEqual(store.require(source.id).customKeywords, ["weekend kit"]);
  assert.equal(documentCalls, savedCalls);
  await dialog().getByRole("button", { name: "Pin", exact: true }).click();
  await dialog().getByRole("button", { name: "Unpin", exact: true }).waitFor();
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await body().inputValue(), source.body);
  assert.equal(await keywords().inputValue(), "weekend kit");
  record("Pin and Unpin persist without saving or losing dirty text/keywords or recomputing embeddings; Cancel restores both drafts.");

  await keywords().fill("x".repeat(41));
  await dialog().getByRole("alert").filter({ hasText: "40 characters" }).waitFor();
  assert(await dialog().getByRole("button", { name: "Save changes", exact: true }).isDisabled());
  await keywords().fill(Array.from({ length: 11 }, (_, i) => `key${i}`).join(","));
  await dialog().getByRole("alert").filter({ hasText: "10 custom keywords" }).waitFor();
  await body().fill("Amber toolbox is in the studio.");
  await keywords().fill(" Star Map, ,STAR MAP,  Workshop ");
  await dialog().getByRole("button", { name: "Save changes", exact: true }).click();
  await dialog().getByRole("button", { name: /^(Save changes|Saving…)$/ }).waitFor({ state: "hidden" });
  assert.equal(store.require(source.id).body, "Amber toolbox is in the studio.");
  assert.deepEqual(store.require(source.id).customKeywords, ["Star Map", "Workshop"]);
  assert.equal(await keywords().inputValue(), "Star Map, Workshop");
  await related().getByText(target.body, { exact: true }).waitFor();
  await close();
  await query.fill("Workshop");
  await waitResults();
  await recall.getByText("Amber toolbox is in the studio.", { exact: true }).waitFor();
  await open("Amber toolbox is in the studio.");
  const keywordCalls = documentCalls;
  await keywords().fill("Star Map");
  await dialog().getByRole("button", { name: "Save changes", exact: true }).click();
  await dialog().getByRole("button", { name: /^(Save changes|Saving…)$/ }).waitFor({ state: "hidden" });
  assert.equal(documentCalls, keywordCalls);
  await close();
  await page.getByText("Nothing found for", { exact: false }).waitFor();
  record("Keyword validation enforces both limits; Save changes normalizes/deduplicates and saves body/keywords together; keyword removal updates Pinned search without embedding.");

  await query.fill("");
  await open("Amber toolbox is in the studio.");
  await related().getByText(target.body, { exact: true }).waitFor();
  // Keyword-only dirtiness blocks close; combined dirtiness blocks related navigation.
  await keywords().fill("unsaved keyword");
  page.once("dialog", (prompt) => { assert.equal(prompt.message(), "Discard your changes?"); void prompt.dismiss(); });
  await dialog().getByRole("button", { name: "Close", exact: true }).click();
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
  await page.screenshot({ path: join(output, "memory-features-related-navigation.png"), fullPage: true });
  await close();
  record("Keyword-only close and combined text/keyword related navigation prompt for discard; declining preserves edits; accepting replaces the existing sheet with one dialog.");

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
  await page.screenshot({ path: join(output, "memory-features-related-error.png"), fullPage: true });
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
  await page.screenshot({ path: join(output, "memory-features-related-loading.png"), fullPage: true });
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
  await page.screenshot({ path: join(output, "memory-features-related-empty.png"), fullPage: true });
  await close();
  await page.unroute(relatedRoute, handler);
  await open("Amber toolbox is in the studio.");
  await related().getByText(target.body, { exact: true }).waitFor();
  await related().getByRole("button").filter({ hasText: target.body }).click();
  assert.equal(await body().inputValue(), target.body);
  record("Related loading/error leaves the memory usable; retry recovers; empty state renders; a late response from a closed memory cannot replace another memory; subsequent related navigation recovers.");
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.innerWidth), 390);
  assert.equal(await page.evaluate(() => window.innerHeight), 844);
  assert.equal(await page.evaluate(() => navigator.maxTouchPoints > 0), true);
  console.log(JSON.stringify({ viewport: "390x844", mobile: true, touch: true, observations, pageErrors: errors,
    screenshots: ["pinned-search", "related-navigation", "related-error", "related-loading", "related-empty"].map((name) => `screenshots/memory-features-${name}.png`),
    limitation: "Chromium mobile emulation; not a physical iPhone test. No external or paid providers used." }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: join(output, "memory-features-failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  db.close();
  // Resolve and verify our own unique fixture directory before recursive cleanup.
  const targetDir = resolve(dir);
  assert(targetDir.startsWith(output + sep) && targetDir !== output);
  await rm(targetDir, { recursive: true, force: true });
}
