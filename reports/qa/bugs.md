# QA Audit — Bug List

**Generated**: 2026-04-23
**Live pool**: 204 events

**Totals**: 8 Critical · 26 Medium · 3 Low

---

## 🔴 Critical (8)


### 1. [filter-coverage] Filter "Arts" leaks out 67% of matching events

**Evidence**: Returned 38, missed 77 matching events. Sample missed: #781 [3-12 free] Open Hours at Environmental Education Center · #812 [6-18] Jim Vines and Carl Mercurio Broadway Magic Hour

**Fix**: Inspect buildAgeFitSql (wide-range exclusion rule in lib/db.ts, around line 208-223) — it rejects events whose range starts ≤ N-3 and spans ≥ 7 years. For age 7+ this excludes normal kids events like "Ages 3-12".


### 2. [filter-coverage] Filter "Science" leaks out 65% of matching events

**Evidence**: Returned 7, missed 13 matching events. Sample missed: #895 [5-10 free] Kids Interactive Poetry · #1015 [3-12 free] Earth Day in Carl Schurz Park

**Fix**: Inspect buildAgeFitSql (wide-range exclusion rule in lib/db.ts, around line 208-223) — it rejects events whose range starts ≤ N-3 and spans ≥ 7 years. For age 7+ this excludes normal kids events like "Ages 3-12".


### 3. [filter-coverage] Filter "Music" leaks out 64% of matching events

**Evidence**: Returned 15, missed 27 matching events. Sample missed: #884 [4-5] Toddies Act + Play (Toddies Crew) · #889 [0-12] Celebrate Holi

**Fix**: Inspect buildAgeFitSql (wide-range exclusion rule in lib/db.ts, around line 208-223) — it rejects events whose range starts ≤ N-3 and spans ≥ 7 years. For age 7+ this excludes normal kids events like "Ages 3-12".


### 4. [filter-coverage] Filter "Theater" leaks out 84% of matching events

**Evidence**: Returned 23, missed 119 matching events. Sample missed: #658 [7-12 free] Video Games: The Great Connector · #737 [10-15] Watson Adventures’ Wizard School Scavenger Hunt

**Fix**: Inspect buildAgeFitSql (wide-range exclusion rule in lib/db.ts, around line 208-223) — it rejects events whose range starts ≤ N-3 and spans ≥ 7 years. For age 7+ this excludes normal kids events like "Ages 3-12".


### 5. [filter-coverage] Filter "Books" leaks out 56% of matching events

**Evidence**: Returned 18, missed 23 matching events. Sample missed: #658 [7-12 free] Video Games: The Great Connector · #812 [6-18] Jim Vines and Carl Mercurio Broadway Magic Hour

**Fix**: Inspect buildAgeFitSql (wide-range exclusion rule in lib/db.ts, around line 208-223) — it rejects events whose range starts ≤ N-3 and spans ≥ 7 years. For age 7+ this excludes normal kids events like "Ages 3-12".


### 6. [filter-coverage] Filter "7yo + Science + Manhattan" leaks out 60% of matching events

**Evidence**: Returned 2, missed 3 matching events. Sample missed: #1015 [3-12 free] Earth Day in Carl Schurz Park · #1065 [7-10 free] Book Launch: Found Sound

**Fix**: Inspect buildAgeFitSql (wide-range exclusion rule in lib/db.ts, around line 208-223) — it rejects events whose range starts ≤ N-3 and spans ≥ 7 years. For age 7+ this excludes normal kids events like "Ages 3-12".


### 7. [filter-coverage] Filter "5yo + Arts + free" leaks out 63% of matching events

**Evidence**: Returned 23, missed 39 matching events. Sample missed: #781 [3-12 free] Open Hours at Environmental Education Center · #838 [5-10 free] Recycled Ocean Crafts

**Fix**: Inspect buildAgeFitSql (wide-range exclusion rule in lib/db.ts, around line 208-223) — it rejects events whose range starts ≤ N-3 and spans ≥ 7 years. For age 7+ this excludes normal kids events like "Ages 3-12".


### 8. [chat] Chat fails for: "Dance or music classes for 6yo"

**Evidence**: Mismatch in categories and age filter misapplied.

**Fix**: Check chat route error log; likely LLM prompt extracted a broken filter.


---

## 🟡 Medium (26)


### 1. [filter-coverage] Filter "Manhattan" coverage only 75%

