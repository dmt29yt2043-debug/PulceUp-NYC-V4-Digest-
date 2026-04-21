/**
 * Turns a raw EventRow from the DB into an EnrichedEvent with all JSON / Python-
 * literal fields parsed, plus a lowercase text blob for keyword matching.
 */

import type { EventRow, EnrichedEvent, ParsedData, Occurrence } from './types';

// ─── Lenient JSON / Python-literal parsers ───────────────────────────────────

function tryParseJson<T>(val: string | null | undefined, fallback: T): T {
  if (!val || val === '' || val === '{}' || val === '[]') return fallback;
  try {
    return JSON.parse(val) as T;
  } catch {
    // Convert Python-literal artefacts to JSON.
    try {
      const cleaned = val
        .replace(/'/g, '"')
        .replace(/\bTrue\b/g, 'true')
        .replace(/\bFalse\b/g, 'false')
        .replace(/\bNone\b/g, 'null');
      return JSON.parse(cleaned) as T;
    } catch {
      return fallback;
    }
  }
}

function parseStringArray(val: string | null | undefined): string[] {
  const arr = tryParseJson<unknown[]>(val, []);
  if (!Array.isArray(arr)) return [];
  return arr.filter((x): x is string => typeof x === 'string').map((s) => s.trim());
}

/**
 * `format` / `motivation` are stored as Python-literal list strings like
 * "['workshop', 'class']". parseStringArray handles them via the JSON fallback.
 * Kept as a separate named helper for clarity at call sites.
 */
function parsePythonListString(val: string | null | undefined): string[] {
  if (!val) return [];
  const parsed = parseStringArray(val);
  if (parsed.length > 0) return parsed;
  // Last-resort regex: match '...'-quoted tokens.
  const matches = val.match(/'([^']+)'/g);
  if (!matches) return [];
  return matches.map((m) => m.replace(/'/g, '').trim());
}

function parseReviews(val: string | null | undefined): string[] {
  const arr = tryParseJson<unknown[]>(val, []);
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) => {
      if (typeof r === 'string') return r;
      if (r && typeof r === 'object' && 'text' in r && typeof (r as { text: unknown }).text === 'string') {
        return (r as { text: string }).text;
      }
      return '';
    })
    .filter((s) => s.length > 0);
}

function parseData(val: string | null | undefined): ParsedData {
  return tryParseJson<ParsedData>(val, {});
}

function parseOccurrences(val: string | null | undefined): Occurrence[] {
  const arr = tryParseJson<unknown[]>(val, []);
  if (!Array.isArray(arr)) return [];
  const out: Occurrence[] = [];
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    const obj = o as Record<string, unknown>;
    if (typeof obj.start_at !== 'string') continue;
    const occ: Occurrence = { start_at: obj.start_at };
    if (typeof obj.end_at === 'string') occ.end_at = obj.end_at;
    out.push(occ);
  }
  return out;
}

// ─── Text blob builder ───────────────────────────────────────────────────────

function buildTextBlob(
  row: EventRow,
  tagsParsed: string[],
  categoriesParsed: string[],
  reviewsParsed: string[],
  formatParsed: string[],
  motivationParsed: string[],
  dataParsed: ParsedData,
): string {
  const parts: string[] = [
    row.title || '',
    row.short_title || '',
    row.tagline || '',
    row.description || '',
    row.description_source || '',
    row.category_l1 || '',
    row.category_l2 || '',
    row.category_l3 || '',
    row.venue_name || '',
    row.price_summary || '',
    row.age_label || '',
    row.address || '',
    row.subway || '',
    row.city || '',
    row.city_locality || '',
    row.city_district || '',
    tagsParsed.join(' '),
    categoriesParsed.join(' '),
    reviewsParsed.join(' '),
    formatParsed.join(' '),
    motivationParsed.join(' '),
    (dataParsed.venue_venue_type as string) || '',
    Array.isArray(dataParsed.includes) ? dataParsed.includes.join(' ') : '',
    (dataParsed.organizer_name as string) || '',
    (dataParsed.venue_accessibility_notes as string) || '',
  ];
  return parts.join(' ').toLowerCase();
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function enrich(row: EventRow): EnrichedEvent {
  const tagsParsed       = parseStringArray(row.tags);
  const categoriesParsed = parseStringArray(row.categories);
  const reviewsParsed    = parseReviews(row.reviews);
  const formatParsed     = parsePythonListString(row.format);
  const motivationParsed = parsePythonListString(row.motivation);
  const dataParsed       = parseData(row.data);
  const occurrencesParsed = parseOccurrences(row.occurrences);
  return {
    ...row,
    tagsParsed,
    categoriesParsed,
    reviewsParsed,
    formatParsed,
    motivationParsed,
    dataParsed,
    occurrencesParsed,
    textBlob: buildTextBlob(
      row, tagsParsed, categoriesParsed, reviewsParsed,
      formatParsed, motivationParsed, dataParsed,
    ),
  };
}

// ─── Small helpers reused by signals ─────────────────────────────────────────

/** Count how many of the given keywords appear in the blob. */
export function countKeywordHits(blob: string, keywords: readonly string[]): number {
  let hits = 0;
  for (const kw of keywords) if (blob.includes(kw)) hits++;
  return hits;
}

/** Return the list of keywords that matched — useful for "why this" reasons. */
export function matchedKeywords(blob: string, keywords: readonly string[]): string[] {
  return keywords.filter((kw) => blob.includes(kw));
}

/** True if any element of `set` is present in `tokens`. */
export function anyInSet(tokens: readonly string[], set: Set<string>): boolean {
  for (const t of tokens) if (set.has(t)) return true;
  return false;
}

/** Count how many tokens are in the set. */
export function countInSet(tokens: readonly string[], set: Set<string>): number {
  let n = 0;
  for (const t of tokens) if (set.has(t)) n++;
  return n;
}
