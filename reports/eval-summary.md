# Chat Relevance Evaluation Report

**Date:** 2026-04-20
**Endpoint:** https://pulseup-v4.srv1362562.hstgr.cloud/api/chat
**Scenarios tested:** 25
**Avg latency:** 2455ms

## Overall Scores

| Metric | Score (1-5) |
|--------|------------|
| Relevance | **4.0** |
| Completeness | **3.0** |
| Age Appropriateness | **4.5** |

## Diagnosis Breakdown

| Diagnosis | Count | % |
|-----------|-------|---|
| good_match | 1 | 4% |
| partial_match | 18 | 72% |
| pipeline_issue | 5 | 20% |
| db_gap | 1 | 4% |

## Scores by Category

| Category | Avg Relevance | Queries |
|----------|--------------|--------|
| Weekend Planning | 4.3 | 4 |
| Age-Specific | 4.0 | 4 |
| Interest-Based | 3.8 | 5 |
| Budget-Conscious | 5.0 | 3 |
| Location-Specific | 3.3 | 3 |
| Specific Needs | 3.0 | 3 |
| Discovery | 4.3 | 3 |

## Failures (Relevance ≤ 2)

### Q19: "Anything in the Bronx for kids?"
- **Diagnosis:** db_gap
- **Filters:** `{"neighborhoods":["Bronx"]}`
- **Events returned:** 10
- **Judge:** The returned events do not relate to the Bronx, which is where the user expressed interest. Additionally, the events mentioned are not relevant to the user’s children's ages or interests.

### Q22: "Bilingual Spanish events for kids"
- **Diagnosis:** pipeline_issue
- **Filters:** `{"search":"bilingual Spanish","ageMax":12}`
- **Events returned:** 0
- **Judge:** The events returned do not directly match the request for bilingual Spanish events for kids. Relevant events exist in the broader search but were not surfaced properly.


## Pipeline Issues (events exist but weren't found)

- **Q8:** "Baby-friendly activities for under 2" — While some events are age-appropriate, the response missed a significant relevant option, such as 'The Velveteen Rabbit Ballet,' which is suitable for infants. The search should have identified more relevant activities for children under 2.
- **Q13:** "Sports activities for boys age 8" — The returned event was somewhat relevant, but the broader search showed additional relevant options that were not included in the initial output. This indicates a potential issue with how the search query was processed in the database.
- **Q20:** "Wheelchair accessible activities" — While the suggested events were relevant to the query, they missed a number of suitable options related to wheelchair accessibility that exist in the broader database. The system could have done better in surfacing these events.
- **Q21:** "Stroller-friendly events" — The response provided some events that are generally family-friendly but missed specific stroller-friendly options from the broader search, such as 'Staten Island Fencing Club Interactive Demonstration' and 'Bengali Folk Dance Class'.
- **Q22:** "Bilingual Spanish events for kids" — The events returned do not directly match the request for bilingual Spanish events for kids. Relevant events exist in the broader search but were not surfaced properly.

## Database Gaps (no relevant events exist)

- **Q19:** "Anything in the Bronx for kids?" — The returned events do not relate to the Bronx, which is where the user expressed interest. Additionally, the events mentioned are not relevant to the user’s children's ages or interests.

## All Results

| # | Query | Relevance | Diagnosis | Events | Top Event |
|---|-------|-----------|-----------|--------|----------|
| 1 | What can we do this weekend? | 5/5 | partial_match | 10 | Hanami Nights |
| 2 | Any free events tomorrow? | 4/5 | partial_match | 4 | Button and Jewelry Making Workshop |
| 3 | What's happening on Easter? | 3/5 | partial_match | 10 | Celebrate the Earth at Salt Marsh N |
| 4 | Activities for a rainy day? | 5/5 | good_match | 10 | Celebrate the Earth at Salt Marsh N |
| 5 | My son is 3, what's good for him? | 5/5 | partial_match | 10 | Celebrate the Earth at Salt Marsh N |
| 6 | Theater for a 7-year-old girl | 4/5 | partial_match | 8 | Broadway Trivia |
| 7 | Something for a teenager, 13+ | 4/5 | partial_match | 4 | Teen Workshop | P.O.V. Who Tells th |
| 8 | Baby-friendly activities for under 2 | 3/5 | pipeline_issue | 10 | The Velveteen Rabbit Ballet at Thir |
| 9 | Art classes for kids | 5/5 | partial_match | 6 | Button and Jewelry Making Workshop |
| 10 | Outdoor activities in Brooklyn | 5/5 | partial_match | 10 | Celebrate the Earth at Salt Marsh N |
| 11 | Science museums for kids | 3/5 | partial_match | 1 | STEAM Dream in Rockefeller Park |
| 12 | Dance or music classes | 3/5 | partial_match | 10 | Celebrate the Earth at Salt Marsh N |
| 13 | Sports activities for boys age 8 | 3/5 | pipeline_issue | 1 | Cliff Runner 5K |
| 14 | Free things to do with kids | 5/5 | partial_match | 10 | Celebrate the Earth at Salt Marsh N |
| 15 | Activities under $20 per person | 5/5 | partial_match | 10 | Celebrate the Earth at Salt Marsh N |
| 16 | Cheap weekend options for a family of 4 | 5/5 | partial_match | 10 | Creatures of the Night: Family Nigh |
| 17 | Events near Midtown Manhattan | 5/5 | partial_match | 10 | Celebrate the Earth at Salt Marsh N |
| 18 | What's happening in Brooklyn this week? | 4/5 | partial_match | 10 | Celebrate the Earth at Salt Marsh N |
| 19 | Anything in the Bronx for kids? | 1/5 | db_gap | 10 | Looney Louie’s Juggling Magic Show |
| 20 | Wheelchair accessible activities | 4/5 | pipeline_issue | 10 | Staten Island Fencing Club Interact |
| 21 | Stroller-friendly events | 3/5 | pipeline_issue | 10 | Staten Island Fencing Club Interact |
| 22 | Bilingual Spanish events for kids | 2/5 | pipeline_issue | 0 | none |
| 23 | We're bored, suggest something fun | 4/5 | partial_match | 10 | Celebrate the Earth at Salt Marsh N |
| 24 | Best family experience in NYC right now | 4/5 | partial_match | 10 | Celebrate the Earth at Salt Marsh N |
| 25 | Something educational but fun for kids | 5/5 | partial_match | 10 | Celebrate the Earth at Salt Marsh N |
