/**
 * DB quality audit — measures the events.db on:
 *   1. volume + freshness (live vs past vs no-date)
 *   2. status / schedule distribution
 *   3. % completeness on every UI-relevant field
 *   4. source / origin diversity
 *
 * Run: npx tsx scripts/db-quality-audit.ts
 */

import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.join(process.cwd(), 'data', 'events.db'), { readonly: true });

// ── 1. Volume & freshness ───────────────────────────────────────────────────

const total = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;

const live = (db.prepare(`
  SELECT COUNT(*) AS n FROM events
  WHERE (status IN ('published','done','new') OR status LIKE '%.done')
    AND disabled = 0 AND archived = 0
    AND (
      COALESCE(NULLIF(next_end_at,''), datetime(next_start_at, '+3 hours')) >= datetime('now')
      OR next_start_at IS NULL
    )
`).get() as { n: number }).n;

const past = (db.prepare(`
  SELECT COUNT(*) AS n FROM events
  WHERE next_start_at IS NOT NULL AND next_start_at != ''
    AND COALESCE(NULLIF(next_end_at,''), datetime(next_start_at, '+3 hours')) < datetime('now')
`).get() as { n: number }).n;

const noDate = (db.prepare(`
  SELECT COUNT(*) AS n FROM events WHERE next_start_at IS NULL OR next_start_at = ''
`).get() as { n: number }).n;

console.log('━━━ VOLUME ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Total events:                ${total.toLocaleString().padStart(6)}`);
console.log(`Live & upcoming:             ${live.toLocaleString().padStart(6)}  (${(live*100/total).toFixed(1)}%)`);
console.log(`Past:                        ${past.toLocaleString().padStart(6)}  (${(past*100/total).toFixed(1)}%)`);
console.log(`Without date:                ${noDate.toLocaleString().padStart(6)}  (${(noDate*100/total).toFixed(1)}%)`);
console.log();

// ── 2. Time horizon (live events with dates) ────────────────────────────────

const horizon = db.prepare(`
  SELECT
    SUM(CASE WHEN date(next_start_at) BETWEEN date('now') AND date('now','+7 days')   THEN 1 ELSE 0 END) AS w,
    SUM(CASE WHEN date(next_start_at) BETWEEN date('now','+8 days') AND date('now','+30 days') THEN 1 ELSE 0 END) AS m,
    SUM(CASE WHEN date(next_start_at) BETWEEN date('now','+31 days') AND date('now','+90 days') THEN 1 ELSE 0 END) AS q,
    SUM(CASE WHEN date(next_start_at) > date('now','+90 days') THEN 1 ELSE 0 END) AS later
  FROM events
  WHERE (status IN ('published','done','new') OR status LIKE '%.done')
    AND disabled = 0 AND archived = 0 AND next_start_at IS NOT NULL
`).get() as Record<string, number>;

console.log('━━━ TIME HORIZON (live events) ━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Next 7 days:                 ${(horizon.w ?? 0).toLocaleString().padStart(6)}`);
console.log(`8–30 days:                   ${(horizon.m ?? 0).toLocaleString().padStart(6)}`);
console.log(`31–90 days:                  ${(horizon.q ?? 0).toLocaleString().padStart(6)}`);
console.log(`Beyond 90 days:              ${(horizon.later ?? 0).toLocaleString().padStart(6)}`);
console.log();

// ── 3. Status distribution ──────────────────────────────────────────────────

const statuses = db.prepare(`SELECT status, COUNT(*) AS n FROM events GROUP BY status ORDER BY n DESC LIMIT 10`).all() as { status: string, n: number }[];
console.log('━━━ STATUS DISTRIBUTION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const s of statuses) console.log(`  ${(s.status || '(null)').padEnd(25)}${String(s.n).padStart(6)}`);
console.log();

// ── 4. Field completeness ───────────────────────────────────────────────────
// Use TWO denominators side by side so the picture is honest:
//   · "all-status" events: every row that passes status+disabled+archived
//      (this is the upper-bound dataset — includes events without a date)
//   · "live-with-date":     all-status AND next_start_at exists AND not past
//      (this is what the user actually sees on screen)

const STATUS_WHERE = `(status IN ('published','done','new') OR status LIKE '%.done') AND disabled = 0 AND archived = 0`;
const LIVE_WHERE   = `${STATUS_WHERE} AND next_start_at IS NOT NULL AND next_start_at != '' AND COALESCE(NULLIF(next_end_at,''), datetime(next_start_at, '+3 hours')) >= datetime('now')`;

const allStatusTotal = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${STATUS_WHERE}`).get() as { n: number }).n;
const liveWithDate   = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${LIVE_WHERE}`).get() as { n: number }).n;

const isPresent = (col: string) => `(${col} IS NOT NULL AND ${col} != '' AND ${col} != '[]' AND ${col} != '{}')`;
const isNumPresent = (col: string) => `(${col} IS NOT NULL)`;

function pct(col: string, kind: 'text' | 'num' = 'text'): {
  col: string; allN: number; allPct: number; liveN: number; livePct: number
} {
  const expr = kind === 'num' ? isNumPresent(col) : isPresent(col);
  const allN  = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${STATUS_WHERE} AND ${expr}`).get() as { n: number }).n;
  const liveN = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${LIVE_WHERE}   AND ${expr}`).get() as { n: number }).n;
  return {
    col, allN, liveN,
    allPct:  allStatusTotal === 0 ? 0 : (allN  * 100 / allStatusTotal),
    livePct: liveWithDate    === 0 ? 0 : (liveN * 100 / liveWithDate),
  };
}

