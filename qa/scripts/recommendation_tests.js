#!/usr/bin/env node
/**
 * Runs each test case through /api/chat, captures filters + top events + latency.
 * Output: qa/results/recommendation_results.json
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.QA_BASE || 'http://localhost:3004';
const TC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test_cases', 'test_cases.json'), 'utf8'));
const OUT = path.join(__dirname, '..', 'results', 'recommendation_results.json');

(async () => {
  const results = [];
  let ok = 0, err = 0;

  for (const tc of TC.test_cases) {
    const start = Date.now();
    let entry = { test_case_id: tc.id, type: tc.type, query: tc.query, expected: tc.expected_behavior };
    try {
      const res = await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: tc.query }),
      });
      const latency = Date.now() - start;
      const body = await res.text();
      let data = null;
      try { data = JSON.parse(body); } catch {}
      entry = {
        ...entry,
        http_status: res.status,
        latency_ms: latency,
        filters_set: data?.filters || null,
        message: (data?.message || '').slice(0, 300),
        results_count: (data?.events || []).length,
        top_3: (data?.events || []).slice(0, 3).map((e) => ({
          id: e.id,
          title: (e.short_title || e.title || '').slice(0, 60),
          is_free: !!e.is_free,
          price: e.price_summary,
          age: e.age_label,
          date: e.next_start_at?.slice(0, 10),
          venue: e.venue_name?.slice(0, 40),
          city: e.city,
        })),
        raw_error: res.ok ? null : body.slice(0, 200),
      };
      if (res.ok) ok++; else err++;
    } catch (e) {
      err++;
      entry = { ...entry, http_status: -1, latency_ms: Date.now() - start, error: String(e) };
    }
    results.push(entry);
    process.stdout.write(`${tc.id}: ${entry.http_status || 'ERR'} ${entry.latency_ms}ms ${entry.results_count || 0} results\n`);
  }

  const summary = {
    generated_at: new Date().toISOString(),
    base_url: BASE,
    total: results.length,
    ok, err,
    latency: {
      avg_ms: Math.round(results.reduce((a, r) => a + r.latency_ms, 0) / results.length),
      p50: percentile(results.map(r => r.latency_ms), 0.5),
      p95: percentile(results.map(r => r.latency_ms), 0.95),
      p99: percentile(results.map(r => r.latency_ms), 0.99),
      max: Math.max(...results.map(r => r.latency_ms)),
    },
    zero_result_cases: results.filter(r => r.results_count === 0).map(r => r.test_case_id),
    results,
  };

  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total: ${results.length}, OK: ${ok}, Errors: ${err}`);
  console.log(`Latency: avg ${summary.latency.avg_ms}ms, p95 ${summary.latency.p95}ms, max ${summary.latency.max}ms`);
  console.log(`Zero-result cases: ${summary.zero_result_cases.length} (${summary.zero_result_cases.join(', ')})`);
  console.log(`Wrote ${OUT}`);
})();

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * p)] || 0;
}
