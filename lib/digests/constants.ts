/**
 * Taxonomies and keyword sets used by digest signal extraction.
 *
 * These are tuned to the actual data in our events.db (audited on 2026-04-21
 * against 207 live events). If the data shape changes significantly, re-audit
 * with `scripts/digests-audit.ts` and adjust.
 */

// ─── Live-event SQL filter ────────────────────────────────────────────────────
// Must stay in sync with the pattern used in `lib/db.ts` and
// `app/api/events/personalized/route.ts`.
export const LIVE_STATUS_FILTER = `(status IN ('published', 'done', 'new') OR status LIKE '%.done')`;

// ─── NYC geo ──────────────────────────────────────────────────────────────────

/** NYC counties → the borough they represent. Used for precise classification. */
export const NYC_COUNTY_TO_BOROUGH: Record<string, string> = {
  'new york county': 'manhattan',
  'kings county':    'brooklyn',
  'queens county':   'queens',
  'bronx county':    'bronx',
  'richmond county': 'staten island',
};

export const NYC_CITIES = new Set([
  'new york',
  'brooklyn',
  'bronx',
  'queens',
  'staten island',
]);

/** All five boroughs bbox — generous edges to catch near-NYC venues. */
export const NYC_BBOX = {
  latMin: 40.49, latMax: 40.92,
  lonMin: -74.27, lonMax: -73.70,
};

/** Manhattan bbox only (tighter) — for Manhattan bonus. */
export const MANHATTAN_BBOX = {
  latMin: 40.70, latMax: 40.88,
  lonMin: -74.02, lonMax: -73.91,
};

// ─── Format taxonomy (from data, 94% live coverage) ───────────────────────────
// Token values observed in live events (sorted by frequency):
//   workshop (78), kids-playgroup (71), live-performance (64), guided-walk (33),
//   class (25), museum-visit (23), meetup (19), community-service (18),
//   sports-event (17), festival (16), concert (16), theater-show (15),
//   tour (14), exhibition (13), competition (10), talk (9), party (7),
//   fair (5), open-day (5), market (5), training-session (4), screening (4),
//   networking-event (4), hike (2), lecture (2), conference (2),
//   online-event (1), club-night (1), camp (1).

/** format tokens that are unambiguously INDOOR. */
export const INDOOR_FORMATS = new Set([
  'workshop', 'class', 'museum-visit', 'theater-show',
  'exhibition', 'screening', 'lecture', 'talk',
  'conference', 'training-session', 'online-event',
]);

/** format tokens that are unambiguously OUTDOOR. */
export const OUTDOOR_FORMATS = new Set([
  'guided-walk', 'hike', 'fair', 'market', 'festival',
]);

/** format tokens that are mixed/ambiguous — signal, but weight lower. */
export const MIXED_FORMATS = new Set([
  'kids-playgroup', 'live-performance', 'concert', 'tour',
  'sports-event', 'competition', 'party', 'camp', 'open-day',
]);

/** format tokens that suggest a decidedly adult audience — used as a demerit. */
export const ADULT_FORMATS = new Set([
  'club-night', 'networking-event', 'conference',
]);

/** format tokens associated with "easy plan" (drop-in, predictable, recurring). */
export const EASY_FORMATS = new Set([
  'museum-visit', 'exhibition', 'kids-playgroup', 'open-day',
]);

// ─── Motivation taxonomy (from data, 94% live coverage) ───────────────────────
// Observed tokens (sorted by freq):
//   bond (147), learn (115), play (103), be-entertained (40), explore (30),
//   socialize (25), support-community (23), create (22), celebrate (19),
//   improve-health (18), be-inspired (13), relax (11), compete (4),
//   dance-party (3), discover-tech (2).

/** Motivations that strongly indicate family-oriented events. */
export const FAMILY_MOTIVATIONS = new Set([
  'bond', 'play', 'learn', 'celebrate',
]);

/** Motivations that indicate rich, engaging, "worth-it" experiences. */
export const WORTH_IT_MOTIVATIONS = new Set([
  'create', 'be-inspired', 'explore', 'discover-tech', 'learn', 'play',
]);

