-- Stage 01 lab schema.
--
-- IMPORTANT TEACHING CHOICE: this schema has NO secondary indexes on purpose.
-- Only the primary keys exist. In Stage 00 we baked the right indexes in from
-- the start (the correct thing for a real app). Here we deliberately start
-- "bare" so the lab can:
--   1. show you the slow "before" (Seq Scan) on an unindexed query,
--   2. add the index live,
--   3. show the fast "after" (Index Scan),
--   4. measure the write-cost that indexes add.
--
-- You are meant to CREATE INDEX yourself via the lab experiments, then DROP
-- them and try again. That is the whole point.

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,           -- ULID
  username      TEXT NOT NULL,              -- NOTE: not UNIQUE here (no index) on purpose
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,        -- ULID (time-sortable)
  conversation_id  TEXT NOT NULL,           -- NO index yet: the lab adds it
  sender_id        TEXT NOT NULL,
  body             TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
