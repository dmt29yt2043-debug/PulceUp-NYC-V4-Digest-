'use client';

import { useState, useEffect, useRef } from 'react';
import type { Event } from '@/lib/types';
import { useFavorites } from '@/lib/FavoritesContext';
import { track, trackBuyTicketsClicked } from '@/lib/analytics';

interface EventDetailProps {
  event: Event | null;
  open: boolean;
  onClose: () => void;
  isFlagged?: boolean;
  onToggleFlag?: (event: Event, flagged: boolean) => void;
}

/* ── helpers ── */

function formatDateShort(dateStr: string): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

/**
 * Smart date display for the detail card meta bar.
 * - Single day or no end       → "Apr 19, 2026"
 * - Multi-day short (≤7d)      → "Apr 19 – Apr 25"
 * - Long-running (>7d, future) → "Through Dec 31"
 * - Already started & ongoing  → "Now – Dec 31"  (if start is in the past)
 */
function formatDateSmart(startStr: string, endStr?: string | null): { label: string; value: string } {
  if (!startStr) return { label: 'DATE', value: '—' };
  try {
    const start = new Date(startStr);
    const now = new Date();
    const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const fmtFull = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    if (!endStr) return { label: 'DATE', value: fmtFull(start) };

    const end = new Date(endStr);
    const diffDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);

    // Same day event
    if (diffDays <= 0) return { label: 'DATE', value: fmtFull(start) };

    // Short run (≤7 days)
    if (diffDays <= 7) {
      return { label: 'DATES', value: `${fmt(start)} – ${fmt(end)}` };
    }

    // Long-running: show availability window
    const started = start.getTime() < now.getTime();
    if (started) {
      return { label: 'AVAILABLE', value: `Now – ${fmt(end)}` };
    }
    return { label: 'DATES', value: `${fmt(start)} – ${fmt(end)}` };
  } catch {
    return { label: 'DATE', value: startStr };
  }
}

function formatTime(dateStr: string): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    const h = d.getHours();
    if (h === 0 && d.getMinutes() === 0) return 'All day';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '—';
  }
}

function priceLabel(event: Event): string {
  if (event.is_free) return 'Free';
  // Extract all dollar amounts from price_summary to build a clean range
  if (event.price_summary) {
    const amounts = [...event.price_summary.matchAll(/\$[\d,]+(?:\.\d{1,2})?/g)]
      .map((m) => parseFloat(m[0].replace(/[$,]/g, '')))
      .filter((n) => n > 0);
    if (amounts.length >= 2) {
      const lo = Math.min(...amounts);
      const hi = Math.max(...amounts);
      if (lo === hi) return `$${lo}`;
      return `$${lo}–$${hi.toLocaleString()}`;
    }
    if (amounts.length === 1) return `$${amounts[0]}`;
    // No dollar amounts found — show summary as-is if short enough
    if (event.price_summary.length <= 25) return event.price_summary;
  }
  if (event.price_min > 0 && event.price_max > 0 && event.price_min !== event.price_max)
    return `$${event.price_min}–$${event.price_max}`;
  if (event.price_min > 0) return `$${event.price_min}`;
  return '—';
}

/* ── sub-components ── */

