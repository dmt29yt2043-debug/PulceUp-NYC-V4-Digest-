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
