# 11 - Challenges & Resolutions (Real-World)

The war stories. These are the problems this kind of system *will* hit in production, why they happen, and the concrete resolution. This is the doc to read before you get paged.

---

## 11.1 The duplicate message problem
**What happens:** a client sends, the network drops the ACK, the client retries, and the recipient sees the message twice.
**Why:** at-least-once delivery + retries are unavoidable on real networks.
**Resolution:** client attaches a stable `client_msg_id` to every send. Server enforces uniqueness on `(conversation_id, client_msg_id)` and returns the existing `message_id` on retry (idempotent). Clients also dedup on `message_id`/`seq`. Result: retries are safe, duplicates are invisible.

---

## 11.2 The "message sent but disappeared" problem
**What happens:** user sees "sent", but the message never persists; after reinstall it's gone.
**Why:** the server ACKed before durably storing, or stored to a single node that then died.
**Resolution:** **never ACK before durable, replicated persist** (quorum write, RF≥3). The ACK is the contract for "no loss". Client keeps the message in a local **outbox** until ACK and retries otherwise.

---

## 11.3 Out-of-order messages
**What happens:** "ok" arrives before the question it answers.
**Why:** concurrent writes, multiple workers, or ordering by unreliable client timestamps.
**Resolution:** route all writes for a conversation through **one bus partition** (key = `conversation_id`) so a single consumer assigns a monotonic `seq`. Order by server `message_id`/`seq`, never client clocks. Clients render by `seq`.

---

## 11.4 The reconnect / thundering-herd storm
**What happens:** a gateway dies (or you deploy), 15k clients reconnect at the same millisecond, auth DB melts, reconnects fail, clients retry harder, cascade.
**Why:** correlated failure + naive immediate reconnect + expensive per-reconnect auth.
**Resolution:** exponential backoff **with jitter**, cached/stateless JWT validation (no DB hit per reconnect), connection admission control, N+2 gateway headroom, and **wave deploys** with draining. Load-test this exact scenario (kill a node under load).

---

## 11.5 Fan-out amplification (the celebrity/large-group problem)
**What happens:** one message to a 500-person active group becomes 500 deliveries; several such groups at peak saturate everything.
**Why:** fan-out-on-write cost scales with membership × message rate.
**Resolution:** **fan-out-on-write for small conversations, fan-out-on-read for large/broadcast** (write once to the log, clients pull). Batch/coalesce deliveries per gateway. Cap group size at 500. Monitor egress/ingress ratio.

---

## 11.6 Presence storms
**What happens:** 100k users reconnect after a blip; each presence change fans out to all their contacts; the system spends more effort on "online" dots than on messages.
**Why:** presence is O(users × contacts) and high-frequency.
**Resolution:** treat presence as **best-effort**: Redis TTL keys, **batch and sample** changes, push **deltas** not full snapshots, debounce, and never persist. A slightly stale green dot is fine.

---

## 11.7 Typing indicator floods
**What happens:** typing events at tens of thousands/sec hammer the system.
**Why:** naive clients emit an event per keystroke.
**Resolution:** client throttles to at most one "typing" every ~3–5 s with a short server-side TTL. Ephemeral in Redis, never persisted, never durable-bussed.

---

## 11.8 The slow consumer / memory blowup
**What happens:** one client on a bad connection can't drain its messages; the server buffers more and more; the gateway OOMs and takes down thousands of healthy connections.
**Why:** unbounded per-connection send queues.
**Resolution:** **bounded send queue** per connection. When it fills, drop that socket (client reconnects and cursor-syncs). Protect the many from the one. This single policy prevents a whole class of outages.

---

## 11.9 Offline delivery without unbounded queues
**What happens:** a user is offline for a week in 30 busy groups; naive per-user in-memory queues explode.
**Why:** treating delivery as "hold messages in RAM until they come back".
**Resolution:** the **durable log is the queue**. Offline users get a **push notification**; on open, they **cursor-sync** (`after=last_read_seq`) from storage. No per-user memory queue exists.

---

