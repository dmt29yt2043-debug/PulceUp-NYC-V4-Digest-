/**
 * Digest 3 — 10 Easy Things to Do with Kids in NYC (No Planning Needed).
 *
 * Hard filter: easy_confidence >= 0.4 (free OR drop-in OR easy format + subway).
 * Score: Easy + NYC + Family + Quality.
 */

import type { EnrichedEvent, DigestResult, ScoredEvent, DigestMeta, EventRow } from './types';
import { THRESHOLDS } from './constants';
import { classifyEasy, classifyFamily, classifyQuality } from './signals';
import { baseGeoAndCompleteness, dedupe, pickWithFallback } from './scoring-helpers';

const SLUG = 'easy-no-planning';

const META: Omit<DigestMeta, 'cover_image' | 'event_count'> = {
  id: 103,
  slug: SLUG,
  title: '10 Easy Things to Do with Kids in NYC (No Planning Needed)',
  subtitle: 'Low-effort plans that are simple, easy, and actually work.',
  category: "Mom's Digest",
  category_tag: 'EASY',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['easy', 'family', 'no-planning']),
};

export function scoreEasy(ev: EnrichedEvent): ScoredEvent | null {
  const easy = classifyEasy(ev);
  if (easy.confidence < 0.4) return null;

  const reasons: string[] = [];
  let score = 0;

  const base = baseGeoAndCompleteness(ev);
  score += base.score;
  reasons.push(...base.reasons);

  const easyPts = Math.round(easy.confidence * 35);
  score += easyPts;
  if (easyPts >= 20) reasons.push(`easy (${easyPts})`);

  const fam = classifyFamily(ev);
  const famPts = Math.round(fam.confidence * 20);
  score += famPts;
  if (famPts >= 12) reasons.push(`family (${famPts})`);

  const q = classifyQuality(ev);
  const qPts = Math.round(q.confidence * 15);
  score += qPts;
  if (qPts >= 10) reasons.push(`quality (${qPts})`);

  return { event: ev, score, reasons };
}

export function getEasyDigest(events: EnrichedEvent[]): DigestResult {
  const notes: string[] = [];

  const scored = events
    .map(scoreEasy)
    .filter((s): s is ScoredEvent => s !== null);

  const deduped = dedupe(scored);
  const { picks, strong, weak, skipped } = pickWithFallback(deduped, {
    target: 10,
    strongFloor: 55,
    weakFloor: 35,
    absoluteFloor: THRESHOLDS.ABSOLUTE_FLOOR,
  });

  if (strong < 5) notes.push(`Only ${strong} strong easy-plan candidates — used fallback tier.`);

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
