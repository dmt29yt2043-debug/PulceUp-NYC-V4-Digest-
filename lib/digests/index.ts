/**
 * Digest orchestrator — the single entry point used by the API routes.
 *
 * All 5 digests are defined in code (no DB rows). Events come from the live
 * events pool and are scored on every request. With 207 live events × 5
 * scorers, this runs in < 50ms, so no caching is needed for now. A TTL cache
 * keyed on the events.db mtime can be added later if this shows up in traces.
 */

import Database from 'better-sqlite3';
import path from 'path';
import type { EventRow, DigestResult, DigestMeta } from './types';
import { LIVE_STATUS_FILTER } from './constants';
import { enrich } from './event-parser';
import { getWeekendDigest } from './weekend';
import { getIndoorDigest } from './indoor';
import { getEasyDigest } from './easy';
import { getAffordableDigest } from './affordable';
import { getWorthItDigest } from './worth-it';

const DB_PATH = path.join(process.cwd(), 'data', 'events.db');

function loadLiveEvents(): EventRow[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT * FROM events
      WHERE ${LIVE_STATUS_FILTER}
        AND disabled = 0 AND archived = 0
    `).all() as EventRow[];
    return rows;
  } finally {
    db.close();
  }
}

/**
 * Run all 5 digests. Events are enriched once and passed to each digest.
 * Order is fixed — reflects the product-desired order on the shelf:
 * Weekend → Indoor → Easy → Affordable → Worth-it.
 */
export function runAllDigests(): DigestResult[] {
  const rows = loadLiveEvents();
  const enriched = rows.map(enrich);
  const now = Date.now();

  const results = [
    getWeekendDigest(enriched, now),
    getIndoorDigest(enriched),
    getEasyDigest(enriched),
    getAffordableDigest(enriched),
    getWorthItDigest(enriched),
  ];

  // Post-process: ensure each digest uses a DIFFERENT cover image.
  // Left-to-right across the shelf: if a digest's top event has an image
  // already used by an earlier digest, pick the next top-scored event
  // whose image_url is unused. Falls back to the original if no alt found.
  diversifyCoverImages(results);

  return results;
}

/**
 * Walk through digests in order; each one claims a cover image. If the first
 * pick collides with a previously-claimed image, drop down the scored list
 * until we find a unique one. Mutates `meta.cover_image` on each digest.
 */
function diversifyCoverImages(results: DigestResult[]): void {
  const claimed = new Set<string>();
  for (const r of results) {
    const candidates = r.scored
      .map((s) => s.event.image_url)
      .filter((u): u is string => !!u);
    const pick = candidates.find((u) => !claimed.has(u)) ?? candidates[0] ?? null;
    r.meta.cover_image = pick;
    if (pick) claimed.add(pick);
  }
}

/**
 * Strip the server-only `scored` field from a digest result for API responses.
 * The API contract is:
 *   { ...meta, context_tags, category, ...bunch-of-display-fields }
 * matching what the legacy DigestShelf expects.
 */
export function toShelfDigest(result: DigestResult): DigestMeta {
  return result.meta;
}

/**
 * List digests as shelf entries (no events inline — events are fetched per
 * slug when the user clicks into one). Groups by `category` to match the
 * legacy API shape consumed by components/DigestShelf.tsx.
 */
export function listShelfCategories(): Array<{ name: string; digests: DigestMeta[] }> {
  const results = runAllDigests();
  const grouped = new Map<string, DigestMeta[]>();
  for (const r of results) {
    const cat = r.meta.category;
    const list = grouped.get(cat) ?? [];
    list.push(r.meta);
    grouped.set(cat, list);
  }
  return Array.from(grouped.entries()).map(([name, digests]) => ({ name, digests }));
}

/**
 * Return a digest by slug with its events. Used by /api/digests/[slug].
 * Returns null if the slug doesn't match any of our 5.
 */
export function getDigestBySlug(slug: string): { digest: DigestMeta; events: EventRow[] } | null {
  const all = runAllDigests();
  const found = all.find((r) => r.meta.slug === slug);
  if (!found) return null;
  return { digest: found.meta, events: found.events };
}

/** All 5 slugs — useful for validation / routing. */
export function allSlugs(): string[] {
  return ['weekend-kids-nyc', 'indoor-rainy-day', 'easy-no-planning', 'free-affordable', 'kids-love-parents-approve'];
}
