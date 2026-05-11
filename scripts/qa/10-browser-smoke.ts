#!/usr/bin/env node
/**
 * Browser-level smoke test — visits real URLs through headless Chromium and
 * verifies the page renders without JS errors, with the URL params applied
 * to filters, and event cards showing real dates (not "Invalid Date").
 *
 * Catches the class of bugs that pass HTTP smoke but break the user:
 *   · "Invalid Date" on cards (date format that JS Date can't parse)
 *   · `(e.categories || []).map is not a function` (string-not-array crashes)
 *   · /results redirect drops filter params (the May-10 source=chat bug)
 *
 * Why a separate script vs extending 07-http-smoke.ts:
 *   · Needs puppeteer (~300 MB browser download)
 *   · Slower (~30 s) — fine for deploys, too slow for every PR
 *   · Better isolated so puppeteer crash doesn't kill cheap HTTP checks
 *
 * Exit codes match the rest of the QA suite:
 *   0  — all scenarios pass
 *   1  — at least one scenario failed (deploy gate should refuse)
 */

import puppeteer, { Browser, Page } from 'puppeteer';
import fs from 'fs';
import path from 'path';

const BASE = process.env.QA_BASE || 'https://pulseup.me';
const HEADFUL = process.env.QA_HEADFUL === '1';
const REPORTS_DIR = path.join(process.cwd(), 'reports', 'qa');
const OUT_FILE = path.join(REPORTS_DIR, '10-browser-smoke.json');

interface Scenario {
  id: string;
  name: string;
  url: string;
  expect: (state: PageState) => string | null;  // returns failure message or null on pass
}

