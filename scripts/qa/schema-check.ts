/**
 * Schema check — fails loudly if the events table is missing any column that
 * our production code reads from.
 *
 * The last schema-shift incident (dropped `gender_fit` column → HTTP 500 on
 * every gender query for ~2 days) was the exact kind of bug this catches.
 * Run it right after a DB import and the broken query will surface in < 1s
 * instead of when the first user hits /api/chat.
 *
 * Usage:
 *   npx tsx scripts/qa/schema-check.ts
 *
 * Exit codes:
 *   0  — schema is compatible
 *   1  — one or more required columns are missing (breaking change)
 *   2  — warnings only (soft mismatches, e.g. new optional column we don't use)
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'data', 'events.db');

// ─── Columns our production code depends on ─────────────────────────────────
// Grouped by "blast radius" so failures are easy to triage.
interface ColumnDep { name: string; usedBy: string; severity: 'required' | 'recommended' }
const REQUIRED_COLUMNS: ColumnDep[] = [
  // Identity
  { name: 'id',                 usedBy: 'all queries',                        severity: 'required' },
  { name: 'title',              usedBy: 'all surfaces (UI, chat, digests)',   severity: 'required' },
  { name: 'status',             usedBy: 'live-events filter',                 severity: 'required' },
  { name: 'disabled',           usedBy: 'live-events filter',                 severity: 'recommended' },
  { name: 'archived',           usedBy: 'live-events filter',                 severity: 'recommended' },

  // Age filter (lib/db.ts buildAgeFitSql)
  { name: 'age_best_from',      usedBy: 'age filter (buildAgeFitSql)',        severity: 'required' },
  { name: 'age_best_to',        usedBy: 'age filter (buildAgeFitSql)',        severity: 'required' },
  { name: 'age_min',            usedBy: 'age filter fallback',                severity: 'required' },
  { name: 'age_label',          usedBy: 'toddler-keyword exclusion',          severity: 'required' },
  { name: 'short_title',        usedBy: 'toddler-keyword exclusion',          severity: 'recommended' },

  // Category filter (lib/db.ts CAT_DEFS buildCatMatch)
  { name: 'category_l1',        usedBy: 'category filter, primary field',     severity: 'required' },
  { name: 'categories',         usedBy: 'category filter, JSON secondary',    severity: 'required' },
  { name: 'tags',               usedBy: 'category filter, JSON primary',      severity: 'required' },

  // Price / free filter
  { name: 'is_free',            usedBy: 'isFree filter + ranking',            severity: 'required' },
  { name: 'price_min',          usedBy: 'priceMin filter',                    severity: 'required' },
  { name: 'price_max',          usedBy: 'priceMax filter',                    severity: 'required' },
  { name: 'price_summary',      usedBy: 'chat reply formatting',              severity: 'recommended' },

  // Date filter
  { name: 'next_start_at',      usedBy: 'dateFrom filter + ordering',         severity: 'required' },
  { name: 'next_end_at',        usedBy: 'past-event filter',                  severity: 'required' },

  // Geo filter (lib/db.ts neighborhoods)
  { name: 'country_county',     usedBy: 'borough filter (primary)',           severity: 'required' },
  { name: 'lat',                usedBy: 'sub-Manhattan bbox + distance',      severity: 'required' },
  { name: 'lon',                usedBy: 'sub-Manhattan bbox + distance',      severity: 'required' },
  { name: 'city',               usedBy: 'borough filter (text fallback)',     severity: 'required' },
  { name: 'city_district',      usedBy: 'borough filter (text fallback)',     severity: 'recommended' },
  { name: 'city_locality',      usedBy: 'borough filter (text fallback)',     severity: 'recommended' },
  { name: 'address',            usedBy: 'borough filter (text fallback)',     severity: 'recommended' },
  { name: 'venue_name',         usedBy: 'borough fallback + chat formatting', severity: 'required' },

  // Ranking signals
  { name: 'rating_avg',         usedBy: 'ranking quality signal',             severity: 'recommended' },
  { name: 'rating_count',       usedBy: 'ranking quality signal',             severity: 'recommended' },
  { name: 'image_url',          usedBy: 'ranking signal + UI',                severity: 'recommended' },
  { name: 'description',        usedBy: 'search + chat context',              severity: 'required' },

  // JSON-parsed fields used by parseEventRow
  { name: 'reviews',            usedBy: 'event detail page',                  severity: 'recommended' },
  { name: 'derisk',             usedBy: 'event detail page',                  severity: 'recommended' },
  { name: 'data',               usedBy: 'accessibility filters (wheelchair/stroller)', severity: 'recommended' },
  { name: 'format',             usedBy: 'digest heuristics (indoor/outdoor)', severity: 'recommended' },
];

// ─── Check ──────────────────────────────────────────────────────────────────

interface ColumnInfo { name: string; type: string; notnull: number; pk: number }

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`✗ DB not found at ${DB_PATH}. Did you run import-csv.ts?`);
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });
  const cols = db.prepare('PRAGMA table_info(events)').all() as ColumnInfo[];
  const colNames = new Set(cols.map(c => c.name));

  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  Schema check — events table                               ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);
  console.log(`Found ${cols.length} columns in the events table.\n`);

  const missingRequired: ColumnDep[] = [];
  const missingRecommended: ColumnDep[] = [];
  for (const dep of REQUIRED_COLUMNS) {
    if (!colNames.has(dep.name)) {
      if (dep.severity === 'required') missingRequired.push(dep);
      else missingRecommended.push(dep);
    }
  }

  // New columns we don't use — just informational.
  const knownNames = new Set(REQUIRED_COLUMNS.map(c => c.name));
  const newColumns = cols.filter(c => !knownNames.has(c.name)).map(c => c.name);

  if (missingRequired.length > 0) {
    console.error(`✗ ${missingRequired.length} REQUIRED columns missing — production code will crash:`);
    for (const c of missingRequired) {
      console.error(`    - ${c.name.padEnd(20)}  used by: ${c.usedBy}`);
    }
    console.error('');
  }

  if (missingRecommended.length > 0) {
    console.warn(`! ${missingRecommended.length} recommended columns missing — some features will degrade:`);
    for (const c of missingRecommended) {
      console.warn(`    - ${c.name.padEnd(20)}  used by: ${c.usedBy}`);
    }
    console.warn('');
  }

  if (newColumns.length > 0) {
    console.log(`ℹ ${newColumns.length} new columns (not yet used by code, which is fine):`);
    console.log(`    ${newColumns.join(', ')}\n`);
  }

  // ── Sanity checks on row counts ──
  const live = db.prepare(
    "SELECT COUNT(*) as n FROM events WHERE status IN ('published','done','new') OR status LIKE '%.done'"
  ).get() as { n: number };
  console.log(`Live events (status in done/published/new): ${live.n}`);
  if (live.n === 0) {
    console.error('✗ Zero live events — either the import failed or status column changed semantics.');
    process.exit(1);
  } else if (live.n < 50) {
    console.warn(`! Only ${live.n} live events — expected 100+. Likely a partial import.`);
  }

  db.close();

  if (missingRequired.length > 0) {
    console.error('Schema check FAILED. Fix the DB or adjust lib/db.ts before deploying.');
    process.exit(1);
  }
  if (missingRecommended.length > 0) {
    console.warn('Schema check passed with soft warnings.');
    process.exit(2);
  }
  console.log('✓ Schema check passed — all required columns present.');
  process.exit(0);
}

main();