// Group fields by purpose so the report tells a story.
const groups: Array<{ name: string; fields: Array<[string, 'text' | 'num']> }> = [
  { name: 'Identity & display', fields: [
    ['title', 'text'], ['short_title', 'text'], ['description', 'text'],
    ['tagline', 'text'], ['image_url', 'text'], ['source_url', 'text'],
  ]},
  { name: 'Time', fields: [
    ['next_start_at', 'text'], ['next_end_at', 'text'],
    ['schedule', 'text'], ['occurrences', 'text'], ['timezone', 'text'],
  ]},
  { name: 'Place', fields: [
    ['venue_name', 'text'], ['address', 'text'], ['city', 'text'],
    ['country_county', 'text'], ['lat', 'num'], ['lon', 'num'],
    ['subway', 'text'],
  ]},
  { name: 'Audience (age)', fields: [
    ['age_min', 'num'], ['age_label', 'text'],
    ['age_best_from', 'num'], ['age_best_to', 'num'],
  ]},
  { name: 'Pricing', fields: [
    ['is_free', 'num'], ['price_min', 'num'], ['price_max', 'num'],
    ['price_summary', 'text'],
  ]},
  { name: 'Categorization', fields: [
    ['category_l1', 'text'], ['categories', 'text'], ['tags', 'text'],
    ['format', 'text'], ['motivation', 'text'],
  ]},
  { name: 'Quality / social', fields: [
    ['rating_avg', 'num'], ['rating_count', 'num'],
    ['reviews', 'text'], ['favorites_count', 'num'],
  ]},
];

console.log(`━━━ FIELD COMPLETENESS ━━━`);
console.log(`  All-status:    ${allStatusTotal} events  (everything not-disabled, not-archived)`);
console.log(`  Live-with-date: ${liveWithDate} events  (above + future date — what users see)`);
console.log();
console.log(`  ${''.padEnd(28)}all-status        live-with-date`);
for (const g of groups) {
  console.log('  ' + g.name);
  for (const [col, kind] of g.fields) {
    const r = pct(col, kind);
    const bar = '█'.repeat(Math.round(r.allPct / 5));
    const flag = r.allPct >= 90 ? '✅' : r.allPct >= 60 ? '🟡' : '🔴';
    console.log(`    ${flag} ${col.padEnd(20)}${String(r.allN).padStart(5)}/${allStatusTotal}  ${r.allPct.toFixed(0).padStart(3)}%   │  ${String(r.liveN).padStart(3)}/${liveWithDate}  ${r.livePct.toFixed(0).padStart(3)}%   ${bar}`);
  }
}
console.log();

