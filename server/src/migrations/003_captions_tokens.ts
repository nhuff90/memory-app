export default /* sql */ `
ALTER TABLE photos ADD COLUMN caption TEXT;
ALTER TABLE photos ADD COLUMN captioned_at INTEGER;
-- Every photo caption of the memory joined with "; ", so the keyword index can cover them.
ALTER TABLE memories ADD COLUMN captions TEXT;

CREATE TABLE api_tokens (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  -- The time zone of the device that made the key. Shortcuts don't send one, and Ask needs it for dates.
  time_zone    TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

DROP TRIGGER memories_fts_insert;
DROP TRIGGER memories_fts_delete;
DROP TRIGGER memories_fts_update;
DROP TABLE memories_fts;

CREATE VIRTUAL TABLE memories_fts USING fts5(
  body, tags, captions, content='memories', content_rowid='id', tokenize='porter unicode61'
);
INSERT INTO memories_fts (memories_fts) VALUES ('rebuild');

CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, body, tags, captions)
    VALUES (new.id, new.body, coalesce(new.tags, ''), coalesce(new.captions, ''));
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, body, tags, captions)
    VALUES ('delete', old.id, old.body, coalesce(old.tags, ''), coalesce(old.captions, ''));
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE OF body, tags, captions ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, body, tags, captions)
    VALUES ('delete', old.id, old.body, coalesce(old.tags, ''), coalesce(old.captions, ''));
  INSERT INTO memories_fts (rowid, body, tags, captions)
    VALUES (new.id, new.body, coalesce(new.tags, ''), coalesce(new.captions, ''));
END;
`;
