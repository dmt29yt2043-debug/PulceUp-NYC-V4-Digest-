#!/usr/bin/env node
/**
 * E2E flows — validates critical user paths via HTTP (Playwright unavailable here).
 * Flow 1: Open page → send chat query → get recommendations
 * Flow 2: Apply filter (digest) → verify results
 * Flow 3: Reset / clear digest
 * Flow 4: No-results scenario
 * Output: qa/results/e2e_report.json
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.QA_BASE || 'http://localhost:3004';
const OUT = path.join(__dirname, '..', 'results', 'e2e_report.json');

const log = [];
function record(flow, step, ok, detail) {
  log.push({ flow, step, ok, detail });
  console.log(`${ok ? '✓' : '✗'} [${flow}] ${step}${detail ? ': ' + detail : ''}`);
}

async function j(url, opts = {}) {
  const res = await fetch(url, opts);
  const body = await res.text();
  let json = null; try { json = JSON.parse(body); } catch {}
  return { status: res.status, json, body };
}

(async () => {
  // -------- FLOW 1: chat → recommendations --------
  {
    const F = 'flow1:chat';
    const { status, json } = await j(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'outdoor for 5yo' }),
    });
    record(F, 'chat returns 200', status === 200, `status=${status}`);
    record(F, 'has filters', !!json?.filters, JSON.stringify(json?.filters || {}));
    record(F, 'has message', typeof json?.message === 'string' && json.message.length > 10, `len=${json?.message?.length}`);
    record(F, 'has events array', Array.isArray(json?.events), `n=${json?.events?.length}`);
    record(F, 'events > 0', (json?.events || []).length > 0);
    record(F, 'event has required fields', !!(json?.events?.[0]?.id && json?.events?.[0]?.title));
    // No HTML tags in message (should be plain text)
    record(F, 'message has no HTML', !/<[a-z]/i.test(json?.message || ''));
  }

  // -------- FLOW 2: digest apply --------
  {
    const F = 'flow2:digest';
    const { status, json } = await j(`${BASE}/api/digests`);
    record(F, 'digests list 200', status === 200);
    record(F, 'has categories', Array.isArray(json?.categories));
    record(F, 'has digests', Array.isArray(json?.digests) && json.digests.length > 0);
    const firstSlug = json?.digests?.[0]?.slug;
    if (firstSlug) {
      const { status: s2, json: d } = await j(`${BASE}/api/digests/${firstSlug}`);
      record(F, `digest[${firstSlug}] 200`, s2 === 200);
      record(F, 'digest has events', Array.isArray(d?.events) && d.events.length > 0, `n=${d?.events?.length}`);
      record(F, 'events have required fields', (d?.events || []).every(e => e.id && e.title));
    }
  }

  // -------- FLOW 3: filters update results --------
  {
    const F = 'flow3:filters';
    const base = await j(`${BASE}/api/events?page=1&page_size=5`);
    record(F, 'unfiltered OK', base.status === 200, `total=${base.json?.total}`);
    const free = await j(`${BASE}/api/events?is_free=true&page=1&page_size=5`);
    record(F, 'isFree filter OK', free.status === 200, `total=${free.json?.total}`);
    record(F, 'isFree total <= unfiltered', (free.json?.total || 0) <= (base.json?.total || 0));
    record(F, 'isFree all events actually free', (free.json?.events || []).every(e => e.is_free));
    const cat = await j(`${BASE}/api/events?categories=outdoors&page=1&page_size=5`);
    record(F, 'category filter OK', cat.status === 200, `total=${cat.json?.total}`);
    const age = await j(`${BASE}/api/events?age=5&page=1&page_size=5`);
    record(F, 'age filter OK', age.status === 200, `total=${age.json?.total}`);
    const date = await j(`${BASE}/api/events?date_from=2026-05-01&page=1&page_size=5`);
    record(F, 'date_from filter OK', date.status === 200, `total=${date.json?.total}`);
    record(F, 'date_from reduces results', (date.json?.total || 0) < (base.json?.total || 0));
  }

  // -------- FLOW 4: no-results scenario --------
  {
    const F = 'flow4:empty';
    const { status, json } = await j(`${BASE}/api/events?categories=nonexistent_category&page=1&page_size=5`);
    record(F, 'HTTP 200 on empty', status === 200);
    record(F, 'total is 0', json?.total === 0);
    record(F, 'events is empty array', Array.isArray(json?.events) && json.events.length === 0);
    // Extreme combination
    const { status: s2, json: j2 } = await j(`${BASE}/api/events?is_free=true&price_max=0&age=2&date_from=2030-01-01`);
    record(F, 'extreme filter returns 200', s2 === 200);
    record(F, 'extreme filter returns 0', j2?.total === 0);
  }

  // -------- FLOW 5: events/[id] detail --------
  {
    const F = 'flow5:detail';
    const { json: list } = await j(`${BASE}/api/events?page=1&page_size=1`);
    const id = list?.events?.[0]?.id;
    if (id) {
      const { status, json } = await j(`${BASE}/api/events/${id}`);
      record(F, `event[${id}] 200`, status === 200);
      const ev = json?.event || json;
      record(F, 'has title', !!ev?.title);
      record(F, 'has description', typeof ev?.description === 'string');
    }
    const { status: s404 } = await j(`${BASE}/api/events/999999`);
    record(F, '999999 returns 404', s404 === 404);
    const { status: s400 } = await j(`${BASE}/api/events/abc`);
    record(F, 'invalid id returns 400', s400 === 400);
  }

  // -------- FLOW 6: SSR / HTML sanity --------
  {
    const F = 'flow6:ssr';
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    record(F, 'homepage 200', res.status === 200);
    record(F, 'has <title>', /<title>/i.test(html));
    record(F, 'has Next.js markers', html.includes('_next/static') || html.includes('__next'));
    record(F, 'no visible error text', !/error 500|failed to fetch/i.test(html));
    const resD = await fetch(`${BASE}/?digest=spring-in-nyc`);
    record(F, 'digest URL 200', resD.status === 200);
  }

  const ok = log.filter(l => l.ok).length;
  const fail = log.length - ok;
  const report = {
    generated_at: new Date().toISOString(),
    base_url: BASE,
    total_checks: log.length, passed: ok, failed: fail,
    pass_rate_percent: Math.round(ok / log.length * 100),
    failures: log.filter(l => !l.ok),
    all: log,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n=== E2E SUMMARY ===`);
  console.log(`Passed: ${ok}/${log.length} (${report.pass_rate_percent}%)`);
  if (fail) console.log('FAILURES:', report.failures.map(f => `${f.flow}/${f.step}`).join('\n  '));
  console.log(`Wrote ${OUT}`);
})();
