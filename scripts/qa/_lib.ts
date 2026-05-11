/**
 * Shared helpers for the QA audit suite (scripts/qa/*).
 *
 * Why a separate module: every audit script needs the same OpenAI client,
 * the same DB helpers, and the same "probably-fits" predicates. Keeping it
 * in one place means the semantics we test against stay consistent across
 * Filter / Digest / Chat / Ranking audits.
 */

import OpenAI from 'openai';
import Database from 'better-sqlite3';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

// ─── Config ────────────────────────────────────────────────────────────────
// Upgraded from gpt-4o-mini → gpt-4o for the full-audit pass.  Mini was
// losing nuance on edge calls ("is a Broadway show age-appropriate for 3yo?",
// "is this Queens event really accessible?"). gpt-4o is 10× pricier but the
// full suite is only ~300 judgments/run (~$5), so the quality win is worth it.
export const JUDGE_MODEL = 'gpt-4o';
export const CHAT_URL = process.env.QA_CHAT_URL || 'https://pulseup.me/api/chat';
export const EVENTS_URL = process.env.QA_EVENTS_URL || 'https://pulseup.me/api/events';
export const DB_PATH = path.join(process.cwd(), 'data', 'events.db');

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── DB types (lightweight, just what we need for audit) ──────────────────
export interface Ev {
  id: number;
  title: string;
  short_title?: string | null;
  description?: string | null;
  tagline?: string | null;
  age_label?: string | null;
  age_min?: number | null;
  age_best_from?: number | null;
  age_best_to?: number | null;
  is_free: boolean;
  price_min?: number | null;
  price_max?: number | null;
  price_summary?: string | null;
  category_l1?: string | null;
  categories: string[];
  tags: string[];
  format?: string | null;
  motivation?: string | null;
  country_county?: string | null;
  city?: string | null;
  city_district?: string | null;
  city_locality?: string | null;
  venue_name?: string | null;
  next_start_at?: string | null;
  rating_avg?: number | null;
  rating_count?: number | null;
  subway?: string | null;
  lat?: number | null;
  lon?: number | null;
}