// ── 5. Special checks the UI cares about ────────────────────────────────────

const meaningfulPrice = (db.prepare(`
  SELECT COUNT(*) AS n FROM events
  WHERE ${LIVE_WHERE}
    AND (is_free = 1 OR (price_max IS NOT NULL AND price_max > 0))
`).get() as { n: number }).n;

const ageActionable = (db.prepare(`
  SELECT COUNT(*) AS n FROM events
  WHERE ${LIVE_WHERE}
    AND (age_best_from IS NOT NULL OR age_min IS NOT NULL OR age_label IS NOT NULL)
`).get() as { n: number }).n;

const fullCard = (db.prepare(`
  SELECT COUNT(*) AS n FROM events
  WHERE ${LIVE_WHERE}
    AND title IS NOT NULL AND title != ''
    AND image_url IS NOT NULL AND image_url != ''
    AND venue_name IS NOT NULL AND venue_name != ''
    AND next_start_at IS NOT NULL AND next_start_at != ''
    AND lat IS NOT NULL AND lon IS NOT NULL
    AND (is_free = 1 OR price_max IS NOT NULL)
    AND (age_best_from IS NOT NULL OR age_label IS NOT NULL)
`).get() as { n: number }).n;

const richCard = (db.prepare(`
  SELECT COUNT(*) AS n FROM events
  WHERE ${LIVE_WHERE}
    AND title IS NOT NULL AND image_url IS NOT NULL AND venue_name IS NOT NULL
    AND description IS NOT NULL AND length(description) >= 100
    AND next_start_at IS NOT NULL
    AND lat IS NOT NULL AND lon IS NOT NULL
    AND (age_best_from IS NOT NULL OR age_label IS NOT NULL)
    AND category_l1 IS NOT NULL AND category_l1 != ''
    AND rating_count >= 1
`).get() as { n: number }).n;

