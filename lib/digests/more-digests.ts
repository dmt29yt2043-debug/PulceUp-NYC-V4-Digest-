/**
 * 10 additional parent-query-style digests.
 *
 * Design principle: each digest answers a natural language question a NYC
 * parent asks herself several times a week. Titles are written to feel like
 * a real query ("Teens won't roll their eyes", "$25 or less") so the shelf
 * doubles as a curated set of pre-made searches.
 *
 * Kept in a single file because each scorer is short (~25 lines) — the five
 * original digests warrant their own files because of fallback / window logic,
 * but these 10 are uniform "classify + combine + rank".
 *
 * All scorers follow the same shape:
 *   scoreX(ev) → ScoredEvent | null          (null = hard-excluded)
 *   getXDigest(events) → DigestResult        (ranks + picks top N)
 */

import type { EnrichedEvent, DigestResult, ScoredEvent, DigestMeta, EventRow } from './types';
import { THRESHOLDS } from './constants';
import {
  classifyFamily, classifyQuality, classifyAffordable, classifyOutdoor,
} from './signals';
import { baseGeoAndCompleteness, dedupe, pickWithFallback } from './scoring-helpers';
import { countKeywordHits, matchedKeywords, anyInSet, countInSet } from './event-parser';

// ════════════════════════════════════════════════════════════════════════════
// Local keyword sets — narrow topic matchers not shared with other digests
// ════════════════════════════════════════════════════════════════════════════

const ART_FORMATS    = new Set(['workshop', 'class', 'exhibition']);
const ART_MOTIVATIONS = new Set(['create', 'be-inspired']);
const ART_KEYWORDS   = [
  'art', 'arts', 'painting', 'drawing', 'craft', 'crafts', 'pottery',
  'clay', 'sculpt', 'make-and-take', 'make and take', 'design', 'creative',
  'hands-on', 'paint', 'collage', 'diy', 'art studio',
];

const SCIENCE_KEYWORDS = [
  'science', 'stem', 'steam', 'robot', 'robotics', 'coding', 'programming',
  'technology', 'engineering', 'lab', 'experiment', 'chemistry', 'physics',
  'planetarium', 'discovery', 'invention', 'biology', 'nature study',
];

const ACTIVE_KEYWORDS = [
  'sport', 'sports', 'run', 'running', 'basketball', 'soccer', 'climb',
  'climbing', 'bike', 'biking', 'skate', 'skating', 'swim', 'swimming',
  'yoga', 'martial arts', 'karate', 'dance', 'tumbling', 'gymnastics',
  'trampoline', 'obstacle', 'playground', 'playspace',
];

const BOOK_KEYWORDS = [
  'storytime', 'story time', 'story-time', 'book', 'books', 'library',
  'reading', 'read aloud', 'read-aloud', 'author', 'poetry', 'literature',
  'bookstore', 'book club', 'picture book',
];

const STROLLER_KEYWORDS = [
  'stroller', 'stroller-friendly', 'stroller friendly', 'baby', 'babies',
  'infant', 'newborn', 'baby-friendly',
];

const AFTER_SCHOOL_KEYWORDS = [
  'after school', 'after-school', 'afterschool', 'weekday afternoon',
  'pickup', 'pick up',
];

// ════════════════════════════════════════════════════════════════════════════
// Shared helper — builds picks from a scored list
// ════════════════════════════════════════════════════════════════════════════

function rankAndPick(
  scored: ScoredEvent[],
  target = 10,
  strongFloor = 55,
  weakFloor = 35,
): ReturnType<typeof pickWithFallback> {
  const deduped = dedupe(scored);
  return pickWithFallback(deduped, {
    target,
    strongFloor,
    weakFloor,
    absoluteFloor: THRESHOLDS.ABSOLUTE_FLOOR,
  });
}

