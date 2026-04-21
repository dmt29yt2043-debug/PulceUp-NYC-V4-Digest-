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

function parseAgeRange(ageStr: string): { min: number; max: number } {
  if (ageStr.includes('+')) {
    const n = parseInt(ageStr.replace('+', ''), 10);
    return { min: n, max: 18 };
  }
  const parts = ageStr.split('-').map((s) => parseInt(s, 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return { min: parts[0], max: parts[1] };
  }
  return { min: 4, max: 10 }; // safe default
}

/**
 * Parse `children` quiz param (format: `boy:3-5,girl:9-12`) → array of
 * {gender, age: {min,max}}. Falls back to back-compat `child_age` + `gender`
 * when `children` is absent or unparseable.
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
  const childAge   = sp.get('child_age') || '6-8';
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
  // multi-stage pipeline (synth.done, verify.done, discovery.done, published).
  // Using just `status = 'published'` misses ~99% of the catalog.
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE (status IN ('published', 'done', 'new') OR status LIKE '%.done')
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
    const ageMin = row.age_min as number | null;
    const ageBestFrom = row.age_best_from as number | null;
    const ageBestTo = row.age_best_to as number | null;
    if (ageBestFrom != null && ageBestTo != null) {
      // Check if child age range overlaps with event's best-for range
      if (ageRange.min <= ageBestTo && ageRange.max >= ageBestFrom) {
        score += 30;
        reasons.push(`Great for kids ${childAge}`);
      } else {
        score += 5;
      }
    } else if (ageMin == null) {
      score += 15; // no age restriction, decent fit
    } else if (ageMin <= ageRange.max) {
      score += 20;
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

  // Parse JSON fields
  const events = top.map(({ event: row, score, reasons }) => {
    let reviews = [];
    let derisk = {};
    try { reviews = JSON.parse((row.reviews as string) || '[]'); } catch {}
    try { derisk = JSON.parse((row.derisk as string) || '{}'); } catch {}

    return {
      ...row,
      reviews,
      derisk,
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
