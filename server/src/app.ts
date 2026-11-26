import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { KEYWORD_CAPTURE_CAPABILITY, KEYWORD_RENAME_CAPABILITY } from "../../shared/keywords.js";
import {
  CATEGORIES,
  PHOTO_TEXT_CAPABILITY,
  type AskResponse,
  type CaptureResponse,
  type KeywordRenameResult,
  type KeywordVocabulary,
  type MeResponse,
  type MemoryList,
  type SearchResponse,
} from "../../shared/types.js";
import { UsageLog, type LlmClient } from "./ai.js";
import { AskService } from "./ask.js";
import {
  clientIp,
  endSession,
  LoginLimiter,
  originCheck,
  requireAuth,
  startSession,
  type AppEnv,
} from "./auth.js";
import { isValidTimeZone, type Config } from "./config.js";
import type { Enricher } from "./enrich.js";
import { badRequest, HttpError, notFound, tooLarge } from "./errors.js";
import { exportFileName, exportZip } from "./export.js";
import type { MemoryStore, PhotoUpload } from "./memories.js";
import { verifyPassword } from "./password.js";
import { MAX_PHOTO_BYTES, MAX_THUMB_BYTES } from "./photos.js";
import type { SearchIndex } from "./search.js";
import { SettingsStore } from "./settings.js";
import { staticFiles } from "./static.js";
import { TokenStore } from "./tokens.js";

export type Logger = (message: string, error?: unknown) => void;

export interface AppDeps {
  config: Config;
  store: MemoryStore;
  search: SearchIndex;
  /** Null when no Anthropic key is set; Ask is then switched off. */
  llm?: LlmClient | null;
  usage?: UsageLog;
  /** Background tagging and photo captions; null when Claude is off. */
  enricher?: Pick<Enricher, "sweep"> | null;
  settings?: SettingsStore;
  tokens?: TokenStore;
  limiter?: LoginLimiter;
  now?: () => number;
  log?: Logger;
  accessLog?: (line: string) => void;
}

type FormValue = string | File;
type ParsedForm = Record<string, FormValue | FormValue[]>;

const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const SAVED_PREVIEW_LENGTH = 80;
/** The only routes a Siri Shortcuts key opens. Everything else, including managing keys, needs the login cookie. */
const TOKEN_ROUTES: ReadonlySet<string> = new Set(["POST /api/capture", "POST /api/ask"]);

const loginBody = z.object({ password: z.string().min(1).max(1024) });
const captureBody = z.object({ text: z.string() });
const tokenBody = z.object({
  name: z.string().trim().min(1).max(60).default("Siri Shortcuts"),
  timeZone: z.string().max(64).optional(),
});
const settingsBody = z.object({ photoCaptions: z.boolean() }).strict();
const createBody = z.object({
  body: z.string().default(""),
  clientId: z.string().optional(),
  createdAt: z.number().optional(),
  customKeywords: z.array(z.string().max(1000)).max(100).optional(),
});
const reconcileBody = z
  .object({
    clientId: z.string(),
    customKeywords: z.array(z.string().max(1000)).max(100),
    /** The recall's updatedAt the device last saw (create response or conflict answer). */
    expectedUpdatedAt: z.number().nullable().optional(),
    resolution: z.enum(["add", "keep"]).nullable().optional(),
  })
  .strict();
const keywordRenameBody = z.object({ from: z.string().max(1000), to: z.string().max(1000) }).strict();
const keywordParam = z.string().max(200).optional();
const updateBody = z
  .object({
    body: z.string().optional(),
    pinned: z.boolean().optional(),
    customKeywords: z.array(z.string()).optional(),
    archived: z.boolean().optional(),
    category: z.enum(CATEGORIES).optional(),
  })
  .strict();
const searchQuery = z.object({
  pinned: z.enum(["0", "1"]).optional(),
  q: z.string().max(500).default(""),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  category: z.enum(CATEGORIES).optional(),
  archived: z.enum(["0", "1"]).optional(),
  strict: z.enum(["0", "1"]).optional(),
  keyword: keywordParam,
});
const askBody = z.object({
  question: z.string().trim().min(1).max(500),
  timeZone: z.string().max(64).optional(),
});
const listQuery = z.object({
  pinned: z.enum(["0", "1"]).optional(),
  cursor: z
    .string()
    .regex(/^\d+_\d+$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  category: z.enum(CATEGORIES).optional(),
  archived: z.enum(["0", "1"]).optional(),
  photos: z.enum(["0", "1"]).optional(),
  keyword: keywordParam,
});

function parseWith<T>(schema: z.ZodType<T>, data: unknown, message = "That request was not valid."): T {
  const result = schema.safeParse(data);
  if (!result.success) throw badRequest(message);
  return result.data;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest("That request was not valid JSON.");
  }
}

