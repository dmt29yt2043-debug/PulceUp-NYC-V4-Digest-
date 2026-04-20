# PulseUp v4 — Pre-Beta QA Audit

**Date:** 2026-04-20
**Auditor:** Claude (Senior QA / Release Engineer role)
**Target:** `https://pulseup-v4.srv1362562.hstgr.cloud/` (prod) + `http://localhost:3004` (dev, same code)
**Codebase:** branch `max/sandbox`, commit `351b3ec`, repo `dmt29yt2043-debug/PulceUp-NYC-V4-Digest-`

---

## 1. Summary

**PulseUp is a curated NYC-events discovery product for parents.** Core flow: user lands → chat or filters → receives recommendations → clicks card → (out-of-scope: buy ticket on source site).

| Dimension | State | Notes |
|---|---|---|
| Data quality | 🟡 Partial | 40.8% events miss category_l1; 100% empty next_end_at (compensated in SQL); 7 out-of-range ages |
| Functional correctness | ✅ Strong | 36/36 E2E checks pass; digest-as-filter, URL persistence, intersection, tag drill-down all work visually |
| Recommendation quality | 🟡 Good | 49/50 test cases return non-empty, 2 legitimately empty. Chat prompt quality avg 7.5/10 |
| Performance | 🔴 Risk | Chat API collapses at >=25 concurrent users (90% failures). DB-backed endpoints handle 50+ concurrent easily |
| Security | 🟢 Good | 0 critical, 0 high. 3 medium (public admin/debug, no rate-limit). No XSS/SQLi/path-traversal. |
| Analytics | ✅ Good | 20 events wired; all core beta metrics covered (except page_view auto-via `trackPageView`) |

### 🎯 Launch recommendation: **⚠️ READY WITH RISKS**

The product works end-to-end for a single user. Core UX flows are functional and safe. However, **the chat endpoint cannot survive concurrent load**, which is a hard blocker for any "open the gate" beta. See Section 7 for the minimal fix list to upgrade to ✅ READY FOR BETA.

---

## 2. Bugs (by severity)

| ID | Severity | Title | Component |
|---|---|---|---|
| BUG_001 | 🔴 CRITICAL | /api/chat collapses at 25+ concurrent users (50-90% failure rate) | chat_api |
| BUG_002 | 🟠 HIGH | Chat response latency too high (avg 3.2s, p95 8s, max 11.7s) | chat_api |
| BUG_003 | 🟠 HIGH | 40.8% of visible events have NULL category_l1 | data_pipeline |
| BUG_004 | 🟡 MEDIUM | 100% of events have empty next_end_at (not NULL) | data_pipeline |
| BUG_005 | 🟡 MEDIUM | 7 events with out-of-range ages (defeating age filter) | data_pipeline |
| BUG_008 | 🟡 MEDIUM | "birthday party for 6yo" returns 1 irrelevant event | chat_prompt |
| BUG_010 | 🟡 MEDIUM | /admin/analytics publicly accessible | security |
| BUG_011 | 🟡 MEDIUM | /api/debug/session publicly accessible | security |
| BUG_012 | 🟡 MEDIUM | No rate limiting anywhere | security |
| BUG_006 | 🟢 LOW | 2 events: is_free=1 but price_min>0 | data_pipeline |
| BUG_007 | 🟢 LOW | 12.1% events lack lat/lon — not shown on map | data_pipeline |
| BUG_009 | 🟢 LOW | Empty query returns raw HTTP 400 | chat_api |
| BUG_013 | 🟢 LOW | Missing security headers (CSP/XCTO/XFO) | headers |
| BUG_014 | 🟢 LOW | Category label inconsistency (fixed in commit) | ui_polish |

**Full details, repro steps, and fix suggestions:** [`qa/results/bugs.json`](../results/bugs.json)

---

## 3. Coverage

### What was tested
| Layer | Script | Result |
|---|---|---|
| DB integrity & completeness | `data_tests.js` | ✓ 18 metrics, 7 anomalies captured |
| 50 user queries via chat | `recommendation_tests.js` | ✓ 49 OK / 1 rejected (empty) |
| E2E HTTP flows (6 flows, 36 checks) | `e2e_tests.js` | ✓ 100% pass |
| Load (10/25/50 concurrent × 6 endpoints) | `load_test.js` | ⚠ Chat fails at 25+ |
| Security (XSS/SQLi/path/auth/headers) | `security_tests.js` | ✓ No criticals |
| Analytics event wiring | `analytics_tests.js` | ✓ 20 events in code |
| URL persistence + intersection + tag drill-down | Manual Chrome E2E (earlier) | ✓ All three work |

### Not covered / gaps
- **Real browser automation** — Playwright/Puppeteer not available in this environment. Chrome MCP was used for spot checks; no full automated UI regression suite.
- **Mobile layout** — desktop-only testing.
- **Accessibility (a11y)** — not audited (no aXe / Lighthouse).
- **Real user session** — no login system yet, so no session/auth flow to test.
- **Purchase/ticketing flow** — product shows external "Buy" links; actual purchase happens off-site, not tested.
- **Google Analytics / GTM integration** — events fire to internal `/api/analytics/event`; downstream ingestion not verified.
- **Cross-browser** — only Chromium-family tested.
- **Long-running stability** — no 24-hour soak test.

---

## 4. Risks (Top 5 for beta)

### R1. Chat endpoint collapse under load 🔴
- **Evidence:** load test shows 50-90% failure rate at 25-50 concurrent users.
- **Mitigation:** See BUG_001 fixes. Before opening beta to >50 users, MUST address.

### R2. Chat response quality for edge cases 🟠
- **Evidence:** recommendations for "birthday party", "teens 13+" (pre-fix) still weak.
- **Mitigation:** Prompt already improved (5.9 → 7.5/10). Monitor in beta, iterate.

