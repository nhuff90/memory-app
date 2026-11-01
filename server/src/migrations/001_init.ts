export default /* sql */ `
CREATE TABLE memories (
  id          INTEGER PRIMARY KEY,
  client_id   TEXT UNIQUE,
  body        TEXT NOT NULL,
  category    TEXT,
  tags        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER,
  enriched_at INTEGER
);
CREATE INDEX memories_by_created ON memories (created_at DESC, id DESC);

CREATE TABLE photos (
  id         INTEGER PRIMARY KEY,
  memory_id  INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  file       TEXT NOT NULL,
  thumb      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX photos_by_memory ON photos (memory_id);

CREATE TABLE embeddings (
  memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model     TEXT NOT NULL,
  vector    BLOB NOT NULL
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  body, tags, content='memories', content_rowid='id', tokenize='porter unicode61'
);

CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, body, tags) VALUES (new.id, new.body, coalesce(new.tags, ''));
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, body, tags)
    VALUES ('delete', old.id, old.body, coalesce(old.tags, ''));
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE OF body, tags ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, body, tags)
    VALUES ('delete', old.id, old.body, coalesce(old.tags, ''));
  INSERT INTO memories_fts (rowid, body, tags) VALUES (new.id, new.body, coalesce(new.tags, ''));
END;
`;
