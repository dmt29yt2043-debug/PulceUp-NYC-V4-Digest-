/**
 * PostHog traffic report — daily DAU / sessions / pageviews / top events.
 *
 * Uses HogQL via the /api/projects/{id}/query/ endpoint. Personal API Key
 * must have `query:read` scope.
 *
 * Run: npx tsx scripts/posthog-traffic.ts
 */

import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env.local') });

const PHX = process.env.POSTHOG_PERSONAL_KEY;
const PID = process.env.POSTHOG_PROJECT_ID ?? '389973';
const HOST = 'https://us.posthog.com';

if (!PHX) { console.error('Missing POSTHOG_PERSONAL_KEY in .env.local'); process.exit(1); }

async function hogql(sql: string): Promise<{ columns: string[]; results: unknown[][] }> {
  const res = await fetch(`${HOST}/api/projects/${PID}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PHX}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql } }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HogQL ${res.status}: ${t.slice(0, 500)}`);
  }
  const j = await res.json();
  return { columns: j.columns ?? [], results: j.results ?? [] };
}

function table(title: string, columns: string[], rows: unknown[][]): void {
  console.log(`━━━ ${title} ━━━`);
  if (rows.length === 0) { console.log('  (no data)\n'); return; }
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map(r => String(r[i] ?? '').length)));
  console.log('  ' + columns.map((c, i) => c.padEnd(widths[i])).join('  '));
  console.log('  ' + columns.map((_, i) => '─'.repeat(widths[i])).join('  '));
  for (const r of rows) {
    console.log('  ' + r.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  '));
  }
  console.log();
}

async function main() {
  // 1. Total events captured all-time
  const total = await hogql(`SELECT count() FROM events`);
  console.log(`Total events captured: ${total.results[0]?.[0] ?? 0}\n`);

  // 2. Daily traffic — last 14 days
  const daily = await hogql(`
    SELECT
      toDate(timestamp) AS day,
      count(DISTINCT distinct_id) AS unique_visitors,
      count(DISTINCT properties.$session_id) AS sessions,
      countIf(event = '$pageview') AS pageviews,
      count() AS all_events
    FROM events
    WHERE timestamp >= now() - INTERVAL 14 DAY
    GROUP BY day
    ORDER BY day DESC
  `);
  table('Daily traffic (last 14 days)',
    ['date', 'unique', 'sessions', 'pageviews', 'all events'],
    daily.results);

  // 3. Top 15 events by frequency
  const topEvents = await hogql(`
    SELECT event, count() AS n, count(DISTINCT distinct_id) AS unique_users
    FROM events
    WHERE timestamp >= now() - INTERVAL 14 DAY
    GROUP BY event ORDER BY n DESC LIMIT 20
  `);
  table('Top 20 event names (last 14 days)',
    ['event', 'count', 'unique users'],
    topEvents.results);

  // 4. Top referrers / source
  const referrers = await hogql(`
    SELECT
      coalesce(properties.$referring_domain, '(direct)') AS source,
      count(DISTINCT distinct_id) AS unique_users
    FROM events
    WHERE timestamp >= now() - INTERVAL 14 DAY AND event = '$pageview'
    GROUP BY source ORDER BY unique_users DESC LIMIT 10
  `);
  table('Top traffic sources (last 14 days)',
    ['referrer', 'unique users'],
    referrers.results);

  // 5. Devices
  const devices = await hogql(`
    SELECT
      coalesce(properties.$device_type, '(unknown)') AS device,
      count(DISTINCT distinct_id) AS unique_users
    FROM events
    WHERE timestamp >= now() - INTERVAL 14 DAY
    GROUP BY device ORDER BY unique_users DESC
  `);
  table('Devices (last 14 days)',
    ['device', 'unique users'],
    devices.results);

  // 6. Countries
  const countries = await hogql(`
    SELECT
      coalesce(properties.$geoip_country_name, '(unknown)') AS country,
      count(DISTINCT distinct_id) AS unique_users
    FROM events
    WHERE timestamp >= now() - INTERVAL 14 DAY
    GROUP BY country ORDER BY unique_users DESC LIMIT 10
  `);
  table('Top countries (last 14 days)',
    ['country', 'unique users'],
    countries.results);
}

main().catch((e) => { console.error(e); process.exit(1); });