## 11.10 Clock skew and "future" messages
**What happens:** a message shows a timestamp from tomorrow, or sorts wrong.
**Why:** trusting client device clocks.
**Resolution:** server assigns authoritative `message_id` (ULID/Snowflake) and `seq`. Client time is display metadata only, never the sort key.

---

## 11.11 Hot partitions (one giant, active conversation)
**What happens:** the busiest 500-member group's partition grows huge and its reads/writes get slow, dragging the node.
**Why:** all its messages live in one partition key.
**Resolution:** **time-bucket** the partition key `(conversation_id, month)` for such conversations; cap group size; use fan-out-on-read for broadcast-style rooms. Monitor partition size (< ~100 MB / 100k rows).

---

## 11.12 Media killing the chat path
**What happens:** users send 100 MB videos through the chat servers; bandwidth and memory spike; latency for text messages suffers.
**Why:** proxying blobs through the message path.
**Resolution:** **presigned S3 upload/download + CDN**. Chat carries only the reference (URL + metadata). Validate size/content-type, scan if required, set short-lived URLs. Chat servers never touch bytes.

---

## 11.13 Push notification reliability
**What happens:** offline users don't get notified; or get duplicate/late pushes.
**Why:** APNs/FCM outages, token churn, retries.
**Resolution:** push worker with retry + backoff + dead-letter queue; refresh push tokens on login; the message is already durable, so a missed push just means it's delivered on next app open via cursor sync. Push is a *nudge*, not the delivery guarantee.

---

## 11.14 Search that lies or leaks
**What happens:** search returns messages from conversations the user isn't in, or blocks the send path.
**Why:** unscoped queries; synchronous indexing.
**Resolution:** **async** indexing off the bus (never blocks send); every query **authZ-scoped** to the user's conversation set. Bound the index retention window to control cost.

---

## 11.15 Deploys without dropping the world
**What happens:** every deploy disconnects all users and looks like an outage.
**Why:** restarting stateful gateways naively.
**Resolution:** **connection draining** (stop new conns, let clients migrate), **wave deploys** (never all nodes at once), clients reconnect with jitter and resume by cursor. No message loss because backlog replays from durable storage.

---

## 11.16 Multi-device consistency
**What happens:** a user reads on their phone, but their laptop still shows unread; or a message appears on one device only.
**Why:** treating a user as a single connection.
**Resolution:** model `user_id → {device_id → gateway}` as a **set**; deliver to all active devices; sync read cursors (`last_read_seq`) across devices so read state converges. Each device cursor-syncs independently on reconnect.

---

## 11.17 The exactly-once temptation
**What happens:** someone insists on true exactly-once delivery and burns weeks.
**Why:** it sounds correct.
**Resolution:** accept **at-least-once + idempotency + dedup = effectively-once**. It is the industry-standard, provably-achievable target. Document it so it doesn't get relitigated.

---

## 11.18 Cost creep
**What happens:** the bill quietly triples, mostly from search indexing all history forever and hot storage of old messages.
**Why:** unbounded retention and premium storage for cold data.
**Resolution:** **bound search retention**, **tier storage** (hot Scylla → cold object storage), media lifecycle rules, reserved/spot for baseline compute, and dashboards that alert on cost anomalies. Review the top-5 cost levers monthly.

---

## 11.19 Quick reference: symptom → likely cause → fix

| Symptom | Likely cause | First fix |
|---|---|---|
| Duplicate messages | retry without dedup | check `client_msg_id` uniqueness path |
| Lost messages | ACK before persist | enforce persist-then-ACK, quorum writes |
| Out-of-order | multi-partition / client clock | single partition per conv, order by `seq` |
| Latency spikes at deploy | no draining | wave deploy + draining + jitter |
| Node OOM | unbounded send queue | bound queue, drop slow consumers |
| Bus lag climbing | fan-out overload | fan-out-on-read, more partitions/consumers |
| Presence lag/storm | presence fan-out | batch/sample presence, deltas only |
| DB write p99 rising | Postgres ceiling / hot partition | migrate to Scylla, time-bucket partition |
| Bill spiking | search/storage retention | bound index window, tier cold storage |
| Reconnect cascade | no jitter / auth per reconnect | jitter + cached token validation |
