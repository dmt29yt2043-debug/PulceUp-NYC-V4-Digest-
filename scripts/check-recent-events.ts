import * as dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '.env.local') });

const PHX = process.env.POSTHOG_PERSONAL_KEY;
const PID = process.env.POSTHOG_PROJECT_ID ?? '389973';
const HOST = 'https://app.posthog.com';

async function hogql(sql: string) {
  const res = await fetch(`${HOST}/api/projects/${PID}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PHX}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql } }),
  });
  const j = await res.json();
  return { columns: j.columns ?? [], results: j.results ?? [] };
}

async function main() {
  const r = await hogql(`
    SELECT
      toDateTime(timestamp) AS ts,
      event,
      distinct_id,
      properties.$current_url,
      properties.$session_id
    FROM events
    WHERE timestamp >= now() - INTERVAL 30 MINUTE
    ORDER BY timestamp DESC
    LIMIT 150
  `);

  console.log('=== Events last 30 min ===');
  if (r.results.length === 0) {
    console.log('(none yet — PostHog may still be ingesting)');
  }
  for (const row of r.results) {
    console.log(
      String(row[0]).slice(11,19), '|',
      String(row[1]).padEnd(32), '|',
      String(row[2]).slice(0,14), '|',
      String(row[3]).slice(0,60)
    );
  }
  console.log('\nTotal:', r.results.length);

  // Top events today
  const today = await hogql(`
    SELECT event, count() AS n, count(DISTINCT distinct_id) AS users
    FROM events
    WHERE toDate(timestamp) = today()
    GROUP BY event ORDER BY n DESC LIMIT 20
  `);
  console.log('\n=== All events today ===');
  for (const row of today.results) {
    console.log(String(row[0]).padEnd(32), 'count:', row[1], ' users:', row[2]);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

// This line won't be used — will write a separate query
