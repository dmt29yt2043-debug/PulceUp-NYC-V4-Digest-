/**
 * Digest 5 — 10 Things Kids Love (And Parents Don't Regret).
 *
 * Hard filter: quality_confidence >= 0.5 AND rating_count >= 5.
 * Score: Quality (heavy) + Family + Engagement text + NYC + Completeness.
 */

import type { EnrichedEvent, DigestResult, ScoredEvent, DigestMeta, EventRow } from './types';
import { THRESHOLDS, ENGAGEMENT_KEYWORDS } from './constants';
import { classifyQuality, classifyFamily } from './signals';
import { baseGeoAndCompleteness, dedupe, pickWithFallback } from './scoring-helpers';
import { matchedKeywords } from './event-parser';

const SLUG = 'kids-love-parents-approve';

const META: Omit<DigestMeta, 'cover_image' | 'event_count'> = {
  id: 105,
  slug: SLUG,
  title: "10 Things Kids Love (And Parents Don't Regret)",
  subtitle: 'Fun for kids, worth the time, and not painful for parents.',
  category: "Mom's Digest",
  category_tag: 'POPULAR',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['popular', 'worth-it', 'family']),
};

export function scoreWorthIt(ev: EnrichedEvent): ScoredEvent | null {
  const q = classifyQuality(ev);
  // Hard gate: must have real reviews + strong rating
  if (q.confidence < 0.5) return null;
  if (ev.rating_count < THRESHOLDS.WORTH_IT_RATING_COUNT_MIN) return null;

  const reasons: string[] = [];
  let score = 0;

  const base = baseGeoAndCompleteness(ev);
  score += base.score;
  reasons.push(...base.reasons);

  const qPts = Math.round(q.confidence * 35);
  score += qPts;
  if (qPts >= 20) reasons.push(`quality (${qPts})`);

  const fam = classifyFamily(ev);
  const famPts = Math.round(fam.confidence * 20);
  score += famPts;
  if (famPts >= 12) reasons.push(`family (${famPts})`);

  // Engagement keywords bonus — "hands-on", "interactive", "workshop", etc.
  const eng = matchedKeywords(ev.textBlob, ENGAGEMENT_KEYWORDS);
  const engPts = Math.min(15, eng.length * 5);
  score += engPts;
  if (engPts >= 10) reasons.push(`engagement kw ×${eng.length}`);

  return { event: ev, score, reasons };
}

export function getWorthItDigest(events: EnrichedEvent[]): DigestResult {
  const notes: string[] = [];

  const scored = events
    .map(scoreWorthIt)
    .filter((s): s is ScoredEvent => s !== null);

  const deduped = dedupe(scored);
  const { picks, strong, weak, skipped } = pickWithFallback(deduped, {
    target: 10,
    strongFloor: 65,
    weakFloor: 45,
    absoluteFloor: THRESHOLDS.ABSOLUTE_FLOOR,
  });

  if (strong < 5) notes.push(`Only ${strong} strong worth-it candidates — used fallback tier.`);

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