function buildResult(
  base: Omit<DigestMeta, 'cover_image' | 'event_count'>,
  picks: ScoredEvent[],
  strong: number,
  weak: number,
  skipped: number,
  notes: string[] = [],
): DigestResult {
  const meta: DigestMeta = {
    ...base,
    cover_image: picks[0]?.event.image_url ?? null,
    event_count: picks.length,
  };
  return {
    meta,
    events: picks.map((s) => s.event) as EventRow[],
    coverage: { strong_candidates: strong, weak_candidates: weak, skipped_low_quality: skipped, notes },
    scored: picks,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Little Artists & Makers — creative, arts, workshops
// ════════════════════════════════════════════════════════════════════════════

const LITTLE_ARTISTS_META = {
  id: 106,
  slug: 'little-artists',
  title: 'Little Artists & Makers',
  subtitle: 'Hands-on art, crafts, and creative workshops across NYC.',
  category: "Mom's Digest",
  category_tag: 'ARTS',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['arts', 'creative', 'workshops', 'crafts']),
};

export function scoreLittleArtists(ev: EnrichedEvent): ScoredEvent | null {
  const isArts = (ev.category_l1 || '').toLowerCase() === 'arts';
  const hasArtFormat = anyInSet(ev.formatParsed, ART_FORMATS);
  const hasArtMotiv = anyInSet(ev.motivationParsed, ART_MOTIVATIONS);
  const artKw = countKeywordHits(ev.textBlob, ART_KEYWORDS);

  // Hard gate: must have at least two art signals
  const artSignals = (isArts ? 1 : 0) + (hasArtFormat ? 1 : 0) + (hasArtMotiv ? 1 : 0) + (artKw >= 2 ? 1 : 0);
  if (artSignals < 2) return null;

  const reasons: string[] = [];
  let score = 0;
  const base = baseGeoAndCompleteness(ev);
  score += base.score;
  reasons.push(...base.reasons);

  if (isArts)       { score += 25; reasons.push('category=arts'); }
  if (hasArtFormat) { score += 15; reasons.push('art format'); }
  if (hasArtMotiv)  { score += 15; reasons.push('create motivation'); }
  if (artKw > 0)    { score += Math.min(15, artKw * 3); reasons.push(`art kw ×${artKw}`); }

  const fam = classifyFamily(ev);
  score += Math.round(fam.confidence * 15);

  const q = classifyQuality(ev);
  score += Math.round(q.confidence * 10);

  return { event: ev, score, reasons };
}

export function getLittleArtistsDigest(events: EnrichedEvent[]): DigestResult {
  const scored = events.map(scoreLittleArtists).filter((s): s is ScoredEvent => s !== null);
  const r = rankAndPick(scored);
  return buildResult(LITTLE_ARTISTS_META, r.picks, r.strong, r.weak, r.skipped);
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Budding Scientists — STEM, science museums, coding, labs
// ════════════════════════════════════════════════════════════════════════════

const SCIENTISTS_META = {
  id: 107,
  slug: 'budding-scientists',
  title: 'Budding Scientists',
  subtitle: 'Science, tech, and STEM — sparks for curious minds.',
  category: "Mom's Digest",
  category_tag: 'SCIENCE',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['science', 'stem', 'learning']),
};

export function scoreScientists(ev: EnrichedEvent): ScoredEvent | null {
  const isScience = (ev.category_l1 || '').toLowerCase() === 'science';
  const hasLearnMotiv = ev.motivationParsed.includes('learn')
                     || ev.motivationParsed.includes('discover-tech');
  const sciKw = countKeywordHits(ev.textBlob, SCIENCE_KEYWORDS);

  if (!isScience && sciKw < 2 && !hasLearnMotiv) return null;
  if (sciKw < 1 && !isScience) return null; // must have at least one science word if not in science category

  const reasons: string[] = [];
  let score = 0;
  const base = baseGeoAndCompleteness(ev);
  score += base.score;
  reasons.push(...base.reasons);

  if (isScience)       { score += 30; reasons.push('category=science'); }
  if (hasLearnMotiv)   { score += 15; reasons.push('learn motivation'); }
  if (sciKw > 0)       { score += Math.min(20, sciKw * 4); reasons.push(`science kw ×${sciKw}`); }

  const fam = classifyFamily(ev);
  score += Math.round(fam.confidence * 15);

  const q = classifyQuality(ev);
  score += Math.round(q.confidence * 10);

  return { event: ev, score, reasons };
}

export function getScientistsDigest(events: EnrichedEvent[]): DigestResult {
  const scored = events.map(scoreScientists).filter((s): s is ScoredEvent => s !== null);
  const r = rankAndPick(scored, 10, 50, 30);
  return buildResult(SCIENTISTS_META, r.picks, r.strong, r.weak, r.skipped);
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Run Off That Energy — sports, active, outdoor play
// ════════════════════════════════════════════════════════════════════════════

const ENERGY_META = {
  id: 108,
  slug: 'run-off-energy',
  title: 'Run Off That Energy',
  subtitle: 'Sports, active play, and outdoor adventures to burn it off.',
  category: "Mom's Digest",
  category_tag: 'ACTIVE',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['sports', 'active', 'outdoor']),
};

/**
 * Detect "5K / charity walk" pattern. These are real sports events, but
 * they're for adults — kids running off energy is the parent intent here.
 * Used to cap their share in the digest (Bug #10).
 */
function is5kRun(ev: EnrichedEvent): boolean {
  const t = (ev.title || '').toLowerCase();
  return /\b\d+k\s*(run|walk|race|charity|fundraiser)?/i.test(t)
      || /\bmarathon\b/i.test(t)
      || /\bfundraiser\b/i.test(t)
      || /\bcharity\b/i.test(t);
}

export function scoreEnergy(ev: EnrichedEvent): ScoredEvent | null {
  const cat = (ev.category_l1 || '').toLowerCase();
  const isSportsOrOutdoor = cat === 'sports' || cat === 'outdoors';
  const hasActiveFormat = ev.formatParsed.some((f) =>
    f === 'sports-event' || f === 'training-session' || f === 'competition'
  );
  const kw = countKeywordHits(ev.textBlob, ACTIVE_KEYWORDS);

  if (!isSportsOrOutdoor && !hasActiveFormat && kw < 2) return null;

  const reasons: string[] = [];
  let score = 0;
  const base = baseGeoAndCompleteness(ev);
  score += base.score;
  reasons.push(...base.reasons);

  if (isSportsOrOutdoor) { score += 25; reasons.push(`category=${cat}`); }
  if (hasActiveFormat)   { score += 15; reasons.push('active format'); }
  if (kw > 0)            { score += Math.min(20, kw * 3); reasons.push(`active kw ×${kw}`); }

  const out = classifyOutdoor(ev);
  score += Math.round(out.confidence * 10);

  const fam = classifyFamily(ev);
  score += Math.round(fam.confidence * 15);

  return { event: ev, score, reasons };
}

export function getEnergyDigest(events: EnrichedEvent[]): DigestResult {
  const scored = events.map(scoreEnergy).filter((s): s is ScoredEvent => s !== null);
  const deduped = dedupe(scored);

  // QA finding: 80% of top-10 was adult charity 5K races. Cap them at 3 so
  // playgrounds, classes, and family sports actually surface.
  const sorted = [...deduped].sort((a, b) => b.score - a.score);
  const fiveKBucket: ScoredEvent[] = [];
  const otherBucket: ScoredEvent[] = [];
  for (const s of sorted) {
    if (is5kRun(s.event as EnrichedEvent)) fiveKBucket.push(s);
    else otherBucket.push(s);
  }
  const limited5k = fiveKBucket.slice(0, 3);
  const merged = [...otherBucket, ...limited5k].sort((a, b) => b.score - a.score);

  const r = rankAndPick(merged, 10, 50, 30);
  return buildResult(ENERGY_META, r.picks, r.strong, r.weak, r.skipped);
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Storytime & Book Lovers — libraries, reading, storytelling
// ════════════════════════════════════════════════════════════════════════════

const STORYTIME_META = {
  id: 109,
  slug: 'story-time-lovers',
  title: 'Storytime & Book Lovers',
  subtitle: 'Library storytimes, author meets, and book-inspired family events.',
  category: "Mom's Digest",
  category_tag: 'BOOKS',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['books', 'storytime', 'library']),
};

export function scoreStorytime(ev: EnrichedEvent): ScoredEvent | null {
  const isBooks = (ev.category_l1 || '').toLowerCase() === 'books';
  const kw = countKeywordHits(ev.textBlob, BOOK_KEYWORDS);
  const venueLib = /library|bookstore|barnes.?&.?noble/i.test(ev.venue_name || '');

  if (!isBooks && kw < 1 && !venueLib) return null;

  const reasons: string[] = [];
  let score = 0;
  const base = baseGeoAndCompleteness(ev);
  score += base.score;
  reasons.push(...base.reasons);

  if (isBooks)   { score += 30; reasons.push('category=books'); }
  if (venueLib)  { score += 20; reasons.push('library venue'); }
  if (kw > 0)    { score += Math.min(20, kw * 4); reasons.push(`book kw ×${kw}`); }

  const fam = classifyFamily(ev);
  score += Math.round(fam.confidence * 15);

  const q = classifyQuality(ev);
  score += Math.round(q.confidence * 10);

  return { event: ev, score, reasons };
}

export function getStorytimeDigest(events: EnrichedEvent[]): DigestResult {
  const scored = events.map(scoreStorytime).filter((s): s is ScoredEvent => s !== null);
  const r = rankAndPick(scored, 10, 50, 30);
  return buildResult(STORYTIME_META, r.picks, r.strong, r.weak, r.skipped);
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Toddler Tornado (Under 5) — age-gated: best_from ≤ 4
// ════════════════════════════════════════════════════════════════════════════

const TODDLER_META = {
  id: 110,
  slug: 'toddler-tornado',
  title: 'Toddler Tornado (Under 5)',
  subtitle: 'Hand-picked for the littlest ones — safe, short, and stroller-sized.',
  category: "Mom's Digest",
  category_tag: 'TODDLER',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['toddler', 'under-5', 'preschool']),
};

export function scoreToddler(ev: EnrichedEvent): ScoredEvent | null {
  // Event must be age-appropriate for under-5
  const from = ev.age_best_from ?? ev.age_min;
  const to = ev.age_best_to;
  if (from == null) return null;
  if (from > 5) return null;                 // not for toddlers
  if (to != null && to < 2) return null;     // age range too narrow (e.g. 0-1 only)

  const reasons: string[] = [];
  let score = 0;
  const base = baseGeoAndCompleteness(ev);
  score += base.score;
  reasons.push(...base.reasons);

  // Reward events specifically targeted at young kids
  if (from <= 3) { score += 20; reasons.push(`ages ${from}+`); }
  else           { score += 10; reasons.push(`ages ${from}+`); }

  if (ev.formatParsed.includes('kids-playgroup')) {
    score += 15;
    reasons.push('kids-playgroup');
  }

  const fam = classifyFamily(ev);
  score += Math.round(fam.confidence * 20);

  const q = classifyQuality(ev);
  score += Math.round(q.confidence * 10);

  return { event: ev, score, reasons };
}

export function getToddlerDigest(events: EnrichedEvent[]): DigestResult {
  const scored = events.map(scoreToddler).filter((s): s is ScoredEvent => s !== null);
  const r = rankAndPick(scored, 10, 55, 35);
  return buildResult(TODDLER_META, r.picks, r.strong, r.weak, r.skipped);
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Teens Won't Roll Their Eyes — age-gated: best_to ≥ 12
// ════════════════════════════════════════════════════════════════════════════

const TEENS_META = {
  id: 111,
  slug: 'teens-will-approve',
  title: 'Teens Won\'t Roll Their Eyes',
  subtitle: 'Things a 12–17-year-old might actually get off their phone for.',
  category: "Mom's Digest",
  category_tag: 'TEENS',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['teens', '12+', 'older-kids']),
};

export function scoreTeens(ev: EnrichedEvent): ScoredEvent | null {
  const from = ev.age_best_from;
  const to = ev.age_best_to;
  // Want events whose sweet spot includes 12-17 (teens). Tightened gate after
  // QA found "47th NYC ABE Conference (Exhibitor Registration)" age 18+
  // adult-education conference appearing in this digest (Bug #13).
  //   - hard floor: from <= 17 (can't be adults-only)
  //   - hard ceiling: (to ?? 99) >= 12 (must include at least the youngest teen)
  if (from != null && from > 17) return null;
  if (to != null && to < 12) return null;
  // If neither bound is set, require strong signal from `from` itself
  if (to == null && from == null) return null;

  const reasons: string[] = [];
  let score = 0;
  const base = baseGeoAndCompleteness(ev);
  score += base.score;
  reasons.push(...base.reasons);

  if (from != null && from >= 10) { score += 15; reasons.push(`ages ${from}+`); }
  if (to != null && to >= 15)     { score += 10; reasons.push(`up to ${to}`); }

  // Engaging formats teens actually tolerate
  const goodFmts = ['concert', 'live-performance', 'screening', 'competition',
    'sports-event', 'exhibition', 'festival', 'gaming'];
  if (ev.formatParsed.some((f) => goodFmts.includes(f))) {
    score += 15;
    reasons.push('teen-friendly format');
  }

  const q = classifyQuality(ev);
  score += Math.round(q.confidence * 25);

  return { event: ev, score, reasons };
}

export function getTeensDigest(events: EnrichedEvent[]): DigestResult {
  const scored = events.map(scoreTeens).filter((s): s is ScoredEvent => s !== null);
  const r = rankAndPick(scored, 10, 50, 30);
  return buildResult(TEENS_META, r.picks, r.strong, r.weak, r.skipped);
}

// ════════════════════════════════════════════════════════════════════════════
// 7. $25 or Less — budget-friendly family fun
// ════════════════════════════════════════════════════════════════════════════

const BUDGET_META = {
  id: 112,
  slug: 'under-twenty-five',
  title: '$25 or Less',
  subtitle: 'Solid family outings that won\'t break the bank.',
  category: "Mom's Digest",
  category_tag: 'BUDGET',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['budget', 'cheap', 'under-25']),
};

