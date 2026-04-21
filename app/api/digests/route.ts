/**
 * GET /api/digests — lists the 5 programmatic curated digests (shelf view).
 *
 * Previously this route queried a `digests` table in events.db. That table is
 * now dropped; digests are computed dynamically from live events via
 * `lib/digests`. Response shape preserves `{ digests, categories }` for
 * backwards compat with components/DigestShelf.tsx.
 */

import { NextRequest } from 'next/server';
import { runAllDigests, listShelfCategories } from '@/lib/digests';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  try {
    const results = runAllDigests();
    const categories = listShelfCategories();
    return Response.json({
      digests: results.map((r) => r.meta),
      categories,
    });
  } catch (err) {
    console.error('Digests API error:', err);
    return Response.json({ error: 'Failed to compute digests' }, { status: 500 });
  }
}
