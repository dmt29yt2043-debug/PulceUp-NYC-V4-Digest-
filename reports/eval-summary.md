# Chat Relevance Evaluation Report

**Date:** 2026-04-25
**Endpoint:** http://localhost:3000/api/chat
**Scenarios tested:** 25
**Avg latency:** 2045ms

## Overall Scores

| Metric | Score (1-5) |
|--------|------------|
| Relevance | **4.2** |
| Completeness | **3.2** |
| Age Appropriateness | **4.1** |

## Diagnosis Breakdown

| Diagnosis | Count | % |
|-----------|-------|---|
| good_match | 1 | 4% |
| partial_match | 19 | 76% |
| pipeline_issue | 5 | 20% |
| db_gap | 0 | 0% |

## Scores by Category

| Category | Avg Relevance | Queries |
|----------|--------------|--------|
| Weekend Planning | 4.0 | 4 |
| Age-Specific | 4.5 | 4 |
| Interest-Based | 3.6 | 5 |
| Budget-Conscious | 5.0 | 3 |
| Location-Specific | 5.0 | 3 |
| Specific Needs | 4.3 | 3 |
| Discovery | 3.3 | 3 |

## Failures (Relevance ≤ 2)

### Q11: "Science museums for kids"
- **Diagnosis:** pipeline_issue
- **Filters:** `{"categories":["attractions","science"],"childAges":[6,3]}`
- **Events returned:** 20
- **Judge:** While some events are listed, none are specifically science-focused for children. Relevant events exist in the broader database search but were not surfaced properly by the system.

### Q24: "Best family experience in NYC right now"
- **Diagnosis:** pipeline_issue
- **Filters:** `{}`
- **Events returned:** 0
- **Judge:** Error: Error: Chat API 429: {"error":"Too many requests. Please slow down.","retry_after_sec":1}


## Pipeline Issues (events exist but weren't found)

- **Q7:** "Something for a teenager, 13+" — While the returned events include some relevant options for teens, the system missed showcasing several suitable events from the broader database that fit the age criteria. Additionally, the events listed are not appropriate for a 6-year-old and a 3-year-old.
- **Q11:** "Science museums for kids" — While some events are listed, none are specifically science-focused for children. Relevant events exist in the broader database search but were not surfaced properly by the system.
- **Q13:** "Sports activities for boys age 8" — While some events returned are related to sports, they do not fully match the specific age requirement of 8. Additionally, several relevant sports activities exist in the broader database that were not surfaced, indicating a pipeline issue.
- **Q22:** "Bilingual Spanish events for kids" — The events returned are somewhat relevant to the query for bilingual Spanish programming, but they lack clear age information, which affects their suitability for the specific ages. Broader search results indicate that there are more relevant options that the initial search did not uncover.
- **Q24:** "Best family experience in NYC right now" — Error: Error: Chat API 429: {"error":"Too many requests. Please slow down.","retry_after_sec":1}

## All Results

| # | Query | Relevance | Diagnosis | Events | Top Event |
|---|-------|-----------|-----------|--------|----------|
| 1 | What can we do this weekend? | 3/5 | partial_match | 20 | Storytime Can You Grow a Stripped B |
| 2 | Any free events tomorrow? | 5/5 | partial_match | 17 | Storytime Can You Grow a Stripped B |
| 3 | What's happening on Easter? | 4/5 | partial_match | 20 | Storytime Can You Grow a Stripped B |
| 4 | Activities for a rainy day? | 4/5 | partial_match | 20 | Little Sprouts: Jump and Play |
| 5 | My son is 3, what's good for him? | 5/5 | good_match | 20 | Storytime Can You Grow a Stripped B |
| 6 | Theater for a 7-year-old girl | 5/5 | partial_match | 20 | Dreamcats! at the Gene Frankel Thea |
| 7 | Something for a teenager, 13+ | 4/5 | pipeline_issue | 20 | Belladonna* Book Launch: 20 Years o |
| 8 | Baby-friendly activities for under 2 | 4/5 | partial_match | 20 | Little Sprouts: Jump and Play |
| 9 | Art classes for kids | 5/5 | partial_match | 20 | Word Portraits at Lehman College Ar |
| 10 | Outdoor activities in Brooklyn | 3/5 | partial_match | 20 | Turtle Time |
| 11 | Science museums for kids | 2/5 | pipeline_issue | 20 | Macy's Herald Square Annual Flower  |
| 12 | Dance or music classes | 5/5 | partial_match | 20 | Musical Explorers Family |
| 13 | Sports activities for boys age 8 | 3/5 | pipeline_issue | 20 | 2026 New York Lymphoma Walk |
| 14 | Free things to do with kids | 5/5 | partial_match | 20 | Storytime Can You Grow a Stripped B |
| 15 | Activities under $20 per person | 5/5 | partial_match | 20 | Storytime Can You Grow a Stripped B |
| 16 | Cheap weekend options for a family of 4 | 5/5 | partial_match | 20 | Storytime Can You Grow a Stripped B |
| 17 | Events near Midtown Manhattan | 5/5 | partial_match | 20 | Paint Your heART Out! Painting Clas |
| 18 | What's happening in Brooklyn this week? | 5/5 | partial_match | 19 | Offsite: Mac Barnett & Jon Klassen: |
| 19 | Anything in the Bronx for kids? | 5/5 | partial_match | 20 | Step Afrika |
| 20 | Wheelchair accessible activities | 5/5 | partial_match | 20 | Storytime Can You Grow a Stripped B |
| 21 | Stroller-friendly events | 5/5 | partial_match | 20 | Storytime Can You Grow a Stripped B |
| 22 | Bilingual Spanish events for kids | 3/5 | pipeline_issue | 4 | Vegan Spanish Feast - Cooking Class |
| 23 | We're bored, suggest something fun | 5/5 | partial_match | 20 | Storytime Can You Grow a Stripped B |
| 24 | Best family experience in NYC right now | 0/5 | pipeline_issue | 0 | none |
| 25 | Something educational but fun for kids | 5/5 | partial_match | 20 | Storytime Can You Grow a Stripped B |
