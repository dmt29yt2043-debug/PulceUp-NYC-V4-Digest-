/**
 * Digest 1 — Top 10 Things to Do with Kids in NYC This Weekend.
 *
 * Hard filter: event has an upcoming Sat/Sun within 14 days (extends to 28 if
 * < 5 candidates in the base window).
 * Score: NYC + Family + Quality + "upcoming soon" bonus.
 */

import type { EnrichedEvent, DigestResult, ScoredEvent, DigestMeta, EventRow } from './types';
import { THRESHOLDS } from './constants';
import { classifyFamily, classifyQuality, classifyWeekend } from './signals';
import { baseGeoAndCompleteness, dedupe, pickWithFallback } from './scoring-helpers';

const SLUG = 'weekend-kids-nyc';

const META: Omit<DigestMeta, 'cover_image' | 'event_count'> = {
  id: 101,
  slug: SLUG,
  title: 'Top 10 Things to Do with Kids in NYC This Weekend',
  subtitle: "Best picks for this weekend — so you don't have to scroll through everything.",
  category: "Mom's Digest",
  category_tag: 'WEEKEND',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['weekend', 'family', 'outdoor', 'indoor']),
};

export function scoreWeekend(ev: EnrichedEvent, nowMs: number, windowDays: number): ScoredEvent | null {
  const weekend = classifyWeekend(ev, nowMs, windowDays);
  if (weekend.confidence === 0) return null;

  const reasons: string[] = [];
  let score = 0;

  const base = baseGeoAndCompleteness(ev);
  score += base.score;
  reasons.push(...base.reasons);

  // Weekend is a hard filter, but we still reward "this coming weekend" over
  // "next weekend" — proximity bonus.
  if (weekend.matchedDate) {
    const ms = Date.parse(weekend.matchedDate);
    const daysAway = Math.max(0, Math.floor((ms - nowMs) / 86400000));
    const prox = Math.max(0, 10 - daysAway);  // 0..10
    score += prox;
    reasons.push(`${weekend.reasons[0]} (+${prox})`);
  }

  const fam = classifyFamily(ev);
  const famPts = Math.round(fam.confidence * 25);
  score += famPts;
  if (famPts >= 15) reasons.push(`family (${famPts})`);

  const q = classifyQuality(ev);
  const qPts = Math.round(q.confidence * 20);
  score += qPts;
  if (qPts >= 12) reasons.push(`quality (${qPts})`);

  return { event: ev, score, reasons };
}

export function getWeekendDigest(events: EnrichedEvent[], nowMs: number): DigestResult {
  const notes: string[] = [];

  // Try the 14-day window first.
  let scored = events.map((e) => scoreWeekend(e, nowMs, THRESHOLDS.WEEKEND_WINDOW_DAYS))
    .filter((s): s is ScoredEvent => s !== null);

  if (scored.length < 5) {
    notes.push(`Only ${scored.length} candidates in 14-day window — extending to 28 days.`);
    scored = events.map((e) => scoreWeekend(e, nowMs, THRESHOLDS.WEEKEND_FALLBACK_DAYS))
      .filter((s): s is ScoredEvent => s !== null);
  }

  const deduped = dedupe(scored);
  const { picks, strong, weak, skipped } = pickWithFallback(deduped, {
    target: 10,
    strongFloor: 55,
    weakFloor: 35,
    absoluteFloor: THRESHOLDS.ABSOLUTE_FLOOR,
  });

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