**Evidence**: Missed 21 candidates. Examples: #815 [5-12 free] Jim Vines and Carl Mercurio announce Broadway Magic Hour Apr · #1044 [0-18 free] Kids Class! Ice Cream Sundae Decorating in Manhattan

**Fix**: Review predicates for this filter path — loose predicate vs strict SQL.


### 2. [digest] weekend-kids-nyc: rule violated by "Move to the Rhythm"

**Evidence**: next_start_at is not an upcoming Sat/Sun

**Fix**: Update digest scorer in lib/digests/ to exclude events matching this pattern.


### 3. [digest-coverage] weekend-kids-nyc: digest misses 10 strong candidates

**Evidence**: #971 Broadway Magic Hour at the Broadway Comedy Club · #992 Bargemusic "Music in Motion" Concerts · #1012 Met Opera Spring Open House

**Fix**: Digest scorer is too conservative. Consider lowering strong-tier threshold or widening signal set.


### 4. [digest] indoor-rainy-day: rule violated by "All-Ages Weekend Stencil Class"

**Evidence**: looks outdoor (festival/park/street)

**Fix**: Update digest scorer in lib/digests/ to exclude events matching this pattern.


### 5. [digest-coverage] indoor-rainy-day: digest misses 5 strong candidates

**Evidence**: #971 Broadway Magic Hour at the Broadway Comedy Club · #812 Jim Vines and Carl Mercurio Broadway Magic Hour · #815 Jim Vines and Carl Mercurio announce Broadway Magic Hour April 2026 Shows

**Fix**: Digest scorer is too conservative. Consider lowering strong-tier threshold or widening signal set.


### 6. [digest-coverage] easy-no-planning: digest misses 7 strong candidates

**Evidence**: #812 Jim Vines and Carl Mercurio Broadway Magic Hour · #535 All-Ages Weekend Stencil Class · #974 Big Umbrella Festival at Lincoln Center

**Fix**: Digest scorer is too conservative. Consider lowering strong-tier threshold or widening signal set.


### 7. [digest-coverage] free-affordable: digest misses 12 strong candidates

**Evidence**: #812 Jim Vines and Carl Mercurio Broadway Magic Hour · #815 Jim Vines and Carl Mercurio announce Broadway Magic Hour April 2026 Shows · #781 Open Hours at Environmental Education Center

**Fix**: Digest scorer is too conservative. Consider lowering strong-tier threshold or widening signal set.


### 8. [digest-coverage] kids-love-parents-approve: digest misses 14 strong candidates

**Evidence**: #1420 Soulful Sounds in Rockland · #971 Broadway Magic Hour at the Broadway Comedy Club · #812 Jim Vines and Carl Mercurio Broadway Magic Hour

**Fix**: Digest scorer is too conservative. Consider lowering strong-tier threshold or widening signal set.


### 9. [chat-coverage] Chat missed DB candidates: "Things to do this weekend with 4 and 7 year old"

**Evidence**: #992 age-appropriate and free · #1240 age-appropriate and free · #1327 age-appropriate and free

**Fix**: Either widen chat filter extraction (LLM too narrow) or improve category/tag mapping.


### 10. [chat-coverage] Chat missed DB candidates: "Science museum for 5 year old"

**Evidence**: #872 not returned but relevant

**Fix**: Either widen chat filter extraction (LLM too narrow) or improve category/tag mapping.


### 11. [chat-coverage] Chat missed DB candidates: "Cheap rainy day activities for kids"

**Evidence**: #1609 better indoor fit for young kids

**Fix**: Either widen chat filter extraction (LLM too narrow) or improve category/tag mapping.


### 12. [chat] Chat hallucinates events: "Teen hangouts in Brooklyn"

**Evidence**: Events not specific to Brooklyn; some events not ideal for teens.

**Fix**: Harden chat prompt to only mention events from the returned list.


### 13. [chat] Chat hallucinates events: "Stroller-friendly nature walk Sunday"

**Evidence**: Returned events lack stroller-friendly nature walks.

**Fix**: Harden chat prompt to only mention events from the returned list.


### 14. [chat] Chat hallucinates events: "After-school Tuesday activity Manhattan"

**Evidence**: Events returned don't match 'after-school' focus well.

**Fix**: Harden chat prompt to only mention events from the returned list.


### 15. [chat-coverage] Chat missed DB candidates: "Birthday party venue for a 7-year-old"