console.log('━━━ READINESS FOR DISPLAY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Has actionable price info:   ${meaningfulPrice.toLocaleString().padStart(6)}  (${(meaningfulPrice*100/liveWithDate).toFixed(0)}%)`);
console.log(`Has age info:                ${ageActionable.toLocaleString().padStart(6)}  (${(ageActionable*100/liveWithDate).toFixed(0)}%)`);
console.log(`"Full card" (all key fields): ${fullCard.toLocaleString().padStart(6)}  (${(fullCard*100/liveWithDate).toFixed(0)}%)`);
console.log(`"Rich card" (full + description+rating+category): ${richCard.toLocaleString().padStart(6)}  (${(richCard*100/liveWithDate).toFixed(0)}%)`);
console.log();

// ── 6. Sources / origins ────────────────────────────────────────────────────

// description_source: noted in CSV header but in practice this column ends up
// holding either a short label OR the raw description. Sample to see what it
// looks like in this batch.
const descSrcStats = db.prepare(`
  SELECT
    SUM(CASE WHEN description_source IS NULL OR description_source = '' THEN 1 ELSE 0 END) AS empty_n,
    SUM(CASE WHEN length(description_source) > 60 THEN 1 ELSE 0 END) AS long_n,
    SUM(CASE WHEN description_source IS NOT NULL AND length(description_source) <= 60 THEN 1 ELSE 0 END) AS short_n
  FROM events WHERE ${LIVE_WHERE}
`).get() as { empty_n: number, long_n: number, short_n: number };

console.log('━━━ DESCRIPTION_SOURCE FIELD ━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Empty / null:        ${descSrcStats.empty_n}`);
console.log(`  Short label (<60 ch): ${descSrcStats.short_n}`);
console.log(`  Long prose (>60 ch):  ${descSrcStats.long_n}  ← field actually holds the description text, not a source label`);
console.log();

// Source URL → origin domain
const urls = db.prepare(`SELECT source_url FROM events WHERE ${LIVE_WHERE} AND source_url IS NOT NULL AND source_url != ''`).all() as { source_url: string }[];
const domainCounts = new Map<string, number>();
for (const r of urls) {
  try {
    const u = new URL(r.source_url);
    const host = u.hostname.replace(/^www\./, '');
    domainCounts.set(host, (domainCounts.get(host) ?? 0) + 1);
  } catch { /* ignore */ }
}

const domains = Array.from(domainCounts.entries()).sort((a, b) => b[1] - a[1]);
console.log('━━━ SOURCE DOMAINS (top 20) ━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Distinct source domains: ${domains.length}`);
console.log(`Events with a source_url: ${urls.length}/${liveWithDate} (${(urls.length*100/liveWithDate).toFixed(0)}%)`);
for (const [d, n] of domains.slice(0, 20)) {
  console.log(`  ${d.padEnd(35)}${String(n).padStart(6)}  (${(n*100/urls.length).toFixed(1)}%)`);
}
console.log();

// External_id format also tells us about source
const extTotal = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${LIVE_WHERE} AND external_id IS NOT NULL AND external_id != ''`).get() as { n: number }).n;
console.log('━━━ EXTERNAL_ID PRESENCE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Has external_id: ${extTotal}/${liveWithDate} (${(extTotal*100/liveWithDate).toFixed(0)}%)`);
console.log();

// Source spread across the whole pool (status-only, no date filter) — useful
// for understanding the scraper's coverage even when events lack dates.
const allUrls = db.prepare(`SELECT source_url FROM events WHERE ${STATUS_WHERE} AND source_url IS NOT NULL AND source_url != ''`).all() as { source_url: string }[];
const allDomCounts = new Map<string, number>();
for (const r of allUrls) {
  try {
    const u = new URL(r.source_url);
    const host = u.hostname.replace(/^www\./, '');
    allDomCounts.set(host, (allDomCounts.get(host) ?? 0) + 1);
  } catch { /* ignore */ }
}
console.log('━━━ SCRAPER COVERAGE (all events, not just live) ━━━━━');
console.log(`Distinct source domains in entire DB: ${allDomCounts.size}`);
console.log(`Top 10 across full DB:`);
for (const [d, n] of Array.from(allDomCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${d.padEnd(35)}${String(n).padStart(6)}  (${(n*100/allUrls.length).toFixed(1)}%)`);
}
console.log();

// ── 7. Categories / formats spread ───────────────────────────────────────────

const cats = db.prepare(`
  SELECT LOWER(category_l1) AS c, COUNT(*) AS n FROM events WHERE ${LIVE_WHERE}
  AND category_l1 IS NOT NULL AND category_l1 != ''
  GROUP BY c ORDER BY n DESC
`).all() as { c: string, n: number }[];
console.log('━━━ CATEGORY DISTRIBUTION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const r of cats) console.log(`  ${r.c.padEnd(20)}${String(r.n).padStart(6)}  (${(r.n*100/liveWithDate).toFixed(1)}%)`);
console.log();

// ── 8. Geographic spread (live events) ──────────────────────────────────────

const counties = db.prepare(`
  SELECT LOWER(country_county) AS c, COUNT(*) AS n FROM events WHERE ${LIVE_WHERE}
  AND country_county IS NOT NULL AND country_county != ''
  GROUP BY c ORDER BY n DESC
`).all() as { c: string, n: number }[];
console.log('━━━ BY BOROUGH (county) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const r of counties) console.log(`  ${r.c.padEnd(25)}${String(r.n).padStart(6)}  (${(r.n*100/liveWithDate).toFixed(1)}%)`);
console.log();

db.close();
