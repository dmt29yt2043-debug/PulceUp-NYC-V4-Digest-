/**
 * Digest 2 — Top 10 Indoor Activities for Kids in NYC (Rainy Day Edition).
 *
 * Hard filter: indoor_confidence >= 0.4 (must have at least ONE indoor signal).
 * Score: Indoor + NYC + Family + Quality.
 */

import type { EnrichedEvent, DigestResult, ScoredEvent, DigestMeta, EventRow } from './types';
import { THRESHOLDS } from './constants';
import { classifyIndoor, classifyFamily, classifyQuality } from './signals';
import { baseGeoAndCompleteness, dedupe, pickWithFallback } from './scoring-helpers';

const SLUG = 'indoor-rainy-day';

const META: Omit<DigestMeta, 'cover_image' | 'event_count'> = {
  id: 102,
  slug: SLUG,
  title: 'Top 10 Indoor Activities for Kids in NYC (Rainy Day Edition)',
  subtitle: 'Great indoor options for days when the weather ruins the plan.',
  category: "Mom's Digest",
  category_tag: 'INDOOR',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['indoor', 'family', 'rainy-day']),
};

export function scoreIndoor(ev: EnrichedEvent): ScoredEvent | null {
  const indoor = classifyIndoor(ev);
  if (indoor.confidence < 0.4) return null;

  const reasons: string[] = [];
  let score = 0;

  const base = baseGeoAndCompleteness(ev);
  score += base.score;
  reasons.push(...base.reasons);

  const indoorPts = Math.round(indoor.confidence * 40);
  score += indoorPts;
  if (indoor.reasons.length > 0) reasons.push(`indoor (${indoorPts})`);

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

export function getIndoorDigest(events: EnrichedEvent[]): DigestResult {
  const notes: string[] = [];

  const scored = events
    .map(scoreIndoor)
    .filter((s): s is ScoredEvent => s !== null);

  const deduped = dedupe(scored);
  const { picks, strong, weak, skipped } = pickWithFallback(deduped, {
    target: 10,
    strongFloor: 60,
    weakFloor: 40,
    absoluteFloor: THRESHOLDS.ABSOLUTE_FLOOR,
  });

  if (strong < 5) notes.push(`Only ${strong} strong indoor candidates — used fallback tier.`);
  if (picks.length < 10) notes.push(`Delivered ${picks.length} (target 10) — DB is thin on confirmed-indoor NYC kid events.`);

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
