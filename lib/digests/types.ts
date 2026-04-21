/**
 * Shared types for the digest generation pipeline.
 *
 * Digests are computed dynamically from the live events table — there is no
 * `digests` table in the DB anymore. Each digest has a hard-coded slug / title /
 * subtitle and a scoring function that picks 10–15 events.
 */

// ────────────────────────────────────────────────────────────────────────────
// Raw event row from the DB (matches events.db schema as of the latest
// import-csv.ts, which pulls most CSV fields into the table)
// ────────────────────────────────────────────────────────────────────────────

export interface EventRow {
  id: number;
  external_id: string | null;
  title: string;
  short_title: string | null;
  tagline: string | null;
  description: string | null;
  description_source: string | null;
  source_url: string | null;
  image_url: string | null;

  // Venue / geo
  venue_name: string | null;
  subway: string | null;
  address: string | null;
  city: string | null;
  city_district: string | null;
  city_locality: string | null;
  country_county: string | null;     // "New York County" = Manhattan; Kings = Brooklyn, etc.
  lat: number | null;
  lon: number | null;
  timezone: string | null;

  // Schedule
  schedule: string;                  // JSON object (date, kind, time_start_local, ...)
  occurrences: string;               // JSON array of {start_at, end_at}
  schedule_confidence: number | null; // 1..10
  schedule_source: string | null;
  next_start_at: string | null;
  next_end_at: string | null;

  // Age
  age_min: number | null;
  age_label: string | null;
  age_best_from: number | null;
  age_best_to: number | null;

  // Price
  is_free: number;
  price_summary: string | null;
  price_min: number | null;
  price_max: number | null;

  // Classification
  category_l1: string | null;
  category_l2: string | null;
  category_l3: string | null;
  categories: string;                // JSON array
  tags: string;                      // JSON array
  format: string | null;             // Python-list-like string, e.g. "['workshop','class']"
  motivation: string | null;         // Python-list-like string, e.g. "['bond','learn','play']"
  class_meta: string;                // JSON object

  // Quality
  reviews: string;                   // JSON array (strings or {text})
  derisk: string;                    // JSON object
  rating_avg: number;
  rating_count: number;
  favorites_count: number;
  comments_count: number;

  // Extra
  data: string;                      // JSON object (venue details, includes, etc.)
  status: string;
  disabled: number;
  archived: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Parsed structures
// ────────────────────────────────────────────────────────────────────────────

export interface ParsedData {
  venue_venue_type?: string;
  duration_minutes?: number;
  is_sold_out?: boolean;
  tickets_available?: number | null;
  includes?: string[];
  group_size_min?: number;
  group_size_max?: number;
  venue_stroller_friendly?: boolean;
  venue_wheelchair_accessible?: boolean;
  venue_accessibility_notes?: string;
  organizer_name?: string;
  [key: string]: unknown;
}

export interface Occurrence {
  start_at: string;
  end_at?: string;
}

export interface EnrichedEvent extends EventRow {
  tagsParsed: string[];
  categoriesParsed: string[];
  reviewsParsed: string[];
  /** e.g. ['workshop','class'] — tokens from the format field. */
  formatParsed: string[];
  /** e.g. ['bond','learn','play']. */
  motivationParsed: string[];
  dataParsed: ParsedData;
  /** All upcoming dates (may be multiple — recurring / multi-day events). */
  occurrencesParsed: Occurrence[];
  /** Lowercase blob of all text fields — for keyword matching. */
  textBlob: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Signal classifiers — each returns 0..1 confidence + reasons
// ────────────────────────────────────────────────────────────────────────────

export interface Signal {
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Human-readable reasons (for debugging + UI "why this" tooltips). */
  reasons: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// Digest output
// ────────────────────────────────────────────────────────────────────────────

export interface ScoredEvent {
  event: EventRow;
  score: number;
  reasons: string[];
}

export interface DigestMeta {
  id: number;
  slug: string;
  title: string;
  subtitle: string;
  cover_image: string | null;
  category: string;                   // UI groups digests by this field
  category_tag: string;
  curator_name: string;
  curator_role: string;
  context_tags: string;               // JSON string array
  event_count: number;
}

export interface DigestResult {
  meta: DigestMeta;
  events: EventRow[];
  coverage: {
    strong_candidates: number;
    weak_candidates: number;
    skipped_low_quality: number;
    notes: string[];
  };
  scored: ScoredEvent[];              // stripped from API response — audit only
}
