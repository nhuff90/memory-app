import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoginLimiter } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { hashPasswordSync, parsePasswordHash, verifyPassword } from "../src/password.js";
import { client, DAY, login, makeContext, sessionCookie, TEST_PASSWORD, type TestContext } from "./helpers.js";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function tryLogin(app: TestContext["app"], password: string) {
  return app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

const PROTECTED_ROUTES: [string, string][] = [
  ["GET", "/api/me"],
  ["GET", "/api/memories"],
  ["POST", "/api/memories"],
  ["GET", "/api/memories/1"],
  ["PATCH", "/api/memories/1"],
  ["DELETE", "/api/memories/1"],
  ["POST", "/api/memories/1/photos"],
  ["GET", "/api/photos/1"],
  ["DELETE", "/api/photos/1"],
  ["GET", "/api/search?q=ipad"],
  ["POST", "/api/ask"],
  ["POST", "/api/capture"],
  ["GET", "/api/usage"],
  ["GET", "/api/export"],
  ["PATCH", "/api/settings"],
  ["GET", "/api/tokens"],
  ["POST", "/api/tokens"],
  ["DELETE", "/api/tokens/1"],
  ["POST", "/api/logout"],
];

describe("login", () => {
  it("leaves only the health check public", async () => {
    ctx = makeContext();
    expect((await ctx.app.request("/api/health")).status).toBe(200);
    for (const [method, path] of PROTECTED_ROUTES) {
      const res = await ctx.app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("rejects a wrong password", async () => {
    ctx = makeContext();
    const res = await tryLogin(ctx.app, "not it");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("sets a long-lived, script-proof cookie on success", async () => {
    ctx = makeContext();
    const res = await tryLogin(ctx.app, TEST_PASSWORD);
    expect(res.status).toBe(200);
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^recall_session=/);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain(`Max-Age=${365 * 24 * 60 * 60}`);
    expect(header).not.toContain("Secure");
  });

  it("marks the cookie Secure in production", async () => {
    ctx = makeContext({ config: { production: true } });
    const res = await tryLogin(ctx.app, TEST_PASSWORD);
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("locks login for 15 minutes after five wrong passwords", async () => {
    let now = Date.UTC(2026, 9, 31);
    ctx = makeContext({ app: { limiter: new LoginLimiter(5, 30, 15 * 60 * 1000, () => now) } });
    for (let attempt = 0; attempt < 5; attempt++) expect((await tryLogin(ctx.app, "guess")).status).toBe(401);

    const locked = await tryLogin(ctx.app, TEST_PASSWORD);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBe(15 * 60);

    now += 15 * 60 * 1000 + 1;
    expect((await tryLogin(ctx.app, TEST_PASSWORD)).status).toBe(200);
  });
});

describe("sessions", () => {
  it("lets a logged-in phone in", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    expect((await api.get("/api/me")).status).toBe(200);
  });

  it("rejects a tampered cookie", async () => {
    ctx = makeContext();
    const cookie = await login(ctx.app);
    const tampered = cookie.replace(/v1\.\d+/, "v1.1");
    expect((await client(ctx.app, tampered).get("/api/me")).status).toBe(401);
  });

  it("expires after a year and refreshes itself while in use", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));

    ctx.clock.now += 8 * DAY;
    const refreshed = await api.get("/api/me");
    expect(refreshed.status).toBe(200);
    expect(sessionCookie(refreshed)).toMatch(/^recall_session=/);

    ctx.clock.now += 400 * DAY;
    expect((await api.get("/api/me")).status).toBe(401);
  });

  it("clears the cookie on logout", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const res = await api.postJson("/api/logout", {});
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("blocks writes from other websites", async () => {
    ctx = makeContext();
    const api = client(ctx.app, await login(ctx.app));
    const body = JSON.stringify({ body: "ipad in gym" });
    const crossSite = await api.send("/api/memories", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", host: "recall.fly.dev" },
      body,
    });
    expect(crossSite.status).toBe(403);

    const sameSite = await api.send("/api/memories", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://recall.fly.dev", host: "recall.fly.dev" },
      body,
    });
    expect(sameSite.status).toBe(201);
  });
});

describe("login limiter", () => {
  it("also caps failures across many addresses", () => {
    const now = 1_000_000;
    const limiter = new LoginLimiter(5, 3, 60_000, () => now);
    limiter.recordFailure("a");
    limiter.recordFailure("b");
    expect(limiter.retryAfter("c")).toBe(0);
    limiter.recordFailure("c");
    expect(limiter.retryAfter("d")).toBe(60);
  });
});

describe("passwords and settings", () => {
  it("verifies hashes made by the hash-password script", async () => {
    const hash = hashPasswordSync("a long passphrase");
    expect(await verifyPassword("a long passphrase", hash)).toBe(true);
    expect(await verifyPassword("a long passphrasE", hash)).toBe(false);
    expect(() => parsePasswordHash("plaintext")).toThrow(/hash-password/);
  });

  it("requires a password hash and session secret in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/RECALL_PASSWORD_HASH and RECALL_SESSION_SECRET/);
    const config = loadConfig({
      NODE_ENV: "production",
      RECALL_PASSWORD_HASH: hashPasswordSync("a long passphrase"),
      RECALL_SESSION_SECRET: "x".repeat(40),
      RECALL_TIMEZONE: "America/New_York",
    });
    expect(config.usingDevPassword).toBe(false);
    expect(config.model).toBe("claude-haiku-5-5");
  });

  it("uses a known password in development", () => {
    const config = loadConfig({});
    expect(config.usingDevPassword).toBe(true);
    expect(config.anthropicApiKey).toBeNull();
  });

  it("rejects a bad time zone or short session secret", () => {
    expect(() => loadConfig({ RECALL_TIMEZONE: "Mars/Olympus" })).toThrow(/time zone/);
    expect(() => loadConfig({ RECALL_SESSION_SECRET: "short" })).toThrow(/32 characters/);
  });
});

describe("web app files", () => {
  it("serves the built app, with index.html for app routes", async () => {
    ctx = makeContext({
      setup: ({ config }) => {
        mkdirSync(join(config.webDist, "assets"), { recursive: true });
        writeFileSync(join(config.webDist, "index.html"), "<!doctype html><title>Recall</title>");
        writeFileSync(join(config.webDist, "assets", "app-123.js"), "console.log('hi')");
        return {};
      },
    });
    const index = await ctx.app.request("/");
    expect(index.status).toBe(200);
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(index.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await (await ctx.app.request("/recall")).text()).toContain("<title>Recall</title>");

    const asset = await ctx.app.request("/assets/app-123.js");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("content-type")).toContain("text/javascript");

    expect((await ctx.app.request("/missing.png")).status).toBe(404);
    expect((await ctx.app.request("/../secret.txt")).status).toBe(404);
  });
});
