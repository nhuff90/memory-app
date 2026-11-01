import { resolve } from "node:path";
import { hashPasswordSync, parsePasswordHash } from "./password.js";

export interface Config {
  production: boolean;
  port: number;
  dataDir: string;
  modelDir: string;
  webDist: string;
  passwordHash: string;
  usingDevPassword: boolean;
  sessionSecret: string;
  anthropicApiKey: string | null;
  model: string;
  timeZone: string;
}

export const DEV_PASSWORD = "recall";
export const DEFAULT_MODEL = "claude-haiku-5-5";
const DEV_SESSION_SECRET = "dev-only-session-secret-never-use-in-production";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const production = env.NODE_ENV === "production";
  const passwordHash = clean(env.RECALL_PASSWORD_HASH);
  const sessionSecret = clean(env.RECALL_SESSION_SECRET);

  if (production) {
    const missing = [
      passwordHash ? null : "RECALL_PASSWORD_HASH",
      sessionSecret ? null : "RECALL_SESSION_SECRET",
    ].filter((name) => name !== null);
    if (missing.length > 0) {
      throw new Error(`Missing ${missing.join(" and ")}. Run "npm run hash-password" to generate them.`);
    }
  }
  if (passwordHash) parsePasswordHash(passwordHash);
  if (sessionSecret && sessionSecret.length < 32) {
    throw new Error("RECALL_SESSION_SECRET must be at least 32 characters.");
  }

  const timeZone = clean(env.RECALL_TIMEZONE) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!isValidTimeZone(timeZone)) throw new Error(`RECALL_TIMEZONE "${timeZone}" is not a valid time zone.`);

  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT "${env.PORT}" is not a valid port.`);

  return {
    production,
    port,
    dataDir: resolve(cwd, env.RECALL_DATA_DIR ?? "data"),
    modelDir: resolve(cwd, env.RECALL_MODEL_DIR ?? "models"),
    webDist: resolve(cwd, env.RECALL_WEB_DIST ?? "dist/web"),
    passwordHash: passwordHash ?? hashPasswordSync(DEV_PASSWORD),
    usingDevPassword: !passwordHash,
    sessionSecret: sessionSecret ?? DEV_SESSION_SECRET,
    anthropicApiKey: clean(env.ANTHROPIC_API_KEY) ?? null,
    model: clean(env.RECALL_MODEL) ?? DEFAULT_MODEL,
    timeZone,
  };
}