function MetaBar({ event }: { event: Event }) {
  const dateMeta = formatDateSmart(event.next_start_at, event.next_end_at);
  const cols = [
    { label: dateMeta.label, value: dateMeta.value },
    { label: 'START TIME', value: formatTime(event.next_start_at) },
    { label: 'AGE GROUP', value: event.age_label || 'All Ages' },
    { label: 'PRICE', value: priceLabel(event) },
  ];

  return (
    <div className="ed-meta-bar">
      {cols.map((c, i) => (
        <div key={i} className="ed-meta-col">
          <span className="ed-meta-label">{c.label}</span>
          <span className={`ed-meta-value${c.label === 'PRICE' && event.is_free ? ' ed-free' : ''}${c.label === 'PRICE' ? ' ed-meta-value-price' : ''}`}>
            {c.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function OverviewTab({ event }: { event: Event }) {
  return (
    <div className="ed-tab-content">
      {event.description && (
        <>
          <h3 className="ed-section-title">
            <span className="ed-sparkle">✦</span> description
          </h3>
          <p className="ed-body">{event.description}</p>
        </>
      )}

      {/* Categories as chips */}
      {event.categories && event.categories.length > 0 && (
        <div className="ed-chips">
          {event.categories.map((cat) => (
            <span key={cat} className="ed-chip">{cat}</span>
          ))}
        </div>
      )}

      {/* Accessibility info moved to ed-quick-info above */}
    </div>
  );
}

function GoodToKnowTab({ event }: { event: Event }) {
  const [expanded, setExpanded] = useState(false);
  const d = event.derisk;
  if (!d) return <p className="ed-empty">No additional info available.</p>;

  const sections = [
    { label: 'What You Get', value: d.what_you_get },
    { label: 'Practical Tips', value: d.practical_tips },
    { label: 'Best For & Duration', value: [d.who_its_best_for, d.duration].filter(Boolean).join('. ') || undefined },
    { label: 'Crowds', value: d.crowds },
    { label: 'What to Expect', value: d.what_to_expect },
    { label: 'How to Get There', value: d.how_to_get_there },
    { label: 'Tickets', value: d.tickets_availability },
    { label: 'Price Info', value: d.price_info },
    { label: 'Verdict', value: d.verdict },
  ].filter((s) => s.value) as { label: string; value: string }[];

  if (sections.length === 0) return <p className="ed-empty">No additional info available.</p>;

  const PREVIEW_COUNT = 3;
  const visible = expanded ? sections : sections.slice(0, PREVIEW_COUNT);
  const hasMore = sections.length > PREVIEW_COUNT;

  return (
    <div className="ed-tab-content">
      <h3 className="ed-section-title">Good to know</h3>
      <div className="ed-gtk-list">
        {visible.map((s) => (
          <div key={s.label} className="ed-gtk-item">
            <span className="ed-gtk-label">{s.label}</span>
            <p className="ed-gtk-text">{s.value}</p>
          </div>
        ))}
      </div>
      {hasMore && (
        <button className="ed-gtk-readmore" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : `Read more (${sections.length - PREVIEW_COUNT} more)`}
        </button>
      )}
    </div>
  );
}

function ReviewsTab({ event }: { event: Event }) {
  const filledReviews = (event.reviews || []).filter(r => r.text && r.text.trim());

  return (
    <div className="ed-tab-content">
      <h3 className="ed-section-title">
        Reviews
        {event.rating_avg > 0 && (
          <span className="ed-rating-inline"> ★ {event.rating_avg.toFixed(1)}</span>
        )}
      </h3>
      {filledReviews.length > 0 ? (
        <div className="ed-reviews-list">
          {filledReviews.map((review, i) => (
            <div key={i} className="ed-review-card">
              <p className="ed-review-text">&ldquo;{review.text}&rdquo;</p>
              {review.source && <p className="ed-review-source">{review.source}</p>}
            </div>
          ))}
        </div>
      ) : (
        <p className="ed-body" style={{ opacity: 0.5 }}>No written reviews yet.</p>
      )}
    </div>
  );
}

function MiniMap({ lat, lon }: { lat: number; lon: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    import('leaflet').then((L) => {
      if (!containerRef.current || mapRef.current) return;

      const TOMTOM_KEY = process.env.NEXT_PUBLIC_TOMTOM_API_KEY || 'l9WXwQeiaM0XOFjaLMv1LMOZxKSK60Jf';
      const tileUrl = `https://api.tomtom.com/map/1/tile/basic/main/{z}/{x}/{y}.png?key=${TOMTOM_KEY}`;

      const map = L.map(containerRef.current, {
        center: [lat, lon],
        zoom: 15,
        zoomControl: true,
        attributionControl: false,
        dragging: true,
        scrollWheelZoom: true,
        doubleClickZoom: true,
        touchZoom: true,
      });

      L.tileLayer(tileUrl, { maxZoom: 18 }).addTo(map);

      const icon = L.divIcon({
        className: 'ed-map-pin',
        html: `<div style="
          width:16px;height:16px;
          background:#ff7573;
          border-radius:50%;
          border:3px solid white;
          box-shadow:0 2px 8px rgba(255,117,115,0.5);
        "></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });

      L.marker([lat, lon], { icon, interactive: false }).addTo(map);
      mapRef.current = map;
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [lat, lon]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}

function LocationTab({ event }: { event: Event }) {
  const hasCoords = event.lat != null && event.lon != null;

  return (
    <div className="ed-tab-content">
      <h3 className="ed-section-title">Location</h3>

      {/* Details */}
      <div className="ed-location-details">
        {event.venue_name && (
          <div className="ed-loc-row">
            <span className="ed-loc-icon">📍</span>
            <span className="ed-loc-value">{event.venue_name}</span>
          </div>
        )}
        {event.address && (
          <div className="ed-loc-row">
            <span className="ed-loc-icon">🏠</span>
            <span className="ed-loc-value">{event.address}</span>
          </div>
        )}
        {event.subway && (
          <div className="ed-loc-row">
            <span className="ed-loc-icon">🚇</span>
            <span className="ed-loc-value">{event.subway}</span>
          </div>
        )}
        {event.derisk?.how_to_get_there && (
          <p className="ed-body" style={{ marginTop: 12 }}>{event.derisk.how_to_get_there}</p>
        )}
      </div>

      {/* Interactive mini map */}
      {hasCoords && (
        <div className="ed-minimap">
          <MiniMap lat={event.lat!} lon={event.lon!} />
        </div>
      )}
    </div>
  );
}

/* ── main component ── */

export default function EventDetail({ event, open, onClose, isFlagged = false, onToggleFlag }: EventDetailProps) {
  const [imgError, setImgError] = useState(false);
  const { isFavorite, toggle } = useFavorites();
  const liked = event ? isFavorite(event.id) : false;

  // Reset transient UI state when the displayed event changes
  const [prevId, setPrevId] = useState<number | null>(null);
  if (event && event.id !== prevId) {
    setPrevId(event.id);
    setImgError(false);
  }

  const handleCopyId = () => {
    if (!event) return;
    try {
      navigator.clipboard?.writeText(String(event.id));
    } catch {}
  };

  if (!event) return null;

  const hasGoodToKnow = event.derisk && Object.values(event.derisk).some(Boolean);
  const hasReviews = event.rating_avg > 0;
  const hasLocation = event.venue_name || event.address || (event.lat != null && event.lon != null);

  return (
    <>
      <div
        className={`event-detail-backdrop ${open ? 'open' : ''}`}
        onClick={onClose}
      />
      <div className={`event-detail-overlay ${open ? 'open' : ''}`}>
        {/* ── Top bar: X, Share, Save ── */}
        <div className="ed-topbar">
          <button onClick={onClose} className="ed-topbar-btn" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          <div className="ed-topbar-right">
            <button className="ed-topbar-btn" aria-label="Share" onClick={() => { track('share_clicked', { event_id: event.id, event_title: event.title }); navigator.share?.({ title: event.title, url: event.source_url || window.location.href }).catch(() => {}); }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            </button>
            <button
              className={`ed-topbar-btn ${liked ? 'ed-liked' : ''}`}
              aria-label="Save"
              onClick={() => toggle(event)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill={liked ? '#ff8d89' : 'none'} stroke={liked ? '#ff8d89' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
            </button>
          </div>
        </div>

        {/* ── Title + location + rating ── */}
        <div className="ed-header">
          <div className="ed-title-row">
            <h2 className="ed-title">{event.title}</h2>
          </div>
          <div className="ed-debug-row">
            <button
              type="button"
              className="ed-event-id"
              onClick={handleCopyId}
              title="Click to copy event_id"
            >
              event_id: {event.id}
            </button>
            {onToggleFlag && (
              <label className={`ed-flag-checkbox ${isFlagged ? 'checked' : ''}`}>
                <input
                  type="checkbox"
                  checked={isFlagged}
                  onChange={(e) => onToggleFlag(event, e.target.checked)}
                />
                <span>Wrong age range</span>
              </label>
            )}
          </div>
          <div className="ed-subtitle-row">
            {event.city && <span className="ed-subtitle-item">{event.city}</span>}
            {event.venue_name && (
              <>
                <span className="ed-dot">·</span>
                <span className="ed-subtitle-item">{event.venue_name}</span>
              </>
            )}
            {event.rating_avg > 0 && (
              <>
                <span className="ed-dot">·</span>
                <span className="ed-rating">★ {event.rating_avg.toFixed(1)}</span>
              </>
            )}
          </div>
        </div>

        {/* ── Hero image ── */}
        <div className="ed-hero">
          {event.image_url && !imgError ? (
            <img
              src={event.image_url}
              alt={event.title}
              className="ed-hero-img"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="ed-hero-placeholder">
              <span>🎪</span>
            </div>
          )}
        </div>

        {/* ── Metadata bar ── */}
        <MetaBar event={event} />

        {/* ── Quick info: address, subway, quick facts ── */}
        {(event.address || event.subway || event.venue_name) && (
          <div className="ed-quick-info">
            {event.venue_name && (
              <div className="ed-qi-row">
                <span className="ed-qi-icon">📍</span>
                <span className="ed-qi-text">{event.venue_name}</span>
              </div>
            )}
            {event.address && (
              <div className="ed-qi-row">
                <span className="ed-qi-icon">🏠</span>
                <span className="ed-qi-text">{event.address}{event.city ? `, ${event.city}` : ''}</span>
              </div>
            )}
            {event.subway && (
              <div className="ed-qi-row">
                <span className="ed-qi-icon">🚇</span>
                <span className="ed-qi-text">{event.subway}</span>
              </div>
            )}
            {(event.data?.venue_stroller_friendly || event.data?.venue_wheelchair_accessible) && (
              <div className="ed-qi-badges">
                {event.data.venue_wheelchair_accessible && <span className="ed-qi-badge">♿ Wheelchair accessible</span>}
                {event.data.venue_stroller_friendly && <span className="ed-qi-badge">🍼 Stroller friendly</span>}
              </div>
            )}
          </div>
        )}

        {/* ── All sections in single scroll ── */}
        <div className="ed-content">
          <OverviewTab event={event} />

          {hasGoodToKnow && (
            <>
              <div className="ed-divider" />
              <GoodToKnowTab event={event} />
            </>
          )}

          {hasReviews && (
            <>
              <div className="ed-divider" />
              <ReviewsTab event={event} />
            </>
          )}

          {hasLocation && (
            <>
              <div className="ed-divider" />
              <LocationTab event={event} />
            </>
          )}
        </div>

        {/* ── Buy ticket ── */}
        {event.source_url && (
          <div className="ed-cta-wrap">
            <a
              href={event.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="ed-cta"
              onClick={() => {
                // ⭐ North Star: user leaves to buy a ticket.
                // price_min drives the price_bucket dimension in analytics.
                trackBuyTicketsClicked({
                  event_id: event.id,
                  event_title: event.title,
                  destination_url: event.source_url,
                  price_min: event.price_min ?? 0,
                });
              }}
            >
              Buy ticket
            </a>
          </div>
        )}
      </div>
    </>
  );
}