**Evidence**: #780 not explicitly a birthday venue · #788 not explicitly a birthday venue · #548 not explicitly a birthday venue

**Fix**: Either widen chat filter extraction (LLM too narrow) or improve category/tag mapping.


### 16. [chat-coverage] Chat missed DB candidates: "Free outdoor Saturday in Manhattan with 4yo"

**Evidence**: #1015 age fit and outdoor · #1014 age fit and outdoor · #1024 age fit and outdoor

**Fix**: Either widen chat filter extraction (LLM too narrow) or improve category/tag mapping.


### 17. [chat-coverage] Chat missed DB candidates: "Bilingual Spanish storytime"

**Evidence**: 

**Fix**: Either widen chat filter extraction (LLM too narrow) or improve category/tag mapping.


### 18. [chat-coverage] Chat missed DB candidates: "Art classes for kids"

**Evidence**: #535 relevant stencil class · #778 relevant journaling workshop · #1102 relevant word portraits

**Fix**: Either widen chat filter extraction (LLM too narrow) or improve category/tag mapping.


### 19. [chat-coverage] Chat missed DB candidates: "Outdoor activities in Brooklyn this weekend"

**Evidence**: #1008 better match for outdoors · #1052 relevant bike event

**Fix**: Either widen chat filter extraction (LLM too narrow) or improve category/tag mapping.


### 20. [chat] Chat hallucinates events: "Sports activities for boy age 8"

**Evidence**: Misstated age range for Bronx Bound event.

**Fix**: Harden chat prompt to only mention events from the returned list.


### 21. [chat-coverage] Chat missed DB candidates: "Events near Midtown Manhattan"

**Evidence**: #548 better fit for family events · #1044 relevant free event · #1020 relevant flower show

**Fix**: Either widen chat filter extraction (LLM too narrow) or improve category/tag mapping.


### 22. [chat-coverage] Chat missed DB candidates: "We are bored, suggest something fun for 4yo"

**Evidence**: #884 age-appropriate

**Fix**: Either widen chat filter extraction (LLM too narrow) or improve category/tag mapping.


### 23. [chat-coverage] Chat missed DB candidates: "Best family experience in NYC right now"

**Evidence**: #548 broader age range · #780 unique experience · #882 large age range

**Fix**: Either widen chat filter extraction (LLM too narrow) or improve category/tag mapping.


### 24. [ranking] Ranking broken: "Indoor rainy day kids" — NDCG@10 = 0.451

**Evidence**: Flops at top: #90002 Spring Garden Exploration for Families · #90004 Family Garden Walks at NYBG. Gems below: #513 pos6 Paint Your heART Out! Painting Class for Kids · #1591 pos7 Face Value: Celebrity Press Photography

**Fix**: Replace ORDER BY next_start_at with a relevance score (or add one weighted against date).


### 25. [ranking] Ranking broken: "Manhattan family" — NDCG@10 = 0.675

**Evidence**: Flops at top: #1591 Face Value: Celebrity Press Photography. Gems below: #885 pos6 Macy’s Flower Show · #886 pos7 Move to the Rhythm

**Fix**: Replace ORDER BY next_start_at with a relevance score (or add one weighted against date).


### 26. [ranking] Ranking broken: "Music for kids" — NDCG@10 = 0.55

**Evidence**: Flops at top: #1306 WU LYF, Lauren Auder · #1237 The Fairy Tale Art Cart LIVE: Featuring Andy Seagrave. Gems below: #1189 pos6 Met Chorus Artists presents Spring Sing: Celebrating Shakespeare · #1075 pos7 JAZZ AT ONE: Silvano Monasterios Venezuelan Nonet

**Fix**: Replace ORDER BY next_start_at with a relevance score (or add one weighted against date).


---

## ⚪ Low (3)


### 1. [filter-correctness] Filter "Theater" returns 4% events that don't match

**Evidence**: Wrong samples: #548 [3-18] Parallel Exit presents the Sunset Circus

**Fix**: Tighten SQL predicate for this category.


### 2. [digest-quality] weekend-kids-nyc: weak fit "Kids @ Grand Central x The Rock & Roll Playhouse"

**Evidence**: judge=1: Event is on a weekday, not weekend.

**Fix**: Boost required signal strength for this digest.


### 3. [digest-quality] easy-no-planning: weak fit "Hablemos: The New York Sari"

**Evidence**: judge=2: Requires registration, not drop-in

**Fix**: Boost required signal strength for this digest.

