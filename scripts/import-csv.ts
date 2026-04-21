import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';

const csvPath = path.join(__dirname, '..', 'data', 'event_us.csv');
const dbPath = path.join(__dirname, '..', 'data', 'events.db');

// BUG_009: previously we `unlinkSync(dbPath)` — which also wiped the `digests`
// and `digest_events` tables seeded separately. Now we only drop/recreate
// the `events` table (and its indexes), preserving everything else.
const db = new Database(dbPath);
db.exec(`
  DROP INDEX IF EXISTS idx_events_category;
  DROP INDEX IF EXISTS idx_events_free;
  DROP INDEX IF EXISTS idx_events_lat_lon;
  DROP INDEX IF EXISTS idx_events_start;
  DROP TABLE IF EXISTS events;
`);

db.exec(`
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    short_title TEXT,
    tagline TEXT,
    description TEXT,
    source_url TEXT,
    image_url TEXT,
    venue_name TEXT,
    subway TEXT,
    address TEXT,
    city TEXT,
    lat REAL,
    lon REAL,
    next_start_at TEXT,
    next_end_at TEXT,
    age_min INTEGER,
    age_label TEXT,
    age_best_from INTEGER,
    age_best_to INTEGER,
    is_free INTEGER DEFAULT 0,
    price_summary TEXT,
    price_min REAL DEFAULT 0,
    price_max REAL DEFAULT 0,
    category_l1 TEXT,
    categories TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    reviews TEXT DEFAULT '[]',
    derisk TEXT DEFAULT '{}',
    rating_avg REAL DEFAULT 0,
    rating_count INTEGER DEFAULT 0,
    data TEXT DEFAULT '{}',
    status TEXT DEFAULT 'published',
    created_at TEXT,
    updated_at TEXT
  );
  CREATE INDEX idx_events_category ON events(category_l1);
  CREATE INDEX idx_events_free ON events(is_free);
  CREATE INDEX idx_events_lat_lon ON events(lat, lon);
  CREATE INDEX idx_events_start ON events(next_start_at);
`);

const csvContent = fs.readFileSync(csvPath, 'utf-8');
const records = parse(csvContent, { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });

