/**
 * 09 · DB vs Output Gap Audit — Block 3 of the Full System Validation.
 *
 * THE CORE QUESTION:
 *   "If an event exists in the DB — do we show it to the user?"
 *
 * Method (per query):
 *   1. Run the query through the product path (filter API + chat API).
 *   2. Independently search the DB for events that "obviously fit" the intent —
 *      using a loose LLM-guided search on all live events (no filters applied).
 *   3. Compare: strong candidates in DB vs strong candidates actually shown.
 *   4. A "gap" is an event the LLM rated ≥4/5 that appears in the DB but NOT
 *      in the top-20 the product returned.
 *
 * Two diagnostic outputs:
 *   · filter-gap: user applied filters X, DB has N strong matches, we showed M
 *   · chat-gap:   user typed natural query Q, same comparison
 *
 * A system with zero gaps is "trustworthy" — whatever is in the DB surfaces
 * when the user asks.  Persistent gaps mean the pipeline (SQL / chat LLM /
 * ranking) is losing relevance.
 *
 * Output: reports/qa/09-db-gap-audit.json
 */

import fs from 'fs';
import path from 'path';
import { getEvents } from '../../lib/db';
import { loadLiveEvents, judge, withRetry, CHAT_URL, sleep, type Ev } from './_lib';

// Throttle between chat API calls — prod rate-limits at ~1 req/sec sustained.
const CHAT_THROTTLE_MS = 3500;
import type { Event as ApiEvent, FilterState } from '../../lib/types';

const OUT = path.join(process.cwd(), 'reports', 'qa', '09-db-gap-audit.json');

// ── Gap probes: one intent = one row in the final report ─────────────────────
interface Probe {
  id: string;
  intent: string;            // plain-English intent
  filters: FilterState;      // product path A: direct filter query
  chatQuery?: string;        // product path B: natural-language chat query
  // Shortlist hint — narrow pool sent to judge (prevents us from judging
  // all 200 events for every probe). If omitted, we judge top-50 by a simple
  // text heuristic based on `intent`.
  shortlistHint?: string;
}

