/**
 * 05 · Ranking Audit — NDCG@10 against LLM ideal ordering.
 *
 * We currently ORDER BY next_start_at. This script asks: for a given user
 * query, do the best events actually sit at the top of what we return?
 *
 * Method:
 *   1. Pick 10 representative queries with parameterised filters.
 *   2. Get our top-20 via getEvents().
 *   3. Feed query + top-20 (with short blurbs) to GPT-4o-mini.
 *   4. Judge returns a relevance score 0-3 per event (0=irrelevant, 3=ideal).
 *   5. Compute NDCG@10 between our date-sorted order and the relevance scores.
 *
 * A high NDCG means ordering happens to work. A low NDCG means we need
 * real ranking logic — not just date-ascending.
 */

import fs from 'fs';
import path from 'path';
import { getEvents } from '../../lib/db';
import type { Event as ApiEvent } from '../../lib/types';
import { judge, withRetry } from './_lib';

const OUT = path.join(process.cwd(), 'reports', 'qa', '05-ranking-audit.json');

interface Query { id: string; label: string; filters: Parameters<typeof getEvents>[0]; }

const QUERIES: Query[] = [
  { id: 'r01', label: 'Free weekend family fun (age 5)', filters: { ageMax: 5, isFree: true } },
  { id: 'r02', label: 'Arts for 7yo',                     filters: { ageMax: 7, categories: ['arts'] } },
  { id: 'r03', label: 'Outdoor Saturday Brooklyn kids',   filters: { neighborhoods: ['Brooklyn'], categories: ['outdoors'] } },
  { id: 'r04', label: 'Cheap plans under $25 for 6yo',    filters: { ageMax: 6, priceMax: 25 } },
  { id: 'r05', label: 'Indoor rainy day kids',            filters: { ageMax: 7 } }, // looking for indoor ones in top-10
  { id: 'r06', label: 'Teen (14) things',                 filters: { ageMax: 14 } },
  { id: 'r07', label: 'Toddler (3) activity',             filters: { ageMax: 3 } },
  { id: 'r08', label: 'Manhattan family',                 filters: { neighborhoods: ['Manhattan'] } },
  { id: 'r09', label: 'Music for kids',                   filters: { categories: ['music'] } },
  { id: 'r10', label: 'Museum-type for kid',              filters: { categories: ['attractions'] } },
];

function dcg(scores: number[]): number {
  return scores.reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
}

function ndcgAt(relsInOurOrder: number[], k: number): number {
  const k2 = Math.min(k, relsInOurOrder.length);
  const ourDcg = dcg(relsInOurOrder.slice(0, k2));
  const idealDcg = dcg([...relsInOurOrder].sort((a, b) => b - a).slice(0, k2));
  return idealDcg === 0 ? 0 : ourDcg / idealDcg;
}

const JUDGE_SYSTEM = `You are an NYC parent. Rate each event's relevance to the stated query on a 0-3 scale:
  3 = ideal match
  2 = good match
  1 = weak match / loosely related
  0 = not relevant
Return STRICT JSON: {"scores": [{"id": <int>, "rel": 0-3}, ...]}`;

async function main() {
  console.log('\n════ RANKING AUDIT (NDCG@10) ════');
  const rows: Array<{ id: string; label: string; returned: number; ndcg_at_10: number; top3: string[]; flops_at_top: string[]; gems_below: string[] }> = [];

  for (const q of QUERIES) {
    process.stdout.write(`  ${q.id}  ${q.label.padEnd(42)} ... `);
    const { events } = getEvents({ ...q.filters, page: 1, page_size: 20 });
    if (events.length === 0) { console.log('∅ no results'); continue; }

    const prompt = `Query: "${q.label}"\nEvents to rate:\n` +
      events.map((e: ApiEvent) => `  #${e.id} | ${e.title} | ${e.category_l1 ?? ''} | ${e.is_free ? 'free' : (e.price_summary ?? '')} | ages ${e.age_best_from ?? '?'}-${e.age_best_to ?? '?'}`).join('\n');

    let relMap = new Map<number, number>();
    try {
      const j = await withRetry(() => judge<{ scores: Array<{ id: number; rel: number }> }>(JUDGE_SYSTEM, prompt));
      const scores = (j as { scores: Array<{ id: number; rel: number }> }).scores || [];
      relMap = new Map(scores.map((s) => [Number(s.id), Math.max(0, Math.min(3, Number(s.rel) || 0))]));
    } catch (e) {
      console.log(`✗ judge error: ${(e as Error).message}`);
      continue;
    }

    const relsInOurOrder = events.map((e: ApiEvent) => relMap.get(e.id) ?? 0);
    const ndcg = ndcgAt(relsInOurOrder, 10);

    // Gems below: events ranked high by judge (rel=3) that sit outside top-5
    const gems_below: string[] = [];
    events.forEach((e: ApiEvent, i: number) => {
      const r = relMap.get(e.id) ?? 0;
      if (r >= 3 && i >= 5) gems_below.push(`#${e.id} pos${i + 1} ${e.title}`);
    });
    // Flops at top: events in top-3 with rel ≤ 1
    const flops_at_top: string[] = events.slice(0, 3).filter((e: ApiEvent) => (relMap.get(e.id) ?? 0) <= 1).map((e: ApiEvent) => `#${e.id} ${e.title}`);

    rows.push({
      id: q.id,
      label: q.label,
      returned: events.length,
      ndcg_at_10: Math.round(ndcg * 1000) / 1000,
      top3: events.slice(0, 3).map((e: ApiEvent) => `#${e.id} ${e.title}`),
      flops_at_top,
      gems_below,
    });
    console.log(`NDCG@10 = ${ndcg.toFixed(3)}  flops=${flops_at_top.length}  gems-below=${gems_below.length}`);
  }

  const avg = rows.reduce((a, b) => a + b.ndcg_at_10, 0) / (rows.length || 1);
  console.log(`\nMean NDCG@10 = ${avg.toFixed(3)}   (> 0.85 good · 0.7-0.85 OK · < 0.7 ranking is not working)`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ queries: rows, mean_ndcg_at_10: avg }, null, 2));
  console.log(`Report → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