// ─── Indoor / outdoor text fallback (for the ~6% missing `format`) ───────────
export const INDOOR_KEYWORDS = [
  'museum', 'library', 'theater', 'theatre', 'gallery', 'exhibit',
  'exhibition', 'auditorium', 'indoor', 'art center', 'arts center',
  'performing arts', 'concert hall', 'opera', 'cinema', 'bookstore',
  'science center', 'planetarium', 'aquarium',
  'workshop', 'storytime', 'story time', 'classroom', 'studio',
  'lecture', 'reading', 'screening', 'film', 'movie night',
  'play space', 'playroom', 'indoor playground',
];

export const OUTDOOR_KEYWORDS = [
  'park', 'outdoor', 'outdoors', 'garden', 'playground', 'hike',
  'hiking', 'farm', 'picnic', 'beach', 'open air', 'open-air',
  'rooftop', 'trail', 'street fair', 'block party', 'parade',
];

export const INDOOR_VENUE_TYPES = new Set([
  'museum', 'library', 'theater', 'theatre', 'gallery',
  'art center', 'arts center', 'indoor', 'opera', 'concert hall',
  'cinema', 'playroom', 'bookstore', 'science center',
  'planetarium', 'aquarium', 'studio',
]);

// ─── Family / kids text signals (fallback when motivation is missing) ─────────
export const FAMILY_KEYWORDS = [
  'kids', 'kid-friendly', 'children', 'family', 'family-friendly',
  'toddler', 'teen', 'preschool', "children's", 'child',
];

export const ADULT_ONLY_MARKERS = [
  '21+', 'adults only', 'adult-only', 'bar crawl', 'wine tasting',
  'bachelorette', 'speed dating',
];

// ─── Easy-plan text signals ───────────────────────────────────────────────────
export const EASY_POSITIVE = [
  'drop-in', 'drop in', 'no rsvp', 'no reservation', 'no ticket',
  'no registration', 'free admission', 'open to the public', 'walk-in',
  'included in admission', 'included with admission', 'no sign-up',
  'everyone welcome', 'all ages welcome',
];

export const EASY_NEGATIVE = [
  'sold out', 'limited seats', 'limited tickets', 'limited capacity',
  'registration required', 'rsvp required', 'application', 'audition',
  'must register', 'must rsvp', 'advance ticket', 'advance registration',
  'by appointment',
];

// ─── Affordability / price text signals ───────────────────────────────────────
export const AFFORDABLE_TEXT = [
  'free', 'free admission', 'no charge', 'community', 'library',
  'public', 'donation-based', 'pay what you wish', 'suggested donation',
  'included in admission', 'included with admission', 'low-cost', 'low cost',
];

export const EXPENSIVE_MARKERS = [
  'premium', 'vip', 'luxury', 'fine dining', 'black tie',
];

// ─── Quality / engagement text signals ────────────────────────────────────────
export const ENGAGEMENT_KEYWORDS = [
  'hands-on', 'interactive', 'singalong', 'sing-along', 'sing along',
  'workshop', 'make and take', 'make-and-take', 'build your own',
  'live performance', 'live music', 'participatory', 'engaging',
  'discover', 'explore', 'create', 'design your own',
];

export const LOW_QUALITY_MARKERS = [
  'placeholder', 'tbd', 'to be determined', 'tba', 'details coming soon',
];

// ─── Thresholds ───────────────────────────────────────────────────────────────
export const THRESHOLDS = {
  /** Any event with final score below this is NEVER included (even as fallback). */
  ABSOLUTE_FLOOR: 20,

  /** Weekend: lookahead window in days for upcoming Sat/Sun. */
  WEEKEND_WINDOW_DAYS: 14,
  WEEKEND_FALLBACK_DAYS: 28,

  /** Affordable tiers. */
  AFFORDABLE_CEILING: 30,
  AFFORDABLE_HARD_CEILING: 75,

  /** Worth-it quality gates. */
  WORTH_IT_RATING_MIN: 4.3,
  WORTH_IT_RATING_COUNT_MIN: 5,
};
