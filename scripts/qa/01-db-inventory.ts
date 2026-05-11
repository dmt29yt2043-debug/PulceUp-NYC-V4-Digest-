/**
 * 01 · DB Inventory — baseline stats for the live event pool.
 *
 * Output: counts/distributions per critical field. This is the denominator
 * for every "coverage" calculation in later audit steps. If age_best_from
 * is only 30% populated, no amount of SQL cleverness rescues the age filter.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { loadLiveEvents, DB_PATH, type Ev } from './_lib';

const OUT = path.join(process.cwd(), 'reports', 'qa', '01-db-inventory.json');

function pct(n: number, d: number) { return d === 0 ? 0 : Math.round((n / d) * 1000) / 10; }

function histogram<T extends string | number>(arr: T[]): Record<string, number> {
  const h: Record<string, number> = {};
  arr.forEach((v) => { h[String(v)] = (h[String(v)] ?? 0) + 1; });
  return h;
}

function ageBucket(n: number): string {
  if (n <= 2) return '0-2';
  if (n <= 5) return '3-5';
  if (n <= 8) return '6-8';
  if (n <= 12) return '9-12';
  return '13+';
}

/** Count raw tag-parse failures from the DB.
 *  A failure = `tags` column is non-null/non-empty but we can't parse it as a
 *  JSON array even after the Python-dict normalisation in _lib.ts.
 *  >5% failure rate = vocabulary has drifted, re-check import script. */
function countTagParseFailures(): { total_with_tags: number; parse_failures: number; failure_pct: number } {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare("SELECT tags FROM events WHERE (status IN ('published','done','new') OR status LIKE '%.done') AND tags IS NOT NULL AND tags != ''")
    .all() as { tags: string }[];
  db.close();

  let failures = 0;
  for (const { tags } of rows) {
    let ok = false;
    try { const v = JSON.parse(tags); ok = Array.isArray(v); } catch {}
    if (!ok) {
      try {
        const fixed = tags.replace(/'/g, '"').replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
        const v = JSON.parse(fixed); ok = Array.isArray(v);
      } catch {}
    }
    if (!ok) failures++;
  }
  return {
    total_with_tags: rows.length,
    parse_failures: failures,
    failure_pct: rows.length === 0 ? 0 : Math.round((failures / rows.length) * 1000) / 10,
  };
}

function main() {
  const events = loadLiveEvents();
  const n = events.length;

  const tagFmt = countTagParseFailures();
  const rpt = {
    total_live_events: n,
    tag_format: tagFmt,
    field_completeness: {
      title: pct(events.filter((e) => !!e.title).length, n),
      age_min: pct(events.filter((e) => e.age_min != null).length, n),
      age_best_from: pct(events.filter((e) => e.age_best_from != null).length, n),
      age_best_to: pct(events.filter((e) => e.age_best_to != null).length, n),
      age_label: pct(events.filter((e) => !!e.age_label).length, n),
      next_start_at: pct(events.filter((e) => !!e.next_start_at).length, n),
      price_max: pct(events.filter((e) => e.price_max != null).length, n),
      is_free: pct(events.filter((e) => e.is_free).length, n),
      category_l1: pct(events.filter((e) => !!e.category_l1).length, n),
      format: pct(events.filter((e) => !!e.format).length, n),
      motivation: pct(events.filter((e) => !!e.motivation).length, n),
      country_county: pct(events.filter((e) => !!e.country_county).length, n),
      subway: pct(events.filter((e) => !!e.subway).length, n),
      rating_count_ge5: pct(events.filter((e) => (e.rating_count ?? 0) >= 5).length, n),
      rating_count_ge20: pct(events.filter((e) => (e.rating_count ?? 0) >= 20).length, n),
      lat_lon: pct(events.filter((e) => e.lat != null && e.lon != null).length, n),
      tags_nonempty: pct(events.filter((e) => e.tags.length > 0).length, n),
      categories_nonempty: pct(events.filter((e) => e.categories.length > 0).length, n),
    },
    distributions: {
      by_county: histogram(events.map((e) => e.country_county ?? '<null>')),
      by_category_l1: histogram(events.map((e) => e.category_l1 ?? '<null>')),
      by_format: histogram(events.map((e) => e.format ?? '<null>')),
      by_motivation: histogram(events.map((e) => e.motivation ?? '<null>')),
      by_is_free: { free: events.filter((e) => e.is_free).length, paid: events.filter((e) => !e.is_free).length },
      by_age_bucket_best_from: (() => {
        const buckets: Record<string, number> = {};
        events.forEach((e) => {
          const v = e.age_best_from;
          const k = v == null ? '<null>' : ageBucket(v);
          buckets[k] = (buckets[k] ?? 0) + 1;
        });
        return buckets;
      })(),
      by_price_band: {
        free: events.filter((e) => e.is_free).length,
        '1_10': events.filter((e) => !e.is_free && (e.price_max ?? 0) > 0 && (e.price_max ?? 0) <= 10).length,
        '11_20': events.filter((e) => !e.is_free && (e.price_max ?? 0) > 10 && (e.price_max ?? 0) <= 20).length,
        '21_50': events.filter((e) => !e.is_free && (e.price_max ?? 0) > 20 && (e.price_max ?? 0) <= 50).length,
        '51_plus': events.filter((e) => !e.is_free && (e.price_max ?? 0) > 50).length,
      },
    },
    // For each interest, count how many events a loose text-based predicate
    // says MIGHT be about that topic — this is the upper bound for what
    // any filter could plausibly return.
    interest_upper_bounds: (() => {
      const map: Record<string, number> = {};
      const topics = ['arts', 'science', 'music', 'outdoors', 'theater', 'books', 'sports', 'food', 'film'];
      const matches = (e: Ev, t: string) => {
        const blob = [
          e.category_l1, e.format, e.motivation,
          ...e.categories, ...e.tags,
          e.title, e.description,
        ].filter(Boolean).join(' ').toLowerCase();
        return blob.includes(t);
      };
      topics.forEach((t) => { map[t] = events.filter((e) => matches(e, t)).length; });
      return map;
    })(),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(rpt, null, 2));

  console.log('\n════ DB INVENTORY ════');
  console.log(`Live events: ${rpt.total_live_events}`);
  // Tag format health — >5% failures = data drift warning
  const tf = rpt.tag_format;
  const tfIcon = tf.failure_pct > 5 ? '!' : '✓';
  console.log(`\nTag format health: ${tfIcon} ${tf.parse_failures}/${tf.total_with_tags} parse failures (${tf.failure_pct}%)${tf.failure_pct > 5 ? ' ← WARN: run qa:tags to inspect' : ''}`);
  console.log('\nField completeness (% of live pool):');
  Object.entries(rpt.field_completeness).forEach(([k, v]) => {
    const bar = '█'.repeat(Math.round((v as number) / 5));
    console.log(`  ${k.padEnd(22)} ${(v as number).toFixed(1).padStart(5)}%  ${bar}`);
  });
  console.log('\nBy county:');
  Object.entries(rpt.distributions.by_county).sort((a, b) => Number(b[1]) - Number(a[1])).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(22)} ${v}`);
  });
  console.log('\nInterest upper bounds (events that *might* match):');
  Object.entries(rpt.interest_upper_bounds).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(22)} ${v}`);
  });
  console.log(`\nFull report → ${OUT}`);
}

main();
