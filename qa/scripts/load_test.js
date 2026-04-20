#!/usr/bin/env node
/**
 * Load test: simulates concurrent users hitting key endpoints.
 * Output: qa/results/load_report.json
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.QA_BASE || 'http://localhost:3004';
const OUT = path.join(__dirname, '..', 'results', 'load_report.json');

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0;
}

async function runScenario(name, fn, concurrency, total) {
  const latencies = [];
  const failures = [];
  let inFlight = 0, completed = 0, launched = 0;
  const start = Date.now();

  await new Promise((resolve) => {
    const launch = () => {
      while (launched < total && inFlight < concurrency) {
        launched++;
        inFlight++;
        const t0 = Date.now();
        fn().then(
          (res) => {
            latencies.push(Date.now() - t0);
            if (!res.ok) failures.push({ idx: launched, status: res.status });
          },
          (err) => {
            latencies.push(Date.now() - t0);
            failures.push({ idx: launched, error: String(err).slice(0, 80) });
          }
        ).finally(() => {
          inFlight--; completed++;
          if (completed >= total) resolve();
          else launch();
        });
      }
    };
    launch();
  });

  const duration = Date.now() - start;
  return {
    scenario: name,
    concurrency, total,
    duration_ms: duration,
    rps: Math.round((total / duration) * 1000 * 10) / 10,
    failures: failures.length,
    latency_ms: {
      avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: Math.max(...latencies),
    },
    sample_failures: failures.slice(0, 5),
  };
}

const scenarios = [
  {
    name: 'GET /api/events (no filter)',
    fn: () => fetch(`${BASE}/api/events?page=1&page_size=20`),
  },
  {
    name: 'GET /api/events (free+age)',
    fn: () => fetch(`${BASE}/api/events?is_free=true&age=5&page=1&page_size=20`),
  },
  {
    name: 'GET /api/digests',
    fn: () => fetch(`${BASE}/api/digests`),
  },
  {
    name: 'GET /api/digests/spring-in-nyc',
    fn: () => fetch(`${BASE}/api/digests/spring-in-nyc`),
  },
  {
    name: 'POST /api/chat (LLM)',
    fn: () => fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'events for 5yo' }),
    }),
  },
  {
    name: 'GET /',
    fn: () => fetch(`${BASE}/`),
  },
];

const userCounts = [10, 25, 50];

(async () => {
  const report = { generated_at: new Date().toISOString(), base_url: BASE, scenarios: [] };

  for (const users of userCounts) {
    for (const s of scenarios) {
      const isChat = s.name.includes('chat');
      const total = isChat ? users * 2 : users * 4;
      process.stdout.write(`Running ${s.name} @ ${users} concurrent, ${total} total requests... `);
      const res = await runScenario(s.name, s.fn, users, total);
      res.user_count = users;
      report.scenarios.push(res);
      console.log(`done in ${res.duration_ms}ms (rps=${res.rps}, p95=${res.latency_ms.p95}ms, fail=${res.failures})`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n=== LOAD TEST SUMMARY ===`);
  console.table(report.scenarios.map(s => ({
    users: s.user_count,
    scenario: s.scenario.slice(0, 35),
    rps: s.rps,
    p50: s.latency_ms.p50,
    p95: s.latency_ms.p95,
    max: s.latency_ms.max,
    fail: s.failures,
  })));
  console.log(`Wrote ${OUT}`);
})();
