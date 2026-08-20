# 05 - Data Model & Sharding

## 5.1 Store split

| Data | Store | Why |
|---|---|---|
| Users, auth, devices | Postgres | Relational, constraints, transactions |
| Conversations, memberships, settings | Postgres | Joins, integrity, moderate volume |
| Messages (history) | Scylla/Cassandra (Postgres in MVP) | Write-heavy, time-ordered, append |
| Read cursors / receipts | Scylla or Redis+DB | High write rate, per (conv, user) |
| Presence / typing | Redis (TTL) | Ephemeral, fast, expiring |
| Search index | OpenSearch | Inverted index, full-text |
| Media blobs | S3 + CDN | Large binary, cheap, cacheable |

## 5.2 Metadata model (Postgres)

```
users
  user_id (PK, ULID)
  handle (unique), display_name, avatar_url
  created_at, status

devices
  device_id (PK), user_id (FK)
  platform (ios|android|web), push_token
  last_seen_at

conversations
  conversation_id (PK, ULID)
  type (direct|group)
  title, avatar_url            -- group only
  created_at, created_by

conversation_members
  conversation_id (FK), user_id (FK)
  role (member|admin)
  joined_at
  last_read_seq                -- read receipt cursor
  muted, notif_prefs
  PRIMARY KEY (conversation_id, user_id)
```

For **direct (1:1)** conversations, derive a deterministic `conversation_id` from the sorted pair of user ids so the same two people always resolve to one conversation (prevents duplicates).

## 5.3 Message model (wide-column: Scylla/Cassandra)

The single most important design decision. **Partition by conversation, cluster by time-sortable id.**

```
messages
  PARTITION KEY : conversation_id
  CLUSTERING KEY: message_id (ULID/Snowflake) DESC
  columns:
    sender_id
    client_msg_id        -- for dedup/idempotency
    seq                  -- monotonic per-conversation sequence
    body / content_type
    media_ref            -- S3 key, null if none
    created_at
    edited_at, deleted
```

Why this shape:
- **All messages of a conversation live in one partition** → reads for a conversation are a single-partition ordered range scan (`SELECT ... WHERE conversation_id=? AND message_id < cursor LIMIT n`), which is exactly cursor pagination.
- **Clustering DESC by message_id** gives newest-first reads and preserves per-conversation order without a global clock.
- **ULID/Snowflake** encodes time → naturally sortable and dedup-friendly.

### Dedup / idempotency table

```
message_dedup
  PARTITION KEY: (conversation_id, client_msg_id)
  -> server message_id
  TTL: e.g. 24-48h
```

On write, check this first. If present, return the existing `server message_id` (idempotent retry). Also enforce a unique constraint on `(conversation_id, client_msg_id)`.

### Read cursors / receipts

```
read_cursors
  PARTITION KEY: conversation_id
  CLUSTERING KEY: user_id
  -> last_read_seq, updated_at
```

Read receipts are computed by comparing members' `last_read_seq` against a message's `seq`. This avoids one receipt row per message per user (which would be catastrophic write amplification).

## 5.4 Partition / sharding key choice

| Table | Partition key | Rationale | Hot-spot risk & mitigation |
|---|---|---|---|
| messages | `conversation_id` | Co-locates a conversation, enables ordered range reads | A 500-member very active group is a hot partition → cap group size, consider time-bucketed sub-partitions `(conversation_id, day)` for extreme cases |
| dedup | `(conversation_id, client_msg_id)` | Even spread, exact-match lookup | None significant |
| read_cursors | `conversation_id` | Co-located with members | Same as messages, bounded by member count |
| users/conversations | `id` | Point lookups | Shard Postgres by user_id range/hash only if it grows past a single primary |

**Why `conversation_id` and not `user_id`:** ordering and pagination are per-conversation, and both participants must read the same ordered log. Partitioning by user would split a conversation across partitions and destroy ordered range reads.

### Time-bucketing for very hot/huge conversations
For conversations that would exceed a healthy partition size (Cassandra/Scylla prefer partitions under ~100 MB / ~100k rows), extend the partition key to `(conversation_id, time_bucket)` (e.g. per month). Reads then span at most a couple of buckets. Apply this only where needed, not universally.

## 5.5 Retention & tiering

- **Hot tier:** recent N months in Scylla on fast storage.
- **Cold tier:** older messages exported to object storage (Parquet/JSON) for cheap archival; rehydrate on demand for rare deep-history reads.
- **Search index:** may keep a shorter window than full history if search of ancient messages is not required (big cost lever).
- Media: lifecycle rules move rarely-accessed blobs to cheaper storage classes.

## 5.6 Search model (OpenSearch)

- Async indexer consumes the message stream (from the bus) and writes documents `{conversation_id, message_id, sender_id, body, created_at}`.
- Query is **authZ-scoped**: only search within conversations the user belongs to (filter by the user's `conversation_id` set).
- Indexing lag of a few seconds is acceptable and never blocks send.
