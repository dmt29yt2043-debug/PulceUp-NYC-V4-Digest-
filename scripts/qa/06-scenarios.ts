/**
 * 06 · End-to-end scenarios — 20 NYC-mom personas exercised over the full
 * stack (filter API + chat API). Each scenario has a success criterion
 * expressed as a predicate, so we can PASS/FAIL without a judge.
 *
 * Unlike the chat audit, the focus here is "does the user GET WHAT THEY
 * WANT in the first screen?" — i.e., does top-10 contain at least one
 * event that clearly satisfies the intent?
 */

import fs from 'fs';
import path from 'path';
import { getEvents } from '../../lib/db';
import type { Event as ApiEvent } from '../../lib/types';
import { loadLiveEvents, ageFits, inBorough, looseCat, looksIndoor, looksOutdoor, looksAffordable, isUpcomingWeekend, CHAT_URL, fmtEv, type Ev } from './_lib';

const OUT = path.join(process.cwd(), 'reports', 'qa', '06-scenarios.json');

const toEv = (e: ApiEvent): Ev => e as unknown as Ev;

interface Scenario {
  id: string;
  story: string;
  // The FilterState we expect to be applied (either by UI or chat)
  filters: Parameters<typeof getEvents>[0];
  // Predicate: at least one top-10 event must satisfy this
  wants: (e: Ev) => boolean;
  // Optional chat query to ALSO exercise through /api/chat
  chatQuery?: string;
}

const SCENARIOS: Scenario[] = [
  { id: 'S01', story: 'Mom of 4yo browses free plans', filters: { ageMax: 4, isFree: true }, wants: (e) => ageFits(e, 4) && e.is_free },
  { id: 'S02', story: 'Toddler (2) indoor morning', filters: { ageMax: 2 }, wants: (e) => ageFits(e, 2) && looksIndoor(e) },
  { id: 'S03', story: 'Weekend plans for 5yo',        filters: { ageMax: 5 }, wants: (e) => ageFits(e, 5) && isUpcomingWeekend(e) },
  { id: 'S04', story: 'Rainy day with 7yo',           filters: { ageMax: 7 }, wants: (e) => ageFits(e, 7) && looksIndoor(e) && !looksOutdoor(e) },
  { id: 'S05', story: 'Brooklyn-only family',         filters: { neighborhoods: ['Brooklyn'] }, wants: (e) => inBorough(e, 'Brooklyn') },
  { id: 'S06', story: 'Manhattan mom under $25',      filters: { neighborhoods: ['Manhattan'], priceMax: 25 }, wants: (e) => inBorough(e, 'Manhattan') && looksAffordable(e) },
  { id: 'S07', story: 'Science for 8yo',              filters: { ageMax: 8, categories: ['science'] }, wants: (e) => ageFits(e, 8) && looseCat(e, 'science') },
  { id: 'S08', story: 'Arts class for 6yo',           filters: { ageMax: 6, categories: ['arts'] }, wants: (e) => ageFits(e, 6) && looseCat(e, 'arts') },
  { id: 'S09', story: 'Outdoor Saturday',             filters: { categories: ['outdoors'] }, wants: (e) => looseCat(e, 'outdoors') },
  { id: 'S10', story: 'Music for 5yo',                filters: { ageMax: 5, categories: ['music'] }, wants: (e) => ageFits(e, 5) && looseCat(e, 'music') },
  { id: 'S11', story: 'Theater for 10yo',             filters: { ageMax: 10, categories: ['theater'] }, wants: (e) => ageFits(e, 10) && looseCat(e, 'theater') },
  { id: 'S12', story: 'Storytime for 3yo',            filters: { ageMax: 3, categories: ['books'] }, wants: (e) => ageFits(e, 3) && looseCat(e, 'books') },
  { id: 'S13', story: 'Free & 4yo & Brooklyn',        filters: { ageMax: 4, isFree: true, neighborhoods: ['Brooklyn'] }, wants: (e) => ageFits(e, 4) && e.is_free && inBorough(e, 'Brooklyn') },
  { id: 'S14', story: '2 kids ages 4 and 10',         filters: { childAges: [4, 10] }, wants: (e) => ageFits(e, 4) || ageFits(e, 10) },
  { id: 'S15', story: 'Teen (14) Brooklyn',           filters: { ageMax: 14, neighborhoods: ['Brooklyn'] }, wants: (e) => ageFits(e, 14) && inBorough(e, 'Brooklyn') },
  { id: 'S16', story: 'Food/cooking for 6yo',         filters: { ageMax: 6, categories: ['food'] }, wants: (e) => ageFits(e, 6) && looseCat(e, 'food') },
  { id: 'S17', story: 'Sports for 8yo',               filters: { ageMax: 8, categories: ['sports'] }, wants: (e) => ageFits(e, 8) && looseCat(e, 'sports') },
  { id: 'S18', story: 'Bronx for kids',               filters: { neighborhoods: ['Bronx'] }, wants: (e) => inBorough(e, 'Bronx') },
  { id: 'S19', story: 'Queens for kids',              filters: { neighborhoods: ['Queens'] }, wants: (e) => inBorough(e, 'Queens') },
  { id: 'S20', story: 'Chat: "indoor for 5yo"',       filters: { ageMax: 5 }, wants: (e) => ageFits(e, 5) && looksIndoor(e), chatQuery: 'indoor activity for 5 year old' },
];

