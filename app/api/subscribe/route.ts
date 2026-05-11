/**
 * POST /api/subscribe — add/refresh an email subscriber.
 *
 * Body: { email, profile, source?, referrer_url? }
 *   - email: string (validated)
 *   - profile: { children, neighborhoods, budget, specialNeeds? }
 *   - source: where the ask was shown (defaults to 'chat_onboarding')
 *
 * Response:
 *   { ok: true, created: boolean, id: number }
 *   { ok: false, error: string }
 *
 * NOTE: Welcome email is intentionally NOT sent yet. When Resend is wired up
 * later, a worker will read subscribers.json and send to rows where
 * welcome_sent_at is null.
 *
 * GET /api/subscribe — list subscribers. Gated by SUBSCRIBERS_ADMIN_TOKEN
 * (Bearer header) so the admin page can fetch. If the env var is unset we
 * refuse — never expose emails publicly.
 */

import { NextRequest } from 'next/server';
import {
  upsertSubscriber,
  listSubscribers,
  isValidEmail,
  type SubscriberProfile,
  type Subscriber,
} from '@/lib/subscribers';

export const dynamic = 'force-dynamic';

interface SubscribeBody {
  email?: string;
  profile?: Partial<SubscriberProfile>;
  source?: Subscriber['source'];
  referrer_url?: string;
}

function sanitizeProfile(p: Partial<SubscriberProfile> | undefined): SubscriberProfile {
  return {
    children: Array.isArray(p?.children) ? p!.children : [],
    neighborhoods: Array.isArray(p?.neighborhoods) ? p!.neighborhoods : [],
    budget: typeof p?.budget === 'string' ? p!.budget : 'Any budget',
    specialNeeds: typeof p?.specialNeeds === 'string' ? p!.specialNeeds : undefined,
  };
}

export async function POST(req: NextRequest) {
  let body: SubscribeBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const email = (body.email || '').trim();
  if (!email || !isValidEmail(email)) {
    return Response.json({ ok: false, error: 'Invalid email' }, { status: 400 });
  }

  const source: Subscriber['source'] =
    body.source === 'quiz_onboarding' ||
    body.source === 'favorites_panel' ||
    body.source === 'other'
      ? body.source
      : 'chat_onboarding';

  try {
    const { subscriber, created } = upsertSubscriber({
      email,
      source,
      profile: sanitizeProfile(body.profile),
      referrer_url: body.referrer_url,
    });
    return Response.json({ ok: true, created, id: subscriber.id });
  } catch (err) {
    console.error('[/api/subscribe] write failed:', err);
    return Response.json({ ok: false, error: 'Write failed' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const adminToken = process.env.SUBSCRIBERS_ADMIN_TOKEN;
  if (!adminToken) {
    // Refuse to list without a configured token — this protects emails from
    // an accidental deploy where the token env var is missing.
    return Response.json({ ok: false, error: 'Admin token not configured' }, { status: 503 });
  }
  const auth = req.headers.get('authorization') || '';
  const provided = auth.replace(/^Bearer\s+/i, '').trim();
  if (!provided || provided !== adminToken) {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const subs = listSubscribers();
  return Response.json({ ok: true, total: subs.length, subscribers: subs });
}