export function scoreBudget(ev: EnrichedEvent): ScoredEvent | null {
  const pmax = ev.price_max ?? 0;
  const isFree = ev.is_free === 1;
  // Hard gate: must be free OR price_max ≤ 25
  if (!isFree && (pmax === 0 || pmax > 25)) return null;

  const reasons: string[] = [];
  let score = 0;
  const base = baseGeoAndCompleteness(ev);
  score += base.score;
  reasons.push(...base.reasons);

  if (isFree) {
    score += 20; reasons.push('free');
  } else if (pmax <= 10) {
    score += 25; reasons.push(`$${pmax}`);
  } else if (pmax <= 20) {
    score += 18; reasons.push(`$${pmax}`);
  } else {
    score += 12; reasons.push(`$${pmax}`);
  }

  const fam = classifyFamily(ev);
  score += Math.round(fam.confidence * 20);

  const q = classifyQuality(ev);
  score += Math.round(q.confidence * 15);

  // Gently de-rank pure "free" items — they already have a dedicated digest
  if (isFree) score -= 5;

  return { event: ev, score, reasons };
}

export function getBudgetDigest(events: EnrichedEvent[]): DigestResult {
  const scored = events.map(scoreBudget).filter((s): s is ScoredEvent => s !== null);
  const r = rankAndPick(scored, 10, 55, 35);
  return buildResult(BUDGET_META, r.picks, r.strong, r.weak, r.skipped);
}

