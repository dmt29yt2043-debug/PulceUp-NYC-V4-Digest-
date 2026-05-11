/**
 * Ad-flight cohort analysis — May 1, 2026 → today.
 *
 * Builds a per-user table from PostHog events, then computes funnel and
 * engagement distributions. Output is one big report meant to be read by
 * a human (and pasted into a PM doc).
 *
 * Run: npx tsx scripts/posthog-flight-analysis.ts
 */

import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env.local') });

const PHX  = process.env.POSTHOG_PERSONAL_KEY!;
const PID  = process.env.POSTHOG_PROJECT_ID ?? '389973';
const HOST = 'https://us.posthog.com';

const FLIGHT_START = '2026-05-01';

async function hogql(sql: string): Promise<unknown[][]> {
  const res = await fetch(`${HOST}/api/projects/${PID}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PHX}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql } }),
  });
  if (!res.ok) throw new Error(`HogQL ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const j = await res.json();
  return j.results ?? [];
}

function pct(n: number, d: number): string {
  if (d === 0) return ' n/a';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function header(title: string) {
  console.log('\n━━━ ' + title + ' ━━━');
}

async function main() {
  // ── Build a per-user dataset for the flight window ──────────────────────────
  // For each distinct_id we compute: visit days, pageview-equivalents
  // (session_start), cards opened, digests opened, buy clicks, chat sends, etc.
  const perUser = await hogql(`
    SELECT
      distinct_id,
      min(toDate(timestamp)) AS first_day,
      max(toDate(timestamp)) AS last_day,
      count(DISTINCT toDate(timestamp))   AS active_days,
      count(DISTINCT properties.$session_id) AS sessions,
      countIf(event = 'session_start')       AS session_starts,
      countIf(event = 'card_expanded')       AS cards_expanded,
      countIf(event = 'digest_selected')     AS digests_opened,
      countIf(event = 'buy_tickets_clicked') AS buys,
      countIf(event = 'filter_applied')      AS filters_applied,
      countIf(event = 'chat_message_sent')   AS chat_msgs,
      countIf(event = 'feed_scroll')         AS scrolls,
      countIf(event = 'map_opened')          AS map_opens,
      countIf(event = 'favorite_toggled')    AS favs,
      countIf(event = 'quiz_landing_loaded') AS quiz_landed,
      countIf(event = 'quiz_step_completed') AS quiz_completed,
      count() AS all_events
    FROM events
    WHERE timestamp >= toDate('${FLIGHT_START}')
    GROUP BY distinct_id
  `) as Array<[string, string, string, number, number, number, number, number, number, number, number, number, number, number, number, number, number]>;

  type U = {
    id: string; firstDay: string; lastDay: string; days: number; sessions: number;
    starts: number; cards: number; digests: number; buys: number; filters: number;
    chats: number; scrolls: number; maps: number; favs: number; quizLand: number;
    quizDone: number; events: number;
  };
  const users: U[] = perUser.map((r) => ({
    id: r[0], firstDay: r[1], lastDay: r[2], days: r[3],
    sessions: r[4], starts: r[5], cards: r[6], digests: r[7], buys: r[8],
    filters: r[9], chats: r[10], scrolls: r[11], maps: r[12], favs: r[13],
    quizLand: r[14], quizDone: r[15], events: r[16],
  }));

  // Filter out bot-y / internal traffic — anyone with 0 session_starts AND 0 cards
  // AND 0 filters AND 0 chats AND 0 quiz events is almost certainly a bot or
  // an empty $web_vitals-only ping. Keep them counted separately.
  const realUsers = users.filter(u =>
    u.starts > 0 || u.cards > 0 || u.filters > 0 || u.chats > 0 ||
    u.digests > 0 || u.quizLand > 0 || u.scrolls > 0
  );
  const ghostUsers = users.length - realUsers.length;

  const N = realUsers.length;

  // ── Top-line ────────────────────────────────────────────────────────────────
  header(`AD-FLIGHT WINDOW: ${FLIGHT_START} → today`);
  console.log(`Total distinct_ids seen:           ${users.length}`);
  console.log(`  · "ghosts" (only $web_vitals):   ${ghostUsers}  (likely bots / 1-ping bounces)`);
  console.log(`  · real visitors (any action):    ${N}`);
  console.log(`Total events in window:            ${users.reduce((s, u) => s + u.events, 0)}`);
  console.log(`Avg events / real visitor:         ${(realUsers.reduce((s,u)=>s+u.events,0)/Math.max(N,1)).toFixed(1)}`);

  // ── Conversion funnel ───────────────────────────────────────────────────────
  header('CONVERSION FUNNEL (real visitors as denominator)');
  const sawDigest    = realUsers.filter(u => u.digests > 0).length;
  const expandedCard = realUsers.filter(u => u.cards > 0).length;
  const usedFilter   = realUsers.filter(u => u.filters > 0).length;
  const openedMap    = realUsers.filter(u => u.maps > 0).length;
  const sentChat     = realUsers.filter(u => u.chats > 0).length;
  const favoured     = realUsers.filter(u => u.favs > 0).length;
  const clickedBuy   = realUsers.filter(u => u.buys > 0).length;

  const funnel: Array<[string, number]> = [
    ['Real visitors',           N],
    ['Used a filter',           usedFilter],
    ['Opened a digest',         sawDigest],
    ['Expanded a card',         expandedCard],
    ['Opened map',              openedMap],
    ['Sent a chat message',     sentChat],
    ['Favourited an event',     favoured],
    ['Clicked "Buy tickets"',   clickedBuy],
  ];
  for (const [label, n] of funnel) {
    const bar = '█'.repeat(Math.round((n / Math.max(N, 1)) * 40));
    console.log(`  ${label.padEnd(28)}${String(n).padStart(4)} / ${N}  ${pct(n, N).padStart(6)}  ${bar}`);
  }

  // ── KEY: % visitors who clicked Buy ─────────────────────────────────────────
  header('★ BUY-CLICK CONVERSION (asked-for metric)');
  console.log(`  ${clickedBuy} / ${N} real visitors = ${pct(clickedBuy, N)}`);
  console.log(`  ${clickedBuy} / ${users.length} all distinct_ids = ${pct(clickedBuy, users.length)}`);

  // ── Card-open distribution ──────────────────────────────────────────────────
  header('★ CARD OPEN DISTRIBUTION');
  const cards0 = realUsers.filter(u => u.cards === 0).length;
  const cards1 = realUsers.filter(u => u.cards === 1).length;
  const cards2 = realUsers.filter(u => u.cards === 2).length;
  const cards3p = realUsers.filter(u => u.cards >= 3).length;
  const cardsGT1 = realUsers.filter(u => u.cards > 1).length;
  const cardsGT2 = realUsers.filter(u => u.cards > 2).length;
  console.log(`  exactly 0 cards opened:   ${cards0} / ${N}  ${pct(cards0, N)}`);
  console.log(`  exactly 1 card  opened:   ${cards1} / ${N}  ${pct(cards1, N)}`);
  console.log(`  exactly 2 cards opened:   ${cards2} / ${N}  ${pct(cards2, N)}`);
  console.log(`  3+ cards         opened:   ${cards3p} / ${N}  ${pct(cards3p, N)}`);
  console.log('  ─────');
  console.log(`  >1 cards opened:           ${cardsGT1} / ${N}  ${pct(cardsGT1, N)}`);
  console.log(`  >2 cards opened:           ${cardsGT2} / ${N}  ${pct(cardsGT2, N)}`);

  const cardCounts = realUsers.map(u => u.cards).sort((a, b) => a - b);
  const median = cardCounts[Math.floor(cardCounts.length / 2)] ?? 0;
  const avg = cardCounts.reduce((s, n) => s + n, 0) / Math.max(cardCounts.length, 1);
  console.log(`  Avg cards / real visitor: ${avg.toFixed(2)}   median: ${median}   max: ${Math.max(...cardCounts)}`);

  // ── Digest open distribution ────────────────────────────────────────────────
  header('★ DIGEST OPEN DISTRIBUTION');
  const dig0 = realUsers.filter(u => u.digests === 0).length;
  const dig1 = realUsers.filter(u => u.digests === 1).length;
  const digGT1 = realUsers.filter(u => u.digests > 1).length;
  console.log(`  0 digests opened:           ${dig0} / ${N}  ${pct(dig0, N)}`);
  console.log(`  exactly 1 digest opened:    ${dig1} / ${N}  ${pct(dig1, N)}`);
  console.log(`  >1 digest opened:           ${digGT1} / ${N}  ${pct(digGT1, N)}`);
  console.log(`  Avg digests / real visitor: ${(realUsers.reduce((s,u)=>s+u.digests,0)/Math.max(N,1)).toFixed(2)}`);

  // ── Returning users ─────────────────────────────────────────────────────────
  header('★ RETURNING USERS');
  const returning = realUsers.filter(u => u.days > 1);
  const returning2 = realUsers.filter(u => u.days >= 2);
  const returning3 = realUsers.filter(u => u.days >= 3);
  console.log(`  Active 2+ days:  ${returning2.length} / ${N}  ${pct(returning2.length, N)}`);
  console.log(`  Active 3+ days:  ${returning3.length} / ${N}  ${pct(returning3.length, N)}`);
  console.log(`  Max active days for any user: ${Math.max(...realUsers.map(u => u.days), 0)}`);

  // ── Engagement depth ────────────────────────────────────────────────────────
  header('ENGAGEMENT DEPTH');
  const sessionsAvg = realUsers.reduce((s, u) => s + u.sessions, 0) / Math.max(N, 1);
  const eventsAvg   = realUsers.reduce((s, u) => s + u.events, 0) / Math.max(N, 1);
  const usedAnyTool = realUsers.filter(u => u.cards > 0 || u.digests > 0 || u.chats > 0 || u.maps > 0 || u.filters > 0).length;
  const usedTwoTools = realUsers.filter(u => {
    const t = [u.cards, u.digests, u.chats, u.maps, u.filters].filter(x => x > 0).length;
    return t >= 2;
  }).length;
  const oneAndDone = realUsers.filter(u => u.events <= 3 && u.cards === 0 && u.filters === 0 && u.digests === 0).length;

  console.log(`  Avg sessions / visitor:        ${sessionsAvg.toFixed(2)}`);
  console.log(`  Avg events / visitor:          ${eventsAvg.toFixed(1)}`);
  console.log(`  Used 1+ feature:               ${usedAnyTool} / ${N}  ${pct(usedAnyTool, N)}`);
  console.log(`  Used 2+ features:              ${usedTwoTools} / ${N}  ${pct(usedTwoTools, N)}`);
  console.log(`  "Bounced" (≤3 events, no act): ${oneAndDone} / ${N}  ${pct(oneAndDone, N)}`);

  // ── Filter usage ────────────────────────────────────────────────────────────
  header('FILTER USAGE (engagement signal)');
  const filt0 = realUsers.filter(u => u.filters === 0).length;
  const filt1to3 = realUsers.filter(u => u.filters >= 1 && u.filters <= 3).length;
  const filt4plus = realUsers.filter(u => u.filters >= 4).length;
  console.log(`  0 filter events:        ${filt0} / ${N}  ${pct(filt0, N)}`);
  console.log(`  1-3 filter events:      ${filt1to3} / ${N}  ${pct(filt1to3, N)}`);
  console.log(`  4+ filter events:       ${filt4plus} / ${N}  ${pct(filt4plus, N)} (signal: trying to find something specific)`);

  // ── Quiz funnel (very thin so far) ──────────────────────────────────────────
  header('QUIZ FUNNEL');
  console.log(`  quiz_landing_loaded:    ${realUsers.filter(u=>u.quizLand>0).length} / ${N}  ${pct(realUsers.filter(u=>u.quizLand>0).length, N)}`);
  console.log(`  quiz_step_completed:    ${realUsers.filter(u=>u.quizDone>0).length} / ${N}  ${pct(realUsers.filter(u=>u.quizDone>0).length, N)}`);

  // ── Day-by-day in flight ────────────────────────────────────────────────────
  const daily = await hogql(`
    SELECT toDate(timestamp) AS d,
           count(DISTINCT distinct_id) AS uniq,
           countIf(event='card_expanded') AS cards,
           countIf(event='digest_selected') AS digests,
           countIf(event='buy_tickets_clicked') AS buys
    FROM events
    WHERE timestamp >= toDate('${FLIGHT_START}')
    GROUP BY d ORDER BY d
  `) as Array<[string, number, number, number, number]>;
  header('DAY-BY-DAY (flight window)');
  console.log('  date         uniq  cards  digests  buys');
  for (const [d, u, c, dg, b] of daily) {
    console.log(`  ${d}   ${String(u).padStart(4)}  ${String(c).padStart(5)}  ${String(dg).padStart(7)}  ${String(b).padStart(4)}`);
  }

  // ── Sessions histogram (depth proxy) ────────────────────────────────────────
  header('SESSIONS PER VISITOR (depth proxy)');
  const sessHist = new Map<string, number>();
  for (const u of realUsers) {
    const k = u.sessions === 1 ? '1' : u.sessions === 2 ? '2' : u.sessions <= 5 ? '3-5' : '6+';
    sessHist.set(k, (sessHist.get(k) ?? 0) + 1);
  }
  for (const k of ['1', '2', '3-5', '6+']) {
    const n = sessHist.get(k) ?? 0;
    console.log(`  ${k.padEnd(4)}  ${String(n).padStart(3)} / ${N}  ${pct(n, N)}`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // EXTRA METRICS (added 2026-05-05) — TTFA, bounce-by-device, UTM, search-to-buy,
  // strict 3-step funnel. Each can be ZERO/empty until the new tracking lands —
  // see `lib/analytics.ts:trackSessionStart` for what got registered as
  // super-properties and `first_action` event for TTFA.
  // ════════════════════════════════════════════════════════════════════════════

  // ── Time-to-first-action ───────────────────────────────────────────────────
  // Two paths:
  //   1. PREFERRED — read the `first_action` event (with time_to_first_action_ms)
  //      that the new tracking emits client-side. Accurate even across long
  //      tab-idle periods.
  //   2. FALLBACK — reconstruct from event timestamps: for each user with a
  //      session_start in the window, find min timestamp of any subsequent
  //      non-passive event and subtract.
  header('TIME-TO-FIRST-ACTION');
  const ttfaDirect = await hogql(`
    SELECT properties.time_to_first_action_ms
    FROM events
    WHERE event = 'first_action' AND timestamp >= toDate('${FLIGHT_START}')
  `) as Array<[number | null]>;
  if (ttfaDirect.length > 0) {
    const arr = ttfaDirect.map(r => Number(r[0])).filter(n => Number.isFinite(n) && n >= 0).sort((a,b)=>a-b);
    const med = arr[Math.floor(arr.length / 2)];
    const p25 = arr[Math.floor(arr.length * 0.25)];
    const p75 = arr[Math.floor(arr.length * 0.75)];
    const avg = arr.reduce((s,n)=>s+n,0) / arr.length;
    console.log(`  Source: first_action events (n=${arr.length})`);
    console.log(`  median: ${(med/1000).toFixed(1)}s   p25: ${(p25/1000).toFixed(1)}s   p75: ${(p75/1000).toFixed(1)}s   avg: ${(avg/1000).toFixed(1)}s`);
  } else {
    console.log(`  Source: reconstructed from event timestamps (first_action not yet deployed)`);
    // Two simple queries, joined in JS — keeps HogQL straightforward.
    const sessRows = await hogql(`
      SELECT distinct_id, min(timestamp) AS t0
      FROM events
      WHERE event = 'session_start' AND timestamp >= toDate('${FLIGHT_START}')
      GROUP BY distinct_id
    `) as Array<[string, string]>;
    const firstRows = await hogql(`
      SELECT distinct_id, min(timestamp) AS t1
      FROM events
      WHERE timestamp >= toDate('${FLIGHT_START}')
        AND event NOT IN ('session_start','$web_vitals','$pageview','$pageleave','$identify','first_action')
      GROUP BY distinct_id
    `) as Array<[string, string]>;
    const t0Map = new Map<string, number>(sessRows.map(([id, t]) => [id, new Date(t).getTime()]));
    const arr: number[] = [];
    for (const [id, t1] of firstRows) {
      const t0 = t0Map.get(id);
      if (!t0) continue;
      const dt = new Date(t1).getTime() - t0;
      if (dt > 0 && Number.isFinite(dt)) arr.push(dt);
    }
    arr.sort((a, b) => a - b);
    if (arr.length === 0) {
      console.log('  (no data — no users with both session_start and a follow-up event)');
    } else {
      const med = arr[Math.floor(arr.length / 2)];
      const p25 = arr[Math.floor(arr.length * 0.25)];
      const p75 = arr[Math.floor(arr.length * 0.75)];
      const avg = arr.reduce((s,n)=>s+n,0) / arr.length;
      console.log(`  n=${arr.length}   median: ${(med/1000).toFixed(1)}s   p25: ${(p25/1000).toFixed(1)}s   p75: ${(p75/1000).toFixed(1)}s   avg: ${(avg/1000).toFixed(1)}s`);
    }
  }

  // ── Bounce rate by device ──────────────────────────────────────────────────
  // Bounce = distinct_id whose only events in the window are passive
  // (web_vitals / pageview / pageleave / identify). Anything else = engaged.
  header('BOUNCE RATE BY DEVICE');
  const bounceByDevice = await hogql(`
    WITH per_user AS (
      SELECT
        distinct_id,
        coalesce(any(properties.$device_type), '(unknown)') AS device,
        countIf(event NOT IN ('$web_vitals','$pageview','$pageleave','$identify')) AS interactive
      FROM events
      WHERE timestamp >= toDate('${FLIGHT_START}')
      GROUP BY distinct_id
    )
    SELECT
      device,
      count() AS visitors,
      countIf(interactive = 0) AS bounced,
      countIf(interactive > 0) AS engaged
    FROM per_user
    GROUP BY device ORDER BY visitors DESC
  `) as Array<[string, number, number, number]>;
  console.log('  device       visitors   bounced  engaged   bounce-rate');
  console.log('  ──────────   ────────   ───────  ───────   ───────────');
  for (const [device, visitors, bounced, engaged] of bounceByDevice) {
    const br = pct(Number(bounced), Number(visitors));
    console.log(`  ${(device ?? '(?)').padEnd(11)}  ${String(visitors).padStart(7)}   ${String(bounced).padStart(7)}  ${String(engaged).padStart(7)}   ${br.padStart(8)}`);
  }

  // ── UTM source / medium / campaign ─────────────────────────────────────────
  header('TRAFFIC SOURCE (UTM + referrer)');
  // Prefer super-properties on any event (registered by trackSessionStart). If
  // those are missing, fall back to properties.utm_source on session_start.
  const utm = await hogql(`
    SELECT
      coalesce(properties.utm_source,   '(none)') AS source,
      coalesce(properties.utm_medium,   '(none)') AS medium,
      coalesce(properties.utm_campaign, '(none)') AS campaign,
      count(DISTINCT distinct_id) AS users
    FROM events
    WHERE timestamp >= toDate('${FLIGHT_START}')
    GROUP BY source, medium, campaign ORDER BY users DESC LIMIT 12
  `) as Array<[string, string, string, number]>;
  console.log('  utm_source        utm_medium    utm_campaign         users');
  console.log('  ────────────────  ────────────  ───────────────────  ─────');
  for (const [s, m, c, u] of utm) {
    console.log(`  ${s.slice(0,16).padEnd(16)}  ${m.slice(0,12).padEnd(12)}  ${c.slice(0,19).padEnd(19)}  ${String(u).padStart(5)}`);
  }
  // Also inspect referrer field captured on session_start
  const refs = await hogql(`
    SELECT coalesce(properties.referrer, '(direct)') AS r, count(DISTINCT distinct_id) AS users
    FROM events
    WHERE event = 'session_start' AND timestamp >= toDate('${FLIGHT_START}')
    GROUP BY r ORDER BY users DESC LIMIT 8
  `) as Array<[string, number]>;
  console.log('\n  Referrer (from session_start):');
  for (const [r, u] of refs) {
    console.log(`    ${(r || '(empty)').slice(0,50).padEnd(50)}  ${String(u).padStart(4)}`);
  }

  // ── Search-to-buy ratio ─────────────────────────────────────────────────────
  header('SEARCH-TO-BUY RATIO');
  const totalCards = realUsers.reduce((s, u) => s + u.cards, 0);
  const totalBuys  = realUsers.reduce((s, u) => s + u.buys, 0);
  console.log(`  Aggregate (real-users): ${totalCards} cards expanded / ${totalBuys} buys`);
  if (totalCards > 0) {
    console.log(`     → 1 buy per ${(totalCards / Math.max(totalBuys, 1)).toFixed(1)} cards`);
    console.log(`     → ${pct(totalBuys, totalCards)} cards-to-buys conversion`);
  }
  const buyersOnly = realUsers.filter(u => u.buys > 0);
  if (buyersOnly.length > 0) {
    const cardsPerBuyer = buyersOnly.reduce((s, u) => s + u.cards, 0) / buyersOnly.length;
    const buysPerBuyer  = buyersOnly.reduce((s, u) => s + u.buys, 0) / buyersOnly.length;
    console.log(`  Per buyer: ${cardsPerBuyer.toFixed(1)} cards / ${buysPerBuyer.toFixed(1)} buys (n=${buyersOnly.length})`);
  } else {
    console.log(`  Per buyer: n/a (no buyers in window)`);
  }

  // ── Strict 3-step funnel: filter → card → buy ──────────────────────────────
  header('FUNNEL: filter_applied → card_expanded → buy_tickets_clicked');
  // We compute it on real users (drops 96% bot/ghost traffic). Each step is
  // counted as "user has at least one such event AT ANY TIME in the window"
  // — not strict ordering. This matches how `card_expanded` post-dates several
  // filter events in our actual sessions.
  const stepFilter = realUsers.filter(u => u.filters > 0).length;
  const stepCard   = realUsers.filter(u => u.filters > 0 && u.cards > 0).length;
  const stepBuy    = realUsers.filter(u => u.filters > 0 && u.cards > 0 && u.buys > 0).length;
  console.log(`  Stage              users   % from prev   % from start`);
  console.log(`  ────────────────   ─────   ───────────   ────────────`);
  console.log(`  Real visitors      ${String(N).padStart(5)}   ${'—'.padStart(11)}   ${'100.0%'.padStart(12)}`);
  console.log(`  filter_applied     ${String(stepFilter).padStart(5)}   ${pct(stepFilter, N).padStart(11)}   ${pct(stepFilter, N).padStart(12)}`);
  console.log(`  + card_expanded    ${String(stepCard).padStart(5)}   ${pct(stepCard, stepFilter).padStart(11)}   ${pct(stepCard, N).padStart(12)}`);
  console.log(`  + buy_tickets      ${String(stepBuy).padStart(5)}   ${pct(stepBuy, stepCard).padStart(11)}   ${pct(stepBuy, N).padStart(12)}`);

  // Also run an "ordered" version: events must appear in the correct sequence
  // in time. This is a stricter / truer funnel.
  const ordered = await hogql(`
    SELECT
      countIf(min_filter_t IS NOT NULL) AS f,
      countIf(min_filter_t IS NOT NULL AND min_card_t > min_filter_t) AS f_then_c,
      countIf(min_filter_t IS NOT NULL AND min_card_t > min_filter_t AND min_buy_t > min_card_t) AS f_then_c_then_b
    FROM (
      SELECT
        distinct_id,
        minIf(timestamp, event = 'filter_applied')      AS min_filter_t,
        minIf(timestamp, event = 'card_expanded')       AS min_card_t,
        minIf(timestamp, event = 'buy_tickets_clicked') AS min_buy_t
      FROM events
      WHERE timestamp >= toDate('${FLIGHT_START}')
      GROUP BY distinct_id
    )
  `) as Array<[number, number, number]>;
  if (ordered[0]) {
    const [f, fc, fcb] = ordered[0];
    console.log('\n  Ordered (events must happen in sequence):');
    console.log(`  filter → card           ${fc} / ${f}  ${pct(Number(fc), Number(f))}`);
    console.log(`  filter → card → buy     ${fcb} / ${f}  ${pct(Number(fcb), Number(f))}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
