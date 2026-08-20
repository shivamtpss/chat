# Real-Time Chat System - Architecture Documentation

Principal-architect design set for a real-time chat platform.

## Target at a glance

| Dimension | Target |
|---|---|
| Registered users | 1,000,000 |
| Concurrent connections | 100,000 |
| Peak throughput | 50,000 msg/sec |
| Features | 1:1 + group (≤500), presence, typing, read receipts, media, push, history/search |
| Team | 4 engineers |
| Timeline | MVP in 8 weeks |
| p99 delivery | < 200 ms |
| Guarantees | No message loss, ordered per-conversation |

## Working assumptions (change any of these)

1. **Single region for MVP**, multi-region deferred to the scaling phase.
2. **No E2EE in MVP.** Server-side search and moderation are required, which is incompatible with end-to-end encryption. E2EE is a phase-2 decision because it is not retrofittable.
3. **Budget target ~$5k–$8k/mo** for MVP infrastructure. Scale-phase cost modeled separately.
4. Clients are **iOS, Android, and Web**.
5. "No message loss" means **durably persisted + at-least-once delivery + dedup** (effectively-once), not distributed exactly-once.
6. Media is capped (e.g. 100 MB/file) and served via object storage + CDN, never proxied through chat servers.

## Document map

| # | Doc | Covers |
|---|---|---|
| 01 | [Requirements & Capacity Math](01-requirements-capacity.md) | Connections, RAM/conn, fan-out, storage/day |
| 02 | [Architecture & Diagram](02-architecture-diagram.md) | Components, data flow, sequence diagrams |
| 03 | [Tech Stack & Rejected Alternatives](03-tech-stack.md) | Every choice + what we rejected and why |
| 04 | [Transport & Load Balancing](04-transport-lb.md) | WS vs SSE vs long-poll vs MQTT/QUIC, sticky sessions |
| 05 | [Data Model & Sharding](05-data-model-sharding.md) | Schemas, DB choice, partition keys |
| 06 | [Delivery Semantics](06-delivery-semantics.md) | At-least-once, dedup, idempotency, ordering, offline |
| 07 | [Scaling Path](07-scaling-path.md) | 1k → 100k → 1M, what breaks at each step |
| 08 | [Failure, Observability, Security](08-failure-observability-security.md) | Failure modes, mitigations, metrics, authZ, E2EE |
| 09 | [Cost & Roadmap](09-cost-roadmap.md) | Cost estimate + phased 8-week plan |
| 10 | [Trade-offs & Riskiest Assumptions](10-tradeoffs-risks.md) | Decision table + top 3 risks |
| 11 | [Challenges & Resolutions](11-challenges-and-resolutions.md) | Real-world problems we WILL hit and how we fix them |
| 12 | [Open Decisions & Assumptions Log](12-open-decisions.md) | Decisions needing input + locked assumptions to revisit |

## How to read this

Start with 01 (why the numbers force the design), then 02 (the shape), then 11 (the war stories). Docs 03–10 are the reference detail behind those.
