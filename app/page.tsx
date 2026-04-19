'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import type { Event, FilterState } from '@/lib/types';
import { initAnalytics, trackEvent as track } from '@/lib/analytics';
import EventDetail from '@/components/EventDetail';
import ChatSidebar from '@/components/ChatSidebar';
import WhatFilter from '@/components/FilterDialogs/WhatFilter';
import WhenFilter from '@/components/FilterDialogs/WhenFilter';
import BudgetFilter from '@/components/FilterDialogs/BudgetFilter';
import WhoFilter from '@/components/FilterDialogs/WhoFilter';
import WhereFilter from '@/components/FilterDialogs/WhereFilter';
import EventCardV2 from '@/components/EventCardV2';
import DateBar from '@/components/DateBar';
import DigestShelf from '@/components/DigestShelf';
import FavoritesPanel from '@/components/FavoritesPanel';
import { FavoritesProvider, useFavorites } from '@/lib/FavoritesContext';
import type { MapBounds } from '@/components/discovery/discovery-state';

const MapView = dynamic(() => import('@/components/MapView'), { ssr: false });

interface Category {
  slug: string;
  label: string;
}

const PAGE_SIZE = 30;

function formatDateRange(filters: FilterState): string {
  // Append T00:00:00 to parse as local time instead of UTC midnight (avoids -1 day offset)
  if (filters.dateFrom && filters.dateTo) {
    const from = new Date(filters.dateFrom + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const to = new Date(filters.dateTo + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${from} - ${to}`;
  }
  if (filters.dateFrom) {
    return `From ${new Date(filters.dateFrom + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  }
  return 'Any date';
}

function formatWho(filters: FilterState): string {
  if (filters.filterChildren && filters.filterChildren.length > 0) {
    const parts = filters.filterChildren.map((c) => {
      const g = c.gender === 'boy' ? '👦' : c.gender === 'girl' ? '👧' : '🧒';
      return `${g}${c.age}`;
    });
    return parts.join(' ');
  }
  if (filters.ageMax !== undefined && filters.ageMax !== null) {
    return `Up to ${filters.ageMax}yo`;
  }
  return 'Anyone';
}

function formatWhere(filters: FilterState): string {
  const nbs = filters.neighborhoods;
  if (!nbs || nbs.length === 0 || nbs.includes('Anywhere in NYC')) return 'Anywhere';
  if (nbs.length === 1) return nbs[0];
  return `${nbs.length} areas`;
}

function formatBudget(filters: FilterState): string {
  if (filters.isFree) return 'Free only';
  if (filters.priceMin !== undefined && filters.priceMax !== undefined) return `$${filters.priceMin} - $${filters.priceMax}`;
  if (filters.priceMin !== undefined) return `From $${filters.priceMin}`;
  if (filters.priceMax !== undefined) return `Up to $${filters.priceMax}`;
  return 'Any budget';
}

export default function Home() {
  return <FavoritesProvider><HomeInner /></FavoritesProvider>;
}

function HomeInner() {
  // Data state
  const [events, setEvents] = useState<Event[]>([]);
  const [allEvents, setAllEvents] = useState<Event[]>([]);   // unfiltered feed
  const [filteredEvents, setFilteredEvents] = useState<Event[]>([]);
  const [total, setTotal] = useState(0);
  const [allTotal, setAllTotal] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  // UI state
  const [filters, setFilters] = useState<FilterState>({});
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'feed' | 'foryou'>('feed');

  // Debug session: tracks events flagged as having a wrong age range.
  // Persists server-side in data/debug_sessions.json. We hold a local copy
  // of flagged ids for instant UI feedback.
  const [flaggedIds, setFlaggedIds] = useState<Set<number>>(new Set());
  const [activeSession, setActiveSession] = useState<{ id: number; flagsCount: number } | null>(null);

  // Active digest — when set, the feed is replaced by a pre-programmed list
  // of events that belong to this digest. Acts like a preset filter.
  // Clicking the already-active digest card toggles it off.
  const [activeDigest, setActiveDigest] = useState<{
    slug: string;
    title: string;
    subtitle?: string;
    curator_name?: string;
    category_tag?: string;
  } | null>(null);
  const [digestEvents, setDigestEvents] = useState<Event[]>([]);
  const [digestLoading, setDigestLoading] = useState(false);

  // Auto-switch to "For you" tab when arriving from quiz + track page view
  useEffect(() => {
    if (typeof window !== 'undefined') {
      initAnalytics();
      const params = new URLSearchParams(window.location.search);
      if (params.get('source') === 'quiz') setActiveTab('foryou');
    }
  }, []);
  const [favoritesOpen, setFavoritesOpen] = useState(false);

  // Price range slider (dual handles)
  const [priceSliderMin, setPriceSliderMin] = useState(0);
  const [priceSliderMax, setPriceSliderMax] = useState(200);
  const [chatResetKey, setChatResetKey] = useState(0);

  // Discovery state
  const [hoveredItemId, setHoveredItemId] = useState<number | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);
  const [searchAreaActive, setSearchAreaActive] = useState(false);
  const [boundsFiltered, setBoundsFiltered] = useState(false);
  const [mapExpanded, setMapExpanded] = useState(false);

  const { favoriteIds, favoriteEvents } = useFavorites();
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Fetch categories on mount — API returns {value,label}, component expects {slug,label}
  useEffect(() => {
    fetch('/api/categories')
      .then((res) => res.json())
      .then((data: { value: string; label: string }[]) => {
        if (Array.isArray(data))
          setCategories(data.map((c) => ({ slug: c.value, label: c.label })));
      })
      .catch(console.error);
  }, []);

  // Fetch all events (no filters) for Feed tab
  useEffect(() => {
    fetch('/api/events?page=1&page_size=500')
      .then((res) => res.json())
      .then((data) => {
        setAllEvents(data.events || []);
        setAllTotal(data.total || 0);
      })
      .catch(console.error);
  }, []);

  // Fetch events when filters or page change
  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('page', '1');
      params.set('page_size', '500');

      if (filters.categories && filters.categories.length > 0) {
        params.set('categories', filters.categories.join(','));
      }
      if (filters.excludeCategories && filters.excludeCategories.length > 0) {
        params.set('exclude_categories', filters.excludeCategories.join(','));
      }
      if (filters.priceMin !== undefined) {
        params.set('price_min', String(filters.priceMin));
      }
      if (filters.priceMax !== undefined) {
        params.set('price_max', String(filters.priceMax));
      }
      if (filters.isFree) {
        params.set('is_free', 'true');
      }
      // Multi-child mode: send all kids' ages so the API can match
      // events suitable for at least one of them and tag partial fits.
      const kidsForFilter = filters.filterChildren && filters.filterChildren.length > 0
        ? filters.filterChildren
        : undefined;
      if (kidsForFilter && kidsForFilter.length >= 2) {
        params.set('child_ages', kidsForFilter.map((c) => c.age).join(','));
        // Pass genders so the API can exclude gender-mismatched events
        const genders = kidsForFilter.map((c) => c.gender).join(',');
        params.set('child_genders', genders);
      } else if (filters.ageMax !== undefined) {
        params.set('age', String(filters.ageMax));
        // Single-child mode: derive gender from filterChildren if available
        if (kidsForFilter && kidsForFilter.length === 1) {
          params.set('child_genders', kidsForFilter[0].gender);
        }
      }
      if (filters.dateFrom) {
        params.set('date_from', filters.dateFrom);
      }
      if (filters.dateTo) {
        params.set('date_to', filters.dateTo);
      }
      if (filters.search) {
        params.set('search', filters.search);
      }
      if (filters.lat && filters.lon && filters.distance) {
        params.set('lat', String(filters.lat));
        params.set('lon', String(filters.lon));
        params.set('distance', String(filters.distance));
      }
      if (filters.neighborhoods && filters.neighborhoods.length > 0) {
        params.set('neighborhoods', filters.neighborhoods.join(','));
      }
      if (filters.ratingMin !== undefined) {
        params.set('rating_min', String(filters.ratingMin));
      }

      const res = await fetch(`/api/events?${params.toString()}`);
      const data = await res.json();

      const evts = data.events || [];
      setEvents(evts);
      setFilteredEvents(evts);
      setTotal(data.total || 0);
      setBoundsFiltered(false);
      setSearchAreaActive(false);
    } catch (err) {
      console.error('Failed to fetch events:', err);
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Load active debug session on mount so flagged checkboxes stay checked across reloads.
  useEffect(() => {
    fetch('/api/flags/age')
      .then((r) => r.json())
      .then((data) => {
        if (data.session) {
          setActiveSession({ id: data.session.id, flagsCount: data.session.flags?.length ?? 0 });
        }
        setFlaggedIds(new Set<number>(data.flagged_ids || []));
      })
      .catch(() => {});
  }, []);

  const toggleFlag = useCallback(async (event: Event, flagged: boolean) => {
    // Optimistic UI
    setFlaggedIds((prev) => {
      const next = new Set(prev);
      if (flagged) next.add(event.id);
      else next.delete(event.id);
      return next;
    });
    try {
      if (flagged) {
        const res = await fetch('/api/flags/age', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_id: event.id,
            title: event.title,
            age_label: event.age_label || null,
            age_min: event.age_min,
            age_best_from: event.age_best_from,
            age_best_to: event.age_best_to,
            filters,
          }),
        });
        const data = await res.json();
        if (data?.session) {
          setActiveSession({ id: data.session.id, flagsCount: data.session.flags.length });
        }
      } else {
        const res = await fetch(`/api/flags/age?event_id=${event.id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data?.session) {
          setActiveSession({ id: data.session.id, flagsCount: data.session.flags.length });
        }
      }
    } catch {
      // Rollback on failure
      setFlaggedIds((prev) => {
        const next = new Set(prev);
        if (flagged) next.delete(event.id);
        else next.add(event.id);
        return next;
      });
    }
  }, [filters]);

  const closeDebugSession = useCallback(async () => {
    try {
      const res = await fetch('/api/debug/session', { method: 'POST' });
      const data = await res.json();
      if (data?.ok) {
        setActiveSession(null);
        setFlaggedIds(new Set());
        // eslint-disable-next-line no-alert
        alert(`Session #${data.closed?.id ?? ''} closed. ${data.closed?.flags?.length ?? 0} flagged events saved to data/debug_sessions.json`);
      }
    } catch {}
  }, []);

  // Scroll card into view when map pin is hovered
  const mapHoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (hoveredItemId === null) return;
    // Small debounce so rapid mouse movements don't thrash the scroll
    if (mapHoverTimeoutRef.current) clearTimeout(mapHoverTimeoutRef.current);
    mapHoverTimeoutRef.current = setTimeout(() => {
      if (resultsRef.current) {
        const cardEl = resultsRef.current.querySelector(`[data-event-id="${hoveredItemId}"]`);
        if (cardEl) cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 80);
    return () => {
      if (mapHoverTimeoutRef.current) clearTimeout(mapHoverTimeoutRef.current);
    };
  }, [hoveredItemId]);

  // Handlers
  const handleEventClick = useCallback((event: Event) => {
    track('card_opened', { event_id: event.id, event_title: event.title });
    setSelectedEvent(event);
    setDetailOpen(true);
    setSelectedItemId(event.id);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setDetailOpen(false);
    setTimeout(() => setSelectedEvent(null), 300);
  }, []);

  const handleFilterReset = useCallback(() => {
    track('filter_applied', { filter_name: 'reset', filter_value: 'all' });
    // Preserve age/children — user clears them only via "Clear" in Who dialog
    setFilters((prev) => {
      const kept: FilterState = {};
      if (prev.ageMax !== undefined) kept.ageMax = prev.ageMax;
      if (prev.filterChildren) kept.filterChildren = prev.filterChildren;
      return kept;
    });
    setPage(1);
    setPriceSliderMin(0);
    setPriceSliderMax(200);
    setActiveTab('feed');
    setChatResetKey((k) => k + 1);
  }, []);

  const handleFiltersFromChat = useCallback((newFilters: FilterState) => {
    setFilters(newFilters);
    setPage(1);
    setActiveTab('foryou');
  }, []);

  // Discovery handlers
  const handleCardClick = useCallback((event: unknown) => {
    const ev = event as { id: number; title: string };
    track('card_clicked', { event_id: ev.id, event_title: ev.title, list_type: 'feed' });
    setSelectedItemId(ev.id);
    setSelectedEvent(event as Parameters<typeof setSelectedEvent>[0]);
    setDetailOpen(true);
  }, []);

  const handleMapSelectItem = useCallback((id: number | null) => {
    setSelectedItemId(id);
    if (id != null && resultsRef.current) {
      const cardEl = resultsRef.current.querySelector(`[data-event-id="${id}"]`);
      if (cardEl) {
        cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, []);

  const handleViewDetailsFromMap = useCallback((event: Event) => {
    setSelectedEvent(event);
    setDetailOpen(true);
    setSelectedItemId(event.id);
  }, []);

  const handleSearchThisArea = useCallback(() => {
    if (!mapBounds) return;
    const inBounds = events.filter((e) => {
      if (e.lat == null || e.lon == null) return false;
      return (
        e.lat >= mapBounds.south &&
        e.lat <= mapBounds.north &&
        e.lon >= mapBounds.west &&
        e.lon <= mapBounds.east
      );
    });
    setFilteredEvents(inBounds);
    setBoundsFiltered(true);
    setSearchAreaActive(false);
  }, [mapBounds, events]);

  const handleBoundsChange = useCallback((bounds: MapBounds) => {
    setMapBounds(bounds);
  }, []);

  // Filter dialog handlers
  const handleWhatApply = useCallback(
    (included: string[], excluded: string[], search: string, highRating: boolean) => {
      track('filter_applied', { filter_name: 'what', filter_value: { categories: included, search, highRating } });
      setFilters((prev) => ({
        ...prev,
        categories: included.length > 0 ? included : undefined,
        excludeCategories: excluded.length > 0 ? excluded : undefined,
        search: search || undefined,
        ratingMin: highRating ? 4.5 : undefined,
      }));
      setPage(1);
      setActiveTab('foryou');
      setOpenFilter(null);
    },
    []
  );

  const handleWhenApply = useCallback((dateFrom: string, dateTo: string) => {
    track('filter_applied', { filter_name: 'when', filter_value: { dateFrom, dateTo } });
    setFilters((prev) => ({
      ...prev,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    }));
    setPage(1);
    setActiveTab('foryou');
    setOpenFilter(null);
  }, []);

  const handleDateBarSelect = useCallback((date: string | undefined) => {
    track('filter_applied', { filter_name: 'datebar', filter_value: date });
    setFilters((prev) => ({
      ...prev,
      dateFrom: date || undefined,
      dateTo: date || undefined,
    }));
    setPage(1);
    if (date) setActiveTab('foryou');
  }, []);

  const handleBudgetApply = useCallback(
    (priceMin?: number, priceMax?: number, isFree?: boolean) => {
      setFilters((prev) => ({
        ...prev,
        priceMin,
        priceMax,
        isFree,
      }));
      setPage(1);
      setActiveTab('foryou');
      setOpenFilter(null);
    },
    []
  );

  const handleWhoApply = useCallback((ageMax?: number, filterChildren?: import('@/lib/types').FilterChild[]) => {
    track('filter_applied', { filter_name: 'who', filter_value: { ageMax } });
    setFilters((prev) => ({
      ...prev,
      ageMax,
      filterChildren,
    }));
    setPage(1);
    setActiveTab('foryou');
    setOpenFilter(null);
  }, []);

  const handleWhereApply = useCallback((neighborhoods: string[]) => {
    track('filter_applied', { filter_name: 'where', filter_value: { neighborhoods } });
    const hasNeighborhoods = neighborhoods.length > 0 && !neighborhoods.includes('Anywhere in NYC');
    setFilters((prev) => ({
      ...prev,
      neighborhoods: hasNeighborhoods ? neighborhoods : undefined,
    }));
    setPage(1);
    setOpenFilter(null);
    setActiveTab('foryou');
  }, []);

  // Price slider handlers (dual range)
  const handlePriceMinChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Math.min(Number(e.target.value), priceSliderMax);
    setPriceSliderMin(val);
  }, [priceSliderMax]);

  const handlePriceMaxChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Math.max(Number(e.target.value), priceSliderMin);
    setPriceSliderMax(val);
  }, [priceSliderMin]);

  const handlePriceSliderCommit = useCallback(() => {
    const hasMin = priceSliderMin > 0;
    const hasMax = priceSliderMax < 200;
    setFilters((prev) => ({
      ...prev,
      priceMin: hasMin ? priceSliderMin : undefined,
      priceMax: hasMax ? priceSliderMax : undefined,
    }));
    setPage(1);
    setActiveTab('foryou');
  }, [priceSliderMin, priceSliderMax]);

  // Digest selection handlers (digest = pre-programmed event set acting as filter).
  const handleDigestSelect = useCallback(async (slug: string) => {
    // Toggle off if clicking the same digest
    if (activeDigest?.slug === slug) {
      setActiveDigest(null);
      setDigestEvents([]);
      return;
    }
    setDigestLoading(true);
    try {
      const res = await fetch(`/api/digests/${slug}`);
      const data = await res.json();
      if (data?.digest && Array.isArray(data?.events)) {
        setActiveDigest({
          slug: data.digest.slug,
          title: data.digest.title,
          subtitle: data.digest.subtitle,
          curator_name: data.digest.curator_name,
          category_tag: data.digest.category_tag,
        });
        setDigestEvents(data.events);
        // Clear conflicting view modes so the digest stands alone.
        if (favoritesOnly) setFavoritesOnly(false);
        track('digest_selected', { slug, event_count: data.events.length });
      }
    } catch (err) {
      console.error('Failed to load digest', err);
    } finally {
      setDigestLoading(false);
    }
  }, [activeDigest, favoritesOnly]);

  const handleDigestClear = useCallback(() => {
    setActiveDigest(null);
    setDigestEvents([]);
  }, []);

  const forYouEvents = boundsFiltered ? filteredEvents : events;
  // Feed always shows ALL events; For You shows filtered results.
  // When a digest is active, it overrides all other sources — the feed
  // becomes exactly the curated digest event list (preset filter behavior).
  const baseEvents = activeTab === 'feed' ? allEvents : forYouEvents;
  const displayEvents = activeDigest
    ? digestEvents
    : (favoritesOnly ? favoriteEvents : baseEvents);
  const displayTotal = activeDigest
    ? digestEvents.length
    : (favoritesOnly ? favoriteIds.size : activeTab === 'feed' ? allTotal : total);

  const sliderMinPct = Math.round((priceSliderMin / 200) * 100);
  const sliderMaxPct = Math.round((priceSliderMax / 200) * 100);

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* ===== Header ===== */}
      <header className="v2-header">
        {/* Logo */}
        <button onClick={() => { localStorage.removeItem('pulseup_profile'); window.location.replace(window.location.pathname); }} className="v2-header-logo" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <img src="/logo.png" alt="Pulse" style={{ height: 36, width: 'auto' }} />
        </button>

        {/* Center: title + tabs */}
        <div className="flex items-center gap-4">
          <div className="v2-header-center">
            <span className="v2-header-title">Epic kids events in NYC</span>
          </div>
          <div className="v2-header-tabs">
            <button
              className={`v2-header-tab ${activeTab === 'feed' ? 'active' : ''}`}
              onClick={() => { track('tab_switched', { tab: 'feed' }); setActiveTab('feed'); }}
            >
              All ({allTotal})
            </button>
            <button
              className={`v2-header-tab ${activeTab === 'foryou' ? 'active' : ''}`}
              onClick={() => { track('tab_switched', { tab: 'foryou' }); setActiveTab('foryou'); }}
            >
              For you ({total})
            </button>
          </div>
        </div>

        {/* Right icons */}
        <div className="v2-header-right">
          <button
            className="v2-header-icon"
            onClick={() => setFavoritesOnly((v) => !v)}
            style={{ position: 'relative' }}
            title={favoritesOnly ? 'Show all events' : 'Show saved events'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill={favoritesOnly ? '#e91e63' : favoriteIds.size > 0 ? '#e91e63' : 'none'} stroke="#e91e63" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
            {favoriteIds.size > 0 && (
              <span style={{
                position: 'absolute', top: -4, right: -4,
                background: '#e91e63', color: 'white',
                fontSize: 9, fontWeight: 700,
                width: 16, height: 16, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {favoriteIds.size}
              </span>
            )}
          </button>
          <div className="v2-header-avatar">M</div>
        </div>
      </header>

      {/* ===== Main 3-column layout ===== */}
      <div className="discovery-layout">
        {/* LEFT SIDEBAR: filters + chat */}
        <aside className="v2-sidebar">
          {/* Filter section */}
          <div className="v2-sidebar-filters">
            <div className="v2-sidebar-filters-label">Refine Search</div>

            {/* Price Range Slider (dual handle) */}
            <div className="v2-price-range">
              <div className="v2-price-range-header">
                <span className="v2-price-range-label">Price Range</span>
                <span className="v2-price-range-value">
                  ${priceSliderMin} &ndash; ${priceSliderMax >= 200 ? '200+' : priceSliderMax}
                </span>
              </div>
              <div
                className="v2-dual-range"
                style={{
                  '--range-min': `${sliderMinPct}%`,
                  '--range-max': `${sliderMaxPct}%`,
                } as React.CSSProperties}
              >
                <div className="v2-dual-range-track" />
                <div className="v2-dual-range-fill" />
                <input
                  type="range"
                  min="0"
                  max="200"
                  value={priceSliderMin}
                  onChange={handlePriceMinChange}
                  onMouseUp={handlePriceSliderCommit}
                  onTouchEnd={handlePriceSliderCommit}
                  className="v2-price-slider v2-price-slider--min"
                />
                <input
                  type="range"
                  min="0"
                  max="200"
                  value={priceSliderMax}
                  onChange={handlePriceMaxChange}
                  onMouseUp={handlePriceSliderCommit}
                  onTouchEnd={handlePriceSliderCommit}
                  className="v2-price-slider v2-price-slider--max"
                />
              </div>
            </div>

            {/* What filter */}
            <div className="v2-filter-item" onClick={() => setOpenFilter('what')}>
              <div className="v2-filter-item-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                </svg>
              </div>
              <span className="v2-filter-item-label">What</span>
              <span className="v2-filter-item-value">
                {filters.categories && filters.categories.length > 0
                  ? `${filters.categories.length} selected`
                  : 'Activities'}
              </span>
              <span className="v2-filter-item-chevron">&rsaquo;</span>
            </div>

            {/* Date filter */}
            <div className="v2-filter-item" onClick={() => setOpenFilter('when')}>
              <div className="v2-filter-item-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </div>
              <span className="v2-filter-item-label">Date</span>
              <span className="v2-filter-item-value">{formatDateRange(filters)}</span>
              <span className="v2-filter-item-chevron">&rsaquo;</span>
            </div>

            {/* Who filter */}
            <div className="v2-filter-item" onClick={() => setOpenFilter('who')}>
              <div className="v2-filter-item-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </div>
              <span className="v2-filter-item-label">Who</span>
              <span className="v2-filter-item-value">{formatWho(filters)}</span>
              <span className="v2-filter-item-chevron">&rsaquo;</span>
            </div>

            {/* Where filter */}
            <div className="v2-filter-item" onClick={() => setOpenFilter('where')}>
              <div className="v2-filter-item-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
              </div>
              <span className="v2-filter-item-label">Where</span>
              <span className="v2-filter-item-value">{formatWhere(filters)}</span>
              <span className="v2-filter-item-chevron">&rsaquo;</span>
            </div>

            {/* Reset button */}
            {(filters.categories || filters.priceMin !== undefined || filters.priceMax !== undefined || filters.dateFrom || filters.ageMax !== undefined || filters.isFree || filters.neighborhoods) && (
              <button
                onClick={handleFilterReset}
                className="mt-2 w-full text-center text-xs py-1.5 rounded-lg transition-colors"
                style={{ color: 'var(--primary)', background: 'rgba(233,30,99,0.1)' }}
              >
                Reset all filters
              </button>
            )}
          </div>

          <div className="v2-sidebar-divider" />

          {/* Chat section */}
          <div className="v2-chat-section">
            <div className="v2-chat-header">
              <div className="v2-chat-header-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <div className="v2-chat-header-text">
                <span className="v2-chat-header-title">Pulse Assistant</span>
                <span className="v2-chat-header-subtitle">Exploring New York City</span>
              </div>
            </div>

            {/* ChatSidebar (reused, but rendered inline in the sidebar) */}
            <ChatSidebar
              key={chatResetKey}
              filters={filters}
              onFiltersChange={handleFiltersFromChat}
              onEventClick={handleEventClick}
            />
          </div>
        </aside>

        {/* CENTER: results grid */}
        <div className="results-column" ref={resultsRef}>
          {/* Digest shelf — always visible above event grid.
              Clicking a digest replaces the feed with its pre-programmed events. */}
          <DigestShelf
            onDigestSelect={handleDigestSelect}
            activeDigestSlug={activeDigest?.slug ?? null}
          />

          {/* Active-digest banner: shows which preset is applied + clear button */}
          {activeDigest && (
            <div className="active-digest-banner">
              <div className="active-digest-banner__info">
                <span className="active-digest-banner__icon">📚</span>
                <div>
                  <div className="active-digest-banner__title">
                    {activeDigest.title}
                    <span className="active-digest-banner__count">· {digestEvents.length} events</span>
                  </div>
                  {(activeDigest.subtitle || activeDigest.curator_name) && (
                    <div className="active-digest-banner__sub">
                      {activeDigest.subtitle}
                      {activeDigest.curator_name && (
                        <span className="active-digest-banner__curator"> by {activeDigest.curator_name}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <button
                className="active-digest-banner__clear"
                onClick={handleDigestClear}
                aria-label="Clear digest"
              >
                ✕ Clear
              </button>
            </div>
          )}

          {loading || digestLoading ? (
            <div className="results-loading">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="result-skeleton">
                  <div className="result-skeleton-img" />
                  <div className="result-skeleton-text">
                    <div className="result-skeleton-line w-3/4" />
                    <div className="result-skeleton-line w-1/2" />
                    <div className="result-skeleton-line w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : displayEvents.length === 0 ? (
            <div className="results-empty">
              <p className="text-base">No events found</p>
              <p className="text-sm mt-1">Try adjusting your filters</p>
            </div>
          ) : (
            <>
              <div className="results-sticky-top">
                <div className="all-events-heading">
                  <span>All Events</span>
                  <span className="all-events-count">{displayTotal}</span>
                </div>
                <DateBar
                  selectedDate={filters.dateFrom === filters.dateTo ? filters.dateFrom : undefined}
                  onSelect={handleDateBarSelect}
                />
              </div>
              <div className={mapExpanded ? 'results-list results-list--2col' : 'results-list'}>
                {displayEvents.map((event) => (
                  <EventCardV2
                    key={event.id}
                    event={event}
                    isHovered={hoveredItemId === event.id}
                    isSelected={selectedItemId === event.id}
                    onMouseEnter={() => setHoveredItemId(event.id)}
                    onMouseLeave={() => setHoveredItemId(null)}
                    onClick={() => handleCardClick(event)}
                    isFlagged={flaggedIds.has(event.id)}
                    onToggleFlag={toggleFlag}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* RIGHT: map */}
        <div className={mapExpanded ? 'map-column map-column--expanded' : 'map-column'}>
          <button
            className="map-expand-btn"
            onClick={() => setMapExpanded(v => !v)}
            title={mapExpanded ? 'Collapse map' : 'Expand map'}
          >
            {mapExpanded ? '›' : '‹'}
          </button>
          <MapView
            events={displayEvents}
            hoveredItemId={hoveredItemId}
            selectedItemId={selectedItemId}
            onHoverItem={setHoveredItemId}
            onSelectItem={handleMapSelectItem}
            onBoundsChange={handleBoundsChange}
            onSearchAreaActive={setSearchAreaActive}
            searchAreaActive={searchAreaActive}
            onSearchThisArea={handleSearchThisArea}
            onViewDetails={handleViewDetailsFromMap}
          />
        </div>
      </div>

      {/* Event Detail Overlay */}
      <EventDetail
        event={selectedEvent}
        open={detailOpen}
        onClose={handleCloseDetail}
        isFlagged={selectedEvent ? flaggedIds.has(selectedEvent.id) : false}
        onToggleFlag={toggleFlag}
      />

      {/* Floating debug session widget — visible whenever there is at least 1 flag */}
      {(activeSession && (activeSession.flagsCount > 0 || flaggedIds.size > 0)) && (
        <div className="debug-session-widget">
          <div className="debug-session-info">
            <span className="debug-session-title">Debug Session #{activeSession.id}</span>
            <span className="debug-session-count">{flaggedIds.size} flagged</span>
          </div>
          <button
            type="button"
            className="debug-session-close"
            onClick={closeDebugSession}
            title="Close session and save snapshot"
          >
            Close session
          </button>
        </div>
      )}

      {/* Filter Dialogs */}
      {openFilter === 'what' && (
        <WhatFilter
          categories={categories}
          includedCategories={filters.categories || []}
          excludedCategories={filters.excludeCategories || []}
          search={filters.search || ''}
          highRating={filters.ratingMin !== undefined && filters.ratingMin >= 4.5}
          onApply={handleWhatApply}
          onClose={() => setOpenFilter(null)}
        />
      )}
      {openFilter === 'when' && (
        <WhenFilter
          dateFrom={filters.dateFrom || ''}
          dateTo={filters.dateTo || ''}
          onApply={handleWhenApply}
          onClose={() => setOpenFilter(null)}
        />
      )}
      {openFilter === 'budget' && (
        <BudgetFilter
          priceMin={filters.priceMin}
          priceMax={filters.priceMax}
          isFree={filters.isFree}
          onApply={handleBudgetApply}
          onClose={() => setOpenFilter(null)}
        />
      )}
      {openFilter === 'who' && (
        <WhoFilter
          ageMax={filters.ageMax}
          children={filters.filterChildren}
          onApply={handleWhoApply}
          onRemember={(kids) => {
            try {
              const stored = localStorage.getItem('pulseup_profile');
              const profile = stored ? JSON.parse(stored) : {};
              profile.children = kids.map((c) => ({ age: c.age, gender: c.gender, interests: [] }));
              localStorage.setItem('pulseup_profile', JSON.stringify(profile));
            } catch { /* ignore */ }
          }}
          onClose={() => setOpenFilter(null)}
        />
      )}
      {openFilter === 'where' && (
        <WhereFilter
          selected={filters.neighborhoods || []}
          onApply={handleWhereApply}
          onClose={() => setOpenFilter(null)}
        />
      )}

      <FavoritesPanel
        open={favoritesOpen}
        onClose={() => setFavoritesOpen(false)}
        onEventClick={(event) => {
          setSelectedEvent(event);
          setDetailOpen(true);
        }}
      />
    </div>
  );
}
