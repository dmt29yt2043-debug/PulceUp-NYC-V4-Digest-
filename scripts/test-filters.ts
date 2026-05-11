/**
 * Filter correctness test — runs a battery of realistic parent queries
 * against `getEvents()` directly (bypassing HTTP + OpenAI) and verifies
 * the results actually match the constraints.
 *
 * Why direct?  HTTP-level tests mix in LLM non-determinism and rate limits.
 * This hits the SQL layer so when a test fails, you know the DB query is
 * wrong — not the prompt.
 *
 * Run:  npx tsx scripts/test-filters.ts
 */

import { getEvents } from '../lib/db';
import type { FilterState, Event } from '../lib/types';

interface Scenario {
  name: string;
  filters: FilterState;
  /** predicate an event must satisfy to count as "correct" */
  correct: (e: Event) => boolean;
  /** set to true if returning 0 is OK (rare / no data) */
  allowEmpty?: boolean;
  /** optional upper bound — expected result count if correct */
  expectCountAtLeast?: number;
}

// Helpers matching the age SQL semantics
const ageFits = (e: Event, N: number) => {
  const lo = e.age_best_from ?? e.age_min ?? null;
  const hi = e.age_best_to ?? null;
  if (lo !== null && lo > N) return false;
  if (hi !== null && hi < N) return false;
  return true;
};

const hasCat = (e: Event, slug: string): boolean => {
  const needle = slug.toLowerCase();
  if (e.category_l1 && e.category_l1.toLowerCase() === needle) return true;
  const cats = Array.isArray(e.categories) ? e.categories : [];
  if (cats.some((c) => String(c).toLowerCase().includes(needle))) return true;
  const tags = Array.isArray(e.tags) ? e.tags : [];
  if (tags.some((t) => String(t).toLowerCase().includes(needle))) return true;
  return false;
};

const SCENARIOS: Scenario[] = [
  {
    name: 'Age-only: child age 4',
    filters: { ageMax: 4 },
    correct: (e) => ageFits(e, 4),
    expectCountAtLeast: 20,
  },
  {
    name: 'Age-only: child age 7',
    filters: { ageMax: 7 },
    correct: (e) => ageFits(e, 7),
    expectCountAtLeast: 20,
  },
  {
    name: 'Age-only: child age 12',
    filters: { ageMax: 12 },
    correct: (e) => ageFits(e, 12),
    expectCountAtLeast: 20,
  },
  {
    name: 'Age + single gender: 7yo girl',
    filters: { ageMax: 7, childGenders: ['girl'] },
    correct: (e) => ageFits(e, 7),
    expectCountAtLeast: 10,
  },
  {
    name: 'Age + single gender: 8yo boy',
    filters: { ageMax: 8, childGenders: ['boy'] },
    correct: (e) => ageFits(e, 8),
    expectCountAtLeast: 10,
  },
  {
    name: 'Multi-child: 4yo + 10yo',
    filters: { childAges: [4, 10] },
    correct: (e) => ageFits(e, 4) || ageFits(e, 10),
    expectCountAtLeast: 20,
  },
  {
    name: 'Category: arts',
    filters: { categories: ['arts'] },
    correct: (e) => hasCat(e, 'art'),
    expectCountAtLeast: 3,
  },
  {
    name: 'Category: science (known scarce)',
    filters: { categories: ['science'] },
    correct: (e) => hasCat(e, 'science') || hasCat(e, 'stem'),
    expectCountAtLeast: 1,
    allowEmpty: true,
  },
  {
    name: 'Category: outdoors',
    filters: { categories: ['outdoors'] },
    correct: (e) => hasCat(e, 'outdoor') || hasCat(e, 'nature') || hasCat(e, 'park'),
    expectCountAtLeast: 3,
  },
  {
    name: 'Category: music',
    filters: { categories: ['music'] },
    correct: (e) => hasCat(e, 'music') || hasCat(e, 'concert'),
    expectCountAtLeast: 3,
  },
  {
    name: 'Free only',
    filters: { isFree: true },
    correct: (e) => e.is_free === true,
    expectCountAtLeast: 30,
  },
  {
    name: 'Price cap: under $25',
    filters: { priceMax: 25 },
    correct: (e) =>
      e.is_free === true || (typeof e.price_min === 'number' && e.price_min <= 25),
    expectCountAtLeast: 30,
  },
  {
    name: 'Neighborhood: Brooklyn',
    filters: { neighborhoods: ['Brooklyn'] },
    correct: (e) => {
      const bits = [e.city, e.city_district, e.city_locality, e.address].map((s) =>
        (s ?? '').toLowerCase()
      );
      return bits.some((b) => b.includes('brooklyn'));
    },
    expectCountAtLeast: 5,
  },
  {
    name: 'Combo: 5yo + Brooklyn',
    filters: { ageMax: 5, neighborhoods: ['Brooklyn'] },
    correct: (e) => {
      const bits = [e.city, e.city_district, e.city_locality, e.address].map((s) =>
        (s ?? '').toLowerCase()
      );
      const inBrooklyn = bits.some((b) => b.includes('brooklyn'));
      return ageFits(e, 5) && inBrooklyn;
    },
    expectCountAtLeast: 3,
  },
  {
    name: 'Combo: 4yo + free + arts',
    filters: { ageMax: 4, isFree: true, categories: ['arts'] },
    correct: (e) => ageFits(e, 4) && e.is_free === true && hasCat(e, 'art'),
    expectCountAtLeast: 1,
    allowEmpty: true,
  },
];

