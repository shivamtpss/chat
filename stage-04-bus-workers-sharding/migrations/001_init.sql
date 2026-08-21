-- Stage 04 schema.
--
-- The headline data change vs earlier stages: the `messages` table is
-- PARTITIONED BY HASH on conversation_id. This teaches the SHARDING idea in a
-- single Postgres instance: rows for a conversation always land in the SAME
-- partition (chosen by hashing conversation_id), so a conversation stays
-- together and its ordered read stays cheap. In a real large system the same
-- partition key would spread data across MACHINES (Cassandra/Scylla); here it
-- spreads across partitions so you can see the concept without a cluster.
--
-- Why conversation_id as the shard key (not user_id): we always read "the
-- messages of ONE conversation, in order". Keeping a conversation in one
-- partition makes that a single-partition ordered scan. Sharding by user would
-- scatter a conversation across partitions and ruin ordered reads.

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

-- The partitioned messages table. Note: for a partitioned table the partition
-- key MUST be part of the primary key, hence (conversation_id, id).
CREATE TABLE IF NOT EXISTS messages (
  id               TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  sender_id        TEXT NOT NULL,
  client_msg_id    TEXT NOT NULL,
  seq              BIGINT NOT NULL,           -- per-conversation ordering number
  body             TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, id)
) PARTITION BY HASH (conversation_id);

-- Idempotency + hot-query index are declared on the parent and inherited by
-- every partition.
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_conv_clientid
  ON messages (conversation_id, client_msg_id);
CREATE INDEX IF NOT EXISTS ix_messages_conv_id_desc
  ON messages (conversation_id, id DESC);

CREATE INDEX IF NOT EXISTS ix_members_user
  ON conversation_members (user_id);

COMMIT;