function parsePythonList(val: string): string[] {
  if (!val || val === '[]' || val === '') return [];
  try {
    // Try JSON first
    return JSON.parse(val.replace(/'/g, '"'));
  } catch {
    // Extract strings from python-like list
    const matches = val.match(/'([^']+)'/g);
    return matches ? matches.map(m => m.replace(/'/g, '')) : [];
  }
}

function parsePythonDict(val: string): Record<string, unknown> {
  if (!val || val === '{}' || val === '') return {};
  try {
    return JSON.parse(val.replace(/'/g, '"').replace(/True/g, 'true').replace(/False/g, 'false').replace(/None/g, 'null'));
  } catch {
    // Try harder with regex for nested structures
    try {
      const cleaned = val
        .replace(/'/g, '"')
        .replace(/True/g, 'true')
        .replace(/False/g, 'false')
        .replace(/None/g, 'null')
        .replace(/\\n/g, ' ')
        .replace(/\n/g, ' ');
      return JSON.parse(cleaned);
    } catch {
      return {};
    }
  }
}

function parseReviews(val: string): Array<{ text: string }> {
  const list = parsePythonList(val);
  return list.map(text => ({ text }));
}

function getImageUrl(row: Record<string, string>): string {
  // Try images field first for CDN URLs
  const images = row.images || '';
  const cdnMatch = images.match(/https:\/\/pulse-cdn\.dnogin\.com\/[^'"\s]+/);
  if (cdnMatch) return cdnMatch[0];
  // Fall back to picture_url
  return row.picture_url || '';
}

function getSourceUrl(row: Record<string, string>): string {
  const urls = row.source_urls || '';
  const ticketMatch = urls.match(/'ticket':\s*'([^']+)'/);
  if (ticketMatch) return ticketMatch[1];
  return row.canonical_url || '';
}

// ===========================================================================
// Data normalization — applied as each CSV row is imported.
// These rules fix recurring data bugs that would otherwise come back with
// every new CSV dump. DO NOT run one-off UPDATE statements on the DB —
// they'll be wiped on next import. Add the rule here instead.
// Each function is pure and side-effect-free on purpose.
// ===========================================================================

// BUG_005: some events ship with age ranges like 0–100 or 0–150, which makes
// them show up for every age filter and spoils personalization. Clamp to
// [0, 18]. If ranges go inverted or negative, normalize them too.
function clampAge(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 18) return 18;
  return n;
}

// BUG_006: a few events claim is_free=True while still carrying a non-zero
// price_min/price_max. Trust the `is_free` flag, zero the prices.
function reconcileFreeAndPrice(isFree: number, priceMin: number, priceMax: number) {
  if (isFree === 1 && (priceMin > 0 || priceMax > 0)) {
    return { priceMin: 0, priceMax: 0 };
  }
  return { priceMin, priceMax };
}

// BUG_004: CSV delivers next_end_at as "" (empty string) for all events.
// An empty string compares as < any ISO timestamp in SQL and silently breaks
// date-range filters. Store NULL instead; the app already handles NULL.
function normalizeDate(v: string | undefined | null): string | null {
  if (!v || v === '' || v === 'None' || v === 'null') return null;
  return v;
}

// BUG_003: ~40% of events come without category_l1 but usually carry
// categories[] or tags[] in JSON. Pick the first non-empty value and use it
// as category_l1 so category filters work out of the box.
const CATEGORY_ALIASES: Record<string, string> = {
  // Map CSV's capitalized "human" categories to our canonical slugs
  'Art': 'arts', 'Arts & Crafts': 'arts', 'Painting': 'arts',
  'Music': 'music', 'Cultural Events': 'arts',
  'Theater': 'theater', 'Circus': 'theater', 'Movies': 'film',
  'History': 'books', 'Walking Tour': 'attractions',
  "Children's Activities": 'family', 'Family Activities': 'family',
  'Kids Activities': 'family', 'Family Events': 'family',
  'Outdoor Activities': 'outdoors',
  'STEAM': 'science', 'STEM': 'science', 'Science': 'science',
  'Dining': 'food', 'Food': 'food',
};
// Canonical category slugs — anything outside this set is rejected to avoid
// exploding the category facet with tag-derived noise (e.g. "dinosaurs",
// "baking", "bingo"). Must match labels exposed by lib/db.ts::getCategories.
const CANONICAL_CATEGORIES = new Set([
  'family', 'arts', 'theater', 'attractions', 'books', 'holiday', 'sports',
  'comedy', 'community', 'education', 'fashion', 'film', 'food', 'gaming',
  'music', 'nightlife', 'outdoors', 'science', 'wellness',
]);

function deriveCategory(raw: string, categoriesJson: string, tagsJson: string): string {
  if (raw && raw.trim() && raw.toLowerCase() !== 'other') {
    // Keep raw if it's canonical OR if it's a known display form
    if (CANONICAL_CATEGORIES.has(raw.toLowerCase())) return raw;
    if (CATEGORY_ALIASES[raw]) return CATEGORY_ALIASES[raw];
    return raw; // Preserve pre-existing non-canonical values to avoid regressions
  }
  const pool: string[] = [];
  try { pool.push(...(JSON.parse(categoriesJson) as string[])); } catch {}
  try { pool.push(...(JSON.parse(tagsJson) as string[])); } catch {}
  // 1) Try alias map (handles "Art", "Children's Activities", etc.)
  for (const c of pool) {
    if (!c) continue;
    if (CATEGORY_ALIASES[c]) return CATEGORY_ALIASES[c];
  }
  // 2) Try direct canonical match (lowercased)
  for (const c of pool) {
    const low = String(c).toLowerCase();
    if (CANONICAL_CATEGORIES.has(low)) return low;
  }
  // 3) Give up — let the filter fall back to tag/category JSON lookup at query time
  return '';
}

// BUG_007 (monitoring only): log how many events have no geocode so we can
// track the trend across CSV drops. We don't auto-geocode here.
function countMissingGeo(lat: number | null, lon: number | null): number {
  return (lat === null || lon === null) ? 1 : 0;
}

const insert = db.prepare(`
  INSERT INTO events (id, title, short_title, tagline, description, source_url, image_url,
    venue_name, subway, address, city, lat, lon, next_start_at, next_end_at,
    age_min, age_label, age_best_from, age_best_to, is_free, price_summary, price_min, price_max,
    category_l1, categories, tags, reviews, derisk, rating_avg, rating_count, data,
    status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let imported = 0;
let skipped = 0;
// Counters for the post-import normalization report
const norm = {
  age_clamped: 0,
  free_price_reconciled: 0,
  end_date_nullified: 0,
  category_derived: 0,
  missing_geo: 0,
  past_events_skipped: 0,
};

// BUG_008: skip events whose next_start_at is explicitly in the past.
// Events with no date (null / empty) are kept — they may be recurring or
// have unknown schedules. Only cut rows where the date is set AND < now.
const NOW_MS = Date.now();
function isPastEvent(nextStartAt: string | undefined | null): boolean {
  if (!nextStartAt || nextStartAt.trim() === '' || nextStartAt === 'None' || nextStartAt === 'null') {
    return false; // no date → keep
  }
  try {
    const ms = new Date(nextStartAt).getTime();
    return Number.isFinite(ms) && ms < NOW_MS;
  } catch {
    return false; // unparseable → keep (safe default)
  }
}

const insertMany = db.transaction((rows: Record<string, string>[]) => {
  for (const row of rows) {
    try {
      if (row.status === 'disabled' || row.disabled === 'True' || row.archived === 'True') {
        skipped++;
        continue;
      }

      // BUG_008 — skip past events (saves tokens on every user request)
      if (isPastEvent(row.next_start_at)) {
        skipped++;
        norm.past_events_skipped++;
        continue;
      }

      const lat = row.lat ? parseFloat(row.lat) : null;
      const lon = row.lon ? parseFloat(row.lon) : null;
      norm.missing_geo += countMissingGeo(lat, lon);

      // BUG_005 — clamp ages
      const rawMin = row.age_min ? parseInt(row.age_min) : null;
      const rawBestFrom = row.age_best_from ? parseInt(row.age_best_from) : null;
      const rawBestTo = row.age_best_to ? parseInt(row.age_best_to) : null;
      const ageMin = clampAge(rawMin);
      const ageBestFrom = clampAge(rawBestFrom);
      const ageBestTo = clampAge(rawBestTo);
      if (ageMin !== rawMin || ageBestFrom !== rawBestFrom || ageBestTo !== rawBestTo) {
        norm.age_clamped++;
      }

      // BUG_006 — reconcile is_free with price
      const isFreeFlag = row.is_free === 'True' ? 1 : 0;
      const rawPriceMin = row.price_min ? parseFloat(row.price_min) : 0;
      const rawPriceMax = row.price_max ? parseFloat(row.price_max) : 0;
      const { priceMin, priceMax } = reconcileFreeAndPrice(isFreeFlag, rawPriceMin, rawPriceMax);
      if (priceMin !== rawPriceMin || priceMax !== rawPriceMax) norm.free_price_reconciled++;

      // BUG_004 — empty end_date -> NULL (count both empty-string and whitespace cases)
      const rawEndAt = row.next_end_at;
      const nextEndAt = normalizeDate(rawEndAt);
      if (rawEndAt !== undefined && rawEndAt !== nextEndAt && nextEndAt === null) {
        norm.end_date_nullified++;
      }

      // BUG_003 — derive category if missing
      const categoriesJson = JSON.stringify(parsePythonList(row.categories || ''));
      const tagsJson = JSON.stringify(parsePythonList(row.tags || ''));
      const rawCategory = row.category_l1 || '';
      const categoryL1 = deriveCategory(rawCategory, categoriesJson, tagsJson);
      if (!rawCategory && categoryL1) norm.category_derived++;

      insert.run(
        parseInt(row.id),
        row.title || '',
        row.short_title || '',
        row.tagline || '',
        row.description || '',
        getSourceUrl(row),
        getImageUrl(row),
        row.venue_name || '',
        row.subway || '',
        row.address || '',
        row.city || '',
        lat,
        lon,
        row.next_start_at || '',
        nextEndAt,
        ageMin,
        row.age_label || '',
        ageBestFrom,
        ageBestTo,
        isFreeFlag,
        row.price_summary || '',
        priceMin,
        priceMax,
        categoryL1,
        categoriesJson,
        tagsJson,
        JSON.stringify(parseReviews(row.reviews || '')),
        JSON.stringify(parsePythonDict(row.derisk || '')),
        row.rating_avg ? parseFloat(row.rating_avg) : 0,
        row.rating_count ? parseInt(row.rating_count) : 0,
        JSON.stringify(parsePythonDict(row.data || '')),
        row.status || 'published',
        row.created_at || '',
        row.updated_at || ''
      );
      imported++;
    } catch (e) {
      console.error(`Error importing row ${row.id}: ${(e as Error).message}`);
      skipped++;
    }
  }
});

insertMany(records);

console.log(`Imported: ${imported}, Skipped: ${skipped}`);
console.log(`Database created at: ${dbPath}`);

// Verify
const count = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
console.log(`Total events in DB: ${count.count}`);

const withCoords = db.prepare('SELECT COUNT(*) as count FROM events WHERE lat IS NOT NULL AND lon IS NOT NULL').get() as { count: number };
console.log(`Events with coordinates: ${withCoords.count}`);

const categories = db.prepare("SELECT DISTINCT category_l1 FROM events WHERE category_l1 != '' ORDER BY category_l1").all();
console.log(`Categories: ${categories.map((c: any) => c.category_l1).join(', ')}`);

console.log(`\n=== Normalization applied ===`);
console.log(`  BUG_005 ages clamped to [0,18]:        ${norm.age_clamped} rows`);
console.log(`  BUG_006 free/price reconciled:         ${norm.free_price_reconciled} rows`);
console.log(`  BUG_004 empty next_end_at -> NULL:     ${norm.end_date_nullified} rows`);
console.log(`  BUG_003 category_l1 derived:           ${norm.category_derived} rows`);
console.log(`  BUG_007 missing lat/lon (monitoring):  ${norm.missing_geo} rows`);
console.log(`  BUG_008 past events skipped:           ${norm.past_events_skipped} rows`);

db.close();