### R3. Data gaps cause filter mismatches 🟠
- **Evidence:** 40% events lack category_l1; 12% lack geo.
- **Mitigation:** Category filter now searches tags/categories JSON as fallback (partial). Run a re-categorization pass pre-beta.

### R4. OpenAI cost / abuse 🟡
- **Evidence:** No rate limiting, no auth on /api/chat.
- **Mitigation:** Add 30 req/min per-IP throttle before opening to public.

### R5. Analytics pipeline unverified downstream 🟢
- **Evidence:** `/api/analytics/event` returns 204, but no downstream dashboard verified.
- **Mitigation:** Sanity check one event shows up in whichever backend sink is used.

---

## 5. Performance

### Response latency (single-user)

| Endpoint | p50 | p95 | p99 | max | Verdict |
|---|---|---|---|---|---|
| GET /api/events | 54ms | 68ms | 68ms | 68ms | ✅ Fast |
| GET /api/events (filtered) | 50ms | 72ms | 73ms | 73ms | ✅ Fast |
| GET /api/digests | 29ms | 79ms | 86ms | 86ms | ✅ Fast |
| GET /api/digests/[slug] | 91ms | 177ms | 182ms | 182ms | ✅ Fast |
| GET / (HTML) | 182ms | 266ms | 267ms | 267ms | ✅ OK |
| POST /api/chat (LLM) | 2.0s | 2.3s | 2.3s | 2.3s | 🟡 Slow but OK single-user |

### Under load

| Concurrency | Endpoint | p95 | Failures |
|---|---|---|---|
| 10 | /api/chat | 2.3s | 0/20 ✅ |
| 25 | /api/chat | 8.4s | **50/50 🔴** |
| 50 | /api/chat | 8.8s | **90/100 🔴** |
| 50 | /api/events | 298ms | 0/200 ✅ |
| 50 | /api/digests | 401ms | 0/200 ✅ |
| 50 | / (HTML) | 1.4s | 0/200 ✅ |

**Verdict:** DB-backed endpoints scale well. Chat is a hard wall that will embarrass the product in beta.

**Full data:** [`qa/results/load_report.json`](../results/load_report.json)

---

## 6. Security

### Findings
- ✅ XSS — chat message is safely escaped (not echoed back as HTML)
- ✅ SQL injection — SQLite prepared statements resist `' OR '1'='1`, `DROP TABLE`, `UNION SELECT`. DB intact after tests.
- ✅ Path traversal — `/api/digests/../../../etc/passwd` → 404. No filesystem access.
- ✅ Prompt injection — LLM refuses to reveal system prompt across 3 attempts.
- ✅ Input validation — negative ages/prices, huge page_size, huge 1MB payload all handled gracefully.
- ⚠️ **MEDIUM** — `/admin/analytics` publicly accessible (inherited).
- ⚠️ **MEDIUM** — `/api/debug/session` publicly accessible (currently empty, could become a leak).
- ⚠️ **MEDIUM** — No rate limiting on any endpoint (cost risk on /api/chat).
- ⚠️ **LOW** — Missing CSP, X-Content-Type-Options, X-Frame-Options.
- ⚠️ **LOW** — Phone numbers visible in event data (venue contact info, not user PII — low concern).

**Full data:** [`qa/results/security_report.json`](../results/security_report.json)

---

## 7. Recommendation

### ⚠️ **READY WITH RISKS**

The product is correct, secure, and functional for a single user. It will work for a closed, small beta (<20 active users).

### Block for open beta until fixed (must-do):

1. **[BUG_001]** Solve /api/chat concurrency failure — add rate limiting + queueing or fallback heuristic
2. **[BUG_012]** Add rate limit on /api/chat (30 req/min per IP) to prevent OpenAI cost abuse
3. **[BUG_010]** Protect /admin/analytics (minimum: HTTP basic auth or IP allowlist)

### Should-do before broad marketing push:

4. **[BUG_002]** Reduce chat latency (switch model, stream, cache)
5. **[BUG_003]** Re-run categorization pipeline — populate 40% empty category_l1
6. **[BUG_008]** Chat prompt fallback for low-result queries like "birthday"
7. **[BUG_011]** Gate /api/debug/* behind NODE_ENV check

### Nice-to-have:

8. **[BUG_004, 005, 006]** Data cleanup pass: end dates, age caps, free/price consistency
9. **[BUG_007]** Geocode the 25 events missing lat/lon
10. **[BUG_013]** Add security headers via `next.config.ts`

---

## Appendix

### QA artifacts
```
qa/
├── README.md
├── test_cases/
│   └── test_cases.json       ← 50 test cases
├── scripts/
│   ├── data_tests.js         ← DB integrity
│   ├── e2e_tests.js          ← HTTP flow validation
│   ├── recommendation_tests.js
│   ├── load_test.js          ← 10/25/50 concurrent
│   ├── security_tests.js     ← XSS/SQLi/auth/headers
│   └── analytics_tests.js    ← event wiring audit
├── results/
│   ├── data_report.json
│   ├── e2e_report.json
│   ├── recommendation_results.json
│   ├── load_report.json
│   ├── security_report.json
│   ├── analytics_report.json
│   └── bugs.json             ← consolidated bug list (14 bugs)
└── reports/
    └── final_report.md       ← this file
```

### Re-run
```bash
cd /Users/maxsnigirev/Claude\ Code/pulseup-v3-alexey
# Ensure dev server is up on :3004
node qa/scripts/data_tests.js
node qa/scripts/e2e_tests.js
node qa/scripts/recommendation_tests.js
node qa/scripts/load_test.js
node qa/scripts/security_tests.js
node qa/scripts/analytics_tests.js
```