const PROBES: Probe[] = [
  { id: 'G01', intent: 'Science museum or STEM activity for a 5-year-old',
    filters: { ageMax: 5, categories: ['science'] },
    chatQuery: 'science museum for a 5 year old',
    shortlistHint: 'science' },

  { id: 'G02', intent: 'Free outdoor weekend activity for a 4-year-old',
    filters: { ageMax: 4, isFree: true, categories: ['outdoors'] },
    chatQuery: 'free outdoor weekend plans for 4 year old',
    shortlistHint: 'outdoor' },

  { id: 'G03', intent: 'Arts / craft class for a 6-year-old',
    filters: { ageMax: 6, categories: ['arts'] },
    chatQuery: 'arts and crafts class for 6 year old',
    shortlistHint: 'art' },

  { id: 'G04', intent: 'Indoor rainy-day activity for a toddler (age 2)',
    filters: { ageMax: 2 },
    chatQuery: 'indoor rainy day activity for my 2 year old',
    shortlistHint: 'indoor' },

  { id: 'G05', intent: 'Storytime / library event for preschooler',
    filters: { ageMax: 4, categories: ['books'] },
    chatQuery: 'storytime for my preschooler',
    shortlistHint: 'story' },

  { id: 'G06', intent: 'Theater / Broadway show kid-friendly',
    filters: { ageMax: 8, categories: ['theater'] },
    chatQuery: 'theater show for kids',
    shortlistHint: 'theater' },

  { id: 'G07', intent: 'Music / concert for a 5-year-old',
    filters: { ageMax: 5, categories: ['music'] },
    chatQuery: 'kids music concert for 5 year old',
    shortlistHint: 'music' },

  { id: 'G08', intent: 'Free event specifically in Manhattan this weekend',
    filters: { isFree: true, neighborhoods: ['Manhattan'] },
    chatQuery: 'free things to do in Manhattan this weekend',
    shortlistHint: 'manhattan' },

  { id: 'G09', intent: 'Anything in Queens for kids',
    filters: { neighborhoods: ['Queens'] },
    chatQuery: 'something for kids in Queens',
    shortlistHint: 'queens' },

  { id: 'G10', intent: 'Anything in Bronx for kids',
    filters: { neighborhoods: ['Bronx'] },
    chatQuery: 'something for kids in the Bronx',
    shortlistHint: 'bronx' },

  { id: 'G11', intent: 'Zoo / animals for a young child',
    filters: { ageMax: 6 },
    chatQuery: 'zoo or animals activity for young kid',
    shortlistHint: 'zoo' },

  { id: 'G12', intent: 'Nature / garden / park outing for family',
    filters: { categories: ['outdoors'] },
    chatQuery: 'nature or park outing for family',
    shortlistHint: 'garden' },

  { id: 'G13', intent: 'Cheap (< $20) activity for a 7-year-old',
    filters: { ageMax: 7, priceMax: 20 },
    chatQuery: 'cheap activity under 20 dollars for 7 year old',
    shortlistHint: 'affordable' },

  { id: 'G14', intent: 'Teen (age 13-14) hangout or event',
    filters: { ageMax: 14 },
    chatQuery: 'things for a 14 year old teen',
    shortlistHint: 'teen' },

  { id: 'G15', intent: 'Birthday party venue / group activity',
    filters: { ageMax: 8 },
    chatQuery: 'birthday party venue for a 7 year old',
    shortlistHint: 'birthday' },

  { id: 'G16', intent: 'Sports class for an 8-year-old',
    filters: { ageMax: 8, categories: ['sports'] },
    chatQuery: 'sports class for 8 year old',
    shortlistHint: 'sport' },

  { id: 'G17', intent: 'Dance class for a 6-year-old girl',
    filters: { ageMax: 6 },
    chatQuery: 'dance class for 6 year old girl',
    shortlistHint: 'dance' },

  { id: 'G18', intent: 'Baby/toddler class (under 2)',
    filters: { ageMax: 2 },
    chatQuery: 'baby class for my 18-month-old',
    shortlistHint: 'baby' },

  { id: 'G19', intent: 'Educational but fun activity for 7yo',
    filters: { ageMax: 7 },
    chatQuery: 'educational but fun activity for 7 year old',
    shortlistHint: 'education' },

  { id: 'G20', intent: 'Free activity for family of 4 on Sunday',
    filters: { isFree: true },
    chatQuery: 'free Sunday activity for family of 4',
    shortlistHint: 'free' },

  { id: 'G21', intent: 'Brooklyn outdoor weekend for 5yo',
    filters: { ageMax: 5, neighborhoods: ['Brooklyn'], categories: ['outdoors'] },
    chatQuery: 'outdoor weekend activity in Brooklyn for 5 year old',
    shortlistHint: 'brooklyn' },

  { id: 'G22', intent: 'Museum visit for 4-year-old',
    filters: { ageMax: 4, categories: ['attractions'] },
    chatQuery: 'museum visit for 4 year old',
    shortlistHint: 'museum' },

  { id: 'G23', intent: 'Food / cooking class for kid',
    filters: { categories: ['food'] },
    chatQuery: 'cooking class for kids',
    shortlistHint: 'cook' },

  { id: 'G24', intent: 'Holiday / seasonal event',
    filters: {},
    chatQuery: 'any holiday or seasonal kids event coming up',
    shortlistHint: 'holiday' },

  { id: 'G25', intent: 'Something bilingual (Spanish) for kids',
    filters: {},
    chatQuery: 'bilingual Spanish activity for kids',
    shortlistHint: 'spanish' },
];

const toEv = (e: ApiEvent): Ev => e as unknown as Ev;

// ─── Judge ──────────────────────────────────────────────────────────────────
const JUDGE_SYSTEM = `You are a discerning NYC parent rating how well an event matches a stated intent.
Score 1-5:
  5 = perfect match (what the parent almost certainly wants)
  4 = strong match (clearly relevant, minor mismatch)
  3 = plausible (category aligns, specifics might not)
  2 = weak (loosely related)
  1 = irrelevant
Return STRICT JSON: {"scores":[{"id":<int>,"score":<1-5>,"why":"<≤10 words>"}]}`;

