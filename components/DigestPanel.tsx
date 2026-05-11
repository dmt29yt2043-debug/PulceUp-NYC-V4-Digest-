'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatAgeLabel } from '@/lib/age-label';

interface DigestEvent {
  id: number;
  title: string;
  short_title: string;
  venue_name: string;
  neighborhood: string;
  age_label: string;
  next_start_at: string;
  next_end_at: string;
  is_free: number;
  price_min: number;
  price_max: number;
  image_url: string;
  rating_avg: number;
  curator_note: string;
  duration_min: number;
}

interface DigestDetail {
  digest: {
    title: string;
    subtitle: string;
    cover_image: string;
    category_tag: string;
    curator_name: string;
    curator_role: string;
  };
  events: DigestEvent[];
}

interface DigestPanelProps {
  slug: string;
  onClose: () => void;
  onEventClick: (event: DigestEvent) => void;
}

type ViewMode = 'schedule' | 'events';

// ── helpers ────────────────────────────────────────────────────────────────
function fmtTime(s: string) {
  if (!s) return '';
  try { return new Date(s).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}
function fmtWeekdayShort(s: string) {
  if (!s) return 'TBD';
  try { return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(); }
  catch { return 'TBD'; }
}
function fmtWeekdayFull(s: string) {
  if (!s) return 'Upcoming';
  try { return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }); }
  catch { return 'Upcoming'; }
}
function fmtMonthDay(s: string) {
  if (!s) return '';
  try { return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  catch { return ''; }
}
function fmtDateKey(s: string) {
  if (!s) return 'tbd';
  try { return new Date(s).toISOString().slice(0, 10); }
  catch { return 'tbd'; }
}
function fmtDateRange(start: string, end: string) {
  if (!start) return '';
  try {
    const s = new Date(start.includes('T') ? start : start + 'T00:00:00');
    const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (!end) return fmt(s);
    const e = new Date(end.includes('T') ? end : end + 'T00:00:00');
    const diff = Math.round((e.getTime() - s.getTime()) / 86400000);
    if (diff <= 0) return fmt(s);
    if (diff > 7) return `Through ${fmt(e)}`;
    return `${fmt(s)}–${fmt(e)}`;
  } catch { return ''; }
}
function priceText(ev: DigestEvent) {
  if (ev.is_free) return 'FREE';
  if (ev.price_min > 0 && ev.price_max > ev.price_min) return `$${ev.price_min}–$${ev.price_max}`;
  if (ev.price_min > 0) return `$${ev.price_min}`;
  return '';
}
function dur(min: number) {
  if (!min) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h ? h + 'h ' : ''}${m}min` : `${h}h`;
}

// ── Transit data by neighborhood ───────────────────────────────────────────
const TRANSIT: Record<string, { lines: string; station: string; walk: string }> = {
  'soho':           { lines: 'N·R·W', station: 'Prince St',      walk: '4 min walk' },
  'tribeca':        { lines: 'A·C·E', station: 'Chambers St',    walk: '5 min walk' },
  'west village':   { lines: '1·2·3', station: '14th St',        walk: '6 min walk' },
  'williamsburg':   { lines: 'L',     station: 'Bedford Ave',    walk: '3 min walk' },
  'brooklyn':       { lines: '2·3',   station: 'Bergen St',      walk: '7 min walk' },
  'midtown':        { lines: 'N·Q·R', station: 'Times Sq–42nd',  walk: '5 min walk' },
  'upper east':     { lines: '4·5·6', station: '86th St',        walk: '4 min walk' },
  'upper west':     { lines: '1·2·3', station: '79th St',        walk: '5 min walk' },
  'park slope':     { lines: 'F·G',   station: '7th Ave',        walk: '6 min walk' },
  'dumbo':          { lines: 'A·C',   station: 'High St',        walk: '8 min walk' },
  'lower east':     { lines: 'F·M·J', station: 'Delancey St',    walk: '5 min walk' },
  'flatiron':       { lines: 'N·R·W', station: '23rd St',        walk: '4 min walk' },
  'chelsea':        { lines: 'C·E',   station: '23rd St',        walk: '5 min walk' },
  'east village':   { lines: 'L',     station: '1st Ave',        walk: '4 min walk' },
  'nolita':         { lines: 'J·Z',   station: 'Bowery',         walk: '5 min walk' },
  'astoria':        { lines: 'N·W',   station: 'Astoria Blvd',   walk: '6 min walk' },
  'flushing':       { lines: '7',     station: 'Main St',        walk: '3 min walk' },
  'bronx':          { lines: '4·5·6', station: 'Fordham Rd',     walk: '8 min walk' },
};
const DEFAULT_TRANSIT = { lines: 'A·C·E', station: 'Nearby Station', walk: '~10 min walk' };

function getTransit(ev: DigestEvent) {
  const hood = (ev.neighborhood || '').toLowerCase();
  for (const [key, val] of Object.entries(TRANSIT)) {
    if (hood.includes(key)) return val;
  }
  return DEFAULT_TRANSIT;
}

// ── Curated NYC cafes ──────────────────────────────────────────────────────
const CAFES = [
  { name: 'Butler',             area: 'Soho',        note: 'Cozy corner, great post-art lattes' },
  { name: 'Devoción',           area: 'Williamsburg',note: 'Sunlit garden — bring a sketchbook' },
  { name: 'Blank Street',       area: 'West Village',note: 'Matcha & pastries, daughter-approved' },
  { name: 'Cha Cha Matcha',     area: 'Nolita',      note: 'Instagrammable matcha spot' },
  { name: 'Birch Coffee',       area: 'Midtown',     note: 'Warm & calm to debrief the day' },
  { name: 'La Colombe',         area: 'Tribeca',     note: 'Beautiful space, great hot chocolate' },
  { name: "Toby's Estate",      area: 'Flatiron',    note: 'Airy, quiet, lovely cakes for two' },
  { name: 'Café Mogador',       area: 'East Village',note: 'Relaxed vibe, brunch all day' },
];
function cafeFor(ev: DigestEvent, i: number) {
  const hood = (ev.neighborhood || '').toLowerCase();
  return CAFES.find(c => c.area.toLowerCase().includes(hood) || hood.includes(c.area.toLowerCase()))
    || CAFES[i % CAFES.length];
}

// ═══════════════════════════════════════════════════════════════════════════
// VIEW: SCHEDULE
// ═══════════════════════════════════════════════════════════════════════════
function ScheduleView({ data, onEventClick }: { data: DigestDetail; onEventClick: (e: DigestEvent) => void }) {
  const dayGroups = useMemo(() => {
    const m: Record<string, DigestEvent[]> = {};
    const keys: string[] = [];
    for (const ev of data.events) {
      const k = fmtDateKey(ev.next_start_at);
      if (!m[k]) { m[k] = []; keys.push(k); }
      m[k].push(ev);
    }
    if (keys.length === 0 || (keys.length === 1 && keys[0] === 'tbd')) {
      const half = Math.ceil(data.events.length / 2);
      return [
        { key: 'day1', label: 'Saturday', short: 'SAT', date: '', events: data.events.slice(0, half) },
        { key: 'day2', label: 'Sunday',   short: 'SUN', date: '', events: data.events.slice(half) },
      ].filter(d => d.events.length > 0);
    }
    return keys.map(k => ({
      key: k,
      label: fmtWeekdayFull(k),
      short: fmtWeekdayShort(k),
      date: fmtMonthDay(k),
      events: m[k],
    }));
  }, [data.events]);

  return (
    <div className="dps-view">
      {/* Hero */}
      <div className="dps-hero">
        {data.digest.cover_image
          ? <img src={data.digest.cover_image} alt={data.digest.title} />
          : <div className="dps-hero-placeholder" />}
        <div className="dps-hero-grad" />
        <div className="dps-hero-badge">{data.digest.category_tag}</div>
      </div>

      {/* Header */}
      <div className="dps-header">
        <h2 className="dps-title">{data.digest.title}</h2>
        <div className="dps-subtitle-row">
          <span className="dps-subtitle-item">{data.events.length} events</span>
          <span className="dps-dot">·</span>
          <span className="dps-subtitle-item">{data.digest.curator_name}</span>
        </div>
        <p className="dps-why">{data.digest.subtitle}</p>
      </div>

      {/* Day groups */}
      {dayGroups.map((day, di) => (
        <div key={day.key} className="dps-day">

          {/* Day header — large + logic */}
          <div className="dps-day-head">
            <div className="dps-day-main">
              <span className="dps-day-short">{day.short}</span>
              <span className="dps-day-full">{day.label}</span>
            </div>
            <div className="dps-day-right">
              {day.date && <span className="dps-day-date">{day.date}</span>}
              <span className="dps-day-count">{day.events.length} {day.events.length === 1 ? 'event' : 'events'}</span>
            </div>
          </div>

          {/* Events */}
          {day.events.map((ev, ei) => {
            const transit = getTransit(ev);
            const cafe    = cafeFor(ev, di * 10 + ei);
            const p       = priceText(ev);
            const time    = fmtTime(ev.next_start_at);
            const date    = fmtDateRange(
              ev.next_start_at ? ev.next_start_at.slice(0,10) : '',
              ev.next_end_at   ? ev.next_end_at.slice(0,10)   : '',
            );

            return (
              <div key={ev.id} className="dps-item">

                {/* ── Horizontal event card ── */}
                <div className="dps-ev-row" onClick={() => onEventClick(ev)}>
                  {/* Thumbnail */}
                  <div className="dps-ev-thumb">
                    {ev.image_url
                      ? <img src={ev.image_url} alt={ev.title} loading="lazy" />
                      : <div className="dps-ev-thumb-empty" />}
                    {time && <span className="dps-ev-time-pill">{time}</span>}
                  </div>

                  {/* Info column */}
                  <div className="dps-ev-info">
                    <h4 className="dps-ev-title">{ev.short_title || ev.title}</h4>
                    {ev.venue_name && (
                      <div className="dps-ev-venue">📍 {ev.venue_name}</div>
                    )}
                    {ev.curator_note && (
                      <p className="dps-ev-note">"{ev.curator_note}"</p>
                    )}
                    <div className="dps-ev-chips">
                      {ev.age_label && <span className="dps-chip">{formatAgeLabel(ev.age_label)}</span>}
                      {dur(ev.duration_min) && <span className="dps-chip">⏱ {dur(ev.duration_min)}</span>}
                      {p && <span className={`dps-chip ${ev.is_free ? 'dps-chip-free' : 'dps-chip-price'}`}>{p}</span>}
                      {ev.rating_avg > 0 && <span className="dps-chip dps-chip-star">★ {ev.rating_avg.toFixed(1)}</span>}
                    </div>
                  </div>

                  <div className="dps-ev-arrow">›</div>
                </div>

                {/* ── Planning strip ── */}
                <div className="dps-plan">
                  <div className="dps-plan-item">
                    <div className="dps-plan-icon">🚇</div>
                    <div className="dps-plan-body">
                      <div className="dps-plan-label">Subway</div>
                      <div className="dps-plan-value">
                        <span className="dps-metro-lines">{transit.lines}</span>
                        <span className="dps-metro-sep">·</span>
                        <span>{transit.station}</span>
                        <span className="dps-metro-sep">·</span>
                        <span>{transit.walk}</span>
                      </div>
                    </div>
                  </div>

                  {time && (
                    <div className="dps-plan-item">
                      <div className="dps-plan-icon">🕐</div>
                      <div className="dps-plan-body">
                        <div className="dps-plan-label">Opens</div>
                        <div className="dps-plan-value">{time}{ev.duration_min > 0 ? ` · ${dur(ev.duration_min)}` : ''}{date ? ` · ${date}` : ''}</div>
                      </div>
                    </div>
                  )}

                  <div className="dps-plan-item dps-plan-cafe">
                    <div className="dps-plan-icon">☕</div>
                    <div className="dps-plan-body">
                      <div className="dps-plan-label">After — stop by</div>
                      <div className="dps-plan-value">
                        <span className="dps-plan-cafe-name">{cafe.name}</span>
                        <span className="dps-metro-sep">·</span>
                        <span>{cafe.area}</span>
                      </div>
                    </div>
                  </div>
                </div>

              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// VIEW: EVENTS — mosaic grid
// ═══════════════════════════════════════════════════════════════════════════
function EventsView({ events, onEventClick }: { events: DigestEvent[]; onEventClick: (e: DigestEvent) => void }) {
  return (
    <div className="dpv-mosaic-view">
      {/* Header */}
      <div className="dpv-mosaic-header">
        <div className="dpv-mosaic-count">
          <span className="dpv-mosaic-num">{events.length}</span>
          <span className="dpv-mosaic-label">events in this digest</span>
        </div>
        <div className="dpv-mosaic-tags">
          {events.some(e => e.is_free) && <span className="dpv-mtag dpv-mtag-free">Some FREE</span>}
          {events.some(e => e.rating_avg >= 4.5) && <span className="dpv-mtag dpv-mtag-rated">Top rated</span>}
        </div>
      </div>

      {/* Mosaic grid */}
      <div className="dpv-mosaic-grid">
        {events.map((ev, i) => {
          // pattern: 2 small, 1 wide, 2 small, 1 wide…
          const isWide = i % 3 === 2;
          const p = priceText(ev);
          return (
            <div
              key={ev.id}
              className={`dpv-tile ${isWide ? 'dpv-tile--wide' : ''}`}
              onClick={() => onEventClick(ev)}
            >
              {/* Image */}
              <div className="dpv-tile-img">
                {ev.image_url
                  ? <img src={ev.image_url} alt={ev.title} loading="lazy" />
                  : <div className="dpv-tile-placeholder" />}
              </div>
              {/* Gradient overlay */}
              <div className="dpv-tile-grad" />
              {/* Age badge */}
              {ev.age_label && <span className="dpv-tile-age">{formatAgeLabel(ev.age_label)}</span>}
              {/* Bottom info */}
              <div className="dpv-tile-bottom">
                <div className="dpv-tile-title">{ev.short_title || ev.title}</div>
                <div className="dpv-tile-row">
                  {ev.rating_avg > 0 && <span className="dpv-tile-rating">★ {ev.rating_avg.toFixed(1)}</span>}
                  {p && <span className={`dpv-tile-price ${ev.is_free ? 'free' : ''}`}>{p}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN PANEL
// ═══════════════════════════════════════════════════════════════════════════
const TABS: { id: ViewMode; label: string }[] = [
  { id: 'schedule', label: 'Schedule' },
  { id: 'events',   label: 'Events'   },
];

export default function DigestPanel({ slug, onClose, onEventClick }: DigestPanelProps) {
  const [data, setData]       = useState<DigestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView]       = useState<ViewMode>('schedule');

  useEffect(() => {
    setLoading(true);
    fetch(`/api/digests/${slug}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [slug]);

  return (
    <div className="digest-panel-backdrop" onClick={onClose}>
      <div className="digest-panel" onClick={e => e.stopPropagation()}>

        {/* Topbar */}
        <div className="dp-topbar">
          <div className="dp-topbar-tabs">
            {TABS.map(t => (
              <button
                key={t.id}
                className={`dp-topbar-tab ${view === t.id ? 'active' : ''}`}
                onClick={() => setView(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="dp-topbar-right">
            <button className="dp-topbar-btn" onClick={onClose} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        {loading && <div className="digest-panel-loading">Loading…</div>}

        {data && !loading && (
          <div className="dp-scroll-body">
            {view === 'schedule' && <ScheduleView data={data} onEventClick={onEventClick} />}
            {view === 'events'   && <EventsView events={data.events} onEventClick={onEventClick} />}
          </div>
        )}
      </div>
    </div>
  );
}
