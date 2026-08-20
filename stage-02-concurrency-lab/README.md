# Stage 02 - Concurrency Lab (how one server serves MANY users at once)

A hands-on lab for the jump from a handful of users to **1,000-10,000 at the same time**. You do not change the app's features. You learn why the *same* app that felt instant for 100 users can fall over for 5,000, and the handful of techniques that fix it.

This is the runnable companion to `../docs/chat-learning-journey/02-stage-1k-10k-users.md` and `../docs/chat-learning-journey/A2-concurrency-multihandling.md`.

---

## First, the big idea (read this even if you skip everything else)

Stage 00 and Stage 01 asked: **"how fast is ONE request?"**
Stage 02 asks a completely different question: **"what happens when a THOUSAND requests arrive at the same moment?"**

These are not the same problem. A query that takes 1 millisecond is great. But if 5,000 users fire that 1 ms query in the same instant and your server can only run 10 at a time, then 4,990 of them are standing in a queue. The request was never slow. The *waiting* is what hurts.

That waiting is called a **concurrency** problem, and it is the wall every growing app hits.

---

## A real-world picture: the coffee shop

Imagine a coffee shop.

- **Stage 01 (indexing)** was about making each coffee faster: a better espresso machine so one drink takes 20 seconds instead of 2 minutes.
- **Stage 02 (concurrency)** is about the morning rush: 200 people walk in at 8:00am. It does not matter how fast one coffee is if you have **one barista** and **one register**. The line goes out the door.

The fixes are about *how many things happen at once*, not how fast each one is:
- How many baristas (database connections) do you have?
- What if one customer orders 40 custom drinks and blocks the register for 10 minutes (a slow query)?
- What if the single cashier stops to deep-clean the machine mid-rush and serves nobody (blocking the event loop)?
- How many people can you actually serve per minute before the line just gets longer (the throughput knee)?

Every experiment below is one of these coffee-shop problems, with real measured numbers.

---

## How Stage 02 is better than Stage 00 / Stage 01

