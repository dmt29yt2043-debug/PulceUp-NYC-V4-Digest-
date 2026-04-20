# PulseUp QA Audit — Pre-Beta Release Check

**Date:** 2026-04-20
**Target:** https://pulseup-v4.srv1362562.hstgr.cloud/ (prod) + http://localhost:3004 (dev)
**Goal:** Decide whether product is READY FOR BETA.

## Folders

- `test_cases/` — generated test case definitions
- `scripts/` — executable test scripts (Node + bash + sqlite)
- `results/` — raw output files from runs
- `reports/` — human-readable reports (`final_report.md` is the deliverable)

## Run order

```bash
# 1. Data validation (no server needed)
node qa/scripts/data_tests.js

# 2. Recommendation tests (needs dev server on :3004)
node qa/scripts/recommendation_tests.js

# 3. E2E functional (needs dev server)
node qa/scripts/e2e_tests.js

# 4. Load / performance
node qa/scripts/load_test.js

# 5. Security
node qa/scripts/security_tests.js
```

Each script writes structured JSON to `qa/results/`.

## Updating the events DB (new CSV arrived)

Drop the new CSV into `data/event_us.csv`, then:

```bash
npm run reimport
```

This single command:
1. Wipes & rebuilds `events.db` from the CSV.
2. Applies data normalization during insert (see `scripts/import-csv.ts`):
   - BUG_003: derives `category_l1` from tags/categories when missing
   - BUG_004: `next_end_at=""` → NULL
   - BUG_005: clamps ages to [0, 18]
   - BUG_006: reconciles `is_free=1` with `price>0`
   - BUG_007: logs events missing lat/lon (no auto-geocode)
3. Reseeds the 11 curated digests from `data/seeds/digests.json`
   (resolves event links by `title+venue`, stable across CSV id shifts).
4. Runs `qa/scripts/data_tests.js` so you see the new data quality
   numbers immediately.

**Do not run one-off `UPDATE events SET ...` SQL.** The next `npm run reimport`
will wipe it. Add the rule to `scripts/import-csv.ts` instead.
