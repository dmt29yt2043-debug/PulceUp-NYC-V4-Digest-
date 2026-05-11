import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

export const dynamic = 'force-dynamic';

const DB_PATH = path.join(process.cwd(), 'data', 'events.db');

const BOROUGH_BOUNDS: Record<string, { latMin: number; latMax: number; lonMin: number; lonMax: number }> = {
  manhattan:       { latMin: 40.70, latMax: 40.88, lonMin: -74.02, lonMax: -73.91 },
  brooklyn:        { latMin: 40.57, latMax: 40.74, lonMin: -74.04, lonMax: -73.83 },
  queens:          { latMin: 40.54, latMax: 40.80, lonMin: -73.96, lonMax: -73.70 },
  bronx:           { latMin: 40.80, latMax: 40.92, lonMin: -73.93, lonMax: -73.75 },
  'staten island': { latMin: 40.49, latMax: 40.65, lonMin: -74.26, lonMax: -74.05 },
  staten_island:   { latMin: 40.49, latMax: 40.65, lonMin: -74.26, lonMax: -74.05 }, // quiz uses underscore
};

// Maps quiz interest slugs → event category values in the DB.
// Must stay in sync with the quiz spec (interests list in docs/quiz-url-contract.md).
const INTEREST_TO_CATEGORIES: Record<string, string[]> = {
  // Core quiz interests (per quiz contract)
  outdoor:     ['outdoors', 'Outdoor', 'attractions'],
  playgrounds: ['family', "Children's Activities", 'attractions'],
  museums:     ['Art', 'arts', 'science'],
  classes:     ['arts', 'Art', "Children's Activities"],
  arts_crafts: ['arts', 'Art'],
  sports:      ['sports', 'Sports & Fitness'],
  science:     ['science'],
  animals:     ['family', 'attractions'],
  indoor_play: ['family', "Children's Activities", 'attractions'],
  // Additional (from ChatSidebar quiz flow / legacy)
  theater:     ['theater', 'Theater & Performing Arts'],
  music:       ['music'],
  film:        ['film'],
  gaming:      ['gaming'],
  art:         ['Art', 'arts'],
  family:      ['family', 'Parents & Kids', 'Family & Kids', "Children's Activities"],
  holiday:     ['holiday', 'Holiday & Seasonal'],
  attractions: ['attractions', 'Attractions & Activities'],
};

/**
 * Parse age string from quiz params.
 * Supports both formats:
 *   - New (exact number):   "7"      → { min: 7, max: 7 }
 *   - Legacy (range):       "3-5"    → { min: 3, max: 5 }
 *   - Legacy (open end):    "16+"    → { min: 16, max: 18 }
 */
