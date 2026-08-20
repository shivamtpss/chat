# 03 - Tech Stack & Rejected Alternatives

Every choice lists what we picked, why, and what we rejected. The MVP column shows the pragmatic 8-week choice; the Scale column shows where it evolves.

## 3.1 Decision table

| Concern | MVP choice | Scale choice | Why | Rejected & why |
|---|---|---|---|---|
| **Transport** | WebSocket (WSS) | Same + SSE/long-poll fallback | Full-duplex, low overhead, universal | Long-poll (10–50× wasted requests); raw SSE alone (no client→server stream); MQTT (broker-centric, extra ops for little gain on web) |
| **Gateway runtime** | Go + gorilla/nhooyr ws, or Elixir/Phoenix | Elixir/Phoenix Channels or Go | Cheap concurrency, proven at 100k+ conns | Node baseline ws (GC pauses at high conn churn - use uWebSockets if Node); Java/Netty (heavier ops for a team of 4) |
| **Load balancer** | Cloud L4 NLB / Envoy | Envoy + regional NLBs | TCP passthrough, no L7 stickiness needed with routing layer | L7 ALB with sticky cookies (limits rebalancing, sticky breaks on node loss) |
| **Message bus** | Redis Streams **or** NATS JetStream | Kafka | Durable, decouples accept/persist/deliver | Kafka on day 1 (operational weight for 4 people); RabbitMQ (weaker replay/retention for a log) |
| **Messages DB** | Postgres (partitioned) | ScyllaDB / Cassandra | Start relational, move to wide-column when writes exceed ~10–20k/s | Mongo (weaker ordered-range story); DynamoDB (cost + lock-in, hot-partition tuning) |
| **Metadata DB** | Postgres | Postgres (+ read replicas) | Relational truth for users/rooms/membership | Putting metadata in Scylla (loses joins, constraints, transactions) |
| **Presence / typing** | Redis (TTL keys) | Redis Cluster | Ephemeral, fast, auto-expire | Persisting to DB (pure waste, write amplification) |
| **Message IDs** | ULID / Snowflake | Same | Time-sortable → per-conversation ordering without global clock | Auto-increment (needs central sequencer, single point); UUIDv4 (not sortable) |
| **Media** | S3 + presigned URLs + CDN | Same | Never proxy blobs through chat | Storing blobs in DB (bloat, cost); proxying through gateway (bandwidth + memory) |
| **Search** | Postgres FTS | OpenSearch async indexer | FTS is free at small scale; OpenSearch when volume grows | Searching Scylla directly (no inverted index); Algolia (cost at this volume) |
| **Push** | FCM + APNs directly | Same, via worker | Native, free-ish, required | Third-party push aggregators (extra hop, cost) |
| **API/auth** | REST + JWT (short-lived) + refresh | Same + rotation | Stateless authZ at handshake | Session cookies only (harder for native apps); long-lived JWT (revocation pain) |

## 3.2 Rationale detail on the contested picks

### Why not Kafka on day one
Kafka is the right destination but wrong starting point for 4 people in 8 weeks. Zookeeper/KRaft, partitions, consumer-group rebalancing, and retention tuning are a real ops burden. **Redis Streams or NATS JetStream** give durable, replayable logs with a fraction of the operational surface, and the code seam (publish/consume with a partition key) is identical, so the swap to Kafka later is contained. Design the seam now, adopt Kafka when partitions/throughput demand it.

### Why Postgres first, Scylla later
The **schema and access patterns** (partition by conversation, clustering by time-sortable id, cursor pagination) are the expensive-to-change part. Postgres with declarative partitioning models these patterns faithfully up to ~10–20k writes/sec. Get the model right in Postgres, then port to Scylla, whose data model is intentionally similar (partition key + clustering key). Starting on Scylla means fighting a distributed DB during the weeks you can least afford it.

### Why WebSocket over MQTT/QUIC
MQTT is excellent for IoT and constrained networks and has nice QoS levels, but it is broker-centric and less natural on the web without extra bridging. QUIC/HTTP3 is promising (better head-of-line behavior on lossy mobile networks) but tooling and LB support are less mature for a team that needs to ship. **WebSocket over TLS is the lowest-risk, most universal choice**, and we keep SSE + HTTP POST as a documented fallback for hostile networks/proxies. Revisit QUIC in the scale phase for mobile.

### Why Elixir or Go for gateways
Both give cheap per-connection concurrency and predictable memory. Elixir/Phoenix Channels is arguably the single most proven stack for millions of persistent connections and gives presence/pubsub primitives out of the box. Go is a strong alternative if the team is more comfortable there. **Pick based on team skill**, not fashion. Node is viable only with uWebSockets.js and disciplined per-connection CPU budgets.

## 3.3 Language/team fit note
With 4 engineers, **operational simplicity beats theoretical ceiling**. Every "scale" choice above is deliberately deferred until metrics justify it. The MVP stack (WS + Go/Elixir + Postgres + Redis + S3 + FCM) is deployable and observable by a small team, and each component has a clear, contained upgrade path.
