# 08 - Failure Modes, Observability, Security

## 8.1 Failure modes & mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| **Gateway node crash** | ~10–15k conns dropped | Clients reconnect (backoff+jitter) to other nodes, resync by cursor; no loss (durable log); N+2 headroom |
| **Redis (routing/presence) down** | Cross-node delivery + presence break | Redis Cluster + replicas; degrade gracefully (presence stale, delivery falls back to push + cursor sync); rebuild routing on reconnect |
| **Bus (Kafka) outage** | Ingest/deliver stalls | Multi-broker RF≥3; gateways buffer briefly and apply backpressure to clients; replay on recovery, nothing lost |
| **Messages DB partial outage** | Writes fail for some partitions | RF=3, quorum writes; retry; do **not** ACK until persisted (client keeps in outbox and retries) |
| **Slow consumer / backpressure** | Memory blowup risk | **Bounded per-connection send queue**; drop the slow socket rather than OOM the node; client reconnects+resyncs |
| **Thundering herd on reconnect** | Auth + DB overload | Backoff with jitter, auth/session caching, connection admission control |
| **Push provider (APNs/FCM) outage** | Offline notifications delayed | Retry with backoff, dead-letter queue; message still durable, delivered on next open |
| **Hot partition (huge active group)** | DB latency spike | Time-bucketed partitions, group-size cap, fan-out-on-read for broadcast |
| **Duplicate delivery** | User sees dupes | Server dedup on `(conv, client_msg_id)` + client dedup on `message_id`/`seq` |
| **Clock skew** | Bad ordering if time-based | Order by server-assigned `message_id`/`seq`, never by client timestamp |
| **Poison message** | Consumer crash loop | Validation + dead-letter queue, skip-and-alert |

## 8.2 Backpressure policy (explicit)

1. Each connection has a **bounded outbound queue**.
2. If a client can't keep up and the queue fills: stop buffering, mark the socket unhealthy, close it.
3. Client reconnects and **cursor-syncs** from durable storage. Never sacrifice a whole node's memory for one slow client.
4. Global admission control: if a gateway is at capacity, reject new conns so the LB routes elsewhere (health check reflects capacity).

## 8.3 Observability

### Golden signals (per gateway + aggregate)
- Active connections / node, and connection churn (connect/disconnect rate).
- **Message latency p50/p95/p99** (send→ACK, and send→delivered).
- **Bus consumer lag** (the earliest sign of trouble).
- Reconnect rate, auth failure rate.
- Dedup hit rate (spikes = client retry storms / network trouble).
- Send-queue depth / dropped-slow-consumer count.
- DB write/read latency, error rate; hot-partition detector.
- Push success/failure rate.

### Traces & logs
- Distributed tracing keyed by `message_id` across gateway → bus → worker → DB → delivery, so any message's journey is reconstructable.
- Structured logs with `conversation_id`, `message_id`, `user_id` (careful with PII; hash where needed).

### SLOs
| SLO | Target |
|---|---|
| Delivery p99 (both online, in-region) | < 200 ms |
| Message durability | 100% after ACK |
| Availability | 99.9% MVP |
| Reconnect success | > 99.9% |

### Alerting
- Page on: consumer lag climbing, delivery p99 breach, DB write errors, gateway capacity saturation, push failure surge.
- Ticket on: dedup-rate anomaly, cold-storage archival failures.

## 8.4 Security

### Authentication
- **Short-lived JWT** (access token) presented in the **WS handshake** (subprotocol header preferred over query param, since URLs get logged).
- **Refresh token** rotation; access token re-validated on every reconnect.
- Device registration ties push tokens to `user_id`.

### Authorization
- **Authorize per conversation, not just per connection.** Every send/read/subscribe checks membership in `conversation_members`.
- Server-side enforcement only; never trust the client's claim of membership.
- Rate limit **per user** and **per connection** at the gateway (send rate, subscribe rate, new-conn rate).

### Transport & data security
- TLS everywhere (WSS, HTTPS, DB, bus).
- Media via **presigned URLs** with short expiry and scoped permissions; validate content-type/size; scan for malware where required.
- Encryption at rest for DBs and object storage.

### E2EE decision (explicit, decide early)
- **MVP: no E2EE** because server-side **search and moderation are required**, and those are impossible over end-to-end encrypted payloads.
- If E2EE becomes a requirement, adopt the **Signal protocol / libsignal** with per-device keys and safety numbers. Consequences: server-side search dies (client-side search only), server-side moderation is limited, media must be encrypted client-side, and multi-device key management gets complex.
- **E2EE is not retrofittable** cleanly. This trade-off must be a conscious product decision before GA, not an afterthought.

### Abuse & safety
- Rate limits + spam heuristics.
- Report/block flows (metadata-level).
- Content moderation hooks on the async pipeline (only feasible without E2EE).
- Audit logging for admin actions.
