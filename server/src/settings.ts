import type { DB } from "./db.js";

/** Choices made on the Settings screen. They live in the database, so every device sees the same ones. */
export class SettingsStore {
  constructor(private readonly db: DB) {}

  /** Whether photos may be sent to Claude to be described. Off until turned on. */
  photoCaptions(): boolean {
    return this.read("photo_captions") === "1";
  }

  setPhotoCaptions(on: boolean): void {
    this.write("photo_captions", on ? "1" : "0");
  }

  private read(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private write(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }
}
