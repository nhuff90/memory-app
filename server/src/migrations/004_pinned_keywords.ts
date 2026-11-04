export default /* sql */ `
ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));
ALTER TABLE memories ADD COLUMN custom_keywords TEXT NOT NULL DEFAULT '';
CREATE INDEX memories_pinned_by_created ON memories (created_at DESC, id DESC) WHERE pinned = 1;

DROP TRIGGER memories_fts_insert;
DROP TRIGGER memories_fts_delete;
DROP TRIGGER memories_fts_update;
DROP TABLE memories_fts;

CREATE VIRTUAL TABLE memories_fts USING fts5(
  body, tags, captions, custom_keywords, content='memories', content_rowid='id', tokenize='porter unicode61'
);
INSERT INTO memories_fts (memories_fts) VALUES ('rebuild');

CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, body, tags, captions, custom_keywords)
    VALUES (new.id, new.body, coalesce(new.tags, ''), coalesce(new.captions, ''), new.custom_keywords);
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, body, tags, captions, custom_keywords)
    VALUES ('delete', old.id, old.body, coalesce(old.tags, ''), coalesce(old.captions, ''), old.custom_keywords);
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE OF body, tags, captions, custom_keywords ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, body, tags, captions, custom_keywords)
    VALUES ('delete', old.id, old.body, coalesce(old.tags, ''), coalesce(old.captions, ''), old.custom_keywords);
  INSERT INTO memories_fts (rowid, body, tags, captions, custom_keywords)
    VALUES (new.id, new.body, coalesce(new.tags, ''), coalesce(new.captions, ''), new.custom_keywords);
END;
`;