interface JudgeScore { id: number; score: number; why: string }

async function rateBatch(intent: string, events: Ev[]): Promise<Map<number, JudgeScore>> {
  if (events.length === 0) return new Map();
  const prompt = `Intent: "${intent}"

Events to rate:
${events.map((e) => `  #${e.id} | ${(e.title ?? '').slice(0, 80)} | cat=${e.category_l1 ?? '-'} | format=${e.format ?? '-'} | ages ${e.age_best_from ?? '?'}-${e.age_best_to ?? '?'} | ${e.is_free ? 'free' : (e.price_summary ?? '$?')} | ${e.country_county ?? e.city ?? '-'} | tags: ${(e.tags ?? []).slice(0, 5).join(', ')}`).join('\n')}`;
  try {
    const raw = await withRetry(() => judge<{ scores: JudgeScore[] }>(JUDGE_SYSTEM, prompt));
    const scores = (raw as { scores?: JudgeScore[] }).scores ?? [];
    const map = new Map<number, JudgeScore>();
    for (const s of scores) map.set(Number(s.id), { id: Number(s.id), score: Number(s.score) || 0, why: String(s.why ?? '') });
    return map;
  } catch (e) {
    console.warn(`  judge error: ${(e as Error).message}`);
    return new Map();
  }
}

/** Build a shortlist from the DB pool using a simple text hint. */
function shortlistFromPool(pool: Ev[], probe: Probe, n = 40): Ev[] {
  const h = (probe.shortlistHint ?? '').toLowerCase();

  // 1. Filter events that roughly match age if an age cap is set
  let pre = pool;
  const ageMax = probe.filters.ageMax;
  if (typeof ageMax === 'number') {
    pre = pool.filter((e) => {
      // Loose: event's range should touch our target age
      const lo = e.age_best_from ?? e.age_min ?? 0;
      const hi = e.age_best_to ?? 18;
      return lo <= ageMax && hi >= Math.max(0, ageMax - 2);
    });
  }

  // 2. Neighborhood pre-filter (loose, based on county/text)
  if (probe.filters.neighborhoods?.length) {
    const nbs = probe.filters.neighborhoods.map((x) => x.toLowerCase());
    pre = pre.filter((e) => {
      const hay = [e.country_county, e.city, e.city_district, e.city_locality, e.venue_name].filter(Boolean).join(' ').toLowerCase();
      // match if hay contains any nb name, or aliasing via county
      return nbs.some((nb) => {
        if (hay.includes(nb)) return true;
        if (nb === 'manhattan' && (hay.includes('new york county') || hay.includes('new york') || hay.includes('manhattan'))) return true;
        if (nb === 'brooklyn' && hay.includes('kings county')) return true;
        if (nb === 'queens' && hay.includes('queens county')) return true;
        if (nb === 'bronx' && hay.includes('bronx county')) return true;
        if (nb === 'staten island' && hay.includes('richmond county')) return true;
        return false;
      });
    });
  }

  // 3. Free-only pre-filter
  if (probe.filters.isFree === true) {
    pre = pre.filter((e) => e.is_free);
  }
  if (typeof probe.filters.priceMax === 'number') {
    const cap = probe.filters.priceMax;
    pre = pre.filter((e) => e.is_free || (typeof e.price_max === 'number' && e.price_max <= cap * 1.2));
  }

  // 4. Score against the hint
  const scored = pre
    .map((e) => {
      const blob = [e.title, e.short_title, e.description?.slice(0, 200), e.format, e.category_l1, ...(e.categories ?? []), ...(e.tags ?? [])]
        .filter(Boolean).join(' ').toLowerCase();
      let s = 0;
      if (h && blob.includes(h)) s += 3;
      // Category nudge
      if (probe.filters.categories?.length) {
        for (const c of probe.filters.categories) {
          if ((e.category_l1 ?? '').toLowerCase() === c) s += 2;
          if ((e.categories ?? []).some((x) => String(x).toLowerCase().includes(c))) s += 1;
          if ((e.tags ?? []).some((x) => String(x).toLowerCase().includes(c))) s += 1;
        }
      }
      // Rating nudge
      s += Math.min(2, (e.rating_count ?? 0) / 20);
      return { e, s };
    })
    .sort((a, b) => b.s - a.s);

  // Hybrid: top-20 by hint + 20 random spares from the pre-filtered pool
  const byHint = scored.slice(0, 20).map((x) => x.e);
  const spares = pre.filter((e) => !byHint.some((x) => x.id === e.id)).slice(0, n - byHint.length);
  return [...byHint, ...spares].slice(0, n);
}

