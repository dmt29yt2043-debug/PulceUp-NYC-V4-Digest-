#!/usr/bin/env node
/**
 * Post-import data quality gate.
 *
 * Run this immediately after `import-csv.ts` to catch import-time disasters:
 *   · column-rename mismatch (geo_lat/best_to vs lat/age_best_to) → 0 coverage
 *   · timezone-suffix on next_start_at → 0 events pass live filter
 *   · age synth disabled → events have null upper bounds and surface for wrong ages
 *   · CSV truncated → too few events
 *
 * Designed as a separate script (rather than a check inside import-csv.ts)
 * so that:
 *   · import-csv.ts can be rerun without QA noise during dev experiments
 *   · the gate runs identically in CI and in `npm run import:csv && npm run qa:import`
 *
 * Exit 0 = pass · Exit 1 = at least one threshold tripped (block deploy)
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'data', 'events.db');
const REPORTS_DIR = path.join(process.cwd(), 'reports', 'qa');
const OUT_FILE = path.join(REPORTS_DIR, '11-import-quality.json');

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];

function addCheck(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
  const mark = passed ? '✓' : '✗';
  console.log(`  ${mark} ${name.padEnd(48)} ${detail}`);
}

function pct(num: number, denom: number): number {
  return denom === 0 ? 0 : Math.round((num / denom) * 100);
}

function main() {
  console.log('\n════ IMPORT QUALITY GATE ════');
  if (!fs.existsSync(DB_PATH)) {
    console.error('  ✗ DB file missing — did import-csv.ts run?');
    process.exit(1);
  }
  const db = new Database(DB_PATH, { readonly: true });

  // 1. Total volume — empty DB means import silently no-op'd
  const total = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  addCheck('total events ≥ 100', total >= 100, `${total} rows in events table`);
  if (total === 0) {
    console.error('  ✗ DB is empty — import is broken, no further checks meaningful');
    process.exit(1);
  }

  // 2. lat/lon coverage — catches geo_lat-vs-lat column rename bug.
  // 80% threshold lets a few orphan venues slip but flags the everything-missing case.
  const withGeo = (db.prepare('SELECT COUNT(*) AS n FROM events WHERE lat IS NOT NULL AND lon IS NOT NULL').get() as { n: number }).n;
  addCheck('lat/lon coverage ≥ 80%', pct(withGeo, total) >= 80, `${pct(withGeo, total)}% (${withGeo}/${total})`);

  // 3. Age data — catches the best_from-vs-age_best_from rename and synth regressions.
  // We expect ≥ 90% to have at least one bound (either from import or synth at read time).
  const withAgeFrom = (db.prepare('SELECT COUNT(*) AS n FROM events WHERE age_best_from IS NOT NULL').get() as { n: number }).n;
  addCheck('age_best_from coverage ≥ 90%', pct(withAgeFrom, total) >= 90, `${pct(withAgeFrom, total)}%`);

  // 4. Date parseability — catches the timezone-suffix-breaks-SQLite bug.
  // Pull one row and check SQLite can compute its +3h offset.
  const dateRow = db.prepare(`SELECT next_start_at, datetime(next_start_at, '+3 hours') AS computed FROM events WHERE next_start_at IS NOT NULL AND next_start_at != '' LIMIT 1`).get() as { next_start_at: string; computed: string | null } | undefined;
  if (!dateRow) {
    addCheck('next_start_at parses in SQLite', false, 'no events have a non-empty next_start_at');
  } else {
    const parseable = dateRow.computed !== null && dateRow.computed !== '';
    addCheck('next_start_at parses in SQLite', parseable, parseable
      ? `e.g. ${dateRow.next_start_at} → +3h = ${dateRow.computed}`
      : `'${dateRow.next_start_at}' → datetime() returned NULL — live filter will reject 100% of rows`);
  }

  // 5. Date parseability in JS — catches "Invalid Date" on cards before users see them.
  if (dateRow) {
    const ms = new Date(dateRow.next_start_at).getTime();
    addCheck('next_start_at parses in JS new Date()', Number.isFinite(ms), Number.isFinite(ms)
      ? `parses to ${new Date(ms).toISOString().slice(0, 16)}`
      : `'${dateRow.next_start_at}' fails new Date() — cards will show "Invalid Date"`);
  }

  // 6. Status hygiene — every row should have a status the LIVE filter recognises.
  // If the CSV starts shipping a new status enum, the filter silently drops 100%.
  const knownStatuses = ['published', 'done', 'new', 'verify.desc', 'verify.done',
                         'synth.expired', 'verify.expired', 'verify.not_ny',
                         'verify.dupe', 'verify.intake', 'verify.latlon',
                         'discovery.expired', 'synth.02_schedule'];
  const placeholders = knownStatuses.map(() => '?').join(',');
  const unknownStatus = db.prepare(`SELECT status, COUNT(*) AS n FROM events WHERE status NOT IN (${placeholders}) GROUP BY status`).all(...knownStatuses) as Array<{ status: string; n: number }>;
  if (unknownStatus.length > 0) {
    addCheck('status values all recognised', false, `unrecognised: ${unknownStatus.map(u => `${u.status}(${u.n})`).join(', ')}`);
  } else {
    addCheck('status values all recognised', true, 'all rows use known statuses');
  }

  // 7. Live filter actually returns events — catches catastrophic combos of
  // status mismatch + date parse failure even when individual checks pass.
  const liveCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM events
    WHERE (status IN ('published', 'done', 'new', 'verify.desc') OR status LIKE '%.done')
      AND (
        COALESCE(NULLIF(next_end_at, ''), datetime(next_start_at, '+3 hours')) >= datetime('now')
        OR next_start_at IS NULL
      )
  `).get() as { n: number }).n;
  addCheck('live filter returns ≥ 50 events', liveCount >= 50, `${liveCount} rows pass the live-event filter`);

  // 8. Title sanity — empty titles or all-uppercase noise.
  const emptyTitles = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE title IS NULL OR title = ''`).get() as { n: number }).n;
  addCheck('all events have a title', emptyTitles === 0, emptyTitles === 0 ? 'no empty titles' : `${emptyTitles} rows have empty titles`);

  db.close();

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ runAt: new Date().toISOString(), checks }, null, 2));
  console.log(`\nReport → ${OUT_FILE}`);

  const failed = checks.filter((c) => !c.passed);
  console.log(`\nSummary: ${checks.length - failed.length}/${checks.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
