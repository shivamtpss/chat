# Stage 03 - Multiple Servers + Redis (the "Alice on A, Bob on B" problem)

The moment you run **more than one chat server**, a brand-new problem appears that did not exist in Stages 00-02. This stage builds a real 2-server cluster and solves it with **Redis**. Every message in the demo crosses from one server process to another and still arrives instantly.

Runnable companion to `../docs/chat-learning-journey/03-stage-10k-50k-users.md`.

---

## The problem in one picture

Until now there was **one** server holding everyone's connection. If Alice sent a message for Bob, the same process that received it also held Bob's socket. Easy.

Now imagine you grew and added a second server behind a load balancer:

```
      Alice's phone  ──────►  Server A   (holds Alice's socket)
      Bob's phone    ──────►  Server B   (holds Bob's socket)
```

Alice sends "hi Bob". It lands on **Server A**. But Server A does **not** have Bob's socket. Only **Server B** does. Server A has no idea where Bob even is. The message has nowhere to go.

This is the wall. A single process cannot solve it, because the knowledge ("Bob is on Server B") lives in a different process's memory. You need something **shared between servers**. That something is **Redis**.

### Real-world analogy: a company with two office buildings

Stage 00-02 was one building: to deliver a memo to a colleague, you walk down the hall. Now the company has **two buildings**. To deliver a memo you need:

1. A **staff directory** that says which building each person is in ("Bob works in Building B").
2. An **internal mail route** between buildings so Building A can forward the memo to Building B, where someone walks it to Bob's desk.

Redis provides both:
- **Directory** = a Redis key `presence:{userId}` listing which server(s) that user is connected to.
- **Internal mail** = Redis **pub/sub**: each server subscribes to its own channel `server:{id}`; to deliver, you publish the message to the recipient's server's channel.

---

## How Stage 03 is better than Stage 02

| | Stage 02 (one bigger server) | Stage 03 (this: many servers + Redis) |
|---|---|---|
| Scaling method | Make one server handle more (vertical) | Add more servers (horizontal) |
| Ceiling | One machine's CPU / RAM / socket limit | Add servers as you grow |
| A server crash / deploy | Everyone drops, full outage | Only that server's users drop; they reconnect to another |
| "Who is online?" | A Map in one process | A shared directory in Redis (all servers see it) |
| Cross-user delivery | Trivial (same process) | Solved via Redis routing + pub/sub |
| New moving parts | Postgres | Postgres **+ Redis** |

The big idea: **Stage 02 made one server strong; Stage 03 lets you use many servers together.** That is how you actually reach tens of thousands of concurrent users, and how you survive a single server dying.

### The durable-vs-ephemeral split (the key mental model)

Stage 03 introduces a rule you keep forever:

- **Postgres = durable truth.** Messages, users, membership. Must never be lost.
- **Redis = fast, disposable coordination.** "Who is online, on which server." If Redis lost it all, nobody's *messages* are lost; users just re-announce their presence on reconnect and re-read history from Postgres.

Never put durable data in Redis, and never hammer Postgres with high-churn presence updates. Right tool, right job.

---

## What actually happens when Alice messages Bob (step by step)

```
1. Alice's socket is on Server A. She sends "hi Bob".
2. Server A authorizes her, then WRITES the message to Postgres (durable, gets an id).
3. Server A ACKs Alice   -> "sent" tick appears. (Ack only AFTER durable save = no loss.)
4. Server A asks Redis:  "which server is Bob on?"  ->  Redis: "Server B".
5. Server A PUBLISHES the message to Redis channel `server:B`.
6. Server B is subscribed to `server:B`, receives it, and pushes it down Bob's socket.
7. Bob sees "hi Bob". Total time: a few milliseconds.
```

If Bob was **offline** (not in the directory), step 4 returns nothing. The message is already safe in Postgres, so Bob simply fetches it via history when he reconnects. (A production app would also send a push notification here.)

There is also a **fast path**: if the recipient happens to be on the *same* server as the sender, we deliver directly and skip Redis entirely.