// ─── Main ───────────────────────────────────────────────────────────────────
interface GapRow {
  id: string;
  intent: string;
  filters: FilterState;

  db_strong: Array<{ id: number; title: string; score: number; why: string }>;

  filter_path: {
    returned_top20: Array<{ id: number; title: string }>;
    strong_shown: number;
    strong_missed: Array<{ id: number; title: string; score: number; why: string }>;
    coverage_pct: number;
    verdict: 'PASS' | 'WARN' | 'FAIL';
  };

  chat_path?: {
    query: string;
    returned: Array<{ id: number; title: string }>;
    strong_shown: number;
    strong_missed: Array<{ id: number; title: string; score: number; why: string }>;
    coverage_pct: number;
    verdict: 'PASS' | 'WARN' | 'FAIL';
    error?: string;
  };
}

async function main() {
  console.log('\n════ BLOCK 3 — DB vs OUTPUT GAP AUDIT ════');
  console.log('(asks: if an event IS in the DB, do we show it?)');

  const pool = loadLiveEvents();
  console.log(`Loaded ${pool.length} live events from DB`);

  const rows: GapRow[] = [];

  for (const p of PROBES) {
    process.stdout.write(`\n  ${p.id}  ${p.intent.slice(0, 65).padEnd(65)} ...\n`);

    // ── Step A: Judge the whole DB shortlist for this intent
    const shortlist = shortlistFromPool(pool, p);
    process.stdout.write(`    · shortlist=${shortlist.length} events\n`);

    const dbScores = await rateBatch(p.intent, shortlist);
    const dbStrong = shortlist
      .map((e) => ({ e, sc: dbScores.get(e.id) }))
      .filter((x) => x.sc && x.sc.score >= 4)
      .map(({ e, sc }) => ({ id: e.id, title: e.title ?? '', score: sc!.score, why: sc!.why }));

    process.stdout.write(`    · DB strong (≥4): ${dbStrong.length}\n`);

    // ── Step B: Product filter path
    let filterRet: ApiEvent[] = [];
    try {
      const res = getEvents({ ...p.filters, page: 1, page_size: 20 });
      filterRet = res.events;
    } catch (e) {
      process.stdout.write(`    · filter threw: ${(e as Error).message}\n`);
    }
    const filterIds = new Set(filterRet.map((e) => e.id));
    const strongShownF = dbStrong.filter((x) => filterIds.has(x.id)).length;
    const strongMissedF = dbStrong.filter((x) => !filterIds.has(x.id));
    const covF = dbStrong.length === 0 ? 100 : Math.round((strongShownF / dbStrong.length) * 100);
    const verdictF: 'PASS' | 'WARN' | 'FAIL' =
      dbStrong.length === 0 ? 'WARN' :
      covF >= 80 ? 'PASS' :
      covF >= 50 ? 'WARN' : 'FAIL';
    process.stdout.write(`    · FILTER path: covered ${strongShownF}/${dbStrong.length} strong (${covF}%) → ${verdictF}\n`);

    // ── Step C: Chat path (only if we have a query)
    let chatPath: GapRow['chat_path'] | undefined;
    if (p.chatQuery) {
      try {
        await sleep(CHAT_THROTTLE_MS);
        const res = await fetch(CHAT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: p.chatQuery }),
        });
        const body = await res.json() as { events?: ApiEvent[]; error?: string };
        if (body.error) {
          chatPath = { query: p.chatQuery, returned: [], strong_shown: 0, strong_missed: dbStrong, coverage_pct: 0, verdict: 'FAIL', error: body.error };
        } else {
          const evs = body.events ?? [];
          const chatIds = new Set(evs.map((e) => e.id));
          const strongShownC = dbStrong.filter((x) => chatIds.has(x.id)).length;
          const strongMissedC = dbStrong.filter((x) => !chatIds.has(x.id));
          const covC = dbStrong.length === 0 ? 100 : Math.round((strongShownC / dbStrong.length) * 100);
          const verdictC: 'PASS' | 'WARN' | 'FAIL' =
            dbStrong.length === 0 ? 'WARN' :
            covC >= 80 ? 'PASS' :
            covC >= 50 ? 'WARN' : 'FAIL';
          chatPath = {
            query: p.chatQuery,
            returned: evs.slice(0, 10).map((e) => ({ id: e.id, title: e.title ?? '' })),
            strong_shown: strongShownC,
            strong_missed: strongMissedC,
            coverage_pct: covC,
            verdict: verdictC,
          };
          process.stdout.write(`    · CHAT path:   covered ${strongShownC}/${dbStrong.length} strong (${covC}%) → ${verdictC}\n`);
        }
      } catch (e) {
        chatPath = { query: p.chatQuery, returned: [], strong_shown: 0, strong_missed: dbStrong, coverage_pct: 0, verdict: 'FAIL', error: (e as Error).message };
      }
    }

    rows.push({
      id: p.id,
      intent: p.intent,
      filters: p.filters,
      db_strong: dbStrong,
      filter_path: {
        returned_top20: filterRet.slice(0, 20).map((e) => ({ id: e.id, title: e.title ?? '' })),
        strong_shown: strongShownF,
        strong_missed: strongMissedF,
        coverage_pct: covF,
        verdict: verdictF,
      },
      chat_path: chatPath,
    });
  }

  // Summary
  const filterPass = rows.filter((r) => r.filter_path.verdict === 'PASS').length;
  const filterWarn = rows.filter((r) => r.filter_path.verdict === 'WARN').length;
  const filterFail = rows.filter((r) => r.filter_path.verdict === 'FAIL').length;
  const chatRows = rows.filter((r) => r.chat_path);
  const chatPass = chatRows.filter((r) => r.chat_path!.verdict === 'PASS').length;
  const chatWarn = chatRows.filter((r) => r.chat_path!.verdict === 'WARN').length;
  const chatFail = chatRows.filter((r) => r.chat_path!.verdict === 'FAIL').length;

  const strongTotal = rows.reduce((a, r) => a + r.db_strong.length, 0);
  const strongShownFilter = rows.reduce((a, r) => a + r.filter_path.strong_shown, 0);
  const strongShownChat = chatRows.reduce((a, r) => a + r.chat_path!.strong_shown, 0);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    probes: rows,
    summary: {
      total_probes: rows.length,
      filter_path: { pass: filterPass, warn: filterWarn, fail: filterFail },
      chat_path: { pass: chatPass, warn: chatWarn, fail: chatFail, total: chatRows.length },
      strong_candidates_total: strongTotal,
      strong_surfaced_filter: strongShownFilter,
      strong_surfaced_chat: strongShownChat,
      coverage_filter_pct: strongTotal === 0 ? 100 : Math.round((strongShownFilter / strongTotal) * 100),
      coverage_chat_pct: strongTotal === 0 ? 100 : Math.round((strongShownChat / strongTotal) * 100),
    },
  }, null, 2));

  console.log(`\n── Summary ──`);
  console.log(`Filter path: ${filterPass} PASS · ${filterWarn} WARN · ${filterFail} FAIL  (of ${rows.length})`);
  console.log(`Chat path:   ${chatPass} PASS · ${chatWarn} WARN · ${chatFail} FAIL  (of ${chatRows.length})`);
  console.log(`\nDB strong candidates total: ${strongTotal}`);
  console.log(`  surfaced via filter: ${strongShownFilter} (${strongTotal === 0 ? 100 : Math.round((strongShownFilter / strongTotal) * 100)}%)`);
  console.log(`  surfaced via chat:   ${strongShownChat} (${strongTotal === 0 ? 100 : Math.round((strongShownChat / strongTotal) * 100)}%)`);
  console.log(`\nReport → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
