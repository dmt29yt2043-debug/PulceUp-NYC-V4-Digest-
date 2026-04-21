/**
 * Signal classifiers used by all 5 digests.
 *
 * Each classifier is a pure function of an EnrichedEvent and returns:
 *   - `confidence`: 0..1 — how sure we are the event is X
 *   - `reasons`: human-readable strings (shown in audit / UI tooltips)
 *
 * Rules of thumb:
 *   - Prefer structured fields (format, motivation, country_county, is_free,
 *     next_start_at) over text keywords — they're cleaner.
 *   - Text keywords are a fallback, not the first source of truth.
 *   - Never rely on a single signal: combine at least 2 (e.g. format + tags,
 *     or venue_type + keywords).
 */

import type { EnrichedEvent, Signal } from './types';
import {
  NYC_COUNTY_TO_BOROUGH, NYC_CITIES, NYC_BBOX, MANHATTAN_BBOX,
  INDOOR_FORMATS, OUTDOOR_FORMATS, MIXED_FORMATS, ADULT_FORMATS, EASY_FORMATS,
  FAMILY_MOTIVATIONS, WORTH_IT_MOTIVATIONS,
  INDOOR_KEYWORDS, OUTDOOR_KEYWORDS, INDOOR_VENUE_TYPES,
  FAMILY_KEYWORDS, ADULT_ONLY_MARKERS,
  EASY_POSITIVE, EASY_NEGATIVE,
  AFFORDABLE_TEXT, EXPENSIVE_MARKERS,
  ENGAGEMENT_KEYWORDS, LOW_QUALITY_MARKERS,
  THRESHOLDS,
} from './constants';
import {
  countKeywordHits, matchedKeywords, anyInSet, countInSet,
} from './event-parser';

// ─── Geo: NYC + Manhattan ────────────────────────────────────────────────────

/**
 * Returns {is_nyc, confidence, reasons}. Confidence 1.0 when both county AND
 * city AND bbox agree; lower if only one signal present.
 */
export function classifyNYC(ev: EnrichedEvent): Signal & { borough: string | null } {
  const reasons: string[] = [];
  let confidence = 0;
  let borough: string | null = null;

  // Signal A: country_county (most reliable)
  const county = (ev.country_county || '').toLowerCase().trim();
  if (county && NYC_COUNTY_TO_BOROUGH[county]) {
    confidence += 0.5;
    borough = NYC_COUNTY_TO_BOROUGH[county];
    reasons.push(`county=${county}`);
  }

  // Signal B: city (medium reliability — some non-NYC events say city='New York')
  const city = (ev.city || '').toLowerCase().trim();
  if (NYC_CITIES.has(city)) {
    confidence += 0.3;
    if (!borough) borough = city === 'new york' ? 'manhattan' : city;
    reasons.push(`city=${city}`);
  }

  // Signal C: bbox fallback
  if (ev.lat != null && ev.lon != null) {
    const b = NYC_BBOX;
    if (ev.lat >= b.latMin && ev.lat <= b.latMax && ev.lon >= b.lonMin && ev.lon <= b.lonMax) {
      confidence += 0.2;
      reasons.push('in NYC bbox');
    }
  }

  return { confidence: Math.min(1, confidence), reasons, borough };
}

export function classifyManhattan(ev: EnrichedEvent): Signal {
  const reasons: string[] = [];
  let confidence = 0;

  const county = (ev.country_county || '').toLowerCase().trim();
  if (county === 'new york county') {
    confidence += 0.7;
    reasons.push('New York County');
  }

  if (ev.lat != null && ev.lon != null) {
    const b = MANHATTAN_BBOX;
    if (ev.lat >= b.latMin && ev.lat <= b.latMax && ev.lon >= b.lonMin && ev.lon <= b.lonMax) {
      confidence += 0.3;
      reasons.push('in Manhattan bbox');
    }
  }

  // City alone is too noisy — skip it.
  return { confidence: Math.min(1, confidence), reasons };
}

// ─── Indoor / outdoor ────────────────────────────────────────────────────────

