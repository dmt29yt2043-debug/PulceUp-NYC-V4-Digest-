/**
 * import-supplements.ts
 *
 * Merges data/supplemental-events.json into the events DB.
 * Run AFTER import-csv.ts so supplemental rows survive CSV re-imports.
 *
 * Usage:
 *   npx tsx scripts/import-supplements.ts
 *
 * IDs must be >= 90000 to avoid collisions with CSV events.
 * Run from project root.
 *
 * To add new events: edit data/supplemental-events.json.
 * Fields that map directly to the events table columns; _note is ignored.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'events.db');
const SRC_PATH = path.join(process.cwd(), 'data', 'supplemental-events.json');

interface SupplementalEvent {
  _note?: string;
  id: number;
  title: string;
  short_title?: string;
  tagline?: string;
  description?: string;
  venue_name?: string;
  address?: string;
  city?: string;
  city_district?: string;
  city_locality?: string;
  country_county?: string;
  lat?: number;
  lon?: number;
  is_free: boolean;
  price_min?: number;
  price_max?: number;
  price_summary?: string;
  category_l1?: string;
  categories?: string[];
  tags?: string[];
  age_min?: number;
  age_best_from?: number;
  age_best_to?: number;
  age_label?: string;
  format?: string;
  motivation?: string;
  source_url?: string;
  image_url?: string;
  next_start_at?: string;
  next_end_at?: string;
  status?: string;
  disabled?: boolean;
  archived?: boolean;
}

function main() {
  if (!fs.existsSync(SRC_PATH)) {
    console.error(`Not found: ${SRC_PATH}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(SRC_PATH, 'utf-8');
  const events: SupplementalEvent[] = JSON.parse(raw);

  const db = new Database(DB_PATH);

  const upsert = db.prepare(`
    INSERT INTO events (
      id, title, short_title, tagline, description,
      venue_name, address, city, city_district, city_locality, country_county,
      lat, lon,
      is_free, price_min, price_max, price_summary,
      category_l1, categories, tags,
      age_min, age_best_from, age_best_to, age_label,
      format, motivation, source_url, image_url,
      next_start_at, next_end_at,
      status, disabled, archived,
      schedule, occurrences, class_meta, reviews, derisk, data
    ) VALUES (
      @id, @title, @short_title, @tagline, @description,
      @venue_name, @address, @city, @city_district, @city_locality, @country_county,
      @lat, @lon,
      @is_free, @price_min, @price_max, @price_summary,
      @category_l1, @categories, @tags,
      @age_min, @age_best_from, @age_best_to, @age_label,
      @format, @motivation, @source_url, @image_url,
      @next_start_at, @next_end_at,
      @status, @disabled, @archived,
      '{}', '[]', '{}', '[]', '{}', '{}'
    )
    ON CONFLICT(id) DO UPDATE SET
      title        = excluded.title,
      short_title  = excluded.short_title,
      tagline      = excluded.tagline,
      description  = excluded.description,
      venue_name   = excluded.venue_name,
      address      = excluded.address,
      city         = excluded.city,
      city_district = excluded.city_district,
      city_locality = excluded.city_locality,
      country_county = excluded.country_county,
      lat          = excluded.lat,
      lon          = excluded.lon,
      is_free      = excluded.is_free,
      price_min    = excluded.price_min,
      price_max    = excluded.price_max,
      category_l1  = excluded.category_l1,
      categories   = excluded.categories,
      tags         = excluded.tags,
      age_min      = excluded.age_min,
      age_best_from = excluded.age_best_from,
      age_best_to  = excluded.age_best_to,
      age_label    = excluded.age_label,
      format       = excluded.format,
      source_url   = excluded.source_url,
      image_url    = excluded.image_url,
      status       = excluded.status,
      disabled     = excluded.disabled,
      archived     = excluded.archived
  `);

  let inserted = 0;
  let updated  = 0;

  const run = db.transaction(() => {
    for (const ev of events) {
      if (ev.id < 90000) {
        console.warn(`  ⚠️  id=${ev.id} is below 90000 — skipping to avoid collision with CSV events`);
        continue;
      }
      const before = db.prepare('SELECT id FROM events WHERE id = ?').get(ev.id);
      upsert.run({
        id:             ev.id,
        title:          ev.title,
        short_title:    ev.short_title  ?? '',
        tagline:        ev.tagline      ?? '',
        description:    ev.description  ?? '',
        venue_name:     ev.venue_name   ?? '',
        address:        ev.address      ?? '',
        city:           ev.city         ?? '',
        city_district:  ev.city_district  ?? '',
        city_locality:  ev.city_locality  ?? '',
        country_county: ev.country_county ?? '',
        lat:            ev.lat          ?? null,
        lon:            ev.lon          ?? null,
        is_free:        ev.is_free ? 1 : 0,
        price_min:      ev.price_min    ?? 0,
        price_max:      ev.price_max    ?? 0,
        price_summary:  ev.price_summary ?? '',
        category_l1:    ev.category_l1  ?? '',
        categories:     JSON.stringify(ev.categories ?? []),
        tags:           JSON.stringify(ev.tags ?? []),
        age_min:        ev.age_min      ?? null,
        age_best_from:  ev.age_best_from ?? null,
        age_best_to:    ev.age_best_to  ?? null,
        age_label:      ev.age_label    ?? '',
        format:         ev.format       ?? '',
        motivation:     ev.motivation   ?? '',
        source_url:     ev.source_url   ?? '',
        image_url:      ev.image_url    ?? '',
        next_start_at:  ev.next_start_at ?? null,
        next_end_at:    ev.next_end_at  ?? null,
        status:         ev.status       ?? 'published',
        disabled:       ev.disabled     ? 1 : 0,
        archived:       ev.archived     ? 1 : 0,
      });
      if (before) updated++; else inserted++;
    }
  });

  run();
  db.close();

  console.log(`Supplemental import done: ${inserted} inserted, ${updated} updated`);
  console.log(`Source: ${SRC_PATH}`);
}

main();
