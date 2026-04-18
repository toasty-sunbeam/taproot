-- Transcript archive — Phase 2 schema
-- Apply with: wrangler d1 execute taproot-transcripts --file=migrations/0001_create_transcripts.sql

CREATE TABLE IF NOT EXISTS transcripts (
  id               TEXT PRIMARY KEY,   -- UUID or caller-supplied conversation_id
  title            TEXT,               -- Optional human-readable title
  content          TEXT NOT NULL,      -- Full raw transcript text
  conversation_date TEXT,              -- When the conversation happened (ISO 8601)
  created_at       TEXT NOT NULL       -- When this record was ingested (ISO 8601)
);

-- FTS5 virtual table for full-text search across title and content
CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
  id      UNINDEXED,
  title,
  content,
  content='transcripts',
  content_rowid='rowid'
);

-- Keep FTS index in sync with the base table
CREATE TRIGGER IF NOT EXISTS tr_transcripts_ai AFTER INSERT ON transcripts BEGIN
  INSERT INTO transcripts_fts(rowid, id, title, content)
    VALUES (new.rowid, new.id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS tr_transcripts_ad AFTER DELETE ON transcripts BEGIN
  INSERT INTO transcripts_fts(transcripts_fts, rowid, id, title, content)
    VALUES ('delete', old.rowid, old.id, old.title, old.content);
END;

CREATE TRIGGER IF NOT EXISTS tr_transcripts_au AFTER UPDATE ON transcripts BEGIN
  INSERT INTO transcripts_fts(transcripts_fts, rowid, id, title, content)
    VALUES ('delete', old.rowid, old.id, old.title, old.content);
  INSERT INTO transcripts_fts(rowid, id, title, content)
    VALUES (new.rowid, new.id, new.title, new.content);
END;
