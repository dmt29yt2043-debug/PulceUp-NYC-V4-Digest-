# Quiz → Site URL Contract

Contract between the quiz app (`quiz.pulseup.me`) and this site (`pulseup.me/results`).
Any change here must be mirrored in both the quiz and the site at the same time.

## Target URL

When a quiz user clicks "Show my results":

```
https://pulseup.me/results?source=quiz&<params>
```

## Parameters

| Parameter     | Always sent? | Values                                                                                     | Meaning                                    |
| ------------- | ------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `source`      | yes          | `quiz`                                                                                     | Marks traffic origin                       |
| `gender`      | yes          | `boy` \| `girl`                                                                            | First child gender (back-compat)           |
| `child_age`   | yes          | `0-2` \| `3-5` \| `6-8` \| `9-12` \| `13-15` \| `16+`                                      | First child age (back-compat)              |
| `children`    | yes          | `boy:3-5` or `boy:3-5,girl:9-12`                                                           | All children, comma-sep `gender:age` pairs |
| `borough`     | yes          | `manhattan` \| `brooklyn` \| `queens` \| `bronx` \| `staten_island` \| `other`             | NYC borough                                |
| `custom_area` | only if `borough=other` | free-text                                                                       | User-entered area name                     |
| `interests`   | yes          | comma-sep subset of: `outdoor` `playgrounds` `museums` `classes` `arts_crafts` `sports` `science` `animals` `indoor_play` | Interests (default `outdoor` if empty) |

## Parsing rules on the site

1. **Prefer `children` over `gender`+`child_age`.** The pair is sent only for
   back-compat with older quiz versions that didn't send `children`.
2. **Borough `staten_island` (underscore) is aliased to `staten island` (space).**
   The site supports both forms for historical reasons.
3. **`borough=other`** disables geo-filtering; show events from anywhere and
   display `custom_area` in the UI.
4. **First interest is the primary interest** — use it for the hero card's
   category preset when no other signal is present.
5. **`source=quiz`** triggers persistence: save the parsed profile to
   `localStorage.pulseup_profile` so the main app (`/`) inherits preferences
   on future visits.

## Where this contract is implemented

- **Parse:** `app/results/page.tsx` (`ResultsInner`), `parseChildrenParam()`
- **Score:** `app/api/events/personalized/route.ts` (`parseChildren`, `INTEREST_TO_CATEGORIES`, `BOROUGH_BOUNDS`)
- **Persist:** `app/results/page.tsx` useEffect → `localStorage.pulseup_profile`

## Example

Family with two kids (boy 3–5 / girl 9–12), Brooklyn, museums + sports:

```
https://pulseup.me/results?source=quiz&gender=boy&child_age=3-5&children=boy:3-5,girl:9-12&borough=brooklyn&interests=museums,sports
```
