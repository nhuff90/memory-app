/**
 * Keyword pills: one row per (recall, normalized keyword) for exact filtering, usage counts and assignment recency,
 * plus capture receipts that let a held offline capture be reconciled by its original clientId.
 *
 * `memories.custom_keywords` stays the display/FTS/export source; these tables are kept in step with it in the same
 * transactions. Existing keywords are backfilled with an unknown assignment time (NULL), so they rank by frequency
 * until a genuine new assignment happens. `recall_keyword_key` is registered on the connection by `openDb` and is the
 * shared `keywordKey` rule (trim + lowercase), so SQL and the app agree on keyword identity.
 */
export default /* sql */ `
CREATE TABLE memory_keywords (
  memory_id INTEGER NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  label TEXT NOT NULL,
  assigned_at INTEGER,
  PRIMARY KEY (memory_id, keyword)
) WITHOUT ROWID;
CREATE INDEX memory_keywords_by_keyword ON memory_keywords (keyword, memory_id);

WITH RECURSIVE split (memory_id, rest, item) AS (
  SELECT id, custom_keywords || ',', NULL FROM memories WHERE custom_keywords != ''
  UNION ALL
  SELECT memory_id, substr(rest, instr(rest, ',') + 1), trim(substr(rest, 1, instr(rest, ',') - 1))
  FROM split WHERE rest != ''
)
INSERT OR IGNORE INTO memory_keywords (memory_id, keyword, label, assigned_at)
  SELECT memory_id, recall_keyword_key(item), item, NULL FROM split WHERE item IS NOT NULL AND item != '';

CREATE TABLE capture_receipts (
  client_id TEXT PRIMARY KEY,
  memory_id INTEGER NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  custom_keywords TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX capture_receipts_by_memory ON capture_receipts (memory_id);
`;