function parseId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
  return id;
}

function parseClientId(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(value)) throw badRequest("That save had an invalid id.");
  return value;
}

function parseCreatedAt(value: string | number | undefined): number | null {
  if (value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Siri reads this back after saving, so a misheard word gets noticed. */
function savedMessage(body: string): string {
  const preview =
    body.length <= SAVED_PREVIEW_LENGTH ? body : `${body.slice(0, SAVED_PREVIEW_LENGTH).replace(/\s+\S*$/, "")}…`;
  return `Saved: ${preview}`;
}

function isMultipart(c: Context): boolean {
  return (c.req.header("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
}

async function parseForm(c: Context): Promise<ParsedForm> {
  try {
    return (await c.req.parseBody({ all: true })) as ParsedForm;
  } catch {
    throw badRequest("Couldn't read that upload. Please try again.");
  }
}

function formValues(form: ParsedForm, name: string): FormValue[] {
  const value = form[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function formString(form: ParsedForm, name: string): string | undefined {
  const value = formValues(form, name)[0];
  return typeof value === "string" ? value : undefined;
}

/** Repeated `customKeywords` text fields. Absent for older clients, which means no keywords. */
function formKeywords(form: ParsedForm): string[] {
  const values = formValues(form, "customKeywords");
  if (values.length > 100 || values.some((value) => typeof value !== "string" || value.length > 1000)) {
    throw badRequest("That request was not valid.");
  }
  return values as string[];
}

async function formPhotos(form: ParsedForm): Promise<PhotoUpload[]> {
  const fulls = formValues(form, "photos").filter((value): value is File => typeof value !== "string");
  const thumbs = formValues(form, "thumbs").filter((value): value is File => typeof value !== "string");
  if (fulls.length !== thumbs.length) throw badRequest("Each photo needs a thumbnail.");
  for (const [index, full] of fulls.entries()) {
    if (full.size > MAX_PHOTO_BYTES || thumbs[index]!.size > MAX_THUMB_BYTES) throw tooLarge("That photo is too large.");
  }
  return Promise.all(
    fulls.map(async (full, index) => ({
      full: new Uint8Array(await full.arrayBuffer()),
      thumb: new Uint8Array(await thumbs[index]!.arrayBuffer()),
    })),
  );
}

function requestLog(log: (line: string) => void): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    const path = c.req.path;
    if (!path.startsWith("/api/") || path === "/api/health") return;
    // Paths only: query strings carry search text, which must never reach the logs.
    log(`${c.req.method} ${path} ${c.res.status} ${Math.round(performance.now() - started)}ms`);
  };
}

const uploadLimit = bodyLimit({
  maxSize: MAX_UPLOAD_BYTES,
  onError: (c) => c.json({ error: "too_large", message: "That upload is too large." }, 413),
});

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { config, store, search } = deps;
  const now = deps.now ?? Date.now;
  const log: Logger = deps.log ?? ((message, error) => console.error(message, error ?? ""));
  const limiter = deps.limiter ?? new LoginLimiter();
  const llm = deps.llm ?? null;
  const usage = deps.usage ?? new UsageLog(store.db, now);
  const settings = deps.settings ?? new SettingsStore(store.db);
  const tokens = deps.tokens ?? new TokenStore(store.db, now);
  const asker = new AskService({ store, search, llm, usage, now, log });
  const app = new Hono<AppEnv>();
  const timeZoneOr = (...choices: (string | null | undefined)[]) =>
    choices.find((timeZone) => timeZone && isValidTimeZone(timeZone)) ?? config.timeZone;
  const me = (): MeResponse => ({
    aiEnabled: llm !== null,
    model: llm?.model ?? null,
    photoCaptions: llm !== null && settings.photoCaptions(),
    counts: store.counts(),
    capabilities: [KEYWORD_CAPTURE_CAPABILITY, KEYWORD_RENAME_CAPABILITY, PHOTO_TEXT_CAPABILITY],
    photoText: { unread: store.countPhotosWithoutText(), requested: settings.readSavedPhotoText() },
  });

  app.use("*", requestLog(deps.accessLog ?? ((line) => console.log(line))));
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "blob:", "data:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      strictTransportSecurity: config.production ? "max-age=31536000; includeSubDomains" : false,
    }),
  );

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof HTTPException) return error.getResponse();
    log(`Unhandled error on ${c.req.method} ${c.req.path}`, error);
    return c.json({ error: "server_error", message: "Something went wrong. Please try again." }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.use("/api/*", originCheck);

  app.post("/api/login", async (c) => {
    const ip = clientIp(c);
    const retryAfter = limiter.retryAfter(ip);
    if (retryAfter > 0) {
      c.header("Retry-After", String(retryAfter));
      const minutes = Math.ceil(retryAfter / 60);
      return c.json(
        {
          error: "too_many_attempts",
          message: `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        },
        429,
      );
    }
    const { password } = parseWith(loginBody, await readJson(c), "Enter your password.");
    if (!(await verifyPassword(password, config.passwordHash))) {
      limiter.recordFailure(ip);
      return c.json({ error: "wrong_password", message: "That password didn't work." }, 401);
    }
    limiter.reset(ip);
    await startSession(c, config, now());
    return c.json({ ok: true });
  });

  app.use("/api/*", requireAuth({ ...config, now, tokens, tokenRoutes: TOKEN_ROUTES }));

  app.post("/api/logout", (c) => {
    endSession(c, config);
    return c.json({ ok: true });
  });

  app.get("/api/me", (c) => c.json(me()));

  app.patch("/api/settings", async (c) => {
    const { photoCaptions } = parseWith(settingsBody, await readJson(c));
    if (photoCaptions && !llm) throw badRequest("Photo descriptions need an Anthropic API key on the server.");
    settings.setPhotoCaptions(photoCaptions);
    if (photoCaptions) deps.enricher?.sweep();
    return c.json(me());
  });

  /**
   * Asks the server to read the text in photos described before photo text existed, once each. The request is
   * remembered: the reading runs only while Describe photos is on, and resumes when it's turned on again. Session
   * only: not a Siri key route.
   */
  app.post("/api/photo-text/read-saved", (c) => {
    if (!llm) throw badRequest("Reading text in photos needs an Anthropic API key on the server.");
    if (!settings.photoCaptions()) throw badRequest("Turn on Describe photos first.");
    settings.setReadSavedPhotoText(true);
    deps.enricher?.sweep();
    return c.json(me());
  });

  app.get("/api/tokens", (c) => c.json({ tokens: tokens.list() }));

  app.post("/api/tokens", async (c) => {
    const { name, timeZone } = parseWith(tokenBody, await readJson(c), "Give the key a name up to 60 characters.");
    return c.json(tokens.create(name, timeZone && isValidTimeZone(timeZone) ? timeZone : null), 201);
  });

  app.delete("/api/tokens/:id", (c) => {
    if (!tokens.revoke(parseId(c.req.param("id")))) throw notFound("That key was already removed.");
    return c.body(null, 204);
  });

  app.post("/api/ask", async (c) => {
    const { question, timeZone } = parseWith(askBody, await readJson(c), "Ask a question first.");
    const auth = c.get("auth");
    const result = await asker.ask(question, timeZoneOr(timeZone, auth.kind === "token" ? auth.timeZone : null));
    const response: AskResponse = { ...result, message: result.answer };
    return c.json(response);
  });

  /** Plain-text capture for Siri Shortcuts: `{ "text": "ipad in gym" }`. */
  app.post("/api/capture", async (c) => {
    const { text } = parseWith(captureBody, await readJson(c), 'Send the memory as JSON, like {"text": "ipad in gym"}.');
    if (!text.trim()) throw badRequest("There was nothing to save. Try again and say what to remember.");
    const { memory } = await store.create({ body: text });
    const response: CaptureResponse = { id: memory.id, message: savedMessage(memory.body) };
    return c.json(response, 201);
  });

  app.get("/api/usage", (c) => c.json(usage.summary(timeZoneOr(c.req.query("tz")))));

  app.get("/api/memories", (c) => {
    const query = parseWith(listQuery, c.req.query());
    const result: MemoryList = store.list({
      pinned: query.pinned === "1",
      cursor: query.cursor ?? null,
      limit: query.limit,
      category: query.category ?? null,
      includeArchived: query.archived === "1",
      withPhotosOnly: query.photos === "1",
      keyword: query.keyword ?? null,
    });
    return c.json(result);
  });

  app.post("/api/memories", uploadLimit, async (c) => {
    let input;
    if (isMultipart(c)) {
      const form = await parseForm(c);
      input = {
        body: formString(form, "body") ?? "",
        clientId: parseClientId(formString(form, "clientId")),
        createdAt: parseCreatedAt(formString(form, "createdAt")),
        customKeywords: formKeywords(form),
        photos: await formPhotos(form),
      };
    } else {
      const json = parseWith(createBody, await readJson(c));
      input = {
        body: json.body,
        clientId: parseClientId(json.clientId),
        createdAt: parseCreatedAt(json.createdAt),
        customKeywords: json.customKeywords ?? [],
      };
    }
    const { memory, created } = await store.create(input);
    return c.json(memory, created ? 201 : 200);
  });

  /** Recovers a capture held on a device (keywords an older server discarded) by its original clientId. */
  app.post("/api/memories/reconcile", async (c) => {
    const json = parseWith(reconcileBody, await readJson(c));
    const clientId = parseClientId(json.clientId);
    if (!clientId) throw badRequest("That save had an invalid id.");
    return c.json(
      await store.reconcile(clientId, json.customKeywords, {
        expectedUpdatedAt: json.expectedUpdatedAt ?? null,
        resolution: json.resolution ?? null,
      }),
    );
  });

  app.get("/api/keywords", (c) => c.json({ keywords: store.keywordVocabulary() } satisfies KeywordVocabulary));

  /** Renames a custom keyword on every recall, or merges it into an existing one. Session only: not a Siri key route. */
  app.post("/api/keywords/rename", async (c) => {
    const { from, to } = parseWith(keywordRenameBody, await readJson(c));
    return c.json((await store.renameKeyword(from, to)) satisfies KeywordRenameResult, 200);
  });

  app.get("/api/search", async (c) => {
    const query = parseWith(searchQuery, c.req.query());
    const hits = await search.search(query.q, {
      pinned: query.pinned === "1",
      limit: query.limit,
      category: query.category ?? null,
      includeArchived: query.archived === "1",
      strict: query.strict === "1",
      keyword: query.keyword ?? null,
    });
    const response: SearchResponse = { results: store.getMany(hits.map((hit) => hit.id)) };
    return c.json(response);
  });

  app.get("/api/memories/:id", (c) => c.json(store.require(parseId(c.req.param("id")))));

  app.get("/api/memories/:id/related", async (c) => {
    const results = await search.related(store, parseId(c.req.param("id")));
    return c.json({ results } satisfies SearchResponse);
  });

  app.patch("/api/memories/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const patch = parseWith(updateBody, await readJson(c));
    return c.json(await store.update(id, patch));
  });

  app.delete("/api/memories/:id", async (c) => {
    if (!(await store.delete(parseId(c.req.param("id"))))) throw notFound();
    return c.body(null, 204);
  });

  app.post("/api/memories/:id/photos", uploadLimit, async (c) => {
    const id = parseId(c.req.param("id"));
    if (!isMultipart(c)) throw badRequest("Send photos as a file upload.");
    const photos = await formPhotos(await parseForm(c));
    return c.json(await store.addPhotos(id, photos));
  });

  app.get("/api/photos/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    const size = c.req.query("size") === "thumb" ? "thumb" : "full";
    const path = store.photoPath(id, size);
    const bytes = path ? await store.photos.read(path).catch(() => null) : null;
    if (!bytes) throw notFound("That photo no longer exists.");
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });

  app.delete("/api/photos/:id", async (c) => c.json(await store.removePhoto(parseId(c.req.param("id")))));

  app.get("/api/export", (c) => {
    const timeZone = timeZoneOr(c.req.query("tz"));
    const at = now();
    return new Response(exportZip(store, at, timeZone, log), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${exportFileName(at, timeZone)}"`,
        "cache-control": "no-store",
      },
    });
  });

  app.all("/api/*", (c) => c.json({ error: "not_found", message: "Unknown API route." }, 404));

  if (existsSync(join(config.webDist, "index.html"))) app.use("*", staticFiles(config.webDist));

  return app;
}
