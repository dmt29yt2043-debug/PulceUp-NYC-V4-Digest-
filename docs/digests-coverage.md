# 5 Curated Digests — Coverage Notes

Audit date: 2026-04-22. Live event pool: **197 events** (after dropping
12 past + 1 disabled from a 210-row LIVE-only CSV).

## Summary

| # | Digest                              | Target | Filled | Strong ≥ threshold | Weak (fallback) |
|---|-------------------------------------|:-----:|:-----:|:-----:|:-----:|
| 1 | Top 10 Things to Do This Weekend    | 10    | 10    | 100  | 16 |
| 2 | Top 10 Indoor (Rainy Day)           | 10    | 10    | 92   | 5  |
| 3 | 10 Easy (No Planning Needed)        | 10    | 10    | 108  | 2  |
| 4 | Top 15 Free & Affordable            | 15    | 15    | 152  | 16 |
| 5 | 10 Kids Love, Parents Don't Regret  | 10    | 10    | 131  | 23 |

All 5 digests hit their target count from strong candidates alone — no
fallback tier was needed to fill any digest.

## Per-digest details

### 1 · Top 10 Things to Do with Kids in NYC This Weekend

**Signals used** (in order of weight):
- `classifyWeekend()` — parses `next_start_at` and `occurrences[]`, returns true if an upcoming Sat/Sun falls within 14 days (NYC tz).
- `baseGeoAndCompleteness()` — NYC + Manhattan + card completeness (~50 pts).
- `classifyFamily()` — prefers `motivation` tokens (`bond`/`play`/`learn`), then `format=kids-playgroup`, then `age_best_from`.
- `classifyQuality()` — `rating_count` + review richness + engagement keywords.
- Proximity bonus: soonest matched date gets up to +10.

**Where the DB is strong.** `next_start_at` is 100% populated in the live pool; `occurrences[]` adds secondary weekend dates for recurring events. Sat+Sun dates are abundant (Saturdays are the #1 DOW in the feed).

**Fallbacks never triggered** — 96 strong candidates easily fill 10 slots.

### 2 · Top 10 Indoor Activities for Kids in NYC (Rainy Day Edition)

**Signals used**:
- `format` tokens in `INDOOR_FORMATS` set (`workshop`, `class`, `museum-visit`, `exhibition`, `theater-show`, `screening`, `lecture`, `talk`, …) — 94% live coverage.
- `data.venue_venue_type` match against `INDOOR_VENUE_TYPES`.
- Text keyword fallback (capped at 0.3 so it can't dominate format signal).
- Outdoor signals (format / text) applied as a **penalty** — keeps outdoor festivals out of the rainy-day list.

**Where the DB is weak.** Some edge cases: `format` missing (~6% of live), then we rely on text keywords which are noisier. Events with mixed format tokens (`['kids-playgroup','live-performance']`) get a medium score rather than strong.

### 3 · 10 Easy Things to Do with Kids in NYC (No Planning Needed)

**Signals used**:
- `is_free=1` → +0.3 easy
- `format` in `EASY_FORMATS` (`museum-visit`, `exhibition`, `kids-playgroup`, `open-day`) → +0.25
- Subway accessible → +0.15
- Text positives: "drop-in", "no RSVP", "included in admission", "walk-in" → up to +0.25
- Text negatives: "sold out", "registration required", "by appointment" → strong demerit
- `data.is_sold_out=true` → −0.3

**Where the DB is weak.** Subway info missing for ~31% of live events. `data.tickets_available` isn't consistently populated, so we can't use it reliably.

**Bias alert.** This digest heavily favours Manhattan (good subway + free public programs). Brooklyn events that would fit (e.g. Open Hours at Environmental Education Center) still make it in via strong family + quality scores.

### 4 · Top 15 Free & Affordable Things to Do with Kids in NYC

**Signals used**:
- `is_free=1` → confidence 1.0 (top tier).
- Else `price_max` tiered: ≤$10 → 0.9, ≤$20 → 0.75, ≤$30 → 0.6, ≤$75 → 0.3 (edge), >$75 → hard cut.
- Text fallback with `AFFORDABLE_TEXT` keywords when structured price is missing.
- `EXPENSIVE_MARKERS` ("premium", "vip", "luxury") → demerit.

**Where the DB is strong.** `is_free` is 100% populated and `price_max` is always known (even when 0). 58% of live events are free outright, another ~30% fall in the $1–$30 band — easy to fill 15.

**Bias alert.** Because free events dominate, the digest sometimes contains broader community events (PAW Day, Car-Free Earth Day, library storytimes) vs. narrowly "kid-targeted" ones. Family scoring keeps the worst off the list.

### 5 · 10 Things Kids Love (And Parents Don't Regret)

**Signals used**:
- **Hard gate**: `rating_count ≥ 5` AND `quality_confidence ≥ 0.5`.
- Rating strength: `rating_count ≥ 20 & rating_avg ≥ 4.5` → strongest; lower tiers scaled.
- Review richness: 3+ reviews → strong signal.
- `motivation` tokens in `WORTH_IT_MOTIVATIONS` (`create`, `be-inspired`, `explore`, `discover-tech`, `learn`, `play`) — scored cumulatively.
- Engagement keywords: `hands-on`, `interactive`, `workshop`, `make-and-take`, `sing-along`, etc.
- Low-quality markers ("placeholder", "tbd") and thin descriptions → demerit.

**Where the DB is weak.** `rating_avg ≥ 4` for 100% of events (useless as a sole signal), but `rating_count ≥ 20` only hits 57% of live. The 87% with `rating_count ≥ 5` is enough. Rare but real problem: some events have suspiciously rounded rating_avg (e.g. exactly 4.5) with 1–2 reviews — the rating_count gate filters these out.

## Fields that most often limited digest quality

- **`next_end_at`: 0% populated** (literally never). Weekend detection can't use a range; we only see the start time. For multi-day exhibits we rely on `occurrences` to check each day individually.
- **`categories` JSON: 0% in live pool** (always `[]`). We depend on `tags` (100%), `category_l1` (97%), and `format`/`motivation` instead.
- **`subway`: 31% missing**. Easy-plan signal degrades; we compensate with `is_free` and format.
- **`age_min`: 46% missing**. Mitigated by `age_best_from` which is 100% populated.
- **`city_district`: 0.5%** and **`city_locality`: 51%** — too sparse to use for fine-grained Manhattan sub-neighborhood filtering. County-based classification (`country_county='New York County'` → Manhattan) is much better.

## Signals available but not yet used in digests

- `schedule_confidence` (100% live) — could down-rank events with `schedule_confidence < 3` (uncertain dates) but currently unused.
- `schedule_source` — values like `intake_date`, `source_occurrences`, `llm_date` could help trust weighting.
- `class_meta` (49% live) — structured class info; not tapped yet.
- `derisk` (71% live) — has crowd / parking / accessibility notes; worth mining for future digests.

## Performance

Running all 5 digests sequentially over 207 live events takes < 50ms on the server. No caching layer is in place yet — if this becomes a hot path, add a simple file-mtime-keyed in-memory cache in `lib/digests/index.ts`.