function parseAgeRange(ageStr: string): { min: number; max: number } {
  if (!ageStr) return { min: 4, max: 10 };
  // Open-end legacy: "16+"
  if (ageStr.includes('+')) {
    const n = parseInt(ageStr.replace('+', ''), 10);
    return { min: isNaN(n) ? 16 : n, max: 18 };
  }
  // New format: exact number "7"
  if (!ageStr.includes('-')) {
    const n = parseInt(ageStr, 10);
    return !isNaN(n) ? { min: n, max: n } : { min: 4, max: 10 };
  }
  // Legacy range: "3-5"
  const parts = ageStr.split('-').map((s) => parseInt(s, 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return { min: parts[0], max: parts[1] };
  }
  return { min: 4, max: 10 }; // safe default
}

/**
 * Parse `children` quiz param.
 * New format:    "boy:7,girl:3"      (exact age)
 * Legacy format: "boy:3-5,girl:9-12" (age range)
 * Falls back to back-compat `child_age` + `gender` when `children` is absent.
 */
function parseChildren(
  childrenParam: string | null,
  fallbackAge: string,
  fallbackGender: string | null,
): Array<{ gender: string; ageRange: { min: number; max: number } }> {
  if (childrenParam) {
    const parsed = childrenParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((piece) => {
        const [gender, age] = piece.split(':');
        if (!age) return null;
        return { gender: (gender || 'unknown').toLowerCase(), ageRange: parseAgeRange(age) };
      })
      .filter((x): x is { gender: string; ageRange: { min: number; max: number } } => x !== null);
    if (parsed.length > 0) return parsed;
  }
  // Back-compat: single-child from child_age + gender
  return [{ gender: (fallbackGender || 'unknown').toLowerCase(), ageRange: parseAgeRange(fallbackAge) }];
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  // --- Quiz params (see docs/quiz-url-contract.md) ---
  // child_age: new format = exact number "7"; legacy = range "3-5" or "16+"
  const childAge   = sp.get('child_age') || '8';
  const gender     = sp.get('gender');                    // back-compat, first child
  const children   = parseChildren(sp.get('children'), childAge, gender);
  const borough    = (sp.get('borough') || 'manhattan').toLowerCase();
  const customArea = sp.get('custom_area') || null;       // free-text when borough=other
  const interests  = (sp.get('interests') || 'outdoor').split(',').map((s) => s.trim().toLowerCase());
  const pain       = sp.get('pain') || 'hard_to_choose';

  // Combined age range = union of all children's ranges (widest span).
  // Scoring boosts events that fit at least one child.
  const ageRange = {
    min: Math.min(...children.map((c) => c.ageRange.min)),
    max: Math.max(...children.map((c) => c.ageRange.max)),
  };

  // Build SQL
  const db = new Database(DB_PATH, { readonly: true });

  // Status filter must match lib/db.ts getEvents() — events flow through a
  // multi-stage pipeline (synth.done, verify.desc, verify.done, discovery.done,
  // published). Including `verify.desc` unlocks ~7x more events than just
  // `verify.done` (95% of the imported catalog had been hidden otherwise).
  // We also exclude nightlife and obvious adult-only events to keep the
  // family surface clean even when age data is NULL.
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE (status IN ('published', 'done', 'new', 'verify.desc') OR status LIKE '%.done')
      AND (category_l1 IS NULL OR category_l1 NOT IN ('networking', 'nightlife'))
      AND title NOT LIKE '%21+%'
      AND title NOT LIKE '%18+%'
      AND (age_min IS NULL OR age_min <= ?)
      AND (COALESCE(NULLIF(next_end_at, ''), datetime(next_start_at, '+1 day')) >= datetime('now') OR next_start_at IS NULL)
    ORDER BY next_start_at ASC
    LIMIT 300
  `).all(ageRange.max) as Record<string, unknown>[];

  db.close();

  // Collect matched category slugs from interests
  const matchCategories = new Set<string>();
  for (const interest of interests) {
    const cats = INTEREST_TO_CATEGORIES[interest];
    if (cats) cats.forEach((c) => matchCategories.add(c.toLowerCase()));
  }

  // Borough bounds for geo scoring
  const bounds = BOROUGH_BOUNDS[borough];

  // Score each event
  const scored = rows.map((row) => {
    let score = 0;
    const reasons: string[] = [];

    // --- 1. Age fit ---
    // Heavier weighting (Bug #16): explicit age match dominates; events with
    // no age info get a small baseline so they don't crowd out matched ones.
    const ageMin = row.age_min as number | null;
    const ageBestFrom = row.age_best_from as number | null;
    const ageBestTo = row.age_best_to as number | null;
    if (ageBestFrom != null && ageBestTo != null) {
      // Tight overlap = stronger bonus (extends the "perfect match" lead)
      const overlapStart = Math.max(ageRange.min, ageBestFrom);
      const overlapEnd   = Math.min(ageRange.max, ageBestTo);
      if (overlapEnd >= overlapStart) {
        score += 45;
        reasons.push(`Great for kids ${childAge}`);
      } else {
        score += 0; // age completely off — don't boost
      }
    } else if (ageMin == null) {
      score += 8; // no age restriction — small baseline only
    } else if (ageMin <= ageRange.max) {
      score += 25;
      reasons.push(`Great for kids ${childAge}`);
    }

    // --- 2. Geography ---
    const lat = row.lat as number | null;
    const lon = row.lon as number | null;
    if (bounds && lat != null && lon != null) {
      if (lat >= bounds.latMin && lat <= bounds.latMax && lon >= bounds.lonMin && lon <= bounds.lonMax) {
        score += 25;
        reasons.push(`In ${borough.charAt(0).toUpperCase() + borough.slice(1)}`);
      } else {
        // Check proximity — nearby boroughs get partial score
        const latDist = Math.min(Math.abs(lat - bounds.latMin), Math.abs(lat - bounds.latMax));
        const lonDist = Math.min(Math.abs(lon - bounds.lonMin), Math.abs(lon - bounds.lonMax));
        if (latDist < 0.05 && lonDist < 0.05) {
          score += 10;
          reasons.push('Nearby');
        }
      }
    }

    // --- 3. Interest match ---
    const cat = ((row.category_l1 as string) || '').toLowerCase();
    if (cat && matchCategories.has(cat)) {
      score += 20;
      // Find which interest matched
      for (const interest of interests) {
        const cats = INTEREST_TO_CATEGORIES[interest];
        if (cats && cats.some((c) => c.toLowerCase() === cat)) {
          reasons.push(interest.charAt(0).toUpperCase() + interest.slice(1));
          break;
        }
      }
    }

    // --- 4. Pain optimization ---
    const isFree = row.is_free as number;
    const priceMin = row.price_min as number;
    const ratingAvg = row.rating_avg as number;
    const ratingCount = row.rating_count as number;

    switch (pain) {
      case 'crowded':
        // Boost niche / less popular events
        if (ratingCount < 5) { score += 15; reasons.push('Low crowd'); }
        else if (ratingCount < 20) { score += 8; }
        break;
      case 'too_far':
        // Geography already handled above, extra boost for in-borough
        if (bounds && lat != null && lon != null) {
          if (lat >= bounds.latMin && lat <= bounds.latMax && lon >= bounds.lonMin && lon <= bounds.lonMax) {
            score += 10;
            if (!reasons.includes('Close to you')) reasons.push('Close to you');
          }
        }
        break;
      case 'too_expensive':
        if (isFree) { score += 20; reasons.push('Free'); }
        else if (priceMin > 0 && priceMin <= 20) { score += 10; reasons.push('Budget-friendly'); }
        break;
      case 'boring':
        if (ratingAvg >= 4) { score += 15; reasons.push('Highly rated'); }
        else if (ratingAvg >= 3) { score += 8; }
        break;
      case 'hard_to_choose':
      default:
        if (ratingAvg >= 4 && ratingCount >= 3) { score += 15; reasons.push('Popular pick'); }
        else if (ratingAvg >= 3) { score += 8; }
        break;
    }

    // Boost events with images
    if (row.image_url) score += 5;

    return { event: row, score, reasons };
  });

  // Sort by score desc
  scored.sort((a, b) => b.score - a.score);

  // Take top 40
  const top = scored.slice(0, 40);

  // Parse JSON fields. We previously only deserialised reviews + derisk,
  // leaving categories/tags as raw JSON-encoded strings. The frontend's
  // event-filter then crashed with "(e.categories || []).map is not a
  // function" because `'[]'` is truthy and bypasses the `|| []` fallback.
  // Parse every JSON-stringified field here so the response matches the
  // shape /api/events returns via parseEventRow().
  const events = top.map(({ event: row, score, reasons }) => {
    const parse = <T>(raw: unknown, fallback: T): T => {
      if (typeof raw !== 'string') return (raw as T) ?? fallback;
      try { return JSON.parse(raw) as T; } catch { return fallback; }
    };

    return {
      ...row,
      reviews: parse(row.reviews, []),
      derisk: parse(row.derisk, {}),
      categories: parse(row.categories, [] as string[]),
      tags: parse(row.tags, [] as string[]),
      data: parse(row.data, {}),
      is_free: Boolean(row.is_free),
      _score: score,
      _reasons: reasons,
    };
  });

  return Response.json({
    events,
    total: events.length,
    profile: {
      child_age: childAge,          // back-compat (first child shorthand)
      children,                     // [{ gender, ageRange: {min,max} }]
      borough,
      custom_area: customArea,
      interests,
      pain,
    },
  });
}