export function classifyIndoor(ev: EnrichedEvent): Signal {
  const reasons: string[] = [];
  let confidence = 0;
  let outdoorPenalty = 0;

  // Format tokens (most reliable)
  const indoorFmt = countInSet(ev.formatParsed, INDOOR_FORMATS);
  const outdoorFmt = countInSet(ev.formatParsed, OUTDOOR_FORMATS);
  if (indoorFmt > 0) {
    confidence += 0.5;
    reasons.push(`format: indoor (${ev.formatParsed.filter(f => INDOOR_FORMATS.has(f)).join(', ')})`);
  }
  if (outdoorFmt > 0) {
    outdoorPenalty += 0.5;
    reasons.push(`format: outdoor (${ev.formatParsed.filter(f => OUTDOOR_FORMATS.has(f)).join(', ')})`);
  }

  // Venue type
  const venueType = String(ev.dataParsed.venue_venue_type || '').toLowerCase();
  if (venueType) {
    for (const t of INDOOR_VENUE_TYPES) {
      if (venueType.includes(t)) {
        confidence += 0.3;
        reasons.push(`venue_type=${venueType}`);
        break;
      }
    }
  }

  // Text keyword fallback — bounded at 0.3 so it can't dominate format signal
  const indoorKw = countKeywordHits(ev.textBlob, INDOOR_KEYWORDS);
  const outdoorKw = countKeywordHits(ev.textBlob, OUTDOOR_KEYWORDS);
  if (indoorKw > 0) {
    const boost = Math.min(0.3, indoorKw * 0.08);
    confidence += boost;
    reasons.push(`indoor keywords ×${indoorKw}`);
  }
  if (outdoorKw > 0) {
    const penalty = Math.min(0.3, outdoorKw * 0.08);
    outdoorPenalty += penalty;
  }

  const finalConf = Math.max(0, Math.min(1, confidence - outdoorPenalty));
  return { confidence: finalConf, reasons };
}

export function classifyOutdoor(ev: EnrichedEvent): Signal {
  const reasons: string[] = [];
  let confidence = 0;
  if (countInSet(ev.formatParsed, OUTDOOR_FORMATS) > 0) {
    confidence += 0.6;
    reasons.push('outdoor format');
  }
  const kw = matchedKeywords(ev.textBlob, OUTDOOR_KEYWORDS);
  if (kw.length > 0) {
    confidence += Math.min(0.4, kw.length * 0.1);
    reasons.push(`outdoor kw: ${kw.slice(0, 3).join(', ')}`);
  }
  return { confidence: Math.min(1, confidence), reasons };
}

// ─── Family friendly ─────────────────────────────────────────────────────────

export function classifyFamily(ev: EnrichedEvent): Signal {
  const reasons: string[] = [];
  let confidence = 0;

  // Motivation is the single best signal here.
  const familyMotiv = countInSet(ev.motivationParsed, FAMILY_MOTIVATIONS);
  if (familyMotiv >= 2) {
    confidence += 0.5;
    reasons.push(`motivations: ${ev.motivationParsed.filter(m => FAMILY_MOTIVATIONS.has(m)).join(', ')}`);
  } else if (familyMotiv === 1) {
    confidence += 0.3;
    reasons.push(`motivation: ${ev.motivationParsed.find(m => FAMILY_MOTIVATIONS.has(m))}`);
  }

  // kids-playgroup format
  if (ev.formatParsed.includes('kids-playgroup')) {
    confidence += 0.3;
    reasons.push('format=kids-playgroup');
  }

  // Age range suggests kids (age_best_from is 100% populated)
  if (ev.age_best_from != null && ev.age_best_from <= 12) {
    confidence += 0.15;
    reasons.push(`ages ${ev.age_best_from}-${ev.age_best_to ?? '?'}`);
  }

  // Keyword fallback
  const kw = countKeywordHits(ev.textBlob, FAMILY_KEYWORDS);
  if (kw >= 2) {
    confidence += 0.15;
    reasons.push(`family keywords ×${kw}`);
  } else if (kw >= 1) {
    confidence += 0.08;
  }

  // Adult-only demerit
  if (countKeywordHits(ev.textBlob, ADULT_ONLY_MARKERS) > 0) {
    confidence -= 0.4;
    reasons.push('adult-only markers — demerit');
  }
  if (anyInSet(ev.formatParsed, ADULT_FORMATS)) {
    confidence -= 0.2;
    reasons.push('adult format — demerit');
  }

  return { confidence: Math.max(0, Math.min(1, confidence)), reasons };
}

// ─── Easy plan ───────────────────────────────────────────────────────────────

