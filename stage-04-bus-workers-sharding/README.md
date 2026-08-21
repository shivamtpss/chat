# Stage 04 - Durable Message Bus + Workers + Sharding

The final scaling stage. You stop doing all the work on the request that receives a message, and instead drop it on a **durable log** that background **workers** process. You also learn **sharding**: splitting the messages table by a partition key so data (and load) spreads out. This is the shape real large-scale chat systems use.

Runnable companion to `../docs/chat-learning-journey/04-stage-50k-100k-users.md`.

---

## The two problems Stage 03 still had

Stage 03 gave us multiple servers that could reach each other via Redis. But two weaknesses remained:

1. **Fire-and-forget delivery.** Redis pub/sub is a megaphone: if nobody is listening at that exact instant, the shout is gone. If a delivery step or a downstream (search indexer, push sender) was briefly down, that work was simply lost.
2. **The gateway did everything inline.** For every message it persisted to the DB, looked up recipients, and fanned out, all on the hot path while holding thousands of sockets. A burst of traffic hits the database directly, and a slow step backs up the whole request.

Stage 04 fixes both with one idea: **put a durable log (a "bus") in the middle, and move the heavy work to separate worker processes.**

---

## Real-world picture: a restaurant kitchen

- **Stage 03** was a waiter who takes your order and *also* cooks it, plates it, and washes up, all before taking the next order. Fine when it is quiet. In a rush, the line backs up to the door.
- **Stage 04** is a real kitchen. The waiter (gateway) just takes the order and clips the ticket to the **order rail** (the durable bus). The order is now safely recorded. **Cooks** (workers) pull tickets off the rail and prepare them. Add more cooks for a rush. If a cook steps away, the tickets wait on the rail, none are lost. When the cook returns, they pick up where they left off.

That "order rail" is the whole point:
- It is **durable**: a ticket sits there until a cook finishes it and marks it done (an "ack").
- It **absorbs bursts**: a flood of orders queues on the rail instead of overwhelming one person.
- It lets you **scale cooks independently** of waiters.

---

## How Stage 04 is better than Stage 03

| | Stage 03 (servers + Redis pub/sub) | Stage 04 (this: bus + workers + sharding) |
|---|---|---|
| Delivery if a consumer is down | Lost (fire-and-forget) | **Waits in the log, replayed later** |
| Hot path per message | persist + fan-out inline on the gateway | gateway just appends to the bus, returns |
| Handling a traffic burst | database hit directly, can overload | bus absorbs it; workers drain at their pace |
| Scaling the heavy work | tied to gateways | **add workers independently** |
| Message table | one big table | **partitioned (sharded) by conversation_id** |
| Ordering | per-conversation | per-conversation `seq` assigned by the worker |

The mental leap: **accept fast, process later, never lose the work.** This is how you reach 50k+ messages/second without the database being on the critical path of every send.

---

## What happens when Alice sends a message now

```
1. Alice's socket is on Gateway A. She sends "hi".
2. Gateway A authorizes her, then APPENDS the job to the durable bus (a Redis Stream).
3. Gateway A immediately replies "accepted" (queued safely) and moves on. Hot path done.
4. A WORKER pulls the job off the bus.
5. Worker PERSISTS it to Postgres (idempotent; assigns per-conversation seq 1,2,3...).
6. Worker sends the durable "ack" back to Alice (routed to her gateway) -> her "sent" tick.
7. Worker delivers the message to Bob wherever he is connected (Redis routing from Stage 03).
8. Worker ACKs the bus entry -> the ticket is marked done.
```

Two acknowledgements, on purpose:
- **`accepted`** = the gateway safely queued it on the durable bus (it cannot be lost now).
- **`ack`** = a worker actually persisted it to the database (with its `seq`).

If every worker is down between steps 3 and 4, the job simply waits on the bus. When a worker starts, it processes the backlog. **Nothing is lost.** That is the headline improvement, and the `demo:replay` script proves it.

---

## Sharding (partitioning) by conversation_id

The `messages` table is declared `PARTITION BY HASH (conversation_id)` with 8 partitions. Postgres hashes each row's `conversation_id` to decide which physical partition it lives in.

- **Every message of one conversation goes to the same partition**, so "read this conversation in order" is a cheap single-partition scan.
- **Different conversations spread across partitions**, so load and data are distributed.

Why `conversation_id` and not `user_id`? Because we always read "one conversation, in order". Sharding by user would scatter a conversation across partitions and wreck ordered reads. **The shard key must match how you read the data.**

