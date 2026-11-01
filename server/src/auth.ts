import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";

export const SESSION_COOKIE = "recall_session";
const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const SESSION_REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type AuthInfo = { kind: "session" } | { kind: "token"; tokenId: number; timeZone: string | null };
export type AppEnv = { Variables: { auth: AuthInfo } };

export interface SessionSettings {
  sessionSecret: string;
  production: boolean;
}

function cookieOptions(settings: SessionSettings): CookieOptions {
  return {
    path: "/",
    httpOnly: true,
    secure: settings.production,
    sameSite: "Strict",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export async function startSession(c: Context, settings: SessionSettings, now: number): Promise<void> {
  await setSignedCookie(c, SESSION_COOKIE, `v1.${now}`, settings.sessionSecret, cookieOptions(settings));
}

export function endSession(c: Context, settings: SessionSettings): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", httpOnly: true, secure: settings.production, sameSite: "Strict" });
}

export async function readSession(c: Context, secret: string, now: number): Promise<{ issuedAt: number } | null> {
  const value = await getSignedCookie(c, secret, SESSION_COOKIE);
  if (!value) return null;
  const match = /^v1\.(\d+)$/.exec(value);
  if (!match) return null;
  const issuedAt = Number(match[1]);
  if (issuedAt > now + 60_000 || now - issuedAt > SESSION_MAX_AGE_SECONDS * 1000) return null;
  return { issuedAt };
}

/** Fly's proxy sets Fly-Client-IP; elsewhere fall back to the socket address. */
export function clientIp(c: Context): string {
  const flyClientIp = c.req.header("fly-client-ip");
  if (flyClientIp) return flyClientIp;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Blocks login after repeated failures: per address, plus a global ceiling against many addresses. */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  private globalFailures: number[] = [];

  constructor(
    private readonly maxPerIp = 5,
    private readonly maxGlobal = 30,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until the next attempt is allowed, or 0 if one is allowed now. */
  retryAfter(ip: string): number {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const mine = (this.failures.get(ip) ?? []).filter((at) => at > cutoff);
    this.failures.set(ip, mine);
    this.globalFailures = this.globalFailures.filter((at) => at > cutoff);
    const blocking: number[] = [];
    if (mine.length >= this.maxPerIp) blocking.push(mine[mine.length - this.maxPerIp]!);
    if (this.globalFailures.length >= this.maxGlobal) {
      blocking.push(this.globalFailures[this.globalFailures.length - this.maxGlobal]!);
    }
    if (blocking.length === 0) return 0;
    const unblockAt = Math.max(...blocking) + this.windowMs;
    return Math.max(1, Math.ceil((unblockAt - now) / 1000));
  }

  recordFailure(ip: string): void {
    const now = this.now();
    this.failures.set(ip, [...(this.failures.get(ip) ?? []), now]);
    this.globalFailures.push(now);
  }

  reset(ip: string): void {
    this.failures.delete(ip);
  }
}

/**
 * Rejects cross-site writes. Browsers always send Origin on cross-site POSTs, so a mismatch means
 * another site is trying to use the session cookie. Requests without Origin (Siri Shortcuts, curl)
 * still need valid credentials.
 */
export const originCheck: MiddlewareHandler = async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  const origin = c.req.header("origin");
  if (!origin) return next();
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  if (!originHost || originHost !== c.req.header("host")) {
    return c.json({ error: "bad_origin", message: "Cross-site request blocked." }, 403);
  }
  return next();
};

export interface VerifiedToken {
  id: number;
  timeZone: string | null;
}

export interface TokenVerifier {
  verify(token: string): VerifiedToken | null;
}

export interface RequireAuthOptions extends SessionSettings {
  now: () => number;
  /** Bearer tokens (for Siri Shortcuts) are only accepted on these "METHOD /path" routes. */
  tokenRoutes?: ReadonlySet<string>;
  tokens?: TokenVerifier;
}

export function requireAuth(options: RequireAuthOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const now = options.now();
    const session = await readSession(c, options.sessionSecret, now);
    if (session) {
      c.set("auth", { kind: "session" });
      if (now - session.issuedAt > SESSION_REFRESH_AFTER_MS) await startSession(c, options, now);
      return next();
    }

    const header = c.req.header("authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
    if (bearer && options.tokens && options.tokenRoutes?.has(`${c.req.method} ${c.req.path}`)) {
      const verified = options.tokens.verify(bearer);
      if (verified) {
        c.set("auth", { kind: "token", tokenId: verified.id, timeZone: verified.timeZone });
        return next();
      }
      // Siri reads this out, so say what to do about it.
      return c.json(
        { error: "bad_token", message: "Recall doesn't know this key. Make a new one in Recall's Settings." },
        401,
      );
    }
    return c.json({ error: "unauthorized", message: "Please log in." }, 401);
  };
}
