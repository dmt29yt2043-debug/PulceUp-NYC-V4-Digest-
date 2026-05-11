'use client';

import { useEffect, useMemo, useState } from 'react';
import DigestCard from './DigestCard';
import type { Event, FilterState } from '@/lib/types';
import { eventMatchesFilters, hasActiveFilters } from '@/lib/event-filter';

/**
 * The shelf is filter-aware: whenever the user applies filters (sidebar, chat,
 * or chip), we count how many of each digest's curated events still match and
 * re-rank accordingly. Digests with zero overlap are hidden while filters are
 * active, so the shelf doubles as a "curated preset search" surface instead
 * of a fixed row.
 *
 * Implementation: the /api/digests response now includes each digest's top
 * events inline, so the intersection runs client-side in microseconds — no
 * extra round-trip per filter change.
 */
interface Digest {
  id: number;
  slug: string;
  title: string;
  subtitle: string;
  cover_image: string;
  category_tag: string;
  curator_name: string;
  curator_role: string;
  event_count: number;
  context_tags: string;
  category: string;
  /** Top events belonging to this digest (added in /api/digests route). */
  events?: Event[];
}

interface Category {
  name: string;
  digests: Digest[];
}

interface DigestShelfProps {
  onDigestSelect: (slug: string) => void;
  activeDigestSlug: string | null;
  /** Current filter state — drives relevance ranking + hiding. */
  filters?: FilterState;
}

/** Minimum matching events to keep a digest on the shelf when filters are active. */
const MIN_MATCHES_WHEN_FILTERED = 2;

export default function DigestShelf({
  onDigestSelect,
  activeDigestSlug,
  filters,
}: DigestShelfProps) {
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    fetch('/api/digests')
      .then((r) => r.json())
      .then((d) => setCategories(d.categories || []))
      .catch(console.error);
  }, []);

  const allDigests = useMemo(
    () => categories.flatMap((cat) => cat.digests),
    [categories],
  );

  // Compute per-digest match count against the current filters.
  // When no filters are active, matchCount === event_count (no-op).
  const filtersActive = !!filters && hasActiveFilters(filters);
  const matchCountBySlug = useMemo<Record<string, number>>(() => {
    if (!filtersActive || !filters) return {};
    const out: Record<string, number> = {};
    for (const d of allDigests) {
      const events = d.events ?? [];
      out[d.slug] = events.filter((e) => eventMatchesFilters(e, filters)).length;
    }
    return out;
  }, [allDigests, filters, filtersActive]);

  // Shelf contents:
  //   - no filters: show all digests in natural order
  //   - filters:    hide digests with < MIN_MATCHES matches, sort by match count desc
  const shelfDigests = useMemo(() => {
    if (!filtersActive) return allDigests;
    return allDigests
      .filter((d) => (matchCountBySlug[d.slug] ?? 0) >= MIN_MATCHES_WHEN_FILTERED)
      .sort((a, b) => (matchCountBySlug[b.slug] ?? 0) - (matchCountBySlug[a.slug] ?? 0));
  }, [allDigests, filtersActive, matchCountBySlug]);

  if (categories.length === 0) return null;

  // If filters wiped out all digests, keep the active one visible (so the
  // user can still deselect it) but don't render an empty shelf.
  if (filtersActive && shelfDigests.length === 0 && !activeDigestSlug) return null;

  return (
    <div className="digest-shelf">
      <div className="digest-shelf-header">
        <div className="digest-shelf-title-row">
          <div>
            <h2 className="digest-shelf-title">Mom&apos;s Digest</h2>
            <p className="digest-shelf-sub">
              {filtersActive
                ? 'Curated sets matching your filters.'
                : 'Curated collections for your lifestyle.'}
            </p>
          </div>
        </div>
      </div>

      <div className="digest-shelf-row">
        {shelfDigests.map((d) => {
          const count = filtersActive ? (matchCountBySlug[d.slug] ?? 0) : d.event_count;
          return (
            <DigestCard
              key={d.slug}
              // Override event_count with the filter-aware count so the tile
              // displays "3 match your filters" instead of the total.
              digest={{ ...d, event_count: count }}
              onClick={onDigestSelect}
              isActive={activeDigestSlug === d.slug}
            />
          );
        })}
      </div>
    </div>
  );
}