export function classifyEasy(ev: EnrichedEvent): Signal {
  const reasons: string[] = [];
  let confidence = 0;

  // Free admission is the strongest "easy" signal (no ticketing friction)
  if (ev.is_free === 1) {
    confidence += 0.3;
    reasons.push('free admission');
  }

  // Easy format tokens
  if (anyInSet(ev.formatParsed, EASY_FORMATS)) {
    confidence += 0.25;
    reasons.push(`easy format: ${ev.formatParsed.filter(f => EASY_FORMATS.has(f)).join(', ')}`);
  }

  // Subway access — no subway = hard to reach
  const subway = (ev.subway || '').trim();
  const hasSubway = subway && subway !== 'N/A' && subway.toLowerCase() !== 'none';
  if (hasSubway) {
    confidence += 0.15;
    reasons.push('subway accessible');
  }

  // Positive text signals
  const pos = matchedKeywords(ev.textBlob, EASY_POSITIVE);
  if (pos.length > 0) {
    confidence += Math.min(0.25, pos.length * 0.1);
    reasons.push(`easy kw: ${pos.slice(0, 2).join(', ')}`);
  }

  // Negative text signals — strong demerit (requires planning / booking)
  const neg = matchedKeywords(ev.textBlob, EASY_NEGATIVE);
  if (neg.length > 0) {
    confidence -= Math.min(0.5, neg.length * 0.2);
    reasons.push(`hard kw: ${neg.slice(0, 2).join(', ')}`);
  }

  // Sold out = not easy
  if (ev.dataParsed.is_sold_out === true) {
    confidence -= 0.3;
    reasons.push('sold out');
  }

  return { confidence: Math.max(0, Math.min(1, confidence)), reasons };
}

// ─── Affordable ──────────────────────────────────────────────────────────────

export function classifyAffordable(ev: EnrichedEvent): Signal {
  const reasons: string[] = [];
  let confidence = 0;

  if (ev.is_free === 1) {
    confidence = 1.0;
    reasons.push('free');
    return { confidence, reasons };
  }

  // Tiered by price_max
  const pmax = ev.price_max ?? 0;
  if (pmax > 0 && pmax <= 10) {
    confidence = 0.9;
    reasons.push(`price ≤ $${pmax}`);
  } else if (pmax > 0 && pmax <= 20) {
    confidence = 0.75;
    reasons.push(`price ≤ $${pmax}`);
  } else if (pmax > 0 && pmax <= THRESHOLDS.AFFORDABLE_CEILING) {
    confidence = 0.6;
    reasons.push(`price ≤ $${pmax}`);
  } else if (pmax > 0 && pmax <= THRESHOLDS.AFFORDABLE_HARD_CEILING) {
    confidence = 0.3;
    reasons.push(`price ≤ $${pmax} (on the edge)`);
  } else if (pmax > THRESHOLDS.AFFORDABLE_HARD_CEILING) {
    confidence = 0;
    reasons.push(`price too high ($${pmax})`);
    return { confidence, reasons };
  }

  // Text fallback — useful when price is 0 but is_free flag is also 0 (free
  // with donation, etc.)
  const kw = matchedKeywords(ev.textBlob, AFFORDABLE_TEXT);
  if (kw.length > 0) {
    confidence = Math.max(confidence, 0.5);
    reasons.push(`affordable kw: ${kw.slice(0, 2).join(', ')}`);
  }

  // Expensive demerit
  if (countKeywordHits(ev.textBlob, EXPENSIVE_MARKERS) > 0) {
    confidence -= 0.3;
    reasons.push('expensive markers — demerit');
  }

  return { confidence: Math.max(0, Math.min(1, confidence)), reasons };
}

// ─── Weekend ─────────────────────────────────────────────────────────────────

/**
 * True if ev.next_start_at (or any occurrence) falls on Sat/Sun within the
 * lookahead window. Weekend is defined in America/New_York timezone.
 */
export function classifyWeekend(
  ev: EnrichedEvent,
  nowMs: number,
  windowDays: number,
): Signal & { matchedDate: string | null } {
  const reasons: string[] = [];
  const cutoff = nowMs + windowDays * 24 * 60 * 60 * 1000;

  const candidates: string[] = [];
  if (ev.next_start_at) candidates.push(ev.next_start_at);
  for (const o of ev.occurrencesParsed) {
    if (o.start_at && !candidates.includes(o.start_at)) candidates.push(o.start_at);
  }

  let bestMatch: string | null = null;
  for (const iso of candidates) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    if (ms < nowMs || ms > cutoff) continue;
    const dow = dayOfWeekNY(iso);
    if (dow === 0 || dow === 6) {
      bestMatch = iso;
      const dayName = dow === 6 ? 'Saturday' : 'Sunday';
      reasons.push(`${dayName} ${iso.slice(0, 10)}`);
      break;
    }
  }

  return {
    confidence: bestMatch ? 1 : 0,
    reasons,
    matchedDate: bestMatch,
  };
}

