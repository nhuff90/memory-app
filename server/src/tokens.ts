import { createHash, randomBytes } from "node:crypto";
import type { ApiToken, CreatedApiToken } from "../../shared/types.js";
import type { TokenVerifier, VerifiedToken } from "./auth.js";
import type { DB } from "./db.js";

const TOKEN_PATTERN = /^rc_[A-Za-z0-9_-]{43}$/;

interface TokenRow {
  id: number;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const toApiToken = (row: TokenRow): ApiToken => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

/** Personal API keys for Siri Shortcuts. Only a SHA-256 hash of each key is stored. */
export class TokenStore implements TokenVerifier {
  constructor(
    private readonly db: DB,
    private readonly now: () => number = Date.now,
  ) {}

  create(name: string, timeZone: string | null = null): CreatedApiToken {
    const token = `rc_${randomBytes(32).toString("base64url")}`;
    const createdAt = this.now();
    const result = this.db
      .prepare(`INSERT INTO api_tokens (name, token_hash, time_zone, created_at) VALUES (?, ?, ?, ?)`)
      .run(name, hashToken(token), timeZone, createdAt);
    return { id: Number(result.lastInsertRowid), name, createdAt, lastUsedAt: null, token };
  }

  list(): ApiToken[] {
    const rows = this.db
      .prepare(`SELECT id, name, created_at, last_used_at FROM api_tokens ORDER BY created_at DESC, id DESC`)
      .all() as TokenRow[];
    return rows.map(toApiToken);
  }

  revoke(id: number): boolean {
    return this.db.prepare(`DELETE FROM api_tokens WHERE id = ?`).run(id).changes > 0;
  }

  verify(token: string): VerifiedToken | null {
    if (!TOKEN_PATTERN.test(token)) return null;
    const row = this.db.prepare(`SELECT id, time_zone FROM api_tokens WHERE token_hash = ?`).get(hashToken(token)) as
      | { id: number; time_zone: string | null }
      | undefined;
    if (!row) return null;
    this.db.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`).run(this.now(), row.id);
    return { id: row.id, timeZone: row.time_zone };
  }
}
