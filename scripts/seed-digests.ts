/**
 * Idempotent digest seeder — recreates the `digests` and `digest_events`
 * tables from the JSON seed so they survive every CSV re-import.
 *
 * Usage:
 *   npx tsx scripts/seed-digests.ts          # uses data/seeds/digests.json
 *
 * Design:
 * - CSV re-import drops the whole events.db. After it, this script:
 *   1. Creates digests + digest_events tables (IF NOT EXISTS).
 *   2. Walks each digest in the seed, INSERTs / REPLACEs it by slug.
 *   3. Resolves event links by (event_title + event_venue) rather than
 *      by raw event_id — event IDs can shift between CSV drops, but the
 *      title+venue pair stays stable.
 *   4. Reports how many digests/links were rebuilt + any unresolved links.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(__dirname, '..', 'data', 'events.db');
const SEED_PATH = path.join(__dirname, '..', 'data', 'seeds', 'digests.json');

interface DigestEventSeed {
  event_id: number;
  event_title: string;
  event_venue: string;
  curator_note: string | null;
  sort_order: number;
}

interface DigestSeed {
  id: number;
  slug: string;
  title: string;
  subtitle: string | null;
  cover_image: string | null;
  category_tag: string | null;
  curator_name: string | null;
  curator_avatar: string | null;
  curator_role: string | null;
  context_tags: string; // JSON string
  is_active: number;
  expires_at: string | null;
  category: string;
  events: string; // JSON string of DigestEventSeed[]
}

function main() {
  if (!fs.existsSync(SEED_PATH)) {
    console.error(`Seed file not found: ${SEED_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found: ${DB_PATH}. Run import-csv.ts first.`);
    process.exit(1);
  }

  const seeds: DigestSeed[] = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const db = new Database(DB_PATH);

  // Ensure schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      cover_image TEXT,
      category_tag TEXT,
      curator_name TEXT,
      curator_avatar TEXT,
      curator_role TEXT,
      context_tags TEXT DEFAULT '[]',
      is_active INTEGER DEFAULT 1,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      category TEXT DEFAULT 'General'
    );
    CREATE TABLE IF NOT EXISTS digest_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      digest_id INTEGER NOT NULL REFERENCES digests(id),
      event_id INTEGER NOT NULL REFERENCES events(id),
      curator_note TEXT,
      sort_order INTEGER DEFAULT 0
    );
  `);

  // Wipe — we want the seed to be authoritative each run
  db.prepare(`DELETE FROM digest_events`).run();
  db.prepare(`DELETE FROM digests`).run();

  const upsertDigest = db.prepare(`
    INSERT INTO digests (slug, title, subtitle, cover_image, category_tag,
      curator_name, curator_avatar, curator_role, context_tags, is_active, expires_at, category)
    VALUES (@slug, @title, @subtitle, @cover_image, @category_tag,
      @curator_name, @curator_avatar, @curator_role, @context_tags, @is_active, @expires_at, @category)
  `);

  const insertLink = db.prepare(`
    INSERT INTO digest_events (digest_id, event_id, curator_note, sort_order)
    VALUES (?, ?, ?, ?)
  `);

  // Resolve event_id by title+venue (robust to id renumbering)
  const resolveByTitleVenue = db.prepare(`
    SELECT id FROM events
    WHERE LOWER(TRIM(title)) = LOWER(TRIM(?))
      AND LOWER(TRIM(venue_name)) = LOWER(TRIM(?))
    LIMIT 1
  `);
  const resolveByTitle = db.prepare(`
    SELECT id FROM events
    WHERE LOWER(TRIM(title)) = LOWER(TRIM(?))
    LIMIT 1
  `);
  const resolveById = db.prepare(`SELECT id FROM events WHERE id = ?`);

  let digestsSeeded = 0;
  let linksSeeded = 0;
  const unresolved: Array<{ digest: string; event_title: string; event_venue: string }> = [];

  const tx = db.transaction(() => {
    for (const d of seeds) {
      upsertDigest.run({
        slug: d.slug,
        title: d.title,
        subtitle: d.subtitle,
        cover_image: d.cover_image,
        category_tag: d.category_tag,
        curator_name: d.curator_name,
        curator_avatar: d.curator_avatar,
        curator_role: d.curator_role,
        context_tags: d.context_tags,
        is_active: d.is_active ?? 1,
        expires_at: d.expires_at,
        category: d.category ?? 'General',
      });
      // Get the just-inserted digest id
      const digestId = (db.prepare(`SELECT id FROM digests WHERE slug = ?`).get(d.slug) as { id: number }).id;
      digestsSeeded++;

      const links: DigestEventSeed[] = JSON.parse(d.events || '[]');
      for (const link of links) {
        if (!link.event_id && !link.event_title) continue;
        // Try 3 strategies in order: id (stable between same-source drops),
        // then title+venue, then title-only as a last resort.
        let eventId: number | null = null;
        if (link.event_id) {
          const r = resolveById.get(link.event_id) as { id: number } | undefined;
          if (r) eventId = r.id;
        }
        if (!eventId && link.event_title && link.event_venue) {
          const r = resolveByTitleVenue.get(link.event_title, link.event_venue) as { id: number } | undefined;
          if (r) eventId = r.id;
        }
        if (!eventId && link.event_title) {
          const r = resolveByTitle.get(link.event_title) as { id: number } | undefined;
          if (r) eventId = r.id;
        }
        if (!eventId) {
          unresolved.push({
            digest: d.slug,
            event_title: link.event_title,
            event_venue: link.event_venue,
          });
          continue;
        }
        insertLink.run(digestId, eventId, link.curator_note, link.sort_order ?? 0);
        linksSeeded++;
      }
    }
  });
  tx();

  console.log(`=== Digest seed ===`);
  console.log(`  Digests seeded:  ${digestsSeeded}/${seeds.length}`);
  console.log(`  Event links:     ${linksSeeded}`);
  if (unresolved.length > 0) {
    console.log(`  UNRESOLVED links: ${unresolved.length}`);
    for (const u of unresolved.slice(0, 10)) {
      console.log(`    - ${u.digest}: "${u.event_title}" @ ${u.event_venue}`);
    }
    if (unresolved.length > 10) console.log(`    ... and ${unresolved.length - 10} more`);
  }
  db.close();
}

main();
