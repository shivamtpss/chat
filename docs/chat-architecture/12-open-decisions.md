# 12 - Open Decisions & Assumptions Log

Tracks decisions that need product/stakeholder input and assumptions made to keep the design moving. Update as answers arrive.

## Open decisions (need input)

| # | Decision | Why it matters | Default if unanswered | Blocks |
|---|---|---|---|---|
| D1 | **Monthly cloud budget (`$X`)** | Drives node counts, whether we run Scylla/OpenSearch from day one or defer | Lean MVP ~$4-6k/mo; full ~$6-13k/mo (doc 09) | Final capacity sizing |
| D2 | **E2EE required?** | If yes, kills server-side search + moderation, changes media + multi-device key mgmt; not retrofittable | No E2EE in MVP (search/moderation required) | Search, moderation, media design |
| D3 | **Global users at launch?** | Forces multi-region cells + geo-routing much earlier | Single region MVP | Region topology, cost |
| D4 | **Broadcast channels >500?** | Shifts to fan-out-on-read / pull model as the default | Group cap 500, fan-out-on-write | Fan-out strategy |
| D5 | **Deep-history search needed?** | Bounding the search index window is the top cost lever | Bounded index window | Search retention, cost |

## Assumptions locked (reversible)

| # | Assumption | Source |
|---|---|---|
| A1 | Single region for MVP | doc 00 |
| A2 | No E2EE in MVP | doc 00, doc 08 |
| A3 | ~$5-8k/mo budget target | doc 00, doc 09 |
| A4 | Clients: iOS, Android, Web | doc 00 |
| A5 | "No loss" = durable persist + at-least-once + dedup | doc 00, doc 06 |
| A6 | Media capped (~100 MB), S3 + CDN, never proxied | doc 00, doc 11 |
| A7 | Avg 1 KB/stored message; ~10% peak duty cycle for storage math | doc 01 |
| A8 | Blended fan-out ~10x, peak headroom to ~1M egress/sec | doc 01, doc 06 |

## Resolution log

_(empty - record answers here as `D#: <answer> (date)`)_
