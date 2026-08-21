-- Stage 03 schema. Same durable model as Stage 00 (Postgres remains the source
-- of truth for messages and membership). Redis is added ALONGSIDE it for
-- ephemeral routing/presence, never as the durable store.

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('direct','group')),
  direct_key    TEXT UNIQUE,
  title         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_id     TEXT,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        TEXT NOT NULL REFERENCES users(id),
  client_msg_id    TEXT NOT NULL,
  body             TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency (safe retries) and the hot-query index (learned in Stage 01).
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_conv_clientid
  ON messages (conversation_id, client_msg_id);
CREATE INDEX IF NOT EXISTS ix_messages_conv_id_desc
  ON messages (conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_members_user
  ON conversation_members (user_id);

COMMIT;
