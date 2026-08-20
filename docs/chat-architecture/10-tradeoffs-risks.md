# 10 - Trade-offs & Riskiest Assumptions

## 10.1 Master trade-off table

| Decision | We chose | We gave up | When to revisit |
|---|---|---|---|
| Delivery guarantee | At-least-once + dedup (effectively-once) | True exactly-once | Never (exactly-once is impractical over unreliable networks) |
| Ordering | Per-conversation only | Global ordering | Never (global order is unneeded and costly) |
| Transport | WebSocket + fallback ladder | QUIC/MQTT benefits | Scale phase, if mobile loss rates hurt |
| Bus (MVP) | Redis Streams/NATS | Kafka's ecosystem/replay depth | When throughput/partitions demand Kafka |
| Messages DB (MVP) | Partitioned Postgres | Scylla write ceiling headroom | At ~10–20k writes/sec |
| Fan-out | On-write for ≤500, on-read for broadcast | Uniform simplicity | When a broadcast/announce feature appears |
| Presence | Ephemeral, best-effort, sampled | Perfect real-time accuracy | If product needs exact presence (rarely worth it) |
| E2EE | Off in MVP | Max privacy | Before GA if privacy is a product requirement |
| Region | Single region MVP | Global low latency | At Stage D / when non-region users grow |
| Search retention | Bounded window | Search of ancient history | If deep-history search is demanded (cost tradeoff) |
| Read receipts | Cursor-based (`last_read_seq`) | Per-message receipt granularity | Rarely needed; cursor is cheaper and enough |
| Sticky sessions | Not required (routing layer) | Slightly simpler reconnect co-location | Never as a correctness dependency |

## 10.2 Consistency vs availability stance
Chat favors **availability + low latency** over strict consistency. We accept: eventual consistency of presence, brief indexing lag for search, and async cross-region replication. We do **not** compromise on: durability after ACK, and per-conversation ordering.

## 10.3 The 3 riskiest assumptions

### Risk 1 - Fan-out amplification is worse than modeled
**Assumption:** blended average ~10 recipients/message, peak handled by fan-out-on-read for large groups.
**If wrong:** if real usage skews to many large, highly active groups, egress could be 5–10× the estimate, saturating gateways and the bus.
**Early signal:** egress/ingress ratio and bus consumer lag climbing.
**Mitigation:** aggressive fan-out-on-read, per-group delivery batching/coalescing, lower group-size cap, add gateway/worker capacity. **Validate with a realistic load test in weeks 7–8**, not with average-case assumptions.

### Risk 2 - Postgres-first bet doesn't hold to launch load
**Assumption:** partitioned Postgres survives MVP write volume; Scylla migration can wait.
**If wrong:** if launch traffic exceeds ~10–20k writes/sec sooner than expected, Postgres write latency breaches p99 and threatens durability timing.
**Early signal:** DB write p99 rising, replication lag, lock contention.
**Mitigation:** keep the message access pattern **Scylla-compatible from day one** (partition + clustering key), so migration is a data move, not a redesign. Have the Scylla path pre-tested. Consider starting on Scylla if pre-launch load tests show Postgres marginal.

### Risk 3 - Reconnect storms / thundering herd at scale
**Assumption:** backoff+jitter, auth caching, and N+2 headroom absorb mass reconnects (node loss, deploy, network blip).
**If wrong:** a correlated disconnect of tens of thousands of clients re-authenticating simultaneously can cascade: auth DB overload → failed reconnects → more retries → collapse.
**Early signal:** reconnect-rate spikes, auth error rate, CPU saturation during deploys.
**Mitigation:** enforced jitter, connection admission control, cached/stateless token validation, staggered/wave deploys, and load-test the reconnect-storm scenario explicitly (kill a node under load and measure recovery).

## 10.4 What would change the whole design
- **E2EE required from day one** → removes server-side search/moderation, changes media handling, complicates multi-device. Different product.
- **Global users from launch** → forces multi-region cells and geo-routing much earlier, raising cost and complexity.
- **Very large broadcast channels (>>500)** → shifts the center of gravity to fan-out-on-read and a pull-based model.
