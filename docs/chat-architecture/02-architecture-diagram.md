# 02 - Architecture & Diagram

## 2.1 Component overview

| Component | Responsibility | State |
|---|---|---|
| **Client SDK** | WS connection, reconnect, local outbox, cursor sync, dedup | Local outbox + cursor |
| **L4 Load Balancer** | TCP passthrough to gateways, TLS optional passthrough | Stateless |
| **Gateway (WS edge)** | Hold connections, auth handshake, rate limit, backpressure, route in/out | Conn table (in-mem) + Redis routing |
| **Redis Cluster** | Presence, typing, `user → gateway` routing, dedup cache | Ephemeral |
| **Message Bus (Kafka)** | Durable, replayable ingress log; decouples accept/persist/deliver | Durable log |
| **Chat Service (workers)** | Persist, assign server IDs, fan-out, receipts, push triggers | Stateless |
| **Messages DB (Scylla/Cassandra)** | Durable message history, time-ordered per conversation | Durable |
| **Metadata DB (Postgres)** | Users, conversations, memberships, settings | Durable |
| **Search (OpenSearch)** | Async-indexed full-text search | Derived |
| **Object Storage (S3) + CDN** | Media blobs via presigned upload/download | Durable |
| **Push service** | APNs/FCM for offline recipients | Stateless |

## 2.2 High-level diagram

```mermaid
flowchart LR
  C[Clients<br/>iOS / Android / Web] -->|WSS| LB[L4 LB / Envoy]
  LB --> GW[Gateway nodes<br/>stateful WS edge]
  GW <-->|presence, routing, dedup| R[(Redis Cluster)]
  GW -->|publish inbound| K[(Kafka / NATS)]
  K --> CS[Chat service workers<br/>persist + fan-out]
  CS --> DB[(Scylla/Cassandra<br/>messages)]
  CS --> PG[(Postgres<br/>users, rooms, membership)]
  CS -->|route outbound| GW
  CS --> IDX[Indexer] --> S[(OpenSearch<br/>search)]
  CS --> PN[Push worker<br/>APNs / FCM]
  C -->|presigned PUT/GET| OBJ[(S3 media)]
  OBJ --> CDN[(CDN)] --> C
```

## 2.3 Send path (happy path)

```mermaid
sequenceDiagram
  participant A as Sender client
  participant GA as Gateway A
  participant K as Kafka
  participant W as Chat worker
  participant DB as Scylla
  participant GB as Gateway B
  participant B as Recipient client

  A->>GA: SEND {client_msg_id, conv_id, body}
  GA->>GA: authZ conv, rate limit
  GA->>K: publish(inbound, key=conv_id)
  W->>K: consume
  W->>W: assign ULID seq, dedup on (conv_id, client_msg_id)
  W->>DB: persist (durable)
  DB-->>W: ok
  W-->>GA: ACK {client_msg_id, server_id, seq}
  GA-->>A: ACK (message confirmed, no loss)
  W->>GB: deliver (lookup Redis: recipient→gateway)
  GB->>B: MESSAGE {server_id, seq, body}
  B-->>GB: DELIVERED receipt
```

Key point: **the sender ACK happens after durable persist**, so an ACK means "no loss". Delivery to the recipient is a separate asynchronous step; if the recipient is offline, it becomes a push + cursor sync on reconnect.

## 2.4 Receive-while-offline path

```mermaid
sequenceDiagram
  participant W as Chat worker
  participant R as Redis routing
  participant PN as Push (APNs/FCM)
  participant B as Recipient (offline)
  participant GB as Gateway

  W->>R: lookup recipient gateway
  R-->>W: not connected
  W->>PN: send push notification
  Note over B: user taps notification, app reconnects
  B->>GB: CONNECT + last_read_seq / last_seen_seq
  GB->>W: sync request after=seq
  W-->>GB: backlog messages (ordered)
  GB-->>B: deliver backlog, update cursor
```

## 2.5 Data flow principles

1. **Accept → log → persist → deliver.** The bus (Kafka) is the seam that lets accept and deliver run at different speeds and survive downstream outages.
2. **Routing, not stickiness, moves messages between users on different gateways.** Redis maps `user_id → gateway_node`; the worker (or a peer gateway) publishes to the target node's topic.
3. **Media never touches chat servers.** Clients upload/download directly to S3 via presigned URLs; only the reference (URL + metadata) flows through chat.
4. **Search is derived and async.** Indexing lag is acceptable; it must never block the send path.
5. **Ephemeral vs durable are physically separated.** Presence/typing live only in Redis; messages/receipts are durable.
