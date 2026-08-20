# 07 - Scaling Path: 1k → 100k → 1M

The point of this doc: **what breaks at each step and the exact fix.** Do not build the 1M architecture on day one.

## 7.1 Stage table

| Stage | Concurrent | Topology | What breaks | Fix |
|---|---|---|---|---|
| **A** | ~1k | Single app (monolith) + Postgres + Redis | Nothing | Ship the monolith |
| **B** | ~10k | 2–3 gateways + Redis pub/sub + Postgres | Single process memory; a restart drops everyone | Multiple gateways, routing via Redis, graceful drain |
| **C** | ~100k | 10–15 gateways + durable bus + Scylla + sharded reads | Redis pub/sub fan-out amplification; Postgres write ceiling; hot partitions | Durable bus (Kafka), Scylla for messages, partition by conversation, fan-out workers |
| **D** | ~1M | Multi-region, regional gateways, geo-pinned data | Cross-region latency; single bus cluster; presence storms; global search cost | Regional cells, geo-routing, presence sampling/batching, tiered search/storage |

## 7.2 Stage A - 1k concurrent

- **Topology:** one service holding WS connections, Postgres for everything, Redis optional.
- **Why it's fine:** 1k conns fit in one process's memory; Postgres handles the write rate easily.
- **Do now anyway:** the message envelope, `client_msg_id`, `seq`, and cursor-sync protocol. These are protocol-level and expensive to retrofit.
- **What breaks next:** a single process is a single point of failure; a deploy or crash disconnects all 1k.

## 7.3 Stage B - 10k concurrent

- **Break:** one process's memory and blast radius. Restarts drop everyone; you cannot deploy without downtime.
- **Fix:**
  - Run **multiple gateway instances** behind an L4 LB.
  - Add **Redis** for `user→gateway` routing and pub/sub cross-node delivery.
  - **Graceful draining** on deploy; clients reconnect with jitter + cursor resume.
- **What breaks next:** Redis pub/sub broadcasts to all subscribers (fan-out amplification), and Postgres write throughput becomes the ceiling as message volume climbs.

## 7.4 Stage C - 100k concurrent (the target)

- **Breaks:**
  1. **Redis pub/sub amplification** - naive pub/sub sends every message to every gateway; wasteful at scale.
  2. **Postgres writes** - past ~10–20k writes/sec, a single primary struggles.
  3. **Hot partitions / big conversations** - active 500-member groups concentrate load.
  4. **Reconnect storms** - a node loss re-authenticates ~10–15k users at once.
- **Fixes:**
  1. Replace broadcast pub/sub with **targeted delivery**: worker looks up recipient gateway and publishes to that node's topic (Kafka partition or Redis stream per node). Adopt **Kafka** for durable, partitioned, replayable ingress.
  2. Move messages to **ScyllaDB/Cassandra**, partitioned by `conversation_id`, clustered by time-sortable id. Keep Postgres for metadata only.
  3. **Time-bucket** hot conversation partitions; cap group size at 500; bound fan-out parallelism.
  4. **Backoff + jitter** on reconnect; capacity-aware health checks; spare gateway headroom (N+2). Cache auth/session to avoid hammering the auth DB on reconnect storms.
- **What breaks next:** everything above is single-region; cross-region users see latency, and one bus/DB cluster becomes a scaling and blast-radius limit.

## 7.5 Stage D - 1M concurrent

- **Breaks:**
  1. **Cross-region latency** - a user in another continent can't hit a single region under 200 ms.
  2. **Single Kafka/DB cluster** - one cluster becomes a bottleneck and a single blast radius.
  3. **Presence storms** - 1M users churning presence overwhelms naive presence broadcast.
  4. **Global search & storage cost** - hundreds of TB/year, cross-region indexing.
- **Fixes:**
  1. **Multi-region cells.** Each region runs its own gateways/bus/DB. Route users to their nearest/home region.
  2. **Geo-pin conversation data** to a home region; cross-region conversations replicate asynchronously (accept slightly higher latency for the rarer cross-region case).
  3. **Presence sampling/batching:** aggregate presence, push deltas not full state, and sample rather than emit every change. Treat presence as best-effort.
  4. **Tiered storage + bounded search window**; per-region indices; archive cold data to object storage.
- **Residual hard problems:** global ordering across regions (we deliberately avoid it), cross-region conversation consistency (async replication + conflict resolution by `message_id` order), and cost governance.

## 7.6 Capacity rules of thumb to watch

| Signal | Threshold | Action |
|---|---|---|
| Conns per gateway | > ~15k | Add gateway nodes |
| Gateway CPU | > ~60% sustained | Add nodes / profile hot path |
| DB write latency p99 | rising | Shard / move to Scylla |
| Bus consumer lag | growing | Add partitions/consumers |
| Reconnect rate spike | node loss | Verify jitter, auth cache, headroom |
| Hot partition size | > ~100 MB / 100k rows | Time-bucket that conversation |

## 7.7 Golden rule
**Scale by evidence, not anticipation.** Each transition (B→C→D) is triggered by a metric crossing a threshold, not by a calendar date. Building Stage D on day one with a team of 4 guarantees you miss the 8-week MVP.