type Row = {
  scenario: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  returned: number;
  wrong: number;
  notes: string;
};

function pct(part: number, total: number) {
  if (total === 0) return 0;
  return Math.round((part / total) * 100);
}

async function main() {
  const results: Row[] = [];

  for (const sc of SCENARIOS) {
    let ret: { events: Event[]; total: number };
    try {
      ret = getEvents({ ...sc.filters, page: 1, page_size: 500 });
    } catch (err) {
      results.push({
        scenario: sc.name,
        status: 'FAIL',
        returned: 0,
        wrong: 0,
        notes: `THROWN: ${(err as Error).message}`,
      });
      continue;
    }

    const wrongEvents = ret.events.filter((e) => !sc.correct(e));
    const status: Row['status'] =
      wrongEvents.length > 0
        ? 'FAIL'
        : ret.events.length === 0 && !sc.allowEmpty
          ? 'FAIL'
          : sc.expectCountAtLeast !== undefined && ret.events.length < sc.expectCountAtLeast
            ? 'WARN'
            : 'PASS';

    const wrongSample = wrongEvents
      .slice(0, 3)
      .map(
        (e) =>
          `#${e.id} [${e.age_best_from ?? '?'}-${e.age_best_to ?? '?'}] ${(
            e.title ?? ''
          ).slice(0, 40)}`
      )
      .join(' | ');

    const notes =
      status === 'FAIL' && wrongEvents.length > 0
        ? `${pct(wrongEvents.length, ret.events.length)}% wrong: ${wrongSample}`
        : status === 'FAIL'
          ? 'zero results (not allowed)'
          : status === 'WARN'
            ? `only ${ret.events.length}, expected ≥ ${sc.expectCountAtLeast}`
            : `clean (${ret.events.length})`;

    results.push({
      scenario: sc.name,
      status,
      returned: ret.events.length,
      wrong: wrongEvents.length,
      notes,
    });
  }

  // Print report
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  FILTER CORRECTNESS REPORT');
  console.log('════════════════════════════════════════════════════════════════');
  const col = (s: string, w: number) => (s + ' '.repeat(w)).slice(0, w);
  console.log(
    col('#', 3) + col('Status', 7) + col('Returned', 10) + col('Wrong', 7) + 'Scenario / Notes'
  );
  console.log('─'.repeat(100));
  results.forEach((r, i) => {
    const icon = r.status === 'PASS' ? '✓' : r.status === 'WARN' ? '!' : '✗';
    console.log(
      col(String(i + 1), 3) +
        col(`${icon} ${r.status}`, 7) +
        col(String(r.returned), 10) +
        col(String(r.wrong), 7) +
        r.scenario
    );
    console.log('     ' + col('', 24) + r.notes);
  });
  console.log('─'.repeat(100));
  const pass = results.filter((r) => r.status === 'PASS').length;
  const warn = results.filter((r) => r.status === 'WARN').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  console.log(
    `\nSummary: ${pass} PASS · ${warn} WARN · ${fail} FAIL  (out of ${results.length})\n`
  );
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