interface PageState {
  finalUrl: string;
  text: string;
  pageErrors: string[];
  consoleErrors: string[];
  apiCalls: Array<{ url: string; status: number; total?: number }>;
  cards: string[];
  has(re: RegExp): boolean;
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

const SCENARIOS: Scenario[] = [
  {
    id: 'b01',
    name: 'home page renders + shows events',
    url: '/',
    expect: (s) => {
      if (s.pageErrors.length > 0) return `JS error: ${s.pageErrors[0].slice(0, 100)}`;
      if (!s.has(/All \(\d+\)/)) return 'no "All (N)" event-count badge — feed did not render';
      if (s.cards.length === 0)  return 'no event-card headings rendered';
      return null;
    },
  },
  {
    id: 'b02',
    name: 'no "Invalid Date" on any card (Bug #2 May-11 timezone)',
    url: '/',
    expect: (s) => {
      if (s.has(/Invalid Date/)) return '"Invalid Date" text on the page — next_start_at format broken';
      return null;
    },
  },
  {
    id: 'b03',
    name: '/results?source=chat&borough=manhattan applies filters (Bug May-10)',
    url: '/results?source=chat&parent=yes&gender=boy&child_age=8&children=boy%3A8&borough=manhattan&interests=arts_crafts%2Cplaygrounds%2Coutdoor%2Cclasses%2Cscience%2Canimals',
    expect: (s) => {
      if (s.pageErrors.length > 0) return `JS error: ${s.pageErrors[0].slice(0, 100)}`;
      if (!/\/$/.test(s.finalUrl)) return `expected redirect to "/", got "${s.finalUrl}"`;
      if (!s.has(/Manhattan/))     return 'Manhattan not present after redirect — quiz params not applied';
      if (s.has(/Staten Island/i)) return 'Staten Island default showing — quiz params NOT applied';
      if (!s.has(/👦.?\s?8/))       return '8yo not visible in Who filter';
      return null;
    },
  },
  {
    id: 'b04',
    name: '/results?source=quiz also works (back-compat)',
    url: '/results?source=quiz&gender=girl&child_age=5&children=girl%3A5&borough=brooklyn&interests=outdoor',
    expect: (s) => {
      if (s.pageErrors.length > 0) return `JS error: ${s.pageErrors[0].slice(0, 100)}`;
      if (!s.has(/Brooklyn/))   return 'Brooklyn not applied for source=quiz';
      if (!s.has(/👧.?\s?5/))    return '5yo girl not visible in Who filter';
      return null;
    },
  },
  {
    id: 'b05',
    name: 'direct /?borough=queens applies even without source label',
    url: '/?borough=queens&child_age=6&gender=boy&interests=playgrounds',
    expect: (s) => {
      if (s.pageErrors.length > 0) return `JS error: ${s.pageErrors[0].slice(0, 100)}`;
      if (!s.has(/Queens/))     return 'Queens not applied — presence-based param detection broken';
      return null;
    },
  },
  {
    id: 'b06',
    name: '/api/events/personalized response does not crash event-filter (Bug #4 May-11)',
    url: '/?borough=manhattan&child_age=8&interests=arts_crafts',
    expect: (s) => {
      // The crashing function reads event.categories.map — page errors will
      // bubble up from the React tree. If they appear specifically about
      // `.map is not a function`, it's the categories-as-string bug.
      const crash = s.pageErrors.find((e) => /map is not a function/.test(e));
      if (crash) return `event-filter crashed: ${crash.slice(0, 120)}`;
      return null;
    },
  },
];

// ─── Runner ─────────────────────────────────────────────────────────────────

async function runScenario(browser: Browser, sc: Scenario): Promise<{ scenario: Scenario; passed: boolean; detail: string; latencyMs: number }> {
  const page: Page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 PulseUp-QA');

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const apiCalls: PageState['apiCalls'] = [];

  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/events') || url.includes('/api/digests')) {
      try {
        const j = await res.json().catch(() => null);
        const total = j && typeof j === 'object' ? (j as { total?: number }).total : undefined;
        apiCalls.push({ url: url.replace(BASE, ''), status: res.status(), total });
      } catch { /* ignore */ }
    }
  });

  const started = Date.now();
  // `load` waits for assets to finish but doesn't block on background XHRs
  // (PostHog, leaflet tiles, session replay) the way networkidle2 does. Then
  // we explicitly wait for the feed counter to appear — that's the real
  // "page is interactive" signal. Add a retry for transient network blips.
  let attempt = 0;
  let lastErr: Error | null = null;
  while (attempt < 2) {
    attempt++;
    try {
      await page.goto(BASE + sc.url, { waitUntil: 'load', timeout: 30_000 });
      // The feed counter only appears once React mounts + the first events
      // request returns. Prod cold-start can take 5–10 s. 25 s budget covers
      // mobile-tier latency comfortably.
      await page.waitForFunction(
        () => /All \(\d+\)/.test(document.body.innerText) || /Pulse AI assistant/.test(document.body.innerText),
        { timeout: 25_000 },
      ).catch(() => { /* error-state scenarios may not render the counter */ });
      // Brief settle for redirect cleanup (replaceState) + filter side-effects.
      await new Promise((r) => setTimeout(r, 2500));
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e as Error;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (lastErr) {
    await page.close();
    return { scenario: sc, passed: false, detail: `goto failed after ${attempt} attempts: ${lastErr.message.slice(0, 100)}`, latencyMs: Date.now() - started };
  }

  const finalUrl = page.url();
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  const cards = await page.evaluate(() => [...document.querySelectorAll('h3')].map((e) => e.textContent?.trim() ?? '').filter((t) => t.length > 5)).catch(() => []);

  const state: PageState = {
    finalUrl, text, pageErrors, consoleErrors, apiCalls, cards,
    has: (re) => re.test(text),
  };

  await page.close();

  const failure = sc.expect(state);
  return {
    scenario: sc,
    passed: failure === null,
    detail: failure ?? `cards=${cards.length} apiCalls=${apiCalls.length}`,
    latencyMs: Date.now() - started,
  };
}

async function main() {
  console.log(`\n════ BROWSER SMOKE (${BASE}) ════`);
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const results: Array<{ id: string; name: string; ok: boolean; detail: string; latencyMs: number }> = [];

  try {
    for (const sc of SCENARIOS) {
      const r = await runScenario(browser, sc);
      const mark = r.passed ? '✓' : '✗';
      console.log(`  ${sc.id} ${mark} ${String(r.latencyMs).padStart(5)}ms  ${sc.name.padEnd(60)} ${r.detail}`);
      results.push({ id: sc.id, name: sc.name, ok: r.passed, detail: r.detail, latencyMs: r.latencyMs });
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ base: BASE, runAt: new Date().toISOString(), cases: results }, null, 2));
  console.log(`Report → ${OUT_FILE}`);

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
