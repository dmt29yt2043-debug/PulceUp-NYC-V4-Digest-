'use client';

import type { Event } from '@/lib/types';
import { formatAgeLabel } from '@/lib/age-label';

interface MarkerPreviewCardProps {
  event: Event;
  onViewDetails: () => void;
}

function formatPrice(event: Event): string {
  if (event.is_free) return 'Free';
  if (event.price_summary) return event.price_summary;
  if (event.price_min > 0 && event.price_max > 0) {
    if (event.price_min === event.price_max) return `$${event.price_min}`;
    return `$${event.price_min}-$${event.price_max}`;
  }
  return '';
}

export default function MarkerPreviewCard({ event, onViewDetails }: MarkerPreviewCardProps) {
  const price = formatPrice(event);

  return (
    <div className="marker-preview-card">
      {event.image_url && (
        <div className="marker-preview-image">
          <img
            src={event.image_url}
            alt={event.title}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </div>
      )}
      <div className="marker-preview-body">
        <h4 className="marker-preview-title">{event.title}</h4>
        {event.venue_name && (
          <p className="marker-preview-venue">{event.venue_name}</p>
        )}
        <div className="marker-preview-meta">
          {price && (
            <span
              className="marker-preview-price"
              style={{ color: event.is_free ? '#22c55e' : '#374151' }}
            >
              {price}
            </span>
          )}
          {event.age_label && (
            <span className="marker-preview-age">{formatAgeLabel(event.age_label)}</span>
          )}
        </div>
        <button className="marker-preview-btn" onClick={onViewDetails}>
          View details
        </button>
      </div>
    </div>
  );
}

// Generate HTML string for Leaflet popup (since Leaflet popups use raw HTML)
export function renderMarkerPreviewHTML(event: Event): string {
  const price = formatPrice(event);
  const imgHtml = event.image_url
    ? `<div style="width:100%;height:80px;overflow:hidden;border-radius:8px 8px 0 0;">
         <img src="${event.image_url}" alt="" style="width:100%;height:100%;object-fit:cover;" />
       </div>`
    : '';

  // Truncate long price summaries to keep popup compact
  const displayPrice = price.length > 22 ? price.slice(0, 22) + '…' : price;

  return `
    <div style="width:220px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#1e1b4b;border-radius:10px;overflow:hidden;">
      ${imgHtml}
      <div style="padding:8px 10px 10px;">
        <h4 style="font-size:13px;font-weight:600;color:#ffffff;margin:0 0 3px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">
          ${event.title}
        </h4>
        ${event.venue_name ? `<p style="font-size:11px;color:#9ca3af;margin:0 0 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${event.venue_name}</p>` : ''}
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;">
          ${displayPrice ? `<span style="font-size:12px;font-weight:700;padding:2px 8px;border-radius:10px;background:${event.is_free ? '#22c55e' : '#e91e63'};color:white;">${displayPrice}</span>` : ''}
          ${event.age_label ? `<span style="font-size:10px;color:#9ca3af;">${formatAgeLabel(event.age_label)}</span>` : ''}
        </div>
        <button
          class="marker-preview-details-btn"
          style="width:100%;padding:6px 0;background:#e91e63;color:white;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;"
        >
          View details
        </button>
      </div>
    </div>
  `;
}
