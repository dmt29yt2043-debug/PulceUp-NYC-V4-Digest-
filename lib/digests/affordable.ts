/**
 * Digest 4 — Top 15 Free & Affordable Things to Do with Kids in NYC.
 *
 * Hard filter: affordable_confidence >= 0.5 (free, ≤$30, or text-flagged).
 * Score: Affordable (tiered) + NYC + Family + Quality.
 */

import type { EnrichedEvent, DigestResult, ScoredEvent, DigestMeta, EventRow } from './types';
import { THRESHOLDS } from './constants';
import { classifyAffordable, classifyFamily, classifyQuality } from './signals';
import { baseGeoAndCompleteness, dedupe, pickWithFallback } from './scoring-helpers';

const SLUG = 'free-affordable';

const META: Omit<DigestMeta, 'cover_image' | 'event_count'> = {
  id: 104,
  slug: SLUG,
  title: 'Top 15 Free & Affordable Things to Do with Kids in NYC',
  subtitle: "Good family plans that won't turn into a $100 outing.",
  category: "Mom's Digest",
  category_tag: 'BUDGET',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['free', 'budget', 'family']),
};

export function scoreAffordable(ev: EnrichedEvent): ScoredEvent | null {
  const afford = classifyAffordable(ev);
  if (afford.confidence < 0.5) return null;

  const reasons: string[] = [];
  let score = 0;

  const base = baseGeoAndCompleteness(ev);
  score += base.score;
  reasons.push(...base.reasons);

  const affPts = Math.round(afford.confidence * 40);
  score += affPts;
  if (affPts >= 25) reasons.push(`affordable (${affPts})`);

  const fam = classifyFamily(ev);
  const famPts = Math.round(fam.confidence * 20);
  score += famPts;
  if (famPts >= 12) reasons.push(`family (${famPts})`);

  const q = classifyQuality(ev);
  const qPts = Math.round(q.confidence * 20);
  score += qPts;
  if (qPts >= 12) reasons.push(`quality (${qPts})`);

  return { event: ev, score, reasons };
}

export function getAffordableDigest(events: EnrichedEvent[]): DigestResult {
  const notes: string[] = [];

  const scored = events
    .map(scoreAffordable)
    .filter((s): s is ScoredEvent => s !== null);

  const deduped = dedupe(scored);
  const { picks, strong, weak, skipped } = pickWithFallback(deduped, {
    target: 15,
    strongFloor: 70,
    weakFloor: 45,
    absoluteFloor: THRESHOLDS.ABSOLUTE_FLOOR,
  });

  if (strong < 8) notes.push(`Only ${strong} strong budget candidates — used fallback tier.`);

  const meta: DigestMeta = {
    ...META,
    cover_image: picks[0]?.event.image_url ?? null,
    event_count: picks.length,
  };

  return {
    meta,
    events: picks.map((s) => s.event) as EventRow[],
    coverage: { strong_candidates: strong, weak_candidates: weak, skipped_low_quality: skipped, notes },
    scored: picks,
  };
}
