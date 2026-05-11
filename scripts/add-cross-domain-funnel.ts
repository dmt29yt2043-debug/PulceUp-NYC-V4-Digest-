/**
 * Add insight #6 to the existing Quiz Health dashboard:
 * the full cross-domain funnel from FB click → main-app engagement.
 *
 * This is the funnel the user actually cares about — it spans both
 * subdomains and is only meaningful because we have identity merging
 * (posthog.identify with quiz_phid passed in URL).
 */

import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env.local') });

const PHX = process.env.POSTHOG_PERSONAL_KEY;
const PID = '389973';
const HOST = 'https://us.posthog.com';
const DASHBOARD_ID = 1555710;

if (!PHX) { console.error('Missing POSTHOG_PERSONAL_KEY'); process.exit(1); }

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers: { Authorization: `Bearer ${PHX}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
  return JSON.parse(text) as T;
}

const QUIZ_HOST = [{ key: '$host', value: 'quiz.pulseup.me', operator: 'exact', type: 'event' }];
const MAIN_HOST = [{ key: '$host', value: 'pulseup.me',      operator: 'exact', type: 'event' }];

function eventsNode(event: string, name: string, properties: typeof QUIZ_HOST) {
  return { kind: 'EventsNode', event, name, math: 'total', properties };
}

const insight = {
  name: '6. CROSS-DOMAIN funnel: FB → quiz → main app',
  description:
    'The end-to-end funnel that actually matters: ' +
    'FB-paid visitor lands on quiz → starts → completes → arrives at pulseup.me → opens an event card. ' +
    'This works because we pass the quiz session\'s PostHog distinct_id in the redirect URL ' +
    'and call posthog.identify() on pulseup.me to merge profiles. ' +
    'A 1-person drop on the quiz_arrival step means the identity bridge is broken.',
  query: {
    kind: 'InsightVizNode',
    source: {
      kind: 'FunnelsQuery',
      dateRange: { date_from: '-14d' },
      series: [
        eventsNode('$pageview',           'Landed on quiz',       QUIZ_HOST),
        eventsNode('quiz_started',        'Started quiz',         QUIZ_HOST),
        eventsNode('quiz_completed',      'Completed quiz',       QUIZ_HOST),
        eventsNode('quiz_arrival',        'Arrived at main app',  MAIN_HOST),
        eventsNode('card_expanded',       'Opened event card',    MAIN_HOST),
      ],
      funnelsFilter: {
        funnelVizType: 'steps',
        funnelOrderType: 'ordered',
        // 24h window — most users who finish the quiz click through within minutes,
        // but allow a generous tail so visitors who hit pulseup.me later still count.
        funnelWindowInterval: 24,
        funnelWindowIntervalUnit: 'hour',
      },
    },
  },
};

async function main() {
  console.log('Adding cross-domain funnel insight to dashboard...');
  const created = await api<{ id: number; short_id: string }>(
    'POST',
    `/api/projects/${PID}/insights/`,
    {
      name: insight.name,
      description: insight.description,
      query: insight.query,
      dashboards: [DASHBOARD_ID],
    },
  );
  console.log(`✓ Insight #${created.id} added`);
  console.log(`\nDashboard: ${HOST}/project/${PID}/dashboard/${DASHBOARD_ID}`);
}
main().catch(e => { console.error(e); process.exit(1); });
