/**
 * Tiny helpers shared across per-digest scoring functions.
 */

import type { EnrichedEvent, ScoredEvent } from './types';
import { classifyCompleteness, classifyNYC, classifyManhattan } from './signals';

/**
 * Base score shared by all digests: NYC relevance (0–30) + Manhattan bonus (0–10)
 * + data completeness (0–10). Roughly 0..50.
 */
export function baseGeoAndCompleteness(ev: EnrichedEvent): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const nyc = classifyNYC(ev);
  if (nyc.confidence > 0) {
    const pts = Math.round(nyc.confidence * 30);
    score += pts;
    if (pts >= 20) reasons.push(`NYC (${pts})`);
  }

  const manh = classifyManhattan(ev);
  if (manh.confidence > 0) {
    const pts = Math.round(manh.confidence * 10);
    score += pts;
    if (pts >= 5) reasons.push(`Manhattan (${pts})`);
  }

  const comp = classifyCompleteness(ev);
  const pts = Math.round(comp.confidence * 10);
  score += pts;
  if (pts >= 7) reasons.push(`complete card (${pts})`);

  return { score, reasons };
}

/**
 * Pick the top N events from a scored list, with a graceful fallback:
 *   - If fewer than `minStrong` events score above `strongFloor`, relax the
 *     threshold to `weakFloor` and include up to `target` total.
 *   - Any event below `absoluteFloor` is dropped regardless.
 *
 * Returns { picks, strong_count, weak_count, skipped }.
 */
export function pickWithFallback(
  scored: ScoredEvent[],
  opts: {
    target: number;
    strongFloor: number;
    weakFloor: number;
    absoluteFloor: number;
    minStrong?: number;
  },
): { picks: ScoredEvent[]; strong: number; weak: number; skipped: number } {
  const { target, strongFloor, weakFloor, absoluteFloor, minStrong = 5 } = opts;

  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const strong = sorted.filter((s) => s.score >= strongFloor);
  const medium = sorted.filter((s) => s.score >= weakFloor && s.score < strongFloor);

  const picks: ScoredEvent[] = [];
  picks.push(...strong.slice(0, target));

  if (picks.length < minStrong && weakFloor < strongFloor) {
    const need = target - picks.length;
    picks.push(...medium.slice(0, need));
  } else if (picks.length < target) {
    // Fill up to target with mediums — but never dip below the absolute floor.
    const need = target - picks.length;
    picks.push(...medium.slice(0, need));
  }

  // Enforce absolute floor on the final list.
  const finalPicks = picks.filter((s) => s.score >= absoluteFloor);
  const skipped = scored.length - finalPicks.length - strong.length - medium.length;

  return {
    picks: finalPicks.slice(0, target),
    strong: strong.length,
    weak: medium.length,
    skipped: Math.max(0, scored.length - finalPicks.length),
  };
}

/**
 * Deduplicate events by id and by title (lower-cased, whitespace-normalized).
 * Keeps the highest-scoring duplicate.
 */
export function dedupe(scored: ScoredEvent[]): ScoredEvent[] {
  const byId = new Map<number, ScoredEvent>();
  const byTitle = new Map<string, ScoredEvent>();
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  for (const s of sorted) {
    if (byId.has(s.event.id)) continue;
    const key = (s.event.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (key && byTitle.has(key)) continue;
    byId.set(s.event.id, s);
    if (key) byTitle.set(key, s);
  }
  return Array.from(byId.values()).sort((a, b) => b.score - a.score);
}