// ════════════════════════════════════════════════════════════════════════════
// 8. Stroller Ready (With Baby) — baby-friendly, stroller-accessible
// ════════════════════════════════════════════════════════════════════════════

const STROLLER_META = {
  id: 113,
  slug: 'stroller-ready',
  title: 'Stroller Ready (With Baby)',
  subtitle: 'Baby-welcome, stroller-friendly spots for parents on the move.',
  category: "Mom's Digest",
  category_tag: 'BABY',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['baby', 'stroller', 'under-2']),
};

export function scoreStroller(ev: EnrichedEvent): ScoredEvent | null {
  const strollerVenue = ev.dataParsed.venue_stroller_friendly === true;
  const kw = countKeywordHits(ev.textBlob, STROLLER_KEYWORDS);
  const from = ev.age_best_from ?? ev.age_min;
  const youngFriendly = from != null && from <= 2;

  if (!strollerVenue && kw < 1 && !youngFriendly) return null;

  const reasons: string[] = [];
  let score = 0;
  const base = baseGeoAndCompleteness(ev);
  score += base.score;
  reasons.push(...base.reasons);

  if (strollerVenue) { score += 30; reasons.push('stroller-friendly venue'); }
  if (youngFriendly) { score += 15; reasons.push(`ages ${from}+`); }
  if (kw > 0)        { score += Math.min(15, kw * 4); reasons.push(`baby kw ×${kw}`); }

  const fam = classifyFamily(ev);
  score += Math.round(fam.confidence * 15);

  const q = classifyQuality(ev);
  score += Math.round(q.confidence * 10);

  // Price demerit — parents with babies usually want budget-friendly options.
  // QA found a $100 karaoke event in the top 5 (Bug #14).
  const pmax = ev.price_max ?? 0;
  if (!ev.is_free && pmax > 30) {
    score -= 15;
    reasons.push(`expensive ($${pmax}) — demerit`);
  }

  return { event: ev, score, reasons };
}

