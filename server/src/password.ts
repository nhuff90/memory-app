import { randomBytes, scrypt as scryptCallback, scryptSync, timingSafeEqual, type ScryptOptions } from "node:crypto";

const LOG_N = 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 32;
const MAX_MEMORY = 128 * 1024 * 1024;

interface ParsedHash {
  logN: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function scryptOptions(logN: number, r: number, p: number): ScryptOptions {
  return { N: 2 ** logN, r, p, maxmem: MAX_MEMORY };
}

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function format(salt: Buffer, hash: Buffer): string {
  return ["scrypt", LOG_N, BLOCK_SIZE, PARALLELISM, salt.toString("base64url"), hash.toString("base64url")].join(":");
}

export function hashPasswordSync(password: string): string {
  const salt = randomBytes(16);
  return format(salt, scryptSync(password, salt, KEY_LENGTH, scryptOptions(LOG_N, BLOCK_SIZE, PARALLELISM)));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return format(salt, await scrypt(password, salt, KEY_LENGTH, scryptOptions(LOG_N, BLOCK_SIZE, PARALLELISM)));
}

export function parsePasswordHash(stored: string): ParsedHash {
  const parts = stored.split(":");
  const malformed = new Error('RECALL_PASSWORD_HASH is not in the format made by "npm run hash-password".');
  if (parts.length !== 6 || parts[0] !== "scrypt") throw malformed;
  const [, logN, r, p, salt, hash] = parts;
  const parsed: ParsedHash = {
    logN: Number(logN),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt ?? "", "base64url"),
    hash: Buffer.from(hash ?? "", "base64url"),
  };
  const sane =
    [parsed.logN, parsed.r, parsed.p].every(Number.isInteger) &&
    parsed.logN >= 10 &&
    parsed.logN <= 20 &&
    parsed.r >= 1 &&
    parsed.r <= 32 &&
    parsed.p >= 1 &&
    parsed.p <= 16 &&
    parsed.salt.length >= 16 &&
    parsed.hash.length >= 16;
  if (!sane) throw malformed;
  return parsed;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const { logN, r, p, salt, hash } = parsePasswordHash(stored);
  const candidate = await scrypt(password, salt, hash.length, scryptOptions(logN, r, p));
  return timingSafeEqual(candidate, hash);
}

export function randomSecret(bytes = 48): string {
  return randomBytes(bytes).toString("base64url");
}
