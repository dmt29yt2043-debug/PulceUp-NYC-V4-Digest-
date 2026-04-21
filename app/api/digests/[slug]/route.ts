/**
 * GET /api/digests/[slug] — returns a digest's metadata + its events.
 *
 * Computes the digest on demand from live events (no DB table). Response
 * shape matches the legacy version so existing UI code keeps working.
 */

import { NextRequest } from 'next/server';
import { getDigestBySlug } from '@/lib/digests';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await params;
    const result = getDigestBySlug(slug);
    if (!result) {
      return Response.json({ error: 'Digest not found' }, { status: 404 });
    }
    // Legacy shape: `digest` (meta) + `events` array. The events are plain
    // EventRow objects — `curator_note` / `sort_order` used to come from the
    // digest_events table; those are dropped. Clients display `reasons` via
    // the audit script; the UI doesn't currently render them.
    return Response.json({ digest: result.digest, events: result.events });
  } catch (err) {
    console.error('Digest detail API error:', err);
    return Response.json({ error: 'Failed to fetch digest' }, { status: 500 });
  }
}