export function getStrollerDigest(events: EnrichedEvent[]): DigestResult {
  const scored = events.map(scoreStroller).filter((s): s is ScoredEvent => s !== null);
  const r = rankAndPick(scored, 10, 50, 30);
  return buildResult(STROLLER_META, r.picks, r.strong, r.weak, r.skipped);
}

// ════════════════════════════════════════════════════════════════════════════
// 9. After-School Quick Wins — weekday afternoon events
// ════════════════════════════════════════════════════════════════════════════

const AFTER_SCHOOL_META = {
  id: 114,
  slug: 'after-school-quick',
  title: 'After-School Quick Wins',
  subtitle: 'Weekday afternoons — drop in after pickup.',
  category: "Mom's Digest",
  category_tag: 'AFTER-SCHOOL',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['weekday', 'after-school', 'afternoon']),
};

/**
 * "After-school" heuristic:
 *   - Event happens on a weekday (Mon–Fri)
 *   - Start time between 14:00 and 19:00 NY time
 *   - OR text contains explicit "after school" keyword
 */
function isAfterSchoolSlot(iso: string | null): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  const d = new Date(ms);
  // Use UTC parts — close enough without pulling in a tz lib
  const hour = d.getUTCHours();
  const dow = d.getUTCDay();
  const isWeekday = dow >= 1 && dow <= 5;
  // Rough NY local hour: UTC−4/5. 14–19 NY ≈ 18–00 UTC
  const isAfternoon = hour >= 18 || hour < 1;
  return isWeekday && isAfternoon;
}

