/**
 * GET /api/digests — lists the 15 programmatic curated digests (shelf view).
 *
 * Previously this route queried a `digests` table in events.db. That table is
 * now dropped; digests are computed dynamically from live events via
 * `lib/digests`. Response shape preserves `{ digests, categories }` for
 * backwards compat with components/DigestShelf.tsx.
 *
 * Now ALSO returns each digest's top events inline (key `events`) so the
 * client can compute filter overlap without hitting /api/digests/[slug] once
 * per tile. ~15 digests × ≤10 events ≈ 150 event rows — a ~120 KB response.
 */

import { NextRequest } from 'next/server';
import { runAllDigests, listShelfCategories } from '@/lib/digests';

export const dynamic = 'force-dynamic';

// Serialise enriched events for the client. enrich() adds `*Parsed`
// versions but keeps the raw string in `tags` / `categories`. The frontend
// does `(event.categories || []).map(...)` — and `'[]'` is truthy, so the
// fallback never kicks in and `.map()` crashes. Swap in the parsed arrays.
type EnrichedEventLike = {
  tags?: unknown; categories?: unknown; reviews?: unknown;
  tagsParsed?: unknown; categoriesParsed?: unknown; reviewsParsed?: unknown;
};
function serializeEvent(e: EnrichedEventLike): EnrichedEventLike {
  return {
    ...e,
    tags:       Array.isArray(e.tagsParsed)       ? e.tagsParsed       : [],
    categories: Array.isArray(e.categoriesParsed) ? e.categoriesParsed : [],
    reviews:    Array.isArray(e.reviewsParsed)    ? e.reviewsParsed    : [],
  };
}

export async function GET(_req: NextRequest) {
  try {
    const results = runAllDigests();
    const categories = listShelfCategories();

    // Build lookup: slug → events[] so categories/digests both carry them.
    // DigestShelf uses the flat `digests` array; we keep both for compat.
    const eventsBySlug: Record<string, unknown[]> = {};
    for (const r of results) {
      eventsBySlug[r.meta.slug] = (r.events as EnrichedEventLike[]).map(serializeEvent);
    }

    const withEvents = <T extends { slug: string }>(meta: T) => ({
      ...meta,
      events: eventsBySlug[meta.slug] ?? [],
    });

    return Response.json({
      digests: results.map((r) => withEvents(r.meta)),
      categories: categories.map((cat) => ({
        name: cat.name,
        digests: cat.digests.map(withEvents),
      })),
    });
  } catch (err) {
    console.error('Digests API error:', err);
    return Response.json({ error: 'Failed to compute digests' }, { status: 500 });
  }
}
