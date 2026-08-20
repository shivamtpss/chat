# Stage 00 Chat - 50 to 100 Users (done with best practices)

A tiny but correctly-built real-time chat: **one server + one Postgres**. This is the runnable companion to `../docs/chat-learning-journey/00-stage-50-100-users.md`. It deliberately avoids Redis, queues, and sharding, because at 50-100 users those solve problems you do not have yet. What it does NOT skip is doing the fundamentals right.

## What is inside

- **WebSocket** real-time messaging (`ws`) + a small **HTTP** API on the same port.
- **Postgres** with a clean schema, foreign keys, and the exact indexes our queries need.
- **Best-practice habits from day one:**
  - Validated config (fails fast on bad env).
  - A shared **connection pool** with a statement timeout.
  - **Parameterized queries** everywhere (no SQL injection).
  - **Idempotent sends** via `(conversation_id, client_msg_id)` unique index (safe retries, no duplicates).
  - **Keyset/cursor pagination** (not OFFSET) so history stays fast forever.
  - **Auth on connect** + **authorization per action** (never trust the client's user id).
  - Per-connection **rate limiting** and WS **heartbeats**.
  - **Graceful shutdown** and structured logging.
  - **Migrations** with a tracking table.

## Requirements

- Node 20+
- Docker (for Postgres) or your own Postgres reachable via `DATABASE_URL`

## Quick start

```bash
cd stage-00-chat
cp .env.example .env
npm install
npm run db:up          # start Postgres in Docker (host port 5433)
npm run dev            # runs migrations, then starts server on :3000
```

In another terminal, run the end-to-end smoke test:

```bash
npm run smoke
```

Expected: `ALL SMOKE CHECKS PASSED` (it verifies delivery, idempotency, authorization, and history).

## Try the pagination lesson yourself (answers "why would it be slow if we paginate?")

Your instinct: "we only ever show ~50 messages (`LIMIT 50`), so how can it be slow?"
The catch: **`LIMIT` caps the OUTPUT, not the WORK.** What matters is *how* you ask for the next page.

```bash
npm run seed -- 200000                 # seed 200k messages, prints a conversationId
npm run bench:pagination -- <thatId>   # compare OFFSET vs keyset
```

Real numbers from this machine (200k messages, both return 50 rows):

```
--- OFFSET pagination (the trap) ---
OFFSET 0 (first page)          avg 0.98 ms
OFFSET 199850 (deep page)      avg 329.37 ms   <-- 300x+ slower, same 50 rows
--- KEYSET / cursor pagination (the fix) ---
KEYSET first page              avg 0.74 ms
KEYSET deep page (id < cursor) avg 0.80 ms      <-- stays flat
```

**Why:** `OFFSET 199850 LIMIT 50` makes Postgres walk and throw away ~199,850 rows every time before returning 50. Keyset (`WHERE id < :cursor ORDER BY id DESC LIMIT 50`) jumps straight to the spot using the index `(conversation_id, id DESC)`. That is why this project paginates by cursor, and why the "load older messages" pattern in real chat apps uses a cursor, not a page number.

There are actually **two** ways pagination gets slow, and this project fixes both:
1. **No index** on `(conversation_id, id)` -> even the first page scans the whole table. Fixed by the index in `migrations/001_init.sql`.
2. **OFFSET for deep pages** -> slow even with an index. Fixed by keyset pagination in `src/db/repo.ts`.

## HTTP endpoints (for bootstrapping)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + DB check |
| POST | `/register` | Create/return a user, returns a `token` |
| POST | `/conversations/direct` | Create/return the 1:1 conversation for two user ids |
| WS | `/ws?token=...` | Real-time channel |

### WebSocket messages

Client -> server: `{type:"send", conversationId, clientMsgId, body}`, `{type:"history", conversationId, limit, beforeId?}`, `{type:"ping"}`
Server -> client: `ready`, `ack`, `message`, `history`, `pong`, `error`

## Project layout

```
migrations/001_init.sql   schema + indexes (well commented)
src/lib/config.ts         validated env
src/lib/logger.ts         structured logging
src/lib/auth.ts           tiny signed-token auth (JWT stand-in)
src/db/pool.ts            connection pool + tx helper + slow-query log
src/db/migrate.ts         forward-only migration runner
src/db/repo.ts            all SQL: users, conversations, messages, KEYSET paging
src/ws/protocol.ts        zod-validated wire protocol
src/ws/registry.ts        in-memory "who is online" (the Stage 03 upgrade point)
src/ws/hub.ts             WS lifecycle, auth, rate limit, send/history/deliver
src/http/server.ts        HTTP API
src/index.ts              composition root + graceful shutdown
scripts/                  seed, pagination benchmark, e2e smoke test
```

## When do you move to Stage 01? (concrete signals)

Stage 01 is the same architecture but you learn indexing/pagination deeply. **You have effectively already applied Stage 01's fixes here** (indexes + keyset), so watch for these signals that the *single-process* model itself is the limit and it is time for Stage 02/03:

- [ ] A `slow query` warning appears in logs (this app logs any query over 200 ms) for a query you run often. Add/adjust an index; confirm with `EXPLAIN ANALYZE`.
- [ ] History or list queries creep up as data grows despite indexes. Revisit the index/column order or add a covering index.
- [ ] The process CPU stays high with many simultaneous users, or you see `too many connections` / pool exhaustion. That is the **concurrency** wall -> Stage 02 (tune pool, async, PgBouncer).
- [ ] One machine can no longer hold all the WebSocket connections, or a restart dropping everyone is unacceptable. That is the **one-server** wall -> Stage 03 (multiple servers + Redis routing).

Rule of thumb: **do not add the next box until a measured symptom above forces it.**

## Cleanup

```bash
npm run db:down        # stop Postgres
docker volume rm stage-00-chat_stage00_pgdata   # wipe data (optional)
```