export function scoreAfterSchool(ev: EnrichedEvent): ScoredEvent | null {
  const slotMatch = isAfterSchoolSlot(ev.next_start_at)
    || ev.occurrencesParsed.some((o) => isAfterSchoolSlot(o.start_at));
  const kwMatch = countKeywordHits(ev.textBlob, AFTER_SCHOOL_KEYWORDS) > 0;

  if (!slotMatch && !kwMatch) return null;

  // Date proximity gate — "after-school quick wins" implies actionable today
  // or in the next ~2 weeks. Without this, June events leak in (Bug #11).
  if (ev.next_start_at) {
    const ms = Date.parse(ev.next_start_at);
    if (Number.isFinite(ms)) {
      const daysAway = (ms - Date.now()) / 86_400_000;
      if (daysAway > 14) return null;
    }
  }

  const reasons: string[] = [];
  let score = 0;
  const base = baseGeoAndCompleteness(ev);
  score += base.score;
  reasons.push(...base.reasons);

  if (slotMatch) { score += 25; reasons.push('weekday afternoon'); }
  if (kwMatch)   { score += 15; reasons.push('after-school kw'); }

  const fam = classifyFamily(ev);
  score += Math.round(fam.confidence * 20);

  // De-rank events requiring advance registration
  const neg = matchedKeywords(ev.textBlob, [
    'registration required', 'advance ticket', 'must register', 'audition',
  ]);
  if (neg.length > 0) score -= 10;

  const q = classifyQuality(ev);
  score += Math.round(q.confidence * 10);

  return { event: ev, score, reasons };
}