/** Day of week in America/New_York (0=Sun..6=Sat). */
function dayOfWeekNY(iso: string): number {
  const d = new Date(iso);
  // toLocaleString with timeZone gives us the NY-local date
  const parts = d.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  // parts is "MM/DD/YYYY"; Date parses that as UTC-naive → use Date.UTC
  const [m, dd, y] = parts.split('/').map((p) => parseInt(p, 10));
  return new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
}

// ─── Quality ─────────────────────────────────────────────────────────────────

/**
 * Quality = high rating × sufficient rating count × review richness × text
 * engagement markers × no low-quality markers.
 */
export function classifyQuality(ev: EnrichedEvent): Signal {
  const reasons: string[] = [];
  let confidence = 0;

  // Rating strength — rating_count matters more than rating_avg (rating_avg is
  // ≥4 for 100% of events, so alone it tells us nothing).
  if (ev.rating_count >= 20 && ev.rating_avg >= 4.5) {
    confidence += 0.35;
    reasons.push(`${ev.rating_avg}★ × ${ev.rating_count}`);
  } else if (ev.rating_count >= 5 && ev.rating_avg >= THRESHOLDS.WORTH_IT_RATING_MIN) {
    confidence += 0.25;
    reasons.push(`${ev.rating_avg}★ × ${ev.rating_count}`);
  } else if (ev.rating_count >= 5) {
    confidence += 0.1;
  }

  // Reviews richness — more reviews = more trust
  if (ev.reviewsParsed.length >= 3) {
    confidence += 0.2;
    reasons.push(`${ev.reviewsParsed.length} reviews`);
  } else if (ev.reviewsParsed.length >= 1) {
    confidence += 0.1;
  }

  // Worth-it motivation tokens
  const wMotiv = countInSet(ev.motivationParsed, WORTH_IT_MOTIVATIONS);
  if (wMotiv >= 2) {
    confidence += 0.2;
    reasons.push(`rich motivations: ${ev.motivationParsed.filter(m => WORTH_IT_MOTIVATIONS.has(m)).join(', ')}`);
  } else if (wMotiv === 1) {
    confidence += 0.1;
  }

  // Engagement text signals
  const eng = matchedKeywords(ev.textBlob, ENGAGEMENT_KEYWORDS);
  if (eng.length >= 2) {
    confidence += 0.15;
    reasons.push(`engagement: ${eng.slice(0, 2).join(', ')}`);
  } else if (eng.length === 1) {
    confidence += 0.08;
  }

  // Low-quality demerit
  if (countKeywordHits(ev.textBlob, LOW_QUALITY_MARKERS) > 0) {
    confidence -= 0.3;
    reasons.push('low-quality markers — demerit');
  }

  // Thin description demerit
  if ((ev.description?.length ?? 0) < 50) {
    confidence -= 0.15;
    reasons.push('thin description');
  }

  return { confidence: Math.max(0, Math.min(1, confidence)), reasons };
}

// ─── Completeness (for "worth showing" at all) ───────────────────────────────

/**
 * A quick completeness check: does this event have enough metadata to be
 * worth showing as a card? Score 0..1. Used as a base-quality gate in digests.
 */
export function classifyCompleteness(ev: EnrichedEvent): Signal {
  const reasons: string[] = [];
  let score = 0;
  const checks: Array<[boolean, string, number]> = [
    [!!ev.image_url,                      'image',   0.25],
    [!!ev.venue_name,                     'venue',   0.1],
    [!!ev.description && ev.description.length >= 50, 'description', 0.15],
    [!!ev.next_start_at,                  'date',    0.2],
    [ev.lat != null && ev.lon != null,    'geo',     0.1],
    [ev.age_best_from != null,            'age',     0.1],
    [!!ev.price_summary,                  'price',   0.05],
    [ev.reviewsParsed.length >= 1,        'reviews', 0.05],
  ];
  for (const [ok, label, weight] of checks) {
    if (ok) { score += weight; reasons.push(label); }
  }
  return { confidence: Math.min(1, score), reasons };
}