---

## Requirements

- Node 20+
- Docker (for Postgres + Redis)

## Run it (this is a real 2-server cluster, so you use 3 terminals)

```bash
cd stage-03-multiserver-redis
cp .env.example .env
npm install
npm run infra:up        # Postgres on 5436 + Redis on 6380
```

Terminal 1 - server A:
```bash
npm run start:a         # SERVER_ID=A on port 3001
```

Terminal 2 - server B:
```bash
npm run start:b         # SERVER_ID=B on port 3002
```

Terminal 3 - the proof:
```bash
npm run smoke
```

Expected output (real run):
```
server A id=A, server B id=B
alice on A, bob on B
bob received it, delivered via server B (cross-server hop worked)
ALL CROSS-SERVER SMOKE CHECKS PASSED
```

The smoke test connects Alice to server A and Bob to server B (genuinely different processes), sends one message, and asserts Bob receives it, that it was delivered by Bob's own server, that retries are deduped cluster-wide, and that history is shared.

## Peek at Redis while it runs

With both servers up and two clients connected, in another terminal:
```bash
docker exec stage03-redis redis-cli KEYS 'presence:*'        # the directory
docker exec stage03-redis redis-cli PUBSUB CHANNELS 'server:*'  # each server's mailbox
```

You will see `server:A` and `server:B` as subscribed channels, and `presence:<userId>` keys showing where each user is.

## Best-practice choices worth calling out

- **Stateless-by-token auth.** All servers share `AUTH_SECRET`, so a token works on any server. That is what lets a load balancer send a user to *any* instance. No server-local sessions.
- **Presence with TTL + heartbeat.** `presence:{user}` keys expire (default 30s) and are refreshed every 10s. If a server crashes, its stale entries vanish automatically. No ghost "online" users.
- **Three Redis connections.** A connection in subscriber mode cannot run normal commands, so we separate `command`, `publisher`, and `subscriber` clients (a common gotcha).
- **Migrations are serialized with a Postgres advisory lock.** When multiple servers boot at once they would otherwise race on `CREATE TABLE` and crash. The lock lets one migrate while the others wait. (We hit this exact bug while building the stage; the fix is in `src/db/migrate.ts`.)
- **Durable-first delivery.** The sender is ACKed only after the message is persisted; cross-server delivery is a separate step. A delivery that misses (recipient just disconnected) is not data loss, the message is fetched via history on reconnect.
- **Graceful shutdown** removes the server from presence and unsubscribes, so a clean deploy does not leave stale routing entries.

## Files

```
docker-compose.yml            Postgres (5436) + Redis (6380)
migrations/001_init.sql        durable schema (same as Stage 00)
src/db/redis.ts                three Redis clients (cmd / pub / sub)
src/db/migrate.ts              advisory-lock-guarded migrations (multi-instance safe)
src/ws/registry.ts             sockets held by THIS process (half the picture)
src/ws/routing.ts    <- STAR   Redis directory + pub/sub delivery (the other half)
src/ws/hub.ts                  WS lifecycle: auth, send/persist, route, history
src/http/server.ts             register / direct-conversation / health
src/index.ts                   one gateway instance (run A and B)
scripts/smoke.ts               proves cross-server delivery end to end
```

## When do you move to Stage 04?

Redis pub/sub is a fire-and-forget megaphone. It is perfect here, but you outgrow it when:

- [ ] The message rate is high enough that writing every message to Postgres on the hot request path is a bottleneck.
- [ ] You need delivery that can be **replayed** after a consumer was briefly down (pub/sub forgets; a message bus remembers).
- [ ] Fan-out to large groups needs to be processed by scalable background workers, not inline in the gateway.

Those needs push you to a **durable message bus (Kafka / Redis Streams)** and background workers, plus a write-optimized store and sharding. That is **Stage 04**.

## Cleanup

```bash
npm run infra:down                                       # stop Postgres + Redis
docker volume rm stage-03-multiserver-redis_stage03_pgdata   # wipe data (optional)
```
