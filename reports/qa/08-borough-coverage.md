# Borough Coverage Audit

_Generated: 2026-04-22T20:38:21.353Z · 204 live events_

## Per-borough share vs. population

| Borough | Events | % of DB | % of NYC pop | Delta | Avg/day (14d) | Empty days |
|---|---:|---:|---:|---:|---:|---:|
| Manhattan | 84 | 41.2% | 19% | +22.2% | 5.1 | 5/14 |
| Brooklyn | 42 | 20.6% | 31% | -10.4% 🚨 | 2.7 | 6/14 |
| Queens | 11 | 5.4% | 27% | -21.6% 🚨 | 0.5 | 11/14 |
| Bronx | 14 | 6.9% | 17% | -10.1% 🚨 | 0.7 | 11/14 |
| Staten Island | 11 | 5.4% | 6% | -0.6% | 0.7 | 10/14 |

_Delta = DB share − population share. Sub-zero values = under-represented borough. 🚨 ≥ 10 pp gap._

## Empty days by borough (next 14)

- **Manhattan** — 5 empty: 2026-04-28 (Tue), 2026-04-30 (Thu), 2026-05-01 (Fri), 2026-05-04 (Mon), 2026-05-05 (Tue)
- **Brooklyn** — 6 empty: 2026-04-22 (Wed), 2026-04-27 (Mon), 2026-05-01 (Fri), 2026-05-02 (Sat), 2026-05-04 (Mon), 2026-05-05 (Tue)
- **Queens** — 11 empty: 2026-04-22 (Wed), 2026-04-23 (Thu), 2026-04-24 (Fri), 2026-04-27 (Mon), 2026-04-28 (Tue), 2026-04-29 (Wed), 2026-04-30 (Thu), 2026-05-01 (Fri), 2026-05-02 (Sat), 2026-05-03 (Sun), 2026-05-04 (Mon)
- **Bronx** — 11 empty: 2026-04-22 (Wed), 2026-04-23 (Thu), 2026-04-24 (Fri), 2026-04-27 (Mon), 2026-04-28 (Tue), 2026-04-29 (Wed), 2026-04-30 (Thu), 2026-05-01 (Fri), 2026-05-03 (Sun), 2026-05-04 (Mon), 2026-05-05 (Tue)
- **Staten Island** — 10 empty: 2026-04-22 (Wed), 2026-04-24 (Fri), 2026-04-27 (Mon), 2026-04-28 (Tue), 2026-04-29 (Wed), 2026-04-30 (Thu), 2026-05-01 (Fri), 2026-05-02 (Sat), 2026-05-03 (Sun), 2026-05-04 (Mon)

## Category gaps (0 events under this `category_l1`)

- **Manhattan** — missing: `food`, `books`
- **Brooklyn** — missing: `arts`, `attractions`, `food`, `science`
- **Queens** — missing: `sports`, `food`, `theater`, `books`, `science`
- **Bronx** — missing: `music`, `food`, `theater`, `science`
- **Staten Island** — missing: `sports`, `attractions`, `music`, `food`, `theater`, `books`, `science`

## Orphans — events with no detectable borough

**42** events (20.6% of DB) could not be assigned to a borough.

These are likely parser misses — a city/county value the borough matcher didn't recognise, or a fully-NULL location. Fix them and we recover coverage with zero scraping effort.

Sample (first 15):

| id | title | city | venue |
|---:|---|---|---|
| 658 | Video Games: The Great Connector | Stony Brook | Long Island Museum |
| 659 | 50 Years of Apple Computers: The Kevin Lenane Collection | Stony Brook | Long Island Museum |
| 838 | Recycled Ocean Crafts | Cold Spring Harbor | The Whaling Museum & Education Center |
| 859 | Walt Whitman Birthplace Museum – Girl Scout Programs! | Huntington Station | Walt Whitman Birthplace Museum |
| 872 | Museum Adventure Activity: Sea Survival Challenge | Cold Spring Harbor | The Whaling Museum & Education Center |
| 884 | Toddies Act + Play (Toddies Crew) | East Hampton | OFVS Studio at Project MOST |
| 890 | Orienteering Meet at West Hills County Park – North | Melville | West Hills County Park – North |
| 896 | Hampton Ballet Theatre School Presents Sleeping Beauty | East Hampton | Guild Hall’s Hilarie and Mitchell Morgan Theater |
| 1245 | Water Safety Splash & Learn - Saf-T-Swim New Hyde Park, NY | New Hyde Park | Saf-T-Swim of New Hyde Park |
| 1259 | Illustrated Ink Club | Bridgehampton | Bridgehampton Library |
| 1268 | BRITE Nights (Formerly POP Nights) | East Hampton | Project MOST Community Learning Center |
| 1356 | Caregiver & Me Ballet | East Hampton | OFVS Studio at Project MOST |
| 1373 | Mor Singing @ Bel Posto | Wantagh | Bel Posto |
| 1374 | Creatures of the Night: Family Night Hike | Rockville Centre | Tanglewood Preserve |
| 1377 | Guided Nature Walk – Celebrating Earth Day 2026 | Sands Point | Sands Point Preserve |

## Day-by-day matrix (next 14 days)

Each cell = events live in that borough on that date.

| Borough | 04-22 W | 04-23 T | 04-24 F | 04-25 S | 04-26 S | 04-27 M | 04-28 T | 04-29 W | 04-30 T | 05-01 F | 05-02 S | 05-03 S | 05-04 M | 05-05 T |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Manhattan | 4 | 4 | 9 | 28 | 14 | 3 | · | 2 | · | · | 4 | 3 | · | · |
| Brooklyn | · | 3 | 1 | 21 | 6 | · | 1 | 1 | 1 | · | · | 4 | · | · |
| Queens | · | · | · | 4 | 2 | · | · | · | · | · | · | · | · | 1 |
| Bronx | · | · | · | 3 | 6 | · | · | · | · | · | 1 | · | · | · |
| Staten Island | · | 1 | · | 5 | 3 | · | · | · | · | · | · | · | · | 1 |

_`·` = zero events._

## Recommendations

- **Brooklyn** is under-represented by 10.4 percentage points. Priority sources to investigate: local library branches, community centres, borough-specific Eventbrite, parks department calendars.
- **Queens** is under-represented by 21.6 percentage points. Priority sources to investigate: local library branches, community centres, borough-specific Eventbrite, parks department calendars.
- **Bronx** is under-represented by 10.1 percentage points. Priority sources to investigate: local library branches, community centres, borough-specific Eventbrite, parks department calendars.
- 42 orphan events (20.6%) — fixing the location fields in the parser is the cheapest win before scraping new sources.