interface Row {
  id: string;
  story: string;
  filter_path: {
    returned_total: number;
    gold_count: number;
    top10_hits: number;   // how many of top-10 satisfy wants()
    any_hit_top10: boolean;
    any_hit_any: boolean;
    top10_titles: string[];
  };
  chat_path?: {
    returned_total: number;
    any_hit: boolean;
    reply: string;
  } | null;
  verdict: 'PASS' | 'WARN' | 'FAIL';
}

async function chatCall(q: string): Promise<{ events: Array<{ id: number; title: string }>; message: string } | null> {
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: q }) });
    if (!res.ok) return null;
    return (await res.json()) as { events: Array<{ id: number; title: string }>; message: string };
  } catch { return null; }
}

async function main() {
  console.log('\n════ SCENARIOS (filter path + chat path) ════');
  const pool = loadLiveEvents();
  const rows: Row[] = [];

  for (const sc of SCENARIOS) {
    const { events, total } = getEvents({ ...sc.filters, page: 1, page_size: 500 });
    const returned = events.map(toEv);
    const gold = pool.filter(sc.wants);
    const top10 = returned.slice(0, 10);
    const hitsTop10 = top10.filter(sc.wants).length;
    const anyHitTop10 = hitsTop10 > 0;
    const anyHitAny = returned.some(sc.wants);

    let chatPath: Row['chat_path'] = null;
    if (sc.chatQuery) {
      const cr = await chatCall(sc.chatQuery);
      if (cr) {
        const chatEvs = (cr.events ?? []).map((x) => pool.find((p) => p.id === x.id)).filter(Boolean) as Ev[];
        const anyHit = chatEvs.some(sc.wants);
        chatPath = { returned_total: cr.events?.length ?? 0, any_hit: anyHit, reply: (cr.message ?? '').slice(0, 150) };
      }
    }

    const verdict: Row['verdict'] =
      gold.length === 0 ? 'WARN' :
      !anyHitAny ? 'FAIL' :
      !anyHitTop10 ? 'WARN' :
      'PASS';

    rows.push({
      id: sc.id,
      story: sc.story,
      filter_path: {
        returned_total: total,
        gold_count: gold.length,
        top10_hits: hitsTop10,
        any_hit_top10: anyHitTop10,
        any_hit_any: anyHitAny,
        top10_titles: top10.map((e) => `${e.title}`.slice(0, 50)),
      },
      chat_path: chatPath,
      verdict,
    });

    const icon = verdict === 'PASS' ? '✓' : verdict === 'WARN' ? '!' : '✗';
    const chatTag = chatPath ? ` · chat: ${chatPath.any_hit ? '✓' : '✗'}` : '';
    console.log(`  ${sc.id} ${icon} ${verdict.padEnd(5)} top10-hits=${hitsTop10}/${top10.length} gold=${gold.length}  ${sc.story}${chatTag}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ scenarios: rows }, null, 2));
  const pass = rows.filter((r) => r.verdict === 'PASS').length;
  const warn = rows.filter((r) => r.verdict === 'WARN').length;
  const fail = rows.filter((r) => r.verdict === 'FAIL').length;
  console.log(`\nSummary: ${pass} PASS · ${warn} WARN · ${fail} FAIL  (of ${rows.length})`);
  console.log(`Report → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
