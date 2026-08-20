-- Stage 02 lab schema. Same shape as Stage 00/01, WITH the right index this
-- time (we already learned indexing in Stage 01). This stage is about
-- concurrency, not data shape, so queries are fast and the ONLY bottleneck we
-- study is how many can run at once.

BEGIN;

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,        -- ULID
  conversation_id  TEXT NOT NULL,
  sender_id        TEXT NOT NULL,
  body             TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The hot-query index (learned in Stage 01), so query time is NOT the variable.
CREATE INDEX IF NOT EXISTS ix_messages_conv_id_desc
  ON messages (conversation_id, id DESC);

COMMIT;