function parseJson<T>(raw: string | null | undefined, fb: T): T {
  if (!raw) return fb;
  try { return JSON.parse(raw) as T; } catch {}
  try {
    const fixed = raw.replace(/'/g, '"').replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
    return JSON.parse(fixed) as T;
  } catch { return fb; }
}

export function loadLiveEvents(): Ev[] {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE (status IN ('published', 'done', 'new') OR status LIKE '%.done')
      AND disabled = 0 AND archived = 0
      AND (COALESCE(NULLIF(next_end_at, ''), datetime(next_start_at, '+1 day')) >= datetime('now') OR next_start_at IS NULL)
  `).all() as Record<string, unknown>[];
  db.close();
  return rows.map((r) => ({
    ...r,
    is_free: Boolean(r.is_free),
    categories: parseJson<string[]>(r.categories as string, []),
    tags: parseJson<string[]>(r.tags as string, []),
  })) as unknown as Ev[];
}

// ─── Predicates (gold standard for "could fit") ───────────────────────────

/** Does the event's age range include N? NULL bounds = open (fits). */
export function ageFits(e: Ev, n: number): boolean {
  const lo = e.age_best_from ?? e.age_min ?? null;
  const hi = e.age_best_to ?? null;
  if (lo !== null && lo > n) return false;
  if (hi !== null && hi < n) return false;
  return true;
}

/** Is the event in the given NYC borough? Uses county + text fallback. */
export function inBorough(e: Ev, borough: string): boolean {
  const COUNTY: Record<string, string> = {
    Manhattan: 'New York County',
    Brooklyn: 'Kings County',
    Queens: 'Queens County',
    Bronx: 'Bronx County',
    'Staten Island': 'Richmond County',
  };
  const target = COUNTY[borough];
  if (target && e.country_county === target) return true;

  // Text-based fallback — used when country_county is absent
  if (!e.country_county) {
    const haystack = [e.city, e.city_district, e.city_locality, e.venue_name]
      .filter(Boolean).join(' ').toLowerCase();
    if (haystack.includes(borough.toLowerCase())) return true;

    // BUG_010: city="New York" (with no other borough signal) maps to Manhattan.
    // ~30% of events arrive with city="New York" and no county/district data —
    // they were all being orphaned because the haystack check looks for the
    // literal string "manhattan", which never appears in the "city" field.
    if (borough === 'Manhattan') {
      const city = (e.city || '').trim().toLowerCase();
      if (
        city === 'new york' ||
        city === 'new york, ny' ||
        city === 'new york city' ||
        city === 'nyc'
      ) return true;
    }
  }
  return false;
}

/** "Probably fits" category — loose predicate for coverage checks. */
export function looseCat(e: Ev, slug: string): boolean {
  const needle = slug.toLowerCase();
  const bits: string[] = [];
  if (e.category_l1) bits.push(e.category_l1.toLowerCase());
  if (e.format) bits.push(e.format.toLowerCase());
  if (e.motivation) bits.push(e.motivation.toLowerCase());
  e.categories.forEach((c) => bits.push(String(c).toLowerCase()));
  e.tags.forEach((t) => bits.push(String(t).toLowerCase()));
  const blob = bits.join(' ');
  const SYN: Record<string, string[]> = {
    arts: ['art', 'paint', 'draw', 'craft', 'museum', 'creative', 'visual'],
    science: ['science', 'stem', 'steam', 'experiment', 'robotic', 'lab', 'tech'],
    music: ['music', 'concert', 'band', 'dj', 'song', 'choir'],
    outdoors: ['outdoor', 'nature', 'park', 'hike', 'garden', 'wildlife', 'trail'],
    food: ['food', 'cook', 'eat', 'dining', 'chef', 'culinary', 'bake'],
    theater: ['theater', 'theatre', 'play', 'broadway', 'performance'],
    books: ['book', 'story', 'library', 'reading', 'literary'],
    sports: ['sport', 'fitness', 'run', 'swim', 'basketball', 'soccer', 'athletic'],
    film: ['film', 'movie', 'cinema', 'screening'],
  };
  const terms = SYN[needle] || [needle];
  return terms.some((t) => blob.includes(t));
}

/** Is the next_start_at on a weekend (Sat/Sun) within 14 days? */
export function isUpcomingWeekend(e: Ev, nowMs = Date.now()): boolean {
  if (!e.next_start_at) return false;
  const ts = new Date(e.next_start_at).getTime();
  if (isNaN(ts)) return false;
  if (ts - nowMs > 14 * 24 * 3600_000) return false;
  const d = new Date(e.next_start_at).getDay();
  return d === 0 || d === 6;
}

/** Is it an "indoor" event by format/venue/text heuristics? */
export function looksIndoor(e: Ev): boolean {
  const fmt = (e.format ?? '').toLowerCase();
  if (['workshop', 'class', 'museum-visit', 'exhibition', 'theater-show', 'screening', 'lecture', 'talk'].includes(fmt)) return true;
  const blob = `${e.title} ${e.description ?? ''}`.toLowerCase();
  if (/\b(indoor|indoors)\b/.test(blob)) return true;
  return false;
}

/** Is it an "outdoor" event? Negative signal for Indoor digest. */
export function looksOutdoor(e: Ev): boolean {
  const fmt = (e.format ?? '').toLowerCase();
  if (['outdoor-festival', 'street-festival', 'parade', 'park-event', 'park-activity'].includes(fmt)) return true;
  const blob = `${e.title} ${e.description ?? ''}`.toLowerCase();
  if (/\b(outdoor|outdoors|park|street|festival)\b/.test(blob) && !/\bindoor\b/.test(blob)) return true;
  return false;
}

/** Is it affordable (free or ≤ $30)? */
export function looksAffordable(e: Ev): boolean {
  if (e.is_free) return true;
  if (typeof e.price_max === 'number' && e.price_max <= 30) return true;
  if (typeof e.price_min === 'number' && e.price_min <= 30) return true;
  return false;
}

/** Has strong social proof: rating_count ≥ 5 and we have a rating average. */
export function hasSocialProof(e: Ev): boolean {
  return (e.rating_count ?? 0) >= 5 && (e.rating_avg ?? 0) >= 4;
}

// ─── LLM judge ────────────────────────────────────────────────────────────

export async function judge<T = unknown>(
  systemPrompt: string,
  userPrompt: string,
  schema: 'json' | 'text' = 'json'
): Promise<T | string> {
  const resp = await openai.chat.completions.create({
    model: JUDGE_MODEL,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    ...(schema === 'json' ? { response_format: { type: 'json_object' } } : {}),
  });
  const raw = resp.choices[0]?.message?.content ?? '';
  if (schema === 'json') {
    try { return JSON.parse(raw) as T; }
    catch { return { _parse_error: true, raw } as unknown as T; }
  }
  return raw;
}

// ─── Output helpers ───────────────────────────────────────────────────────
export function fmtEv(e: Ev): string {
  const age = `${e.age_best_from ?? '?'}-${e.age_best_to ?? '?'}`;
  return `#${e.id} [${age}${e.is_free ? ' free' : ''}] ${(e.title ?? '').slice(0, 60)}`;
}

export async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Simple retry wrapper for flaky network calls. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 3, delayMs = 500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(delayMs * (i + 1)); }
  }
  throw last;
}
