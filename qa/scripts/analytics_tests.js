#!/usr/bin/env node
/**
 * Analytics validation — scans the codebase for track()/trackEvent() calls and verifies
 * the analytics endpoint behavior. Lists which expected beta-launch events are wired.
 * Output: qa/results/analytics_report.json
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = process.env.QA_BASE || 'http://localhost:3004';
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'results', 'analytics_report.json');

const EXPECTED = [
  'page_view', 'chat_started', 'chat_sent', 'message_sent',
  'onboarding_completed', 'onboarding_started',
  'recommendations_shown', 'results_shown',
  'card_clicked', 'event_clicked', 'card_click',
  'buy_clicked', 'purchase_click', 'buy_click',
  'filter_applied', 'digest_selected',
];

// Grep track() calls — walk files manually for reliability
function walk(dir, files = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const s = fs.statSync(p);
    if (s.isDirectory() && !f.includes('node_modules') && !f.startsWith('.')) walk(p, files);
    else if (/\.(ts|tsx)$/.test(f)) files.push(p);
  }
  return files;
}

const files = [
  ...walk(path.join(ROOT, 'app')),
  ...walk(path.join(ROOT, 'components')),
  ...walk(path.join(ROOT, 'lib')),
];

let lines = [];
for (const f of files) {
  const content = fs.readFileSync(f, 'utf8');
  const matches = content.split('\n').map((line, i) => {
    const m = line.match(/\btrack(?:Event)?\s*\(\s*['"]([^'"]+)['"]/);
    if (m) return `${f.replace(ROOT, '.')}:${i + 1}: ${line.trim()}`;
    return null;
  }).filter(Boolean);
  lines = lines.concat(matches);
}

// (old grep removed; `lines` is populated by the walk above)
const eventNames = new Set();
const callSites = [];

for (const line of lines) {
  const m = line.match(/track(?:Event)?\(['"]([^'"]+)['"]/);
  if (m) {
    eventNames.add(m[1]);
    callSites.push({ event: m[1], line: line.slice(0, 200) });
  }
}

// Live analytics endpoint test
async function testEndpoint() {
  try {
    const res = await fetch(`${BASE}/api/analytics/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_name: 'qa_test_event', props: { qa: true } }),
    });
    return { status: res.status, ok: res.ok };
  } catch (e) {
    return { error: String(e) };
  }
}

(async () => {
  const fired = [...eventNames].sort();
  const missing = EXPECTED.filter(e => !fired.some(f => f === e || f.includes(e.split('_')[0])));
  const endpointResult = await testEndpoint();

  const report = {
    generated_at: new Date().toISOString(),
    base_url: BASE,
    analytics_endpoint_test: endpointResult,
    events_fired_in_code: fired,
    total_call_sites: callSites.length,
    expected_for_beta: EXPECTED,
    coverage: {
      page_view: fired.some(f => /page_view|pageview/i.test(f)),
      chat_started: fired.some(f => /chat_started|chat_sent|message_sent|chat_completed/i.test(f)),
      onboarding_completed: fired.some(f => /onboarding/i.test(f)),
      recommendations_shown: fired.some(f => /recommendations|results_shown|results/i.test(f)),
      card_clicked: fired.some(f => /card_click|event_click|card_opened/i.test(f)),
      buy_clicked: fired.some(f => /buy|purchase|ticket_click/i.test(f)),
      filter_applied: fired.some(f => /filter/i.test(f)),
      digest_selected: fired.some(f => /digest/i.test(f)),
    },
    call_sites: callSites.slice(0, 80),
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`Analytics endpoint: ${JSON.stringify(endpointResult)}`);
  console.log(`\nEvents fired in code (${fired.length}):`);
  fired.forEach(e => console.log('  - ' + e));
  console.log(`\nBeta coverage:`);
  Object.entries(report.coverage).forEach(([k, v]) => console.log(`  ${v ? '✓' : '✗'} ${k}`));
  console.log(`Missing candidates: ${missing.length > 0 ? missing.join(', ') : 'none'}`);
  console.log(`Wrote ${OUT}`);
})();
