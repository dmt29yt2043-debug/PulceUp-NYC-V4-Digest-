'use client';

import { useState } from 'react';
import type { Event } from '@/lib/types';
import { useFavorites } from '@/lib/FavoritesContext';
import { formatAgeLabel } from '@/lib/age-label';

interface EventCardV2Props {
  event: Event;
  isHovered: boolean;
  isSelected: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClick: () => void;
  isFlagged?: boolean;
  onToggleFlag?: (event: Event, flagged: boolean) => void;
  /** 1-based rank in the visible list — used for impression tracking (CTR@k, NDCG) */
  position?: number;
}

/**
 * Format date range from DB fields:
 * - Single day or no end  → "Apr 4"
 * - Multi-day short (≤7d) → "Apr 4 – Apr 6"
 * - Long run (>7d)        → "Through Apr 5"
 */
function formatDateRange(startStr: string, endStr?: string): string {
  if (!startStr) return '';
  try {
    // Force local-time parsing (avoid UTC midnight → previous day)
    const startDate = startStr.includes('T')
      ? new Date(startStr)
      : new Date(startStr + 'T00:00:00');

    const fmt = (d: Date) =>
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    if (!endStr) return fmt(startDate);

    const endDate = endStr.includes('T')
      ? new Date(endStr)
      : new Date(endStr + 'T00:00:00');

    const diffDays = Math.round(
      (endDate.getTime() - startDate.getTime()) / 86_400_000
    );

    if (diffDays <= 0) return fmt(startDate);
    if (diffDays > 7)  return `Through ${fmt(endDate)}`;

    // Same month short-form: "Apr 4–6"
    const sameMonth =
      startDate.getMonth() === endDate.getMonth() &&
      startDate.getFullYear() === endDate.getFullYear();

    if (sameMonth) {
      return `${startDate.toLocaleDateString('en-US', { month: 'short' })} ${startDate.getDate()}–${endDate.getDate()}`;
    }
    return `${fmt(startDate)} – ${fmt(endDate)}`;
  } catch {
    return startStr;
  }
}

function formatPrice(event: Event): string {
  if (event.is_free) return 'FREE';
  if (event.price_min > 0 && event.price_max > event.price_min)
    return `$${event.price_min}–$${event.price_max}`;
  if (event.price_min > 0) return `$${event.price_min}`;
  if (event.price_summary) return event.price_summary;
  return '';
}

export default function EventCardV2({
  event,
  isHovered,
  isSelected,
  onMouseEnter,
  onMouseLeave,
  onClick,
  isFlagged = false,
  onToggleFlag,
  position,
}: EventCardV2Props) {
  const [imgError, setImgError] = useState(false);
  const { isFavorite, toggle } = useFavorites();
  const liked = isFavorite(event.id);

  const priceText   = formatPrice(event);
  const dateText    = formatDateRange(event.next_start_at, event.next_end_at);
  const accentColor = event.is_free ? '#22c55e' : '#e91e63';

  const handleLike = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggle(event);
  };

  return (
    <div
      data-event-id={event.id}
      data-position={position}
      className={`event-card-v2 ${isHovered ? 'hovered' : ''} ${isSelected ? 'selected' : ''}`}
      style={isHovered ? {
        borderColor: accentColor,
        boxShadow: `0 0 0 1px ${accentColor}, 0 12px 32px ${accentColor}33`,
      } : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      onDoubleClick={(e) => {
        e.stopPropagation();
        const id = String(event.id);
        try { navigator.clipboard?.writeText(id); } catch {}
        // eslint-disable-next-line no-alert
        alert(`Event ID: ${id}\n(copied to clipboard)`);
      }}
    >
      {/* ── Full-bleed image ── */}
      <div className="event-card-v2-image">
        {event.image_url && !imgError ? (
          <img
            src={event.image_url}
            alt={event.title}
            onError={() => setImgError(true)}
            loading="lazy"
          />
        ) : (
          <div className="event-card-v2-placeholder" />
        )}
      </div>

      {/* ── Top badges ── */}
      {event.age_label && (
        <span className="event-card-v2-age">{formatAgeLabel(event.age_label)}</span>
      )}

      {/* ── Heart ── */}
      <button className="event-card-v2-fav" onClick={handleLike} aria-label="Save">
        <svg width="15" height="15" viewBox="0 0 24 24"
          fill={liked ? '#e91e63' : 'none'}
          stroke={liked ? '#e91e63' : 'white'}
          strokeWidth="2"
        >
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
      </button>

      {/* ── Gradient overlay + text ── */}
      <div className="event-card-v2-overlay">
        <h3 className="event-card-v2-title">{event.short_title || event.title}</h3>

        {event.venue_name && (
          <p className="event-card-v2-venue">{event.venue_name}</p>
        )}

        <div className="event-card-v2-bottom">
          <span className="event-card-v2-date">{dateText}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {event.rating_avg > 0 && (
              <span className="event-card-v2-rating">
                ★ {event.rating_avg.toFixed(1)}
              </span>
            )}
            {priceText && (
              <span className={`event-card-v2-price ${event.is_free ? 'free' : ''}`}>
                {priceText}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
