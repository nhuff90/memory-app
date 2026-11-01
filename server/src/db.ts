import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations/index.js";

export type DB = Database.Database;

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
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
