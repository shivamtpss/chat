# Stage 01 - Indexing Lab

A hands-on lab where you **feel** what an index does. You run the real chat query, watch Postgres choose a slow `Seq Scan`, add an index, and watch it flip to a fast `Index Scan`, with `EXPLAIN ANALYZE` evidence and real timings every step.

This is the runnable companion to `../docs/chat-learning-journey/01-stage-100-1k-users.md` and `../docs/chat-learning-journey/A1-indexing-explained.md`.

## How this builds on (and helps over) Stage 00

Stage 00 was a **working chat app** that already did the right thing: it shipped with the correct indexes and keyset pagination baked in. That is correct for production, but it means you never got to *see the problem those choices solve*. You just trusted that they mattered.

Stage 01 flips that around. It is **not another app**; it is a laboratory whose only job is to teach one skill deeply: indexing. The difference:

| | Stage 00 (the app) | Stage 01 (this lab) |
|---|---|---|
| Goal | Ship a correct chat | Understand *why* it is correct |
| Indexes | Pre-created in the migration | You add/drop them live and measure |
| Schema | Correct from the start | Deliberately starts **bare** (no secondary indexes) so you can see the slow "before" |
| Evidence | "trust me, it is fast" | `EXPLAIN ANALYZE` plans + timings you can reproduce |
| Data | ~a few messages | 300k messages so scans actually hurt |
| Outcome | A running product | The judgment to know when/what to index |

Put simply: **Stage 00 gave you the answer; Stage 01 shows you the working.** After this lab, the index lines in Stage 00's `001_init.sql` stop being magic and become obvious.

It also directly finishes answering your earlier question ("if we paginate, how can it be slow?"). Experiment 4 proves that `LIMIT 50` alone does not save you: deep `OFFSET` pages stay slow even with an index, while keyset pagination stays flat.

## What you will learn (6 experiments)

| # | Experiment | The lesson |
|---|---|---|
| 1 | Seq Scan vs Index Scan | The core idea. No index = read the whole table; with index = jump straight to the rows. |
| 2 | Composite index column order | `(conversation_id, id)` helps a conversation filter, but not a `sender_id`-only filter. Leading column matters. |
| 3 | Index-only / covering index | An index holding every needed column answers without touching the table (`Heap Fetches: 0`). |
| 4 | OFFSET vs keyset pagination | `LIMIT` caps output, not work. OFFSET rescans skipped rows; keyset (`id < cursor`) stays flat. |
| 5 | Write-cost of indexes | Each index slows every INSERT and uses disk. Why we do not index everything. |
| 6 | Detecting unused indexes | `pg_stat_user_indexes` shows which indexes nobody uses so you can drop the freeloaders. |

## Requirements

- Node 20+
- Docker (for Postgres)

## Quick start

```bash
cd stage-01-indexing-lab
cp .env.example .env
npm install
npm run db:up          # Postgres in Docker on host port 5434
npm run seed           # ~300k messages (takes ~20-30s). Prints a hot + sparse conversation id.
npm run lab:all        # run all six experiments in order
```

Run one at a time to focus:

```bash
npm run lab 1          # just Seq Scan vs Index Scan
npm run lab 4          # just OFFSET vs keyset
```

Re-seed any time to reset to a clean, index-free state:

```bash
npm run seed
```

## Real output from this machine (300k messages)

Experiment 1 (the headline):

```
[BEFORE: no index]
  scan: Seq Scan
  Execution Time: 68.176 ms      <- reads the whole table, sorts, to return 50 rows
[AFTER: with composite index]
  scan: Index Scan using ix_lab_conv_id
  Execution Time: 0.187 ms       <- jumps to the rows, already ordered
  => ~365x faster
```

Experiment 4 (your pagination question, settled):

```
OFFSET 0      (first page)   0.81 ms
OFFSET 75230  (deep page)   95.59 ms    <- same 50 rows, but scans+discards 75k
KEYSET id<cursor (deep page) 0.89 ms    <- stays flat
```

Experiment 5 (the trade-off, so you do not over-index):

```
0 secondary indexes: 1909 ms   index size 15 MB
1 secondary index:   2050 ms   index size 42 MB
3 secondary indexes: 2050 ms   index size 51 MB
```

Your absolute numbers will differ by hardware; the **ratios and the scan-kind flips** are the lesson.

## Why the lab uses two conversations (an honest-teaching note)

The seed creates one **hot** conversation (~75k messages, 25% of the table) and many **sparse** ones (~100 messages each).

- The **sparse** conversation is used for the scan lessons (1, 2, 3, 6). With few matching rows spread through a big table, a missing index really forces a full `Seq Scan`, so the "before" is honestly slow.
- The **hot** conversation is used for pagination depth (4), because you need tens of thousands of rows to make a deep `OFFSET` visibly crawl.

This matters: if we had only used the hot conversation for experiment 1, Postgres could satisfy it quickly by scanning its primary key backward and you would not see the lesson. Choosing the right data to demonstrate a point is itself a real skill.

## How to read an EXPLAIN plan (cheat sheet)

- **`Seq Scan`**: reading the whole table. Fine for tiny tables, a red flag for big ones on a frequent query.
- **`Index Scan`**: using an index to jump to rows. What you want for selective filters.
- **`Index Only Scan`** + **`Heap Fetches: 0`**: answered entirely from the index (covering index).
- **`Rows Removed by Filter: N`**: how many rows Postgres looked at and threw away. Big number = wasted work.
- **`Execution Time`**: actual time to run (from `EXPLAIN ANALYZE`).
- **`using <name>`**: which index was chosen.

## Files

```
migrations/001_bare_schema.sql   tables with PK only (no secondary indexes, on purpose)
src/lib/explain.ts               EXPLAIN/timing/index helpers (the lab engine)
src/seed.ts                      generates 300k messages + hot/sparse conversations
src/lab.ts                       menu + runner (npm run lab <n|all>)
src/experiments/01..06           one file per lesson, each heavily commented
```

## When are you truly done with Stage 01 (ready for Stage 02)?

You have internalized indexing when you can, without looking it up:

- [ ] Predict whether a query will use an index from its `WHERE` / `ORDER BY`.
- [ ] Read an `EXPLAIN ANALYZE` plan and spot a `Seq Scan` on a big table.
- [ ] Choose composite index column order (equality filter first, range/sort second).
- [ ] Explain why keyset pagination beats OFFSET for deep pages.
- [ ] Justify NOT adding an index because of its write cost.

Once indexing is second nature, the next wall is not about data shape at all. It is **many users acting at the same time**: connection-pool exhaustion, blocking, and concurrency. That is Stage 02.

## Cleanup

```bash
npm run db:down                                   # stop Postgres
docker volume rm stage-01-indexing-lab_stage01_pgdata   # wipe data (optional)
```
