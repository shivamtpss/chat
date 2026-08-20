-- Stage 00 schema. Deliberately minimal, but correct and future-proof.
--
-- Design notes (best practices even at 50-100 users):
--   * ULIDs (26-char text) as ids: globally unique AND time-sortable, so
--     "newest first" ordering needs no separate timestamp sort and there is
--     no central auto-increment bottleneck later.
--   * Foreign keys + ON DELETE rules keep data honest.
--   * A join table models the many-to-many "users in conversations".
--   * Indexes match the exact queries we run (see 02 below). Nothing
--     speculative.

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,                 -- ULID
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,                 -- ULID
  type          TEXT NOT NULL CHECK (type IN ('direct','group')),
  -- For 1:1 we store a canonical key (sorted user pair) so the same two
  -- people always resolve to exactly one conversation. NULL for groups.
  direct_key    TEXT UNIQUE,
  title         TEXT,                             -- groups only
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_id     TEXT,                          -- read-receipt cursor (ULID of last read msg)
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,              -- ULID (time-sortable)
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        TEXT NOT NULL REFERENCES users(id),
  client_msg_id    TEXT NOT NULL,                 -- idempotency key from the client
  body             TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 01. Idempotency: the same (conversation, client_msg_id) can only exist once.
--     This makes send retries safe from day one (no duplicate messages).
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_conv_clientid
  ON messages (conversation_id, client_msg_id);

-- 02. THE query index. Our hot query is:
--       SELECT ... FROM messages
--       WHERE conversation_id = $1 [AND id < $cursor]
--       ORDER BY id DESC LIMIT $n
--     A composite index on (conversation_id, id DESC) turns that into a
--     direct jump + short ordered read instead of scanning the table.
--     Note: even with LIMIT, without this index Postgres would still scan
--     and sort matching rows -> slow as the table grows. LIMIT caps the
--     OUTPUT, not the WORK. This index caps the work too.
CREATE INDEX IF NOT EXISTS ix_messages_conv_id_desc
  ON messages (conversation_id, id DESC);

-- 03. "Which conversations is this user in?" (loading a user's chat list).
CREATE INDEX IF NOT EXISTS ix_members_user
  ON conversation_members (user_id);

COMMIT;
