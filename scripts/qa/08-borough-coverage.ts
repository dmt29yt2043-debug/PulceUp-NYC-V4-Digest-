/**
 * 08 · Borough Coverage — where's the database thin?
 *
 * Motivation: a parent in Queens picked a Thursday and saw "No events found".
 * Turns out the DB genuinely had 0 events in Queens on that day. This audit
 * measures that gap systematically across all 5 NYC boroughs.
 *
 * Output:
 *   · Per-borough event counts (live pool) — absolute + % of total
 *   · Per-borough date coverage over the next 14 days (which days are empty)
 *   · Per-borough × category matrix (which category is absent where)
 *   · Events with no detectable borough ("orphans") — candidates for venue
 *     fixes in the parser
 *   · NYC population reference for sanity check
 *
 * Reports go to reports/qa/08-borough-coverage.{json,md}.
 */

import fs from 'fs';
import path from 'path';
import { loadLiveEvents, inBorough, type Ev } from './_lib';

const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'] as const;
type Borough = typeof BOROUGHS[number];

// Rough NYC population split (US Census 2020-ish). Keeps "expected share"
// honest instead of eyeballing. Sum ≈ 100 %.
const POPULATION_SHARE: Record<Borough, number> = {
  Manhattan: 19,      // ~1.6M
  Brooklyn: 31,       // ~2.7M
  Queens: 27,         // ~2.4M
  Bronx: 17,          // ~1.5M
  'Staten Island': 6, // ~0.5M
};

const JSON_OUT = path.join(process.cwd(), 'reports', 'qa', '08-borough-coverage.json');
const MD_OUT   = path.join(process.cwd(), 'reports', 'qa', '08-borough-coverage.md');

// We intentionally probe the category_l1 field for distribution because that's
// what the card/filter surfaces most often. Events can have many tags but only
// one l1 category.
const CATEGORY_BUCKETS = [
  'family', 'arts', 'sports', 'attractions', 'music', 'food', 'theater', 'books', 'science',
];

function pct(n: number, d: number) { return d === 0 ? 0 : Math.round((n / d) * 1000) / 10; }

function eventBorough(e: Ev): Borough | null {
  for (const b of BOROUGHS) if (inBorough(e, b)) return b;
  return null;
}

function dateKey(e: Ev): string | null {
  const s = e.next_start_at;
  if (!s) return null;
  return s.slice(0, 10);
}

