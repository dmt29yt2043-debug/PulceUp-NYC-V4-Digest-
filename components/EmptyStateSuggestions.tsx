'use client';

/**
 * Smart empty-state for the events grid.
 *
 * When the user's filter combo returns 0 matches, we fire 3 relaxation queries
 * in parallel and surface the strongest alternative:
 *   · drop date     → nearest day that does have events
 *   · drop area     → other boroughs with matches
 *   · drop cats     → same area/date/age, any category
 *
 * Each suggestion is a chip that applies the relaxation when clicked. Keeps
 * users moving instead of staring at "try adjusting your filters".
 */

import { useEffect, useState } from 'react';
import type { FilterState, Event } from '@/lib/types';

interface Props {
  filters: FilterState;
  onApply: (next: FilterState) => void;
}

interface Suggestion {
  key: string;
  label: string;
  hint: string;
  count: number;
  apply: () => void;
}

const NYC_BOROUGHS = ['Upper Manhattan', 'Midtown', 'Lower Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'];

function buildQuery(filters: FilterState, overrides: Partial<FilterState> = {}, drop: (keyof FilterState)[] = []): URLSearchParams {
  const merged: FilterState = { ...filters, ...overrides };
  for (const k of drop) delete merged[k];

  const params = new URLSearchParams();
  params.set('page', '1');
  params.set('page_size', '100');

  if (merged.categories?.length) params.set('categories', merged.categories.join(','));
  if (merged.excludeCategories?.length) params.set('exclude_categories', merged.excludeCategories.join(','));
  if (merged.priceMin !== undefined) params.set('price_min', String(merged.priceMin));
  if (merged.priceMax !== undefined) params.set('price_max', String(merged.priceMax));
  if (merged.isFree) params.set('is_free', 'true');
  if (merged.ageMax !== undefined) params.set('age', String(merged.ageMax));
  if (merged.dateFrom) params.set('date_from', merged.dateFrom);
  if (merged.dateTo) params.set('date_to', merged.dateTo);
  if (merged.search) params.set('search', merged.search);
  if (merged.neighborhoods?.length) params.set('neighborhoods', merged.neighborhoods.join(','));
  return params;
}

function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' });
}

export default function EmptyStateSuggestions({ filters, onApply }: Props) {
  const [loading, setLoading] = useState(true);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let canceled = false;

    (async () => {
      setLoading(true);
      setSuggestions([]);

      // Build 3 probes:
      //  A) drop date  → any upcoming date with matches
      //  B) drop area  → anywhere-in-NYC
      //  C) drop cats  → same area/date/age
      const today = new Date().toISOString().slice(0, 10);
      const probeA = buildQuery(filters, { dateFrom: today }, ['dateTo']);
      const probeB = buildQuery(filters, {}, ['neighborhoods']);
      const probeC = buildQuery(filters, {}, ['categories', 'excludeCategories']);

      try {
        const [resA, resB, resC] = await Promise.all([
          fetch(`/api/events?${probeA}`, { signal: controller.signal }).then((r) => r.json()).catch(() => null),
          fetch(`/api/events?${probeB}`, { signal: controller.signal }).then((r) => r.json()).catch(() => null),
          fetch(`/api/events?${probeC}`, { signal: controller.signal }).then((r) => r.json()).catch(() => null),
        ]);
        if (canceled) return;

        const out: Suggestion[] = [];

        // A — nearest date with events (only meaningful if a date filter was set)
        if ((filters.dateFrom || filters.dateTo) && resA?.events?.length) {
          const byDate = new Map<string, number>();
          for (const ev of resA.events as Event[]) {
            const day = (ev.next_start_at || '').slice(0, 10);
            if (!day || day < today) continue;
            byDate.set(day, (byDate.get(day) || 0) + 1);
          }
          const sorted = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
          const nearest = sorted[0];
          if (nearest && nearest[0] !== filters.dateFrom) {
            out.push({
              key: 'date',
              label: `Try ${formatDate(nearest[0])}`,
              hint: `${nearest[1]} event${nearest[1] === 1 ? '' : 's'} that day`,
              count: nearest[1],
              apply: () => onApply({ ...filters, dateFrom: nearest[0], dateTo: nearest[0] }),
            });
          }
        }

        // B — nearby boroughs (only if neighborhoods filter is active)
        if (filters.neighborhoods?.length && resB?.events?.length) {
          const byArea = new Map<string, number>();
          for (const ev of resB.events as Event[]) {
            const loc = `${ev.city || ''} ${ev.address || ''}`.toLowerCase();
            for (const nb of NYC_BOROUGHS) {
              if (filters.neighborhoods?.includes(nb)) continue;
              if (loc.includes(nb.toLowerCase())) {
                byArea.set(nb, (byArea.get(nb) || 0) + 1);
                break;
              }
            }
          }
          const topArea = [...byArea.entries()].sort((a, b) => b[1] - a[1])[0];
          if (topArea && topArea[1] > 0) {
            out.push({
              key: 'area',
              label: `Try ${topArea[0]}`,
              hint: `${topArea[1]} event${topArea[1] === 1 ? '' : 's'} match your other filters`,
              count: topArea[1],
              apply: () => onApply({ ...filters, neighborhoods: [topArea[0]] }),
            });
          }
        }

        // C — drop categories (only if categories filter is active)
        if (filters.categories?.length && resC?.total > 0) {
          out.push({
            key: 'cats',
            label: 'Any category',
            hint: `${resC.total} event${resC.total === 1 ? '' : 's'} if we ignore categories`,
            count: resC.total,
            apply: () => {
              const next = { ...filters };
              delete next.categories;
              delete next.excludeCategories;
              onApply(next);
            },
          });
        }

        setSuggestions(out.slice(0, 3));
      } catch {
        if (!canceled) setSuggestions([]);
      } finally {
        if (!canceled) setLoading(false);
      }
    })();

    return () => {
      canceled = true;
      controller.abort();
    };
  }, [filters, onApply]);

  if (loading) {
    return (
      <div style={{ textAlign: 'center', color: '#777', fontSize: 13, marginTop: 10 }}>
        Looking for alternatives…
      </div>
    );
  }

  if (suggestions.length === 0) return null;

  return (
    <div style={{ marginTop: 20, maxWidth: 480, margin: '20px auto 0', textAlign: 'left' }}>
      <div style={{ color: '#aaa', fontSize: 13, marginBottom: 10, textAlign: 'center' }}>
        Here&rsquo;s what we found nearby:
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {suggestions.map((s) => (
          <button
            key={s.key}
            onClick={s.apply}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              background: 'rgba(233,30,99,0.12)',
              border: '1px solid rgba(233,30,99,0.35)',
              borderRadius: 10,
              color: '#fff',
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(233,30,99,0.22)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(233,30,99,0.12)')}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{s.label}</div>
              <div style={{ fontSize: 12, color: '#bbb', marginTop: 2 }}>{s.hint}</div>
            </div>
            <span style={{ fontSize: 18, color: '#e91e63' }}>›</span>
          </button>
        ))}
      </div>
    </div>
  );
}
