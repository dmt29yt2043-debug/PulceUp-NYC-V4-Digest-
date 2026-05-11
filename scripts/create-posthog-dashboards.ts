/**
 * Create PulseUp Analytics dashboards in PostHog via Management API.
 *
 * REQUIRES the personal API key to have these scopes:
 *   dashboard:write   insight:write
 * Add them at: https://us.posthog.com/settings/user-api-keys
 *
 * Run:
 *   PHX=phx_xxx npx tsx scripts/create-posthog-dashboards.ts
 *
 * Or add to .env.local:
 *   POSTHOG_PERSONAL_KEY=phx_xxx
 * then: npx tsx scripts/create-posthog-dashboards.ts
 */

import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env.local') });

const PHX  = process.env.PHX ?? process.env.POSTHOG_PERSONAL_KEY;
const PID  = process.env.POSTHOG_PROJECT_ID ?? '389973';
const HOST = 'https://us.posthog.com';

if (!PHX) {
  console.error('Set PHX=phx_xxx or POSTHOG_PERSONAL_KEY in .env.local');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${PHX}`,
  'Content-Type': 'application/json',
};

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

// ─── Dashboard definitions ─────────────────────────────────────────────────

const DASHBOARDS: Array<{
  name: string;
  description: string;
  insights: Array<{ name: string; filters: Record<string, unknown> }>;
}> = [
  {
    name: 'PulseUp — North Star Funnel',
    description: 'Session → Chat → Card → Buy conversion funnel. Updated automatically.',
    insights: [
      {
        name: 'Conversion funnel: session → chat → card → buy',
        filters: {
          insight: 'FUNNELS',
          date_from: '-30d',
          funnel_window_interval: 7,
          funnel_window_interval_unit: 'day',
          events: [
            { id: 'session_start',       name: 'session_start',       type: 'events', order: 0 },
            { id: 'chat_message_sent',   name: 'chat_message_sent',   type: 'events', order: 1 },
            { id: 'card_expanded',       name: 'card_expanded',       type: 'events', order: 2 },
            { id: 'buy_tickets_clicked', name: 'buy_tickets_clicked', type: 'events', order: 3 },
          ],
        },
      },
      {
        name: 'Direct funnel: session → card → buy (no chat)',
        filters: {
          insight: 'FUNNELS',
          date_from: '-30d',
          funnel_window_interval: 1,
          funnel_window_interval_unit: 'day',
          events: [
            { id: 'session_start',       name: 'session_start',       type: 'events', order: 0 },
            { id: 'card_expanded',       name: 'card_expanded',       type: 'events', order: 1 },
            { id: 'buy_tickets_clicked', name: 'buy_tickets_clicked', type: 'events', order: 2 },
          ],
        },
      },
    ],
  },
  {
    name: 'PulseUp — Traffic & Engagement',
    description: 'DAU, WAU, feed scroll depth, chat message volume.',
    insights: [
      {
        name: 'DAU (daily sessions)',
        filters: {
          insight: 'TRENDS',
          date_from: '-30d',
          interval: 'day',
          events: [{ id: 'session_start', name: 'session_start', type: 'events' }],
        },
      },
      {
        name: 'WAU (weekly sessions)',
        filters: {
          insight: 'TRENDS',
          date_from: '-8w',
          interval: 'week',
          events: [{ id: 'session_start', name: 'session_start', type: 'events' }],
        },
      },
      {
        name: 'Chat messages sent per day',
        filters: {
          insight: 'TRENDS',
          date_from: '-30d',
          interval: 'day',
          events: [{ id: 'chat_message_sent', name: 'chat_message_sent', type: 'events' }],
        },
      },
      {
        name: 'Feed scroll depth (% of users reaching 50 %+)',
        filters: {
          insight: 'TRENDS',
          date_from: '-30d',
          interval: 'day',
          events: [
            { id: 'feed_scroll', name: 'feed_scroll (25%)',  type: 'events', order: 0,
              properties: [{ key: 'depth_pct', operator: 'exact', value: [25], type: 'event' }] },
            { id: 'feed_scroll', name: 'feed_scroll (50%)',  type: 'events', order: 1,
              properties: [{ key: 'depth_pct', operator: 'exact', value: [50], type: 'event' }] },
            { id: 'feed_scroll', name: 'feed_scroll (75%)',  type: 'events', order: 2,
              properties: [{ key: 'depth_pct', operator: 'exact', value: [75], type: 'event' }] },
          ],
        },
      },
    ],
  },
  {
    name: 'PulseUp — Revenue & Conversion',
    description: 'Buy-ticket clicks by price tier, top clicked events, returning vs new.',
    insights: [
      {
        name: 'Buy clicks by price_bucket',
        filters: {
          insight: 'TRENDS',
          date_from: '-30d',
          interval: 'day',
          breakdown: 'price_bucket',
          breakdown_type: 'event',
          events: [{ id: 'buy_tickets_clicked', name: 'buy_tickets_clicked', type: 'events' }],
        },
      },
      {
        name: 'Buy clicks by source (feed / chat / digest)',
        filters: {
          insight: 'TRENDS',
          date_from: '-30d',
          interval: 'day',
          breakdown: 'source',
          breakdown_type: 'event',
          events: [{ id: 'buy_tickets_clicked', name: 'buy_tickets_clicked', type: 'events' }],
        },
      },
      {
        name: 'Card CTR: impressions vs expansions',
        filters: {
          insight: 'TRENDS',
          date_from: '-30d',
          interval: 'day',
          events: [
            { id: 'event_impression', name: 'Impressions', type: 'events' },
            { id: 'card_expanded',    name: 'Card clicks', type: 'events' },
          ],
        },
      },
      {
        name: 'Returning vs new users',
        filters: {
          insight: 'TRENDS',
          date_from: '-30d',
          interval: 'week',
          breakdown: 'is_returning',
          breakdown_type: 'event',
          events: [{ id: 'session_start', name: 'session_start', type: 'events' }],
        },
      },
    ],
  },
  {
    name: 'PulseUp — Retention',
    description: 'D1 / D7 / D14 retention: users who return to the site after first session.',
    insights: [
      {
        name: 'User retention (D1–D14)',
        filters: {
          insight: 'RETENTION',
          date_from: '-30d',
          retention_type: 'retention_first_time',
          target_entity: { id: 'session_start', name: 'session_start', type: 'events' },
          returning_entity: { id: 'session_start', name: 'session_start', type: 'events' },
          period: 'Day',
          total_intervals: 14,
        },
      },
      {
        name: 'Buyer retention: users who buy again',
        filters: {
          insight: 'RETENTION',
          date_from: '-60d',
          retention_type: 'retention_first_time',
          target_entity:    { id: 'buy_tickets_clicked', name: 'buy_tickets_clicked', type: 'events' },
          returning_entity: { id: 'buy_tickets_clicked', name: 'buy_tickets_clicked', type: 'events' },
          period: 'Day',
          total_intervals: 14,
        },
      },
    ],
  },
  {
    name: 'PulseUp — Chat Pipeline QA',
    description: 'Filter extraction latency, auto-broaden rate, empty-result rate.',
    insights: [
      {
        name: 'Filter extraction latency (P50/P95)',
        filters: {
          insight: 'TRENDS',
          date_from: '-30d',
          interval: 'day',
          math: 'p90',
          math_property: 'extraction_latency_ms',
          events: [{ id: 'chat_filters_extracted', name: 'chat_filters_extracted', type: 'events' }],
        },
      },
      {
        name: 'Auto-broaden rate (% of chat queries widened)',
        filters: {
          insight: 'TRENDS',
          date_from: '-30d',
          interval: 'day',
          events: [
            { id: 'chat_message_sent',    name: 'Queries sent',     type: 'events' },
            { id: 'auto_broadened',       name: 'Queries broadened', type: 'events' },
          ],
        },
      },
      {
        name: 'Chat response: events returned (avg)',
        filters: {
          insight: 'TRENDS',
          date_from: '-30d',
          interval: 'day',
          math: 'avg',
          math_property: 'events_count',
          events: [{ id: 'chat_response_received', name: 'chat_response_received', type: 'events' }],
        },
      },
    ],
  },
];

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🚀  Creating PulseUp dashboards in PostHog project ${PID}…\n`);

  for (const dash of DASHBOARDS) {
    console.log(`📊  Dashboard: "${dash.name}"`);

    // 1. Create dashboard
    const dashboard = await api<{ id: number; name: string }>(
      'POST',
      `/api/projects/${PID}/dashboards/`,
      { name: dash.name, description: dash.description },
    );
    console.log(`   ✅  Created dashboard ${dashboard.id}`);

    // 2. Create insights and attach to dashboard
    for (const ins of dash.insights) {
      try {
        const insight = await api<{ id: number; short_id: string }>(
          'POST',
          `/api/projects/${PID}/insights/`,
          {
            name: ins.name,
            filters: ins.filters,
            dashboards: [dashboard.id],
          },
        );
        console.log(`      ➕  Insight "${ins.name}" → ${insight.short_id}`);
      } catch (err) {
        console.warn(`      ⚠️   Failed "${ins.name}": ${err}`);
      }
    }

    console.log(`   🔗  https://us.posthog.com/project/${PID}/dashboard/${dashboard.id}\n`);
  }

  console.log('Done ✓');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
