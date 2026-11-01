export default /* sql */ `
CREATE TABLE ai_usage (
  id            INTEGER PRIMARY KEY,
  at            INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('ask', 'enrich', 'caption')),
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL
);
CREATE INDEX ai_usage_by_time ON ai_usage (at);

ALTER TABLE memories ADD COLUMN category_set_by_user INTEGER NOT NULL DEFAULT 0;
`;
