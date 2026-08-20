# Appendix A3 - Glossary & Decision Cheatsheet

Every term used in this journey, defined in one line, plus a "when do I add X?" table so you never add complexity too early or too late.

---

## Part 1: Glossary (plain-language)

### Core building blocks
- **Monolith:** one program that does everything. The right starting point.
- **WebSocket:** a persistent two-way connection between client and server, so the server can push messages instantly (unlike normal request/response).
- **Load balancer:** spreads incoming connections across multiple servers.
- **Gateway:** a server whose job is to hold WebSocket connections and pass messages in/out.
- **Worker:** a background process that does heavy jobs (save, deliver, index) pulled from a queue.

### Databases
- **Postgres:** a relational (SQL) database. Great general-purpose, safe, supports relationships and transactions. Your default.
- **Relational / SQL database:** stores data in tables with rows and columns, and relationships between them (users, conversations, memberships).
- **Wide-column database (Cassandra / ScyllaDB):** built for massive write volume and time-ordered reads, at the cost of joins/flexibility. Used for the message firehose.
- **Redis:** an in-memory key-value store. Extremely fast, used for ephemeral/hot data (presence, routing, typing, rate limits).
- **OpenSearch / Elasticsearch:** a search engine that builds an inverted index for fast full-text search.
- **Read replica:** a copy of a database that serves read-only queries to spare the primary.

### Data & queries
- **Schema:** the shape of your tables (what columns, what relationships).
- **Primary key:** the unique id of a row.
- **Foreign key:** a column that references another table's row (e.g. `message.sender_id -> users.id`).
- **Join table (many-to-many):** a table linking two others (e.g. `conversation_members` links users and conversations).
- **Index:** a precomputed sorted shortcut so the database jumps to matching rows instead of scanning all of them.
- **Full table scan / sequential scan:** reading every row to find matches. Slow on big tables. The thing indexes prevent.
- **Composite index:** an index on multiple columns, for filter+sort queries.
- **EXPLAIN ANALYZE:** a command that shows how the database runs a query, so you can see if it scans or uses an index.
- **Cursor / keyset pagination:** "give me items after the last id I saw", stays fast forever (unlike OFFSET).
- **Inverted index:** word -> list of documents containing it. How search engines work.

### Concurrency
- **Concurrency:** juggling many tasks in overlapping time.
- **Parallelism:** running tasks literally simultaneously on multiple CPU cores.
- **Event loop (async / non-blocking):** one thread serves many connections by never sitting idle while waiting. (Node, asyncio.)
- **Goroutine / green thread / lightweight process:** a very cheap thread-like unit; runtimes (Go, Elixir) run thousands cheaply.
- **Blocking:** a worker sitting idle while waiting for something, wasting capacity. What we avoid.
- **Connection pool:** a small set of reusable database connections shared by all requests.
- **PgBouncer:** a tool that multiplexes many app connections onto few Postgres connections.
- **Race condition:** a bug where concurrent operations interleave and corrupt data.
- **Transaction:** a group of writes that all succeed or all fail together.
- **Atomic operation:** a single indivisible change (e.g. `n = n + 1`) that avoids read-then-write races.
- **Lock:** temporarily reserving data so only one operation changes it at a time. Use the narrowest lock possible.
- **Backpressure:** pushing back when overwhelmed instead of buffering until you crash.

### Real-time delivery
- **Presence:** who is online/offline.
- **Typing indicator:** the "user is typing..." signal. Ephemeral, throttled, never saved.
- **Pub/sub (publish/subscribe):** senders publish to a channel, subscribers receive. How servers pass messages to each other via Redis.
- **Message bus / queue (Kafka, Redis Streams, NATS):** a durable pipe in the middle; producers drop messages, workers consume, spikes are absorbed, and (with Kafka) the stream is stored and replayable.
- **Fan-out:** delivering one message to many recipients.
- **Fan-out on write:** push to each recipient when the message arrives (good for small groups).
- **Fan-out on read:** store once, let recipients pull (good for huge/broadcast groups).
- **Sticky session:** load balancer sends a user back to the same server. Helpful but must not be required for correctness.