export function getAfterSchoolDigest(events: EnrichedEvent[]): DigestResult {
  const scored = events.map(scoreAfterSchool).filter((s): s is ScoredEvent => s !== null);
  const r = rankAndPick(scored, 10, 50, 30);
  return buildResult(AFTER_SCHOOL_META, r.picks, r.strong, r.weak, r.skipped);
}

// ════════════════════════════════════════════════════════════════════════════
// 10. Brooklyn Spotlight — borough-specific highlights
// ════════════════════════════════════════════════════════════════════════════

const BROOKLYN_META = {
  id: 115,
  slug: 'brooklyn-spotlight',
  title: 'Brooklyn Highlights',
  subtitle: 'The best of Brooklyn for families — this week and beyond.',
  category: "Mom's Digest",
  category_tag: 'BROOKLYN',
  curator_name: 'Pulse',
  curator_role: 'Curated by PulseUp',
  context_tags: JSON.stringify(['brooklyn', 'borough']),
};

export function scoreBrooklyn(ev: EnrichedEvent): ScoredEvent | null {
  const county = (ev.country_county || '').toLowerCase().trim();
  const city   = (ev.city || '').toLowerCase().trim();
  const isBrooklyn = county === 'kings county' || city === 'brooklyn';
  if (!isBrooklyn) return null;

  const reasons: string[] = [];
  let score = 30; // flat bonus for being in Brooklyn (no NYC base needed)
  reasons.push('Brooklyn');

  const base = baseGeoAndCompleteness(ev);
  score += Math.round(base.score * 0.5); // soften geo double-count

  const fam = classifyFamily(ev);
  score += Math.round(fam.confidence * 20);

  const q = classifyQuality(ev);
  score += Math.round(q.confidence * 20);

  return { event: ev, score, reasons };
}

export function getBrooklynDigest(events: EnrichedEvent[]): DigestResult {
  const scored = events.map(scoreBrooklyn).filter((s): s is ScoredEvent => s !== null);
  const r = rankAndPick(scored, 10, 50, 30);
  return buildResult(BROOKLYN_META, r.picks, r.strong, r.weak, r.skipped);
}

// ════════════════════════════════════════════════════════════════════════════
// Public re-export used by lib/digests/index.ts
// ════════════════════════════════════════════════════════════════════════════

export const MORE_DIGEST_RUNNERS = [
  getLittleArtistsDigest,
  getScientistsDigest,
  getEnergyDigest,
  getStorytimeDigest,
  getToddlerDigest,
  getTeensDigest,
  getBudgetDigest,
  getStrollerDigest,
  getAfterSchoolDigest,
  getBrooklynDigest,
];

export const MORE_DIGEST_SLUGS = [
  'little-artists',
  'budding-scientists',
  'run-off-energy',
  'story-time-lovers',
  'toddler-tornado',
  'teens-will-approve',
  'under-twenty-five',
  'stroller-ready',
  'after-school-quick',
  'brooklyn-spotlight',
];

// unused but exported so tree-shaking doesn't drop helpers referenced elsewhere
void countInSet; void classifyAffordable;