function next14Days(): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function weekdayShort(isoDay: string): string {
  return new Date(isoDay + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
}

interface Report {
  generated_at: string;
  total_live: number;
  per_borough: Array<{
    borough: Borough;
    count: number;
    share_pct: number;
    expected_share_pct: number;
    delta_pct: number;         // share - expected (negative = under-represented)
    avg_events_per_day_next14: number;
    empty_days_next14: string[];
    category_gaps: string[];   // categories with 0 events in this borough
  }>;
  orphans: {
    count: number;
    share_pct: number;
    samples: Array<{ id: number; title: string; city: string | null; venue: string | null }>;
  };
  date_matrix: {
    dates: string[];
    rows: Array<{ borough: Borough; counts: number[] }>;
  };
}

function build(): Report {
  const events = loadLiveEvents();
  const total = events.length;

  // Bucket events by borough
  const byBorough: Record<Borough, Ev[]> = {
    Manhattan: [], Brooklyn: [], Queens: [], Bronx: [], 'Staten Island': [],
  };
  const orphans: Ev[] = [];
  for (const e of events) {
    const b = eventBorough(e);
    if (b) byBorough[b].push(e);
    else orphans.push(e);
  }

  // Per-borough counts + date coverage
  const dates = next14Days();
  const perBorough: Report['per_borough'] = [];
  const matrixRows: { borough: Borough; counts: number[] }[] = [];

  for (const b of BOROUGHS) {
    const pool = byBorough[b];
    const share = pct(pool.length, total);

    // Day-by-day over next 14 days
    const dayCounts: Record<string, number> = {};
    dates.forEach((d) => { dayCounts[d] = 0; });
    for (const e of pool) {
      const k = dateKey(e);
      if (k && k in dayCounts) dayCounts[k]++;
    }
    const empty = dates.filter((d) => dayCounts[d] === 0);
    const coveredDays = dates.filter((d) => dayCounts[d] > 0);
    const avg = coveredDays.length
      ? Math.round((coveredDays.reduce((s, d) => s + dayCounts[d], 0) / 14) * 10) / 10
      : 0;

    // Category gaps — which l1 buckets have 0 events in this borough?
    const catSet = new Set(pool.map((e) => (e.category_l1 || '').toLowerCase()).filter(Boolean));
    const gaps = CATEGORY_BUCKETS.filter((c) => !catSet.has(c));

    perBorough.push({
      borough: b,
      count: pool.length,
      share_pct: share,
      expected_share_pct: POPULATION_SHARE[b],
      delta_pct: Math.round((share - POPULATION_SHARE[b]) * 10) / 10,
      avg_events_per_day_next14: avg,
      empty_days_next14: empty,
      category_gaps: gaps,
    });

    matrixRows.push({
      borough: b,
      counts: dates.map((d) => dayCounts[d]),
    });
  }

  return {
    generated_at: new Date().toISOString(),
    total_live: total,
    per_borough: perBorough,
    orphans: {
      count: orphans.length,
      share_pct: pct(orphans.length, total),
      samples: orphans.slice(0, 15).map((e) => ({
        id: e.id,
        title: (e.title || '').slice(0, 70),
        city: e.city ?? null,
        venue: e.venue_name ?? null,
      })),
    },
    date_matrix: { dates, rows: matrixRows },
  };
}

function renderMd(r: Report): string {
  const lines: string[] = [];
  lines.push('# Borough Coverage Audit');
  lines.push('');
  lines.push(`_Generated: ${r.generated_at} · ${r.total_live} live events_`);
  lines.push('');
  lines.push('## Per-borough share vs. population');
  lines.push('');
  lines.push('| Borough | Events | % of DB | % of NYC pop | Delta | Avg/day (14d) | Empty days |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const p of r.per_borough) {
    const flag = p.delta_pct <= -10 ? ' 🚨' : p.delta_pct <= -5 ? ' ⚠️' : '';
    lines.push(
      `| ${p.borough} | ${p.count} | ${p.share_pct}% | ${p.expected_share_pct}% | ${p.delta_pct > 0 ? '+' : ''}${p.delta_pct}%${flag} | ${p.avg_events_per_day_next14} | ${p.empty_days_next14.length}/14 |`,
    );
  }
  lines.push('');
  lines.push('_Delta = DB share − population share. Sub-zero values = under-represented borough. 🚨 ≥ 10 pp gap._');
  lines.push('');

  lines.push('## Empty days by borough (next 14)');
  lines.push('');
  for (const p of r.per_borough) {
    if (p.empty_days_next14.length === 0) {
      lines.push(`- **${p.borough}** — no empty days ✅`);
    } else {
      const dayLabels = p.empty_days_next14.map((d) => `${d} (${weekdayShort(d)})`);
      lines.push(`- **${p.borough}** — ${p.empty_days_next14.length} empty: ${dayLabels.join(', ')}`);
    }
  }
  lines.push('');

  lines.push('## Category gaps (0 events under this `category_l1`)');
  lines.push('');
  for (const p of r.per_borough) {
    if (p.category_gaps.length === 0) lines.push(`- **${p.borough}** — all tracked categories present ✅`);
    else lines.push(`- **${p.borough}** — missing: \`${p.category_gaps.join('`, `')}\``);
  }
  lines.push('');

  lines.push('## Orphans — events with no detectable borough');
  lines.push('');
  lines.push(`**${r.orphans.count}** events (${r.orphans.share_pct}% of DB) could not be assigned to a borough.`);
  lines.push('');
  lines.push('These are likely parser misses — a city/county value the borough matcher didn\'t recognise, or a fully-NULL location. Fix them and we recover coverage with zero scraping effort.');
  lines.push('');
  if (r.orphans.samples.length) {
    lines.push('Sample (first 15):');
    lines.push('');
    lines.push('| id | title | city | venue |');
    lines.push('|---:|---|---|---|');
    for (const s of r.orphans.samples) {
      lines.push(`| ${s.id} | ${s.title} | ${s.city ?? '—'} | ${s.venue ?? '—'} |`);
    }
    lines.push('');
  }

  // Date matrix — compact grid
  lines.push('## Day-by-day matrix (next 14 days)');
  lines.push('');
  lines.push('Each cell = events live in that borough on that date.');
  lines.push('');
  const header = ['Borough', ...r.date_matrix.dates.map((d) => `${d.slice(5)} ${weekdayShort(d).slice(0,1)}`)];
  lines.push('| ' + header.join(' | ') + ' |');
  lines.push('|' + header.map(() => '---').join('|') + '|');
  for (const row of r.date_matrix.rows) {
    const cells = row.counts.map((c) => c === 0 ? '·' : String(c));
    lines.push(`| ${row.borough} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('_`·` = zero events._');
  lines.push('');

  // Recommendations
  lines.push('## Recommendations');
  lines.push('');
  const under = r.per_borough.filter((p) => p.delta_pct <= -5);
  if (under.length === 0) {
    lines.push('- Coverage is roughly population-weighted. No single borough is a systemic gap.');
  } else {
    for (const p of under) {
      lines.push(`- **${p.borough}** is under-represented by ${Math.abs(p.delta_pct)} percentage points. Priority sources to investigate: local library branches, community centres, borough-specific Eventbrite, parks department calendars.`);
    }
  }
  if (r.orphans.share_pct > 2) {
    lines.push(`- ${r.orphans.count} orphan events (${r.orphans.share_pct}%) — fixing the location fields in the parser is the cheapest win before scraping new sources.`);
  }
  return lines.join('\n');
}

function main() {
  const r = build();
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(r, null, 2));
  fs.writeFileSync(MD_OUT, renderMd(r));
  console.log(`Wrote ${JSON_OUT}`);
  console.log(`Wrote ${MD_OUT}`);
  console.log('');
  console.log(`Total live events: ${r.total_live}`);
  for (const p of r.per_borough) {
    console.log(`  ${p.borough.padEnd(14)} ${String(p.count).padStart(4)} (${p.share_pct.toString().padStart(4)}%) · avg/day ${p.avg_events_per_day_next14} · empty ${p.empty_days_next14.length}/14`);
  }
  console.log(`  ${'Orphans'.padEnd(14)} ${String(r.orphans.count).padStart(4)} (${r.orphans.share_pct}%)`);
}

main();
