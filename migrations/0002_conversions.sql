-- PDFs being converted to LilyPond, until their owner dismisses the outcome.
-- A finished conversion's document has the conversion's ID, so a retry can't
-- make a second one.
CREATE TABLE conversions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX conversions_owner ON conversions (owner_id, created_at);
