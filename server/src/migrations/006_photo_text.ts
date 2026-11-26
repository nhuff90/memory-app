/**
 * Photo text: the full text read from each photo, kept per photo like its caption.
 *
 * `photos.extracted_text` is the text (line breaks kept), NULL when none was read. `photos.text_read_at` records that a
 * reading finished, even when it found no text; NULL means the photo has never been read. `memories.photo_text` is every
 * photo's text in photo id order joined with a blank line, or NULL when no photo has text, so the keyword index can
 * cover it. Photo text is keyword-searchable only: it never feeds embeddings or auto-tagging.
 */
export default /* sql */ `
ALTER TABLE photos ADD COLUMN extracted_text TEXT;
ALTER TABLE photos ADD COLUMN text_read_at INTEGER;
ALTER TABLE memories ADD COLUMN photo_text TEXT;

DROP TRIGGER memories_fts_insert;
DROP TRIGGER memories_fts_delete;
DROP TRIGGER memories_fts_update;
DROP TABLE memories_fts;

CREATE VIRTUAL TABLE memories_fts USING fts5(
  body, tags, captions, custom_keywords, photo_text, content='memories', content_rowid='id', tokenize='porter unicode61'
);
INSERT INTO memories_fts (memories_fts) VALUES ('rebuild');

CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, body, tags, captions, custom_keywords, photo_text)
    VALUES (new.id, new.body, coalesce(new.tags, ''), coalesce(new.captions, ''), new.custom_keywords,
      coalesce(new.photo_text, ''));
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, body, tags, captions, custom_keywords, photo_text)
    VALUES ('delete', old.id, old.body, coalesce(old.tags, ''), coalesce(old.captions, ''), old.custom_keywords,
      coalesce(old.photo_text, ''));
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE OF body, tags, captions, custom_keywords, photo_text ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, body, tags, captions, custom_keywords, photo_text)
    VALUES ('delete', old.id, old.body, coalesce(old.tags, ''), coalesce(old.captions, ''), old.custom_keywords,
      coalesce(old.photo_text, ''));
  INSERT INTO memories_fts (rowid, body, tags, captions, custom_keywords, photo_text)
    VALUES (new.id, new.body, coalesce(new.tags, ''), coalesce(new.captions, ''), new.custom_keywords,
      coalesce(new.photo_text, ''));
END;
`;
