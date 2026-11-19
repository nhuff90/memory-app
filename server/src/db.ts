import Database from "better-sqlite3";
import { keywordKey } from "../../shared/keywords.js";
import { MIGRATIONS } from "./migrations/index.js";

export type DB = Database.Database;

/** SQL helpers used by migrations. Never referenced from triggers or schema, so other tools can still open the file. */
export function registerFunctions(db: DB): void {
  db.function("recall_keyword_key", { deterministic: true }, (value: unknown) => keywordKey(String(value ?? "")));
}

export function openDb(file: string): DB {
  const db = new Database(file);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    registerFunctions(db);
    migrate(db);
    return db;
  } catch (error) {
    // The caller never receives this connection if initialization fails.
    db.close();
    throw error;
  }
}

export function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `The database is at version ${current}, but this app only knows ${MIGRATIONS.length} migrations. Update the app first.`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version]!;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
