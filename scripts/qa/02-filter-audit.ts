/**
 * 02 · Filter Audit — correctness + coverage across 25 scenarios.
 *
 * Two metrics per scenario:
 *   · correctness = % of returned events that satisfy the independent predicate
 *   · coverage    = % of predicate-matching events in the DB that we return
 *
 * Correctness close to 100% ⇒ we don't show the wrong stuff.
 * Coverage close to 100% ⇒ we don't hide the right stuff.
 *
 * This script hits the DB directly (via getEvents). A later script tests
 * the HTTP layer against prod to catch any API-level regressions.
 */

import fs from 'fs';
import path from 'path';
import { getEvents } from '../../lib/db';
import type { Event, FilterState } from '../../lib/types';
import { loadLiveEvents, ageFits, inBorough, looseCat, looksAffordable, fmtEv, type Ev } from './_lib';

const OUT = path.join(process.cwd(), 'reports', 'qa', '02-filter-audit.json');

interface Scenario {
  id: string;
  name: string;
  filters: FilterState;
  fits: (e: Ev) => boolean;
  allowEmpty?: boolean;
}

// Cast API Event to audit Ev (shape overlaps on the fields we inspect)
const toEv = (e: Event): Ev => e as unknown as Ev;

const SCENARIOS: Scenario[] = [
  // ── Age only ────────────────────────────────────────────────────────────
  { id: 'age-2',  name: 'Age 2',  filters: { ageMax: 2  }, fits: (e) => ageFits(e, 2) },
  { id: 'age-4',  name: 'Age 4',  filters: { ageMax: 4  }, fits: (e) => ageFits(e, 4) },
  { id: 'age-7',  name: 'Age 7',  filters: { ageMax: 7  }, fits: (e) => ageFits(e, 7) },
  { id: 'age-10', name: 'Age 10', filters: { ageMax: 10 }, fits: (e) => ageFits(e, 10) },
  { id: 'age-14', name: 'Age 14', filters: { ageMax: 14 }, fits: (e) => ageFits(e, 14) },

  // ── Age + gender (gender is currently no-op, should not break) ─────────
  { id: 'age-gender-7g',  name: '7yo girl',  filters: { ageMax: 7, childGenders: ['girl'] },  fits: (e) => ageFits(e, 7) },
  { id: 'age-gender-10b', name: '10yo boy',  filters: { ageMax: 10, childGenders: ['boy'] }, fits: (e) => ageFits(e, 10) },

  // ── Multi-child ─────────────────────────────────────────────────────────
  { id: 'multi-4-10',     name: 'Kids [4, 10]',     filters: { childAges: [4, 10] },     fits: (e) => ageFits(e, 4) || ageFits(e, 10) },
  { id: 'multi-2-7-12',   name: 'Kids [2, 7, 12]',  filters: { childAges: [2, 7, 12] },  fits: (e) => ageFits(e, 2) || ageFits(e, 7) || ageFits(e, 12) },

  // ── Single interest ─────────────────────────────────────────────────────
  { id: 'cat-arts',      name: 'Arts',      filters: { categories: ['arts'] },      fits: (e) => looseCat(e, 'arts') },
  { id: 'cat-science',   name: 'Science',   filters: { categories: ['science'] },   fits: (e) => looseCat(e, 'science'), allowEmpty: true },
  { id: 'cat-music',     name: 'Music',     filters: { categories: ['music'] },     fits: (e) => looseCat(e, 'music') },
  { id: 'cat-outdoors',  name: 'Outdoors',  filters: { categories: ['outdoors'] },  fits: (e) => looseCat(e, 'outdoors') },
  { id: 'cat-theater',   name: 'Theater',   filters: { categories: ['theater'] },   fits: (e) => looseCat(e, 'theater') },
  { id: 'cat-books',     name: 'Books',     filters: { categories: ['books'] },     fits: (e) => looseCat(e, 'books') },

  // ── Location ────────────────────────────────────────────────────────────
  { id: 'loc-manhattan', name: 'Manhattan', filters: { neighborhoods: ['Manhattan'] }, fits: (e) => inBorough(e, 'Manhattan') },
  { id: 'loc-brooklyn',  name: 'Brooklyn',  filters: { neighborhoods: ['Brooklyn'] },  fits: (e) => inBorough(e, 'Brooklyn') },
  { id: 'loc-queens',    name: 'Queens',    filters: { neighborhoods: ['Queens'] },    fits: (e) => inBorough(e, 'Queens'),  allowEmpty: true },
  { id: 'loc-bronx',     name: 'Bronx',     filters: { neighborhoods: ['Bronx'] },     fits: (e) => inBorough(e, 'Bronx'),   allowEmpty: true },

  // ── Price ───────────────────────────────────────────────────────────────
  { id: 'price-free',  name: 'Free only',    filters: { isFree: true }, fits: (e) => e.is_free },
  { id: 'price-u25',   name: 'Under $25',    filters: { priceMax: 25 }, fits: (e) => looksAffordable(e) || (typeof e.price_min === 'number' && e.price_min <= 25) },
  { id: 'price-u50',   name: 'Under $50',    filters: { priceMax: 50 }, fits: (e) => e.is_free || (typeof e.price_min === 'number' && e.price_min <= 50) },

  // ── Combos (the real product experience) ───────────────────────────────
  { id: 'combo-4-bk-free', name: '4yo + Brooklyn + free',
    filters: { ageMax: 4, neighborhoods: ['Brooklyn'], isFree: true },
    fits: (e) => ageFits(e, 4) && inBorough(e, 'Brooklyn') && e.is_free },
  { id: 'combo-7-sci-mh',  name: '7yo + Science + Manhattan',
    filters: { ageMax: 7, categories: ['science'], neighborhoods: ['Manhattan'] },
    fits: (e) => ageFits(e, 7) && looseCat(e, 'science') && inBorough(e, 'Manhattan'),
    allowEmpty: true },
  { id: 'combo-teen-bk',   name: 'Teen (14) + Brooklyn',
    filters: { ageMax: 14, neighborhoods: ['Brooklyn'] },
    fits: (e) => ageFits(e, 14) && inBorough(e, 'Brooklyn'),
    allowEmpty: true },
  { id: 'combo-5-arts-free', name: '5yo + Arts + free',
    filters: { ageMax: 5, categories: ['arts'], isFree: true },
    fits: (e) => ageFits(e, 5) && looseCat(e, 'arts') && e.is_free },
];