### Scaling data
- **Sharding / partitioning:** splitting data across many machines by a shard key.
- **Shard key / partition key:** the value that decides which machine a row lives on (for messages: `conversation_id`).
- **Hot partition:** one shard getting disproportionate load (e.g. a giant active group). Mitigate by capping size or time-bucketing.
- **Replication factor (RF):** how many copies of each piece of data are kept (RF=3 = three copies) for durability.
- **Time-bucketing:** splitting a huge partition by time (e.g. per month) to keep it a healthy size.

### Delivery guarantees
- **At-least-once:** a message may be delivered more than once, but never zero times.
- **Idempotency:** doing the same operation twice has the same effect as doing it once (so retries are safe).
- **Deduplication (dedup):** recognizing and dropping duplicates, using a client-provided id.
- **Effectively-once:** at-least-once + dedup, so users see each message once. The practical target (true exactly-once is impractical).
- **Ordering (per-conversation):** messages in one conversation always appear in a consistent order (via a sequence number).

---

## Part 2: "When do I add X?" cheatsheet

Add each thing only when you see its trigger symptom. This is the whole philosophy of the journey in one table.

| Thing | Add it when... | Do NOT add it if... | Stage |
|---|---|---|---|
| **Postgres (one DB)** | From day one | (always start here) | 00 |
| **A real schema + join tables** | You have users, groups, memberships | You only have a toy demo | 00 |
| **Indexes** | A frequent query is slow; `EXPLAIN` shows Seq Scan on a big table | The table is tiny; no slow queries yet | 01 |
| **Cursor pagination** | "Load older messages" with OFFSET gets slow | You never paginate | 01 |
| **Connection pool / PgBouncer** | You see "too many connections" or requests queueing | You have a handful of users | 02 |
| **Async / concurrency tuning** | One slow op stalls others; CPU underused | Single-user usage | 02 |
| **Read replicas** | Reads (history/search) overload the primary | Write-light, read-light | 02-03 |
| **A second/third server + load balancer** | One server is CPU/memory/connection maxed, or you need redundancy | One server still has headroom | 03 |
| **Redis (routing + pub/sub)** | Users on different servers can't reach each other | You still run one server | 03 |
| **Redis for presence/typing** | These features churn and would hammer Postgres | You have no presence/typing yet | 03 |
| **Message bus/queue (Kafka etc.)** | Hot-path writes bottleneck; you need durable, replayable, decoupled processing | Message volume is modest | 04 |
| **Wide-column DB (Cassandra/Scylla)** | Postgres message writes hit their ceiling (~10-20k/s) | Postgres is coping fine | 04 |
| **Sharding / partitioning** | One DB machine can't hold or write all data | Your data fits comfortably on one machine | 04 |
| **Dedicated search engine (OpenSearch)** | Full-text search over huge data is slow | Postgres full-text search is fine | 04 |
| **Multi-region** | Users are global and latency hurts | Everyone is in one region | beyond |

## Part 3: The symptom -> action quick lookup

| You observe | It means | Do this |
|---|---|---|
| Query slow, data grew | Missing index | Add index matching WHERE+ORDER BY |
| "Too many connections" | No/undersized pool | Add connection pool / PgBouncer |
| One slow request stalls others | Blocking model | Use async / lightweight threads |
| Lost counter updates | Race condition | Atomic update / transaction |
| Memory climbs then crash | No backpressure | Bound queues, drop slow consumers |
| Users on different servers can't chat | No shared routing | Add Redis routing + pub/sub |
| Every message write strains DB | Coupled hot path | Add a message bus + workers |
| Message-table writes maxed out | Postgres write ceiling | Move messages to wide-column + shard |
| Search slow/heavy | Wrong tool for full-text | Add OpenSearch inverted index |
| Everyone drops on deploy | No draining/redundancy | Multiple servers + rolling drain + reconnect |

## Part 4: The one rule to remember

> **Climb one stage at a time, and only when a measured symptom forces it.**
> Complexity you add too early is complexity you pay for (in bugs, ops, and learning) without any benefit. The symptom is your permission slip to level up.