| | Stage 00 (app) | Stage 01 (indexing lab) | Stage 02 (this lab) |
|---|---|---|---|
| Question answered | "Does it work?" | "How fast is one query?" | "What happens under many users at once?" |
| The enemy | missing features | full table scans | waiting, queuing, one bad request hurting all |
| Key tools learned | schema, WebSocket, dedup | indexes, EXPLAIN, keyset | pools, timeouts, async/event loop, load testing |
| How you measure | it runs | single-query ms | throughput + p50/p95/**p99** under load |
| Users it prepares you for | ~100 | ~100-1,000 (fast data) | ~1,000-10,000 (fast under load) |

Stage 01 made each request cheap. **Stage 02 makes thousands of those cheap requests survive arriving together.** Without Stage 01, Stage 02 would be hopeless (a slow query under load is a disaster). With both, one well-tuned server carries far more than beginners expect, which is exactly why you delay buying more servers (Stage 03) until you have squeezed this.

### The one new metric you must learn: p99

We stop looking at averages. We report **p50 / p95 / p99** latency.

- **p50** = the median. Half of users were faster than this.
- **p99** = the slow tail. 1 in 100 requests was at least this slow.

Averages lie. If 99 requests take 5 ms and 1 takes 3,000 ms, the "average" looks fine but 1% of your users had a terrible time. In chat, that is the person whose message hangs. **We optimize the tail, not the average.**

---

## The 4 experiments (with real numbers from this machine)

Your absolute numbers depend on your hardware. The *shapes and ratios* are the lesson.

### Experiment 1: pool size vs concurrency ("how many baristas?")

A **connection pool** is a small, fixed set of reusable database connections shared by every request. The database cannot handle thousands of direct connections (each costs it memory), so we share a few.

Same load (2,000 requests, 200 at a time), only the pool size changes:

```
pool max = 1    throughput=1557 ops/s   p99=171 ms     (everything serialized)
pool max = 5    throughput=4749 ops/s   p99=57 ms      (sweet spot here)
pool max = 20   throughput=3715 ops/s   p99=90 ms
pool max = 50   throughput=3435 ops/s   p99=211 ms  + 15 "too many clients" ERRORS
```

Lessons:
- **pool=1** is like one barista: every request waits its turn. Worst throughput, worst tail.
- Growing the pool helps... up to a point.
- **pool=50 got WORSE and started failing** with `too many clients already`, because it exceeded the database's own `max_connections`. More is not always better. A pool bigger than the DB can handle just moves the failure into the database.
- Real world: apps pick a modest pool (often 10-30 per instance) and use **PgBouncer** to funnel many app connections into few DB ones.

### Experiment 2: one slow query drains the pool (the classic outage)

Only **10** deliberately slow queries (3 seconds each) mixed into **500** fast ones, sharing a pool of 10:

```
WITHOUT statement_timeout:  p50=11 ms  but p99=3012 ms   <- fast users held hostage
WITH statement_timeout=500ms: p50=12 ms  p99=584 ms  (10 slow ones fail fast)
                              throughput 162 -> 679 ops/s
```

Lessons:
- Ten bad queries poisoned the experience for everyone: the p99 for *fast* requests jumped to ~3 seconds because all the connections were held by the slow ones.
- Adding a **statement_timeout** cancelled the runaways after 500 ms, freed the connections, and protected the 500 good requests. You deliberately sacrifice the 10 bad requests to save the majority.
- Real world: this is one of the most common production incidents. Always bound query time and connection-wait time. A single runaway query must never take the whole app down.

### Experiment 3: blocking the event loop (the greedy request that freezes everyone)

Node.js runs your code on a **single main thread** (the "event loop"). It juggles thousands of *waiting* connections beautifully, but if one request does heavy CPU work in one burst, nobody else gets served until it finishes.

800 light requests with 8 CPU-heavy ones mixed in:

```
BLOCKING (heavy work in one burst):  light-request p99=1530 ms   <- everyone froze
CHUNKED  (heavy work yields):        light-request p99=106 ms    <- stayed responsive
```

Lessons:
- In blocking mode, the light requests' tail exploded because a greedy handler hogged the only thread.
- Breaking the work into chunks that periodically **yield** kept the server responsive.
- Real world: never do big CPU work inline (image processing, huge JSON, crypto loops). Offload it (worker threads, a separate service, a queue) or chunk it. This is why chat gateways keep per-connection work tiny: one greedy handler must not stall thousands of sockets.

### Experiment 4: throughput vs concurrency (find the sweet spot)

Ramp how many requests run at once through a fixed pool:

```
concurrency  throughput(ops/s)   p50 ms   p99 ms
    1              1316            0.5      3.0
   10              1767            4.1     21.2
   50              2100           20.7     70.2
  200              5140           38.3     47.0
  400              5513           70.8     79.0
```

Lessons:
- More concurrency buys more throughput, but with **diminishing returns**, and latency climbs the whole way (p50 went from 0.5 ms to 70 ms).
- The **"knee"** is where extra load stops buying throughput and only adds waiting. Above it, users just wait longer for the same work.
- Real world: load-test to find *your* knee, then size pools and instances around it. Do not just crank a number and hope.

---

## Requirements

- Node 20+
- Docker (for Postgres)

## Quick start

```bash
cd stage-02-concurrency-lab
cp .env.example .env
npm install
npm run db:up          # Postgres in Docker on host port 5435 (max_connections=50)
npm run seed           # ~200k messages so queries touch real data
npm run lab:all        # run all four experiments
```

Run one at a time:

```bash
npm run lab 1     # pool size
npm run lab 2     # slow-query drain
npm run lab 3     # event-loop blocking
npm run lab 4     # throughput curve
```

## Files

```
migrations/001_schema.sql          messages + the hot-query index (indexing is already solved)
src/db/pool.ts                     makePool(): build pools of any size + timeouts (the lab's dial)
src/lib/load.ts                    the load-test engine: runs N tasks C-at-a-time, reports p50/p95/p99
src/seed.ts                        generate 200k messages
src/lab.ts                         menu + runner
src/experiments/01..04             one file per lesson, each heavily commented
```

## What actually improved from Stage 00/01 (the takeaways)

1. **Connection pooling with the right size** (not too small, not bigger than the DB allows).
2. **Timeouts everywhere**: `statement_timeout` (cap query time) and `connectionTimeoutMillis` (cap how long you wait for a free connection). These turn a total freeze into a few fast, isolated failures.
3. **Never block the event loop**: keep per-request CPU work tiny; offload or chunk heavy work.
4. **Measure the tail (p99), not the average**, and load-test to find your throughput knee.

Notice all four are about *behavior under simultaneous load*, not features. Same app, far more users.

## When do you move to Stage 03?

You have outgrown Stage 02 when the limit is no longer *inside* one server but is the *single server itself*:

- [ ] You have tuned the pool, added timeouts, and stopped blocking the loop, and one machine's CPU or memory is still maxed by the number of connections.
- [ ] You need a second server for capacity or so a crash/deploy does not drop everyone.
- [ ] You realize: "if Alice is connected to server A and Bob to server B, how does Alice's message reach Bob?"

That last question has no answer within a single process. Solving it needs shared state between servers, which is why **Stage 03** introduces **Redis** for routing and pub/sub.

## Cleanup

```bash
npm run db:down                                       # stop Postgres
docker volume rm stage-02-concurrency-lab_stage02_pgdata   # wipe data (optional)
```