interface Row {
  id: string;
  name: string;
  returned: number;
  correct: number;
  wrong_samples: string[];
  gold_count: number;
  missed: number;
  missed_samples: string[];
  correctness_pct: number;
  coverage_pct: number;
  verdict: 'PASS' | 'WARN' | 'FAIL';
}

function main() {
  const pool = loadLiveEvents();
  const rows: Row[] = [];

  for (const sc of SCENARIOS) {
    let res: { events: Event[] };
    try {
      res = getEvents({ ...sc.filters, page: 1, page_size: 500 });
    } catch (e) {
      rows.push({
        id: sc.id, name: sc.name, returned: 0, correct: 0, wrong_samples: [`THROWN: ${(e as Error).message}`],
        gold_count: pool.filter(sc.fits).length, missed: 0, missed_samples: [],
        correctness_pct: 0, coverage_pct: 0, verdict: 'FAIL',
      });
      continue;
    }
    const returned = res.events.map(toEv);
    const correct = returned.filter(sc.fits);
    const wrong = returned.filter((e) => !sc.fits(e));

    const gold = pool.filter(sc.fits);
    const returnedIds = new Set(returned.map((e) => e.id));
    const missed = gold.filter((e) => !returnedIds.has(e.id));

    const correctness_pct = returned.length === 0 ? 100 : Math.round((correct.length / returned.length) * 100);
    const coverage_pct = gold.length === 0 ? 100 : Math.round((returned.filter((e) => returnedIds.has(e.id) && sc.fits(e)).length / gold.length) * 100);

    const verdict: Row['verdict'] =
      correctness_pct < 80 ? 'FAIL' :
      returned.length === 0 && !sc.allowEmpty ? 'FAIL' :
      correctness_pct < 95 || coverage_pct < 80 ? 'WARN' : 'PASS';

    rows.push({
      id: sc.id,
      name: sc.name,
      returned: returned.length,
      correct: correct.length,
      wrong_samples: wrong.slice(0, 3).map(fmtEv),
      gold_count: gold.length,
      missed: missed.length,
      missed_samples: missed.slice(0, 3).map(fmtEv),
      correctness_pct,
      coverage_pct,
      verdict,
    });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ scenarios: rows }, null, 2));

  const pad = (s: string | number, w: number) => (String(s) + ' '.repeat(w)).slice(0, w);
  console.log('\n════ FILTER AUDIT ════');
  console.log(pad('Scenario', 28) + pad('Ret', 5) + pad('Corr%', 7) + pad('Cov%', 7) + pad('Miss', 6) + 'Verdict');
  console.log('─'.repeat(80));
  rows.forEach((r) => {
    const icon = r.verdict === 'PASS' ? '✓' : r.verdict === 'WARN' ? '!' : '✗';
    console.log(pad(r.name, 28) + pad(r.returned, 5) + pad(r.correctness_pct + '%', 7) + pad(r.coverage_pct + '%', 7) + pad(r.missed, 6) + `${icon} ${r.verdict}`);
    if (r.wrong_samples.length) console.log('    wrong: ' + r.wrong_samples.join(' | '));
    if (r.missed > 0 && r.coverage_pct < 90) console.log('    missed: ' + r.missed_samples.join(' | '));
  });
  const pass = rows.filter((r) => r.verdict === 'PASS').length;
  const warn = rows.filter((r) => r.verdict === 'WARN').length;
  const fail = rows.filter((r) => r.verdict === 'FAIL').length;
  console.log('─'.repeat(80));
  console.log(`Summary: ${pass} PASS · ${warn} WARN · ${fail} FAIL (of ${rows.length})`);
  console.log(`Report → ${OUT}`);
}

main();
