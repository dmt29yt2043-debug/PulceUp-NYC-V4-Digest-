/**
 * Client-side event ↔ filter intersection — shared by the main event feed
 * and the DigestShelf. Only covers filters that constrain the visible event
 * set (isFree, price range, age, date range, categories, neighborhoods).
 * Chat/search and map bounds are intentionally excluded — those run on the
 * server side via /api/events.
 */

import type { Event, FilterState } from '@/lib/types';

/**
 * True if `event` survives `filters`. Matches the server-side semantics of
 * /api/events for the filter fields it covers. Used to:
 *   1. Client-side recompute the feed when the user narrows filters without
 *      waiting for a round-trip.
 *   2. Score digest overlap against the current filter set so the shelf can
 *      hide / re-rank digests whose events no longer match.
 */
export function eventMatchesFilters(event: Event, filters: FilterState): boolean {
  // isFree
  if (filters.isFree && !event.is_free) return false;

  // Price range — only apply when the event actually has pricing info (>0)
  if (filters.priceMin !== undefined && filters.priceMin > 0) {
    if (event.is_free) return false;
    if ((event.price_max ?? 0) < filters.priceMin) return false;
  }
  if (filters.priceMax !== undefined && !event.is_free) {
    if ((event.price_min ?? 0) > filters.priceMax) return false;
  }

  // Age (ageMax = upper bound kid can attend)
  if (filters.ageMax !== undefined && filters.ageMax !== null) {
    const bestFrom = event.age_best_from ?? event.age_min;
    if (bestFrom !== null && bestFrom !== undefined && bestFrom > filters.ageMax) return false;
    if (event.age_best_to !== null && event.age_best_to !== undefined && event.age_best_to < filters.ageMax) return false;
  }

  // Date range
  const startStr = event.next_start_at;
  if (filters.dateFrom && startStr) {
    if (startStr.slice(0, 10) < filters.dateFrom) return false;
  }
  if (filters.dateTo && startStr) {
    if (startStr.slice(0, 10) > filters.dateTo) return false;
  }

  // Categories — match against category_l1, categories JSON, tags JSON
  if (filters.categories && filters.categories.length > 0) {
    const cats = (event.categories || []).map((c) => String(c).toLowerCase());
    const tags = (event.tags || []).map((t) => String(t).toLowerCase());
    const l1 = (event.category_l1 || '').toLowerCase();
    const wanted = filters.categories.map((c) => c.toLowerCase());
    const hit = wanted.some((w) => l1 === w || cats.some((c) => c.includes(w)) || tags.some((t) => t.includes(w)));
    if (!hit) return false;
  }

  // Exclude categories
  if (filters.excludeCategories && filters.excludeCategories.length > 0) {
    const l1 = (event.category_l1 || '').toLowerCase();
    if (filters.excludeCategories.some((c) => c.toLowerCase() === l1)) return false;
  }

  // Neighborhoods (simple substring match against city/address)
  if (filters.neighborhoods && filters.neighborhoods.length > 0 && !filters.neighborhoods.includes('Anywhere in NYC')) {
    const loc = `${event.city || ''} ${event.address || ''}`.toLowerCase();
    const hit = filters.neighborhoods.some((n) => loc.includes(n.toLowerCase()));
    if (!hit) return false;
  }

  return true;
}

/**
 * True if `filters` has any meaningful constraint set. Used by DigestShelf
 * to decide whether to show per-digest match counts vs. the default display.
 */
export function hasActiveFilters(filters: FilterState): boolean {
  return !!(
    filters.isFree ||
    filters.priceMin !== undefined ||
    filters.priceMax !== undefined ||
    (filters.ageMax !== undefined && filters.ageMax !== null) ||
    filters.dateFrom ||
    filters.dateTo ||
    (filters.categories && filters.categories.length > 0) ||
    (filters.excludeCategories && filters.excludeCategories.length > 0) ||
    (filters.neighborhoods && filters.neighborhoods.length > 0 &&
      !filters.neighborhoods.includes('Anywhere in NYC'))
  );
}
