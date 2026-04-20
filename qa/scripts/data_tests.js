#!/usr/bin/env node
/**
 * Data validation — scans events.db for completeness and integrity issues.
 * Output: qa/results/data_report.json
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, '..', '..', 'data', 'events.db');
const OUT = path.join(__dirname, '..', 'results', 'data_report.json');

const db = new Database(DB, { readonly: true });

// Only events the app actually shows users
const WHERE = `WHERE (status IN ('published','done','new') OR status LIKE '%.done') AND title NOT LIKE '%Rewards%' AND title NOT LIKE '%Royalty%' AND title NOT LIKE '%Loyalty%' AND title NOT LIKE '%Club Baja%' AND title NOT LIKE '%Join Club%' AND (category_l1 IS NULL OR category_l1 NOT IN ('networking'))`;

const total = db.prepare(`SELECT COUNT(*) c FROM events`).get().c;
const visible = db.prepare(`SELECT COUNT(*) c FROM events ${WHERE}`).get().c;

const pct = (n, base = visible) => Math.round((n / Math.max(1, base)) * 100 * 10) / 10;

const missing = {
  title: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND (title IS NULL OR title='')`).get().c,
  category_l1: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND (category_l1 IS NULL OR category_l1='')`).get().c,
  age_min: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND age_min IS NULL`).get().c,
  age_best_from: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND age_best_from IS NULL`).get().c,
  age_best_to: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND age_best_to IS NULL`).get().c,
  age_label: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND (age_label IS NULL OR age_label='')`).get().c,
  price_min: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND price_min IS NULL`).get().c,
  price_summary: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND (price_summary IS NULL OR price_summary='')`).get().c,
  is_free: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND is_free IS NULL`).get().c,
  next_start_at: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND (next_start_at IS NULL OR next_start_at='')`).get().c,
  next_end_at: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND (next_end_at IS NULL OR next_end_at='')`).get().c,
  image_url: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND (image_url IS NULL OR image_url='')`).get().c,
  venue_name: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND (venue_name IS NULL OR venue_name='')`).get().c,
  address: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND (address IS NULL OR address='')`).get().c,
  lat: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND lat IS NULL`).get().c,
  lon: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND lon IS NULL`).get().c,
  description: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND (description IS NULL OR description='')`).get().c,
  tagline: db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND (tagline IS NULL OR tagline='')`).get().c,
};

// Duplicates
const dupeTitles = db.prepare(`SELECT title, COUNT(*) c FROM events ${WHERE} GROUP BY LOWER(TRIM(title)) HAVING c > 1 ORDER BY c DESC LIMIT 20`).all();
// events table has no slug column — detect dupes by title+venue instead
const dupeVenueTitle = db.prepare(`SELECT title, venue_name, COUNT(*) c FROM events ${WHERE} GROUP BY LOWER(TRIM(title)), LOWER(TRIM(venue_name)) HAVING c > 1 ORDER BY c DESC LIMIT 10`).all();

// Broken references in digests
const brokenDigestLinks = db.prepare(`SELECT COUNT(*) c FROM digest_events de LEFT JOIN events e ON e.id=de.event_id WHERE e.id IS NULL`).get().c;

// Data anomalies
const weirdAges = db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND (age_min < 0 OR age_min > 18 OR age_best_to > 100)`).get().c;
const weirdPrices = db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND (price_min < 0 OR price_max < price_min)`).get().c;
const pastEvents = db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND next_start_at < datetime('now','-30 days')`).get().c;
const mismatchedFree = db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND is_free=1 AND (price_min > 0 OR price_max > 0)`).get().c;
const emptyCategoryButHasTags = db.prepare(`SELECT COUNT(*) c FROM events ${WHERE} AND (category_l1 IS NULL OR category_l1='') AND tags != '[]' AND tags IS NOT NULL`).get().c;

// Category distribution
const byCategory = db.prepare(`SELECT COALESCE(NULLIF(category_l1,''),'_empty_') cat, COUNT(*) c FROM events ${WHERE} GROUP BY cat ORDER BY c DESC`).all();

// Age distribution
const byAge = db.prepare(`SELECT
  SUM(CASE WHEN age_best_from <= 3 AND (age_best_to IS NULL OR age_best_to >= 3) THEN 1 ELSE 0 END) as fits_3,
  SUM(CASE WHEN age_best_from <= 5 AND (age_best_to IS NULL OR age_best_to >= 5) THEN 1 ELSE 0 END) as fits_5,
  SUM(CASE WHEN age_best_from <= 8 AND (age_best_to IS NULL OR age_best_to >= 8) THEN 1 ELSE 0 END) as fits_8,
  SUM(CASE WHEN age_best_from <= 12 AND (age_best_to IS NULL OR age_best_to >= 12) THEN 1 ELSE 0 END) as fits_12,
  SUM(CASE WHEN age_best_from <= 15 AND (age_best_to IS NULL OR age_best_to >= 15) THEN 1 ELSE 0 END) as fits_15
FROM events ${WHERE}`).get();

// Status breakdown (full DB)
const statusBreakdown = db.prepare(`SELECT status, COUNT(*) c FROM events GROUP BY status ORDER BY c DESC`).all();

const report = {
  generated_at: new Date().toISOString(),
  summary: {
    total_events_in_db: total,
    visible_to_users: visible,
    hidden_by_filters: total - visible,
  },
  field_completeness_percent_of_visible: {
    title: pct(visible - missing.title),
    category_l1: pct(visible - missing.category_l1),
    age_min: pct(visible - missing.age_min),
    age_best_from: pct(visible - missing.age_best_from),
    age_best_to: pct(visible - missing.age_best_to),
    age_label: pct(visible - missing.age_label),
    price_min: pct(visible - missing.price_min),
    price_summary: pct(visible - missing.price_summary),
    is_free: pct(visible - missing.is_free),
    next_start_at: pct(visible - missing.next_start_at),
    next_end_at: pct(visible - missing.next_end_at),
    image_url: pct(visible - missing.image_url),
    venue_name: pct(visible - missing.venue_name),
    address: pct(visible - missing.address),
    lat_lon: pct(visible - Math.max(missing.lat, missing.lon)),
    description: pct(visible - missing.description),
    tagline: pct(visible - missing.tagline),
  },
  missing_percent: {
    missing_category_percent: pct(missing.category_l1),
    missing_age_percent: pct(missing.age_best_from),
    missing_price_percent: pct(missing.price_summary),
    missing_date_percent: pct(missing.next_start_at),
    missing_end_date_percent: pct(missing.next_end_at),
    missing_image_percent: pct(missing.image_url),
    missing_geo_percent: pct(missing.lat),
    missing_description_percent: pct(missing.description),
  },
  anomalies: {
    duplicate_titles: dupeTitles.length,
    duplicate_title_plus_venue: dupeVenueTitle.length,
    broken_digest_links: brokenDigestLinks,
    weird_ages: weirdAges,
    weird_prices: weirdPrices,
    past_events_shown: pastEvents,
    is_free_but_price_set: mismatchedFree,
    no_category_but_has_tags: emptyCategoryButHasTags,
  },
  samples: {
    top_duplicate_titles: dupeTitles.slice(0, 5),
    duplicate_title_plus_venue: dupeVenueTitle.slice(0, 5),
  },
  distributions: {
    by_category: byCategory,
    age_coverage: byAge,
    status_breakdown: statusBreakdown,
  },
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`Total events in DB: ${total}`);
console.log(`Visible to users: ${visible}`);
console.log('Missing percent:', JSON.stringify(report.missing_percent, null, 2));
console.log('Anomalies:', JSON.stringify(report.anomalies, null, 2));
db.close();
