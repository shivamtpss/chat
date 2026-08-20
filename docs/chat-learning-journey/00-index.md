# Chat System - Learning Journey (Small to Large)

A step-by-step, teaching-first guide. We start with a tiny app for **50-100 users** and grow it one stage at a time. At every stage we ask the same three questions:

1. **What do we have now?** (the simplest thing that works)
2. **What breaks as users grow?** (the real pain, with symptoms)
3. **Why this fix / why this tech?** (Postgres, indexing, concurrency, Redis, etc.)

This is the opposite of "design the giant system first". A small firm does **not** start at MVP-for-a-million. It starts small, ships, and grows only when a real problem forces it. That is exactly what this journey teaches.

> If you want the "final big-system" reference, see the sibling folder `../chat-architecture/`. This folder is the *how you get there, and why* version.

## The golden rule of this journey

> **Do not add a technology until a real, measured problem forces it.**
> Every box you add (Redis, a queue, a second database) is more to run, more to break, and more to learn. Add it when the pain is real, not because a blog said so.

## Stages at a glance

| Stage | Users (concurrent) | Shape | New thing you learn |
|---|---|---|---|
| [00](00-stage-50-100-users.md) | 50-100 | One small server + one DB | Why simple wins; the first schema |
| [01](01-stage-100-1k-users.md) | 100-1,000 | Same, but with indexes & real schema | **Indexing**: why a query suddenly gets slow |
| [02](02-stage-1k-10k-users.md) | 1,000-10,000 | Concurrency + connection pooling | **Multi-handling**: many users at once |
| [03](03-stage-10k-50k-users.md) | 10,000-50,000 | Multiple servers + Redis | Why one server isn't enough; routing |
| [04](04-stage-50k-100k-users.md) | 50,000-100,000+ | Queue + specialized DB + sharding | Bus, wide-column DB, partitioning |

## Deep-dive appendices (read when the stage points you here)

| Doc | Topic |
|---|---|
| [A1 - Indexing explained](A1-indexing-explained.md) | What an index is, when to add one, the cost |
| [A2 - Concurrency & multi-handling](A2-concurrency-multihandling.md) | Threads, event loops, pools, locks, in plain words |
| [A3 - Glossary & decision cheatsheet](A3-glossary-cheatsheet.md) | Every term defined + "when do I add X?" table |

## How to use this

Read stages **in order**. Each stage ends with a "graduation checklist": the symptoms that tell you it is time to move to the next stage. Do not skip ahead. The whole point is to feel *why* each step exists.