In this lab it is partitions inside one Postgres. In a system at true scale, the *same* key would spread data across **machines** (Cassandra/ScyllaDB). The concept is identical; only the blast radius differs.

---

## Honest scope notes (what is real vs simplified)

This lab teaches the real patterns with approachable tools, and is upfront about the swaps:

- **Bus = Redis Streams**, not Kafka. Redis Streams has the same core model (append-only log, consumer groups, offsets, acks, replay) with zero extra services to run. Kafka is the production destination when you need higher throughput and longer retention; the code seam (publish / consume-group / ack) is the same.
- **Sharding = Postgres hash partitions**, not a multi-machine cluster. Same partition-key thinking; single node so you can actually run it.
- **Ordering**: `seq` is assigned per conversation by the worker. Because the consumer group hands each bus entry to one consumer and persist is idempotent, sequences stay clean. At true scale you would key the bus by conversation so one worker owns a conversation's ordering.

None of these simplifications change the lessons; they just keep the lab runnable on a laptop.

---

## Requirements

- Node 20+
- Docker (Postgres + Redis)

## Run the demos (no long-lived servers needed)

```bash
cd stage-04-bus-workers-sharding
cp .env.example .env
npm install
npm run infra:up

npm run demo:sharding    # shows conversations spread across partitions, ordered seq
npm run demo:replay      # publishes 25 msgs with NO worker, then starts one and drains them
```

Real output from `demo:replay`:
```
1) Publishing 25 messages to the bus with NO worker running...
   bus log length:      25  (durable, waiting)
   persisted in Postgres: 0  <- still zero, no worker yet
   >>> In Stage 03 (pub/sub) these 25 messages would be GONE. Here they are safe.
2) Starting a worker now...
3) After the worker ran:
   persisted in Postgres: 25
SUCCESS: all 25 messages published while offline were REPLAYED and persisted.
```

Real output from `demo:sharding`:
```
2) Which partition holds each conversation:
   conversation 0  ->  messages_p0
   conversation 1  ->  messages_p6
   ...
4) Ordering within one conversation (seq is 1..5, single partition):
   seq=1 ... seq=5   [messages_p0]
   -> conversation 0 lives in exactly 1 partition, with ordered seq.
```

## Run the full live system (4 terminals)

```bash
npm run infra:up
npm run gateway:a     # terminal 1: the WebSocket gateway on :3001
npm run worker:1      # terminal 2: a background worker
npm run smoke         # terminal 3: end-to-end test
# optional terminal 4: npm run worker:2  (a second worker; the bus shares work between them)
```

Smoke output:
```
accepted -> ack(seq=1) -> delivered. Bus path works.
ALL SMOKE CHECKS PASSED
```

Try scaling: start `worker:2` as well and watch the two workers split the load (the consumer group gives each bus entry to exactly one of them).

## Files

```
docker-compose.yml           Postgres (5437) + Redis (6381, appendonly for a durable bus)
migrations/001_init.sql       schema; messages PARTITION BY HASH (conversation_id)
src/db/migrate.ts             advisory-locked migrations + creates N hash partitions
src/bus/bus.ts       <- NEW   durable log over Redis Streams (publish/read-group/ack/replay)
src/bus/routing.ts            Redis directory + pub/sub delivery (from Stage 03)
src/gateway/hub.ts            WS edge: authorize, append to bus, return "accepted"
src/worker/index.ts  <- NEW   consume bus -> persist -> deliver -> ack; scalable + replayable
src/db/repo.ts                persistMessage (idempotent + per-conversation seq), partition helpers
scripts/demo-replay.ts        proves durability/replay after downtime
scripts/demo-sharding.ts      proves partition spread + in-conversation ordering
scripts/smoke.ts              full live path test
```

## When would you go beyond Stage 04?

This is the architecture that carries you to very large scale. Beyond here you are tuning and specializing, not restructuring:

- Swap Redis Streams -> **Kafka** when throughput/retention demand it.
- Swap Postgres partitions -> **Cassandra/ScyllaDB** across machines when one node cannot hold the writes.
- Add **multi-region** (Stage D in the architecture docs): regional cells, geo-routing, presence sampling.
- Split workers by job type (persist vs search-index vs push) and scale each independently.

See `../docs/chat-architecture/` for the full large-scale reference design.

## Cleanup

```bash
npm run infra:down                                             # stop Postgres + Redis
docker volume rm stage-04-bus-workers-sharding_stage04_pgdata  # wipe data (optional)
docker volume rm stage-04-bus-workers-sharding_stage04_redisdata
```
