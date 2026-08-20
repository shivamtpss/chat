# 01 - Requirements & Capacity Math

## 1.1 Functional requirements

| Feature | Notes |
|---|---|
| 1:1 chat | Direct conversation between two users |
| Group chat | Up to 500 members per group |
| Presence | Online / offline / last-seen |
| Typing indicators | Ephemeral, per-conversation |
| Read receipts | Per-user read cursor (last_read_seq) |
| Media attachments | Images, video, files via object storage |
| Push notifications | APNs (iOS) + FCM (Android/Web) when offline |
| Message history | Full durable history, cursor-paginated |
| Search | Full-text over message history |

## 1.2 Non-functional requirements

| Requirement | Target | Implication |
|---|---|---|
| Delivery latency | p99 < 200 ms (in-region, both online) | Push-based transport, no polling, in-memory routing |
| Durability | No message loss | Persist before ACK, replicated storage, replayable bus |
| Ordering | Per-conversation | Time-sortable IDs + single partition per conversation |
| Availability | 99.9% MVP → 99.95% scale | Stateless-where-possible, graceful reconnect |

## 1.3 Connection capacity

**100k concurrent WebSocket connections.**

Per-connection cost is dominated by TCP + TLS buffers, app-level read/write buffers, and per-connection state (user id, subscriptions, send queue).

| Item | Estimate |
|---|---|
| Kernel socket buffers (rcv+snd) | ~40–60 KB tunable |
| TLS state | ~20–40 KB |
| App per-conn state + bounded send queue | ~20–50 KB |
| **Realistic RAM per idle conn** | **~100–150 KB** |

So 100k conns ≈ **10–15 GB RAM** for connection state alone, before message buffers. This is why we spread across nodes rather than one giant box.

**Connections per gateway node.** Battle-tested comfort zone:

| Runtime | Comfortable conns/node | Notes |
|---|---|---|
| Go | ~30–50k | Goroutine-per-conn is fine at this scale |
| Elixir/Phoenix | ~50k–100k+ | Proven to 2M on tuned clusters |
| Node + uWebSockets | ~30–50k | Event loop; avoid heavy per-conn CPU |

**MVP plan: ~10 gateway nodes @ ~10–15k conns each.** Deliberately conservative so a node loss reconnects ~10–15k users, not 50k. Each node sized ~4 vCPU / 8 GB.

## 1.4 Throughput and fan-out

Peak **50k msg/sec ingress.** The real load is **fan-out (egress)**, not ingress.

Fan-out amplification = average recipients per message.

```
egress_msgs/sec = ingress_msgs/sec × avg_recipients_per_message
```

| Scenario | Avg recipients | Egress msgs/sec |
|---|---|---|
| Mostly 1:1 (2 endpoints) | ~2 | ~100k |
| Mixed with groups (avg ~10) | ~10 | ~500k |
| Heavy 500-member groups | ~50–100 | ~2.5M–5M |

**Design to a blended average of ~10× → ~500k egress msgs/sec, with headroom to ~1M.** Large groups get special treatment (fan-out on read) so a single 500-person message does not create 500 synchronous writes on the hot path. See doc 06.

Message bus sizing: at 50k ingress msgs/sec and ~1 KB/msg the bus moves ~50 MB/sec write. Kafka handles this on a small cluster (3 brokers) comfortably; the constraint is partitions and consumer parallelism, not raw bytes.

## 1.5 Storage per day

Assume average stored message ≈ **1 KB** (text + metadata; media stored separately in object storage).

```
msgs/day        = 50,000 msg/s × 86,400 s        ≈ 4.32 billion (theoretical peak)
realistic/day   ≈ 300–500 million (peak ≠ sustained; assume ~10% duty cycle)
raw bytes/day   = 400M × 1 KB                     ≈ 400 GB/day
with replication (RF=3)                            ≈ 1.2 TB/day
with indexes + search copy                          ≈ 1.5–1.8 TB/day
```

| Horizon | Raw (RF=3) |
|---|---|
| Day | ~1.2 TB |
| Month | ~36 TB |
| Year | ~430 TB |

Implications:
- This is a **write-heavy, time-ordered, append** workload → wide-column store (Cassandra/ScyllaDB), not a single relational DB.
- **Tiered retention:** hot (recent, on fast storage) + cold (archived to object storage/Parquet). Do not keep 430 TB/year on premium SSD.
- Media bytes dwarf text and live in S3-class storage + CDN, billed separately.

## 1.6 Presence / typing volume

Presence and typing are **ephemeral, high-frequency, low-value-if-lost.**

- Typing events can spike to tens of thousands/sec. **Never persist them.** Redis with short TTL, and debounce/throttle client-side (send "typing" at most every ~3–5 s).
- Presence changes (online/offline) on 100k users churning at reconnect storms can be its own thundering herd. Batch and sample; see doc 07/11.

## 1.7 What the math forces

1. **Multiple stateful gateway nodes** + a routing layer (Redis) → no single process.
2. **Fan-out is the scaling problem**, not ingest. Two strategies (write vs read) chosen by group size.
3. **Wide-column message store** with conversation-based partitioning.
4. **Bus (Kafka)** to decouple accept-from-persist-from-deliver and to survive downstream slowness.
5. **Tiered storage + retention** or storage cost explodes.
