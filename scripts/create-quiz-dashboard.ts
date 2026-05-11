/**
 * Create the "Quiz Health" dashboard in PostHog with 5 insights for
 * comparing FB ad spend vs what we actually capture.
 *
 * Run:  npx tsx scripts/create-quiz-dashboard.ts
 *
 * Personal API key needs scopes: dashboard:write, insight:write
 */

import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env.local') });

const PHX = process.env.POSTHOG_PERSONAL_KEY;
const PID = process.env.POSTHOG_PROJECT_ID ?? '389973';
const HOST = 'https://us.posthog.com';

if (!PHX) { console.error('Missing POSTHOG_PERSONAL_KEY'); process.exit(1); }

const headers = { Authorization: `Bearer ${PHX}`, 'Content-Type': 'application/json' };

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
  return JSON.parse(text) as T;
}

// Property filter — flat list as expected by the new PostHog query schema.
const QUIZ_HOST_PROP = [
  { key: '$host', value: 'quiz.pulseup.me', operator: 'exact', type: 'event' },
];

// Helper: build an EventsNode entry for the new TrendsQuery schema.
function eventsNode(event: string, opts: { math?: string; name?: string } = {}) {
  return {
    kind: 'EventsNode',
    event,
    name: opts.name ?? event,
    math: opts.math ?? 'total',
    properties: QUIZ_HOST_PROP,
  };
}

interface InsightDef {
  name: string;
  description: string;
  query: Record<string, unknown>;
}

const INSIGHTS: InsightDef[] = [
  // 1. Daily $pageview unique visitors — compare directly to FB Ads link clicks
  {
    name: '1. Daily visitors (compare with FB Ads link clicks)',
    description:
      'Daily unique visitors who fired $pageview on quiz.pulseup.me. ' +
      'This is your truth metric — compare numbers here to "Link Clicks" in Facebook Ads Manager for the same dates. ' +
      'Pre-fix this was 75% lower than FB. After multi-layer tracking it should be within 10-20%.',
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'TrendsQuery',
        dateRange: { date_from: '-14d' },
        interval: 'day',
        series: [eventsNode('$pageview', { math: 'dau', name: 'Visitors' })],
        trendsFilter: { display: 'ActionsLineGraph' },
      },
    },
  },

  // 2. Funnel: pageview → started → answered ≥1 → completed
  {
    name: '2. Quiz funnel: landed → started → answered → completed',
    description:
      'Where users drop. Big drop pageview → quiz_started = page issue (slow load, design). ' +
      'Big drop quiz_started → completed = quiz too long or boring. ' +
      'Pre-fix: only ~5% reached quiz_started. Watch this number recover.',
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'FunnelsQuery',
        dateRange: { date_from: '-14d' },
        series: [
          eventsNode('$pageview', { name: 'Landed' }),
          eventsNode('quiz_started', { name: 'Started' }),
          eventsNode('quiz_question_answered', { name: 'Answered ≥1' }),
          eventsNode('quiz_completed', { name: 'Completed' }),
        ],
        funnelsFilter: { funnelVizType: 'steps', funnelOrderType: 'ordered' },
      },
    },
  },

  // 3. UTM source breakdown
  {
    name: '3. Visitors by UTM source / campaign',
    description:
      'Daily $pageview broken down by utm_source. Should be dominated by "fb". ' +
      'Other sources = baseline of organic / direct unpaid traffic.',
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'TrendsQuery',
        dateRange: { date_from: '-14d' },
        interval: 'day',
        series: [eventsNode('$pageview', { math: 'dau', name: 'visitors' })],
        breakdownFilter: {
          breakdown_type: 'event',
          breakdown: 'utm_source',
        },
        trendsFilter: { display: 'ActionsAreaGraph' },
      },
    },
  },

  // 4. Bounce: pageview vs quiz_started side by side
  {
    name: '4. Bounce check — landed vs started',
    description:
      'How many landed vs how many started the quiz. The gap = bounces. ' +
      'Pre-fix it was 95% because most visitors left before any interaction. Watch the gap shrink.',
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'TrendsQuery',
        dateRange: { date_from: '-14d' },
        interval: 'day',
        series: [
          eventsNode('$pageview', { math: 'dau', name: 'Landed' }),
          eventsNode('quiz_started', { math: 'dau', name: 'Started' }),
        ],
        trendsFilter: { display: 'ActionsLineGraph' },
      },
    },
  },

  // 5. 7-day big number
  {
    name: '5. This week — total pageviews & completions',
    description:
      'Quick weekly health check. Total visitors and completions across last 7 days. ' +
      'Cross-check vs total FB ad spend / 7d.',
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'TrendsQuery',
        dateRange: { date_from: '-7d' },
        interval: 'day',
        series: [
          eventsNode('$pageview', { math: 'total', name: 'Pageviews' }),
          eventsNode('quiz_completed', { math: 'total', name: 'Completed' }),
        ],
        trendsFilter: { display: 'BoldNumber' },
      },
    },
  },
];

interface CreatedDashboard { id: number }
interface CreatedInsight { id: number; short_id: string }

async function main() {
  console.log('Creating Quiz Health dashboard...');

  const dash = await api<CreatedDashboard>('POST', `/api/projects/${PID}/dashboards/`, {
    name: 'Quiz Health — FB ad spend vs what we capture',
    description:
      'Side-by-side comparison of Facebook Ads Manager (paid clicks) and what PostHog actually sees on quiz.pulseup.me.\n\n' +
      'How to read: compare insight #1 with FB Ads Manager "Link Clicks" for the same date range. ' +
      'Gap should be <20% after the multi-layer tracking fix (was 75% before).\n\n' +
      `Generated: ${new Date().toISOString().slice(0, 10)}`,
    pinned: true,
  });
  console.log(`  Dashboard id=${dash.id}`);

  for (const def of INSIGHTS) {
    const insight = await api<CreatedInsight>('POST', `/api/projects/${PID}/insights/`, {
      name: def.name,
      description: def.description,
      query: def.query,
      dashboards: [dash.id],
    });
    console.log(`  ✓ ${def.name}  (id=${insight.id})`);
  }

  console.log(`\n✅ Done. Open here:`);
  console.log(`   ${HOST}/project/${PID}/dashboard/${dash.id}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
