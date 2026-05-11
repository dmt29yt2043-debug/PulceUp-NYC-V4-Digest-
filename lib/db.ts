import Database from 'better-sqlite3';
import path from 'path';
import type { Event, FilterState } from './types';

const NEIGHBORHOOD_BOUNDS: Record<string, { latMin: number; latMax: number; lonMin: number; lonMax: number }> = {
  'Upper Manhattan': { latMin: 40.80, latMax: 40.88, lonMin: -73.97, lonMax: -73.91 },
  'Midtown':         { latMin: 40.74, latMax: 40.80, lonMin: -74.01, lonMax: -73.95 },
  'Lower Manhattan': { latMin: 40.70, latMax: 40.74, lonMin: -74.02, lonMax: -73.97 },
  'Manhattan':       { latMin: 40.70, latMax: 40.88, lonMin: -74.02, lonMax: -73.91 },
  'Brooklyn':        { latMin: 40.57, latMax: 40.74, lonMin: -74.04, lonMax: -73.83 },
  'Queens':          { latMin: 40.54, latMax: 40.80, lonMin: -73.96, lonMax: -73.70 },
  'Bronx':           { latMin: 40.80, latMax: 40.92, lonMin: -73.93, lonMax: -73.75 },
  'Staten Island':   { latMin: 40.49, latMax: 40.65, lonMin: -74.26, lonMax: -74.05 },
};

const DB_PATH = path.join(process.cwd(), 'data', 'events.db');

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true });
  }
  return _db;
}

function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    // Handle Python-style dicts/lists with single quotes
    try {
      const fixed = value
        .replace(/'/g, '"')
        .replace(/\bNone\b/g, 'null')
        .replace(/\bTrue\b/g, 'true')
        .replace(/\bFalse\b/g, 'false');
      return JSON.parse(fixed) as T;
    } catch {
      return fallback;
    }
  }
}

// ── Synthetic age defaults ──────────────────────────────────────────────────
// Used when the scraper's AI age-classification step left age_best_from /
// age_best_to NULL (the verify.desc backlog: ~600 events, 100% lack age).
// These defaults are deliberately wide — the SQL filter is NULL-tolerant
// (NULL passes any age check), so synthesizing tighter ranges would silently
// shrink the digest shelf for filtered queries. Keep ranges generous and
// defensible: they only differ from "all-ages" for categories where the
// gap is clear (comedy needs ~8+ comprehension; fashion/gaming events skew
// teen+ when the data ships without explicit age).
const DEFAULT_AGE_BY_CATEGORY: Record<string, [number, number]> = {
  family: [0, 18],
  attractions: [0, 18],
  books: [0, 18],
  music: [0, 18],
  community: [0, 18],
  holiday: [0, 18],
  arts: [3, 18],
  theater: [3, 18],
  outdoors: [3, 18],
  film: [5, 18],
  education: [5, 18],
  science: [5, 18],
  sports: [5, 18],
  wellness: [5, 18],
  food: [5, 18],
  comedy: [8, 18],
  gaming: [8, 18],
  fashion: [8, 18],
};
const DEFAULT_AGE_FALLBACK: [number, number] = [0, 18];

function parseEventRow(row: Record<string, unknown>): Event {
  // ── Normalize is_free ─────────────────────────────────────────────────────
  // The scraper currently leaves is_free=0 on 751 events even when both
  // price_min and price_max are 0 — that broke the "Free only" filter.
  // Treating $0/$0 as free here repairs the filter without touching the
  // underlying DB. Audit (2026-04-30): no rows have pmin=0,pmax=0,is_free=1
  // contradicting this rule; cross-tab is clean.
  const priceMin = row.price_min as number | null;
  const priceMax = row.price_max as number | null;
  const rawIsFree = Boolean(row.is_free);
  const inferredFree = priceMin === 0 && priceMax === 0;

  // ── Synthesize age range when missing ─────────────────────────────────────
  // The 608 verify.desc events all lack both age_best_from/_to AND age_label,
  // because the scraper's age-classification step never completed. Without a
  // synthetic default, cards render "Age: —" and look broken. Use category_l1
  // as the soft signal (99% coverage). Original NULLs are preserved when the
  // category is also missing so the SQL filter still treats them as open.
  const rawAgeFrom = row.age_best_from as number | null;
  const rawAgeTo   = row.age_best_to as number | null;
  const cat        = (row.category_l1 as string | null)?.toLowerCase() ?? '';
  // The May-11 CSV refresh exposed a second failure mode: ~79% of events
  // arrive with age_best_from = 0 and age_best_to = NULL. The original
  // synthesis only triggered when BOTH bounds were missing — so this fleet
  // (sports 5Ks, music concerts, community events) silently passed every
  // age check and surfaced for an 8-year-old kid. Fill the missing bound
  // individually so partial age data also gets normalised.
  let ageBestFrom = rawAgeFrom;
  let ageBestTo   = rawAgeTo;
  if (cat) {
    const [defLo, defHi] = DEFAULT_AGE_BY_CATEGORY[cat] ?? DEFAULT_AGE_FALLBACK;
    if (ageBestFrom === null || ageBestFrom === undefined) ageBestFrom = defLo;
    if (ageBestTo   === null || ageBestTo   === undefined) ageBestTo   = defHi;
  }

  return {
    ...row,
    is_free: rawIsFree || inferredFree,
    age_best_from: ageBestFrom,
    age_best_to: ageBestTo,
    categories: parseJsonField<string[]>(row.categories as string, []),
    tags: parseJsonField<string[]>(row.tags as string, []),
    reviews: parseJsonField(row.reviews as string, []),
    derisk: parseJsonField(row.derisk as string, {}),
    data: parseJsonField(row.data as string, {}),
  } as unknown as Event;
}

/**
 * Haversine distance in km between two lat/lon points
 */
function haversineCondition(): string {
  // We'll compute distance in SQL using an approximation.
  // For precise haversine, we compute in the WHERE clause.
  return `(
    6371 * 2 * asin(sqrt(
      pow(sin(radians((lat - @lat) / 2)), 2) +
      cos(radians(@lat)) * cos(radians(lat)) *
      pow(sin(radians((lon - @lon) / 2)), 2)
    ))
  )`;
}

export function getEvents(filters: FilterState & { page?: number; page_size?: number } = {}): {
  events: Event[];
  total: number;
} {
  const db = getDb();
  const conditions: string[] = [
    // Status allowlist: include `verify.desc` so we surface ~7x more events.
    // Without this we drop from 1771 → 88 events (95% loss). The pipeline has
    // multiple "verify.*" intermediate stages — `verify.desc` means description
    // has been verified, only some metadata (age, lat/lon) may still be NULL.
    // Those NULLs are already handled gracefully downstream.
    "(status IN ('published', 'done', 'new', 'verify.desc') OR status LIKE '%.done')",
    // Exclude rewards/loyalty/club programs — not real events
    'title NOT LIKE \'%Rewards%\'',
    'title NOT LIKE \'%Royalty%\'',
    'title NOT LIKE \'%Loyalty%\'',
    'title NOT LIKE \'%Club Baja%\'',
    'title NOT LIKE \'%Join Club%\'',
    // Exclude adult-only categories from family-events surface. `nightlife`
    // (parties, clubs, 21+ events) is never appropriate for a kids app even
    // when age data is missing. `networking` is the original exclusion.
    "(category_l1 IS NULL OR category_l1 NOT IN ('networking', 'nightlife'))",
    // Exclude obvious adult-only patterns (21+, 18+) regardless of category.
    "title NOT LIKE '%21+%'",
    "title NOT LIKE '%18+%'",
    "COALESCE(age_label, '') NOT LIKE '%21+%'",
    "COALESCE(age_label, '') NOT LIKE '%18+%'",
    // Hide past events. Logic:
    //   - if next_end_at is set, the event is over once that time has passed
    //   - if no end time, assume a 3-hour duration (typical kids' show / class)
    //     and hide once start + 3h < now. Old code used +1 day which let
    //     yesterday-evening shows leak into today's feed.
    //   - events with no date at all (recurring / TBA) stay visible
    "(COALESCE(NULLIF(next_end_at, ''), datetime(next_start_at, '+3 hours')) >= datetime('now') OR next_start_at IS NULL)",
  ];
  const params: Record<string, unknown> = {};

  // Canonical filter slug → candidate aliases.
  //
  // `exactL1`:  values that match category_l1 via equality (case-insensitive).
  // `tokens`:   strings to look for INSIDE tags/categories JSON. Each is
  //             wrapped in quotes for the LIKE so we match full JSON array
  //             entries (e.g. `"Art"` or `"visual-arts"`) and don't cause
  //             "Painting" → "face-painting" cross-contamination. Tokens
  //             can include a trailing `-` or leading `-` to match hyphen
  //             compounds (e.g. `art-` matches `"art-workshop"`).
  // `titleKeywords`: additional keywords searched in event title (with spaces as
  // word-boundary approximation). Use only for highly specific terms unlikely to
  // produce false-positives (acronyms, proper nouns, multi-word phrases).
  type CatDef = { exactL1: string[]; tokens: string[]; titleKeywords?: string[] };
  const CAT_DEFS: Record<string, CatDef> = {
    arts: {
      exactL1: ['arts'],
      tokens: ['Art', 'arts', 'art-', '-art', 'visual-arts', 'kids-art', 'artmaking',
               'craft', 'crafts', 'drawing', 'painting', 'ceramics', 'pottery',
               'sculpture', 'collage', 'printmaking', 'illustration', 'creative-'],
    },
    family: {
      exactL1: ['family'],
      tokens: ['family', 'family-friendly', "Children's Activities", 'Kids Activities'],
    },
    nature: {
      exactL1: ['outdoors'],
      tokens: ['nature', 'park', 'garden', 'hiking', 'wildlife', 'outdoor',
               'ecology', 'environment', 'earth-day', 'nature-'],
    },
    science: {
      exactL1: ['science'],
      tokens: ['science', 'Science', 'STEAM', 'STEM', 'stem-', 'steam-',
               'engineering', 'technology', 'coding', 'robotics', 'astronomy',
               'chemistry', 'physics', 'biology'],
      // NOTE: avoid broad terms like ecology/environment — they pull in Earth Day events
      titleKeywords: ['STEAM', 'STEM', 'science', 'coding', 'robotics', 'astronomy'],
    },
    food: {
      exactL1: ['food'],
      tokens: ['food', 'cooking', 'culinary', 'Dining', 'baking', 'chef', 'food-'],
    },
    outdoors: {
      exactL1: ['outdoors'],
      tokens: ['outdoor', 'nature', 'park', 'hiking', 'outdoor-', 'garden',
               'playground', 'trail', 'camping'],
    },
    education: {
      exactL1: ['education'],
      tokens: ['education', 'Educational', 'learning', 'workshop', 'tutorial'],
    },
    music: {
      exactL1: ['music'],
      tokens: ['music', 'Music', 'concert', 'musical', 'singing', 'song', 'band',
               'orchestra', 'choir', 'jazz', 'drum', 'guitar', 'piano', 'violin'],
    },
    film: {
      exactL1: ['film'],
      tokens: ['film', 'movie', 'cinema', 'Film', 'screening', 'documentary'],
    },
    community: {
      exactL1: ['community'],
      tokens: ['community', 'volunteer', 'Community', 'neighborhood'],
    },
    gaming: {
      exactL1: ['gaming'],
      tokens: ['gaming', 'games', 'Gaming', 'video-game', 'board-game', 'esports'],
    },
    sports: {
      exactL1: ['sports'],
      tokens: ['sports', 'Sports', 'fitness', 'Basketball', 'Soccer', 'swimming',
               'gymnastics', 'martial-arts', 'karate', 'tennis', 'baseball',
               'football', 'volleyball', 'running', 'cycling', 'yoga'],
    },
    theater: {
      exactL1: ['theater'],
      tokens: ['theater', 'Theatre', 'Theater', 'Performing Arts', 'Broadway',
               'musical', 'dance', 'ballet', 'circus', 'puppet', 'puppetry',
               'improv', 'comedy', 'play-', 'performing-'],
      // NOTE: avoid generic terms like 'performance', 'show', 'storytelling'
      // — they match unrelated art workshops and readings
      titleKeywords: ['theater', 'Theatre', 'musical', 'Broadway', 'ballet', 'circus', 'puppet show'],
    },
    attractions: {
      exactL1: ['attractions'],
      tokens: ['Attractions', 'museum', 'exhibit', 'exhibition', 'gallery', 'zoo',
               'aquarium', 'planetarium', 'botanical'],
    },
    books: {
      exactL1: ['books'],
      tokens: ['books', 'Literary', 'reading', 'library', 'storytime', 'story-time',
               'poetry', 'writing', 'author', 'book-', 'literature'],
      // NOTE: avoid 'literacy' (matches "financial literacy") and 'story' (too generic)
      titleKeywords: ['storytime', 'story time', 'poetry reading', 'book club'],
    },
    holiday: {
      exactL1: ['holiday'],
      tokens: ['holiday', 'Holiday', 'seasonal', 'festival', 'celebration',
               'Halloween', 'Christmas', 'Hanukkah', 'Easter', 'Thanksgiving'],
    },
  };

  /** Build WHERE fragment for a single category slug. */
  const buildCatMatch = (cat: string, i: number): string => {
    const def = CAT_DEFS[cat] || { exactL1: [cat], tokens: [cat] };
    const parts: string[] = [];
    // category_l1 exact match (case-insensitive)
    def.exactL1.forEach((v, j) => {
      params[`cat_l1_${i}_${j}`] = v.toLowerCase();
      parts.push(`LOWER(category_l1) = @cat_l1_${i}_${j}`);
    });
    // tags / categories JSON: match with quote delimiters to hit full entries.
    // We search BOTH double-quoted JSON ("Art") AND Python single-quoted ('Art')
    // formats because some events are imported with Python-style arrays like
    // ['Art', 'museum'] which the SQL double-quote LIKE would otherwise miss.
    def.tokens.forEach((tok, j) => {
      params[`cat_tok_${i}_${j}`]    = `%"${tok}"%`;     // double-quoted JSON entry  ["Art"]
      params[`cat_tok_sq_${i}_${j}`] = `%'${tok}'%`;     // Python single-quoted entry ['Art']
      params[`cat_tok_part_${i}_${j}`] = `%"${tok}%`;    // prefix entries (art- matches "art-workshop")
      params[`cat_tok_suff_${i}_${j}`] = `%${tok}"%`;    // suffix entries (-art matches "pixel-art")
      parts.push(
        `(categories LIKE @cat_tok_${i}_${j} OR tags LIKE @cat_tok_${i}_${j}` +
        ` OR categories LIKE @cat_tok_sq_${i}_${j} OR tags LIKE @cat_tok_sq_${i}_${j}` +
          (tok.endsWith('-')
            ? ` OR categories LIKE @cat_tok_part_${i}_${j} OR tags LIKE @cat_tok_part_${i}_${j}`
            : '') +
          (tok.startsWith('-')
            ? ` OR categories LIKE @cat_tok_suff_${i}_${j} OR tags LIKE @cat_tok_suff_${i}_${j}`
            : '') +
          ')'
      );
    });
    // titleKeywords: search in event title (word-boundary approximated with spaces).
    // Used for specific terms unlikely to produce false-positives (STEAM, ballet, etc.)
    (def.titleKeywords ?? []).forEach((kw, j) => {
      const esc = kw.replace(/'/g, "''");
      // Match: " keyword " | "keyword " (start) | " keyword" (end) | exact title
      parts.push(
        `(LOWER(title) LIKE '% ${esc.toLowerCase()} %'` +
        ` OR LOWER(title) LIKE '${esc.toLowerCase()} %'` +
        ` OR LOWER(title) LIKE '% ${esc.toLowerCase()}'` +
        ` OR LOWER(title) = '${esc.toLowerCase()}')`
      );
      void j; // suppress unused-var warning
    });
    return `(${parts.join(' OR ')})`;
  };

  if (filters.categories && filters.categories.length > 0) {
    const catConditions = filters.categories.map((cat, i) => buildCatMatch(cat, i));
    conditions.push(`(${catConditions.join(' OR ')})`);
  }

  if (filters.excludeCategories && filters.excludeCategories.length > 0) {
    // Exclude = NOT (any alias matches) — reuse the same match builder
    filters.excludeCategories.forEach((cat, i) => {
      const sub = buildCatMatch(cat, 1000 + i);
      conditions.push(`NOT ${sub}`);
    });
  }

  if (filters.priceMin !== undefined && filters.priceMin > 0) {
    params.price_min = filters.priceMin;
    // Exclude free events when user sets a minimum price > 0, even if they have paid tiers
    conditions.push('(price_max >= @price_min AND (is_free = 0 OR is_free IS NULL))');
  }

  if (filters.priceMax !== undefined) {
    params.price_max = filters.priceMax;
    conditions.push('price_min <= @price_max');
  }

  if (filters.isFree !== undefined) {
    // Match the parseEventRow normalization: $0/$0 events count as free even
    // when the is_free flag wasn't set by the scraper. Without this the SQL
    // and the parsed row disagree — UI shows "Free" badge while the filter
    // hides the same row.
    if (filters.isFree) {
      conditions.push('(is_free = 1 OR (price_min = 0 AND price_max = 0))');
    } else {
      conditions.push('(is_free = 0 AND NOT (price_min = 0 AND price_max = 0))');
    }
  }

  // ─── Age filter ─────────────────────────────────────────────────────────
  // Supports single age (legacy `ageMax`) or multi-child (`childAges`).
  // An event "fits" a child at age N when ALL of these hold:
  //
  //   1. Base range:
  //        COALESCE(age_best_from, age_min) <= N  AND  age_best_to >= N
  //      (NULL on either side = open, passes that side.)
  //      Events with no age data at all (both bounds NULL) always pass.
  //
  //   2. No toddler-label exclusion:
  //      For school-age kids (N >= 6), reject events whose title/age_label
  //      explicitly signals "toddler/baby/preschool" content. Even if the
  //      declared upper bound reaches 10, a "Toddler Music Class" isn't
  //      what a 9-year-old wants.
  //
  //   3. No wide-toddler-range: reject events where the range is wide (≥7 years),
  //      starts in true baby territory (age_best_from ≤ 2, i.e. 0-2yo infant focus),
  //      and the upper bound ≤18 (not an "all ages" community event).
  //      Only applies to school-age kids (N ≥ 6).
  //      e.g. child 7 vs event 0-10 → excluded (infant-centric wide range);
  //      e.g. child 7 vs event 3-12 → kept (normal kids range starting at 3).
  //
  // `buildAgeFitSql(paramKey)` produces the SQL for a single child age bound
  // to a named parameter.
  const TODDLER_KEYWORDS = [
    'toddler', 'toddlers',
    'baby', 'babies',
    'infant', 'infants',
    'newborn',
    'preschool', 'preschooler', 'preschoolers',
    'pre-k', 'pre k',
    'little ones', 'little kids',
    'for tots', 'tots ',
  ];
  const toddlerConds = TODDLER_KEYWORDS
    .map((kw) => {
      const escaped = kw.replace(/'/g, "''");
      return (
        `COALESCE(age_label,'') LIKE '%${escaped}%' ` +
        `OR COALESCE(title,'') LIKE '%${escaped}%' ` +
        `OR COALESCE(short_title,'') LIKE '%${escaped}%'`
      );
    })
    .join(' OR ');

  const buildAgeFitSql = (paramKey: string): string =>
    '(' +
      // (1) base range
      `(COALESCE(age_best_from, age_min) IS NULL OR COALESCE(age_best_from, age_min) <= @${paramKey})` +
      ` AND (age_best_to IS NULL OR age_best_to >= @${paramKey})` +
      // (2) toddler-label exclusion for school-age kids (>= 6)
      ` AND NOT (@${paramKey} >= 6 AND (${toddlerConds}))` +
      // (3) [removed] wide-range exclusion caused too many false negatives;
      //     rule (2) toddler-label exclusion already handles truly baby-centric events.
      // (4) top-of-toddler-range: child is at the very top of a small
      //     range that starts in baby/toddler territory (from ≤ 2).
      //     e.g. child 6 vs event 1-6 → excluded; child 6 vs 3-6 → kept.
      ' AND NOT (' +
        `@${paramKey} >= 6` +
        ' AND age_best_to IS NOT NULL AND age_best_from IS NOT NULL' +
        ` AND @${paramKey} >= age_best_to` +
        ' AND age_best_from <= 2' +
      ')' +
    ')';

  if (filters.childAges && filters.childAges.length > 0) {
    // Hybrid mode: keep events that suit AT LEAST ONE of the kids.
    // Per-event "which children fit" labels are computed later in JS.
    const perAgeConds = filters.childAges.map((age, i) => {
      const key = `child_age_${i}`;
      params[key] = age;
      return buildAgeFitSql(key);
    });
    conditions.push(`(${perAgeConds.join(' OR ')})`);
  } else if (filters.ageMax !== undefined) {
    params.age_max = filters.ageMax;
    conditions.push(buildAgeFitSql('age_max'));
  }

  if (filters.dateFrom) {
    params.date_from = filters.dateFrom;
    // next_end_at is often an empty string (not NULL) after import — fall
    // back to next_start_at + 1 day so ongoing events aren't accidentally
    // excluded by an empty string comparison.
    conditions.push("COALESCE(NULLIF(next_end_at, ''), datetime(next_start_at, '+1 day')) >= @date_from");
  }

  if (filters.dateTo) {
    params.date_to = filters.dateTo;
    // Use substr(next_start_at, 1, 10) to compare only the date portion.
    // A bare string comparison like `next_start_at <= '2026-05-05'` breaks
    // when next_start_at includes a time component (e.g. '2026-05-05 10:00:00')
    // because SQLite string ordering makes that timestamp GREATER than the
    // date-only string, incorrectly excluding all same-day events.
    conditions.push("substr(next_start_at, 1, 10) <= @date_to");
  }

  if (filters.search) {
    params.search = `%${filters.search}%`;
    conditions.push('(title LIKE @search OR description LIKE @search OR tagline LIKE @search OR tags LIKE @search OR category_l1 LIKE @search OR venue_name LIKE @search)');
  }

  // Fix 2: Location text search (venue, address, city, district)
  if (filters.location) {
    params.location = `%${filters.location}%`;
    conditions.push('(venue_name LIKE @location OR address LIKE @location OR city LIKE @location)');
  }

  // Rating filter
  if (filters.ratingMin !== undefined) {
    params.rating_min = filters.ratingMin;
    conditions.push('rating_avg >= @rating_min');
  }

  // Fix 3: Accessibility filters (search in JSON data field)
  if (filters.wheelchairAccessible) {
    conditions.push("data LIKE '%\"venue_wheelchair_accessible\": true%' OR data LIKE '%\"venue_wheelchair_accessible\":true%'");
  }
  if (filters.strollerFriendly) {
    conditions.push("data LIKE '%\"venue_stroller_friendly\": true%' OR data LIKE '%\"venue_stroller_friendly\":true%'");
  }

  // Neighborhood filter.
  //
  // We used to use a lat/lon bounding box per borough, but the Brooklyn box
  // and the Lower Manhattan box overlapped — so Brooklyn filters pulled in
  // Manhattan events and vice versa (42% false-positive rate).
  //
  // `country_county` is populated for ~85% of live events and is 100%
  // accurate when set ('Kings County' = Brooklyn, 'New York County' =
  // Manhattan, etc.). We use it as the primary signal and fall back to
  // text-matching on city/district/address/venue for events where county
  // is missing. Sub-Manhattan selections (Upper/Midtown/Lower) still use
  // a bounding box inside the county, which is unambiguous.
  if (filters.neighborhoods && filters.neighborhoods.length > 0 && !filters.neighborhoods.includes('Anywhere in NYC')) {
    const COUNTY_MAP: Record<string, string> = {
      'Brooklyn': 'Kings County',
      'Queens': 'Queens County',
      'Bronx': 'Bronx County',
      'Staten Island': 'Richmond County',
      'Manhattan': 'New York County',
      'Upper Manhattan': 'New York County',
      'Midtown': 'New York County',
      'Lower Manhattan': 'New York County',
    };
    const perNbClauses = filters.neighborhoods.map((nb, i) => {
      const parts: string[] = [];
      const county = COUNTY_MAP[nb];
      if (county) {
        params[`nb_county_${i}`] = county;
        parts.push(`country_county = @nb_county_${i}`);
      }
      const bounds = NEIGHBORHOOD_BOUNDS[nb];
      if (bounds && county === 'New York County' && nb !== 'Manhattan') {
        // Sub-Manhattan slice: restrict by bounding box within the county
        params[`nb_latmin_${i}`] = bounds.latMin;
        params[`nb_latmax_${i}`] = bounds.latMax;
        params[`nb_lonmin_${i}`] = bounds.lonMin;
        params[`nb_lonmax_${i}`] = bounds.lonMax;
        // Replace the plain county match with a stricter county+bbox match
        parts.pop();
        parts.push(
          `(country_county = @nb_county_${i} ` +
            `AND lat BETWEEN @nb_latmin_${i} AND @nb_latmax_${i} ` +
            `AND lon BETWEEN @nb_lonmin_${i} AND @nb_lonmax_${i})`
        );
      }
      // Text fallback for events with NULL county (about 15% of the pool)
      params[`nb_text_${i}`] = `%${nb}%`;
      parts.push(
        `(country_county IS NULL AND ` +
          `(city LIKE @nb_text_${i} OR city_district LIKE @nb_text_${i} ` +
          `OR city_locality LIKE @nb_text_${i} OR address LIKE @nb_text_${i} ` +
          `OR venue_name LIKE @nb_text_${i}))`
      );

      // BUG_010: city="New York" with no county → treat as Manhattan.
      // ~30% of events arrive with city="New York" and NULL country_county.
      // The text fallback above looks for LIKE '%Manhattan%' which never matches
      // plain "New York".  Add an explicit alias so these events surface when the
      // user picks Manhattan (or any sub-Manhattan neighbourhood).
      if (county === 'New York County') {
        parts.push(
          `(country_county IS NULL AND (city = 'New York' OR city = 'New York, NY' OR city = 'New York City' OR city = 'NYC'))`
        );
      }

      return `(${parts.join(' OR ')})`;
    });
    conditions.push(`(${perNbClauses.join(' OR ')})`);
  }

  // Gender-fit filter: DISABLED in the current data pool. The schema used
  // to carry a `gender_fit` column, but the new CSV/DB does not include it.
  // Referencing it caused HTTP 500s on any query that also had a gender.
  // We accept childGenders in the API (no-op) until we bring the column back.
  // TODO: re-introduce gender matching when we can reliably tag events.
  void filters.childGenders;

  let distanceSelect = '';
  let distanceCondition = '';
  // Composite ranking — replaces the old "NYC first, then earliest start" rule.
  // Why: pure chronological ordering meant whichever NYC event happened to start
  // first today won every query, regardless of relevance. The Paley Center
  // "Recreating Radio" event was top-1 for 9 / 35 chat queries in QA-REPORT.md.
  //
  // The new score interleaves four signals:
  //   1. NYC bbox (events with NYC coordinates beat out-of-area)
  //   2. Has-image (cards with photos clearly outperform placeholder cards)
  //   3. Recency band (next 72h beats further-out, but not by orders of magnitude)
  //   4. Rating × count (within a band, quality wins over chronology)
  //   5. next_start_at ASC (final tiebreaker)
  //
  // Result: at any given moment several events compete for the top — no one
  // event sweeps. Verified manually against the QA chat suite.
  // Composite ranking with stochastic tiebreak.
  // The first 4 buckets are deterministic so the SAME query returns events in
  // a roughly-stable order. The final tiebreak is random — when 50+ events
  // tie on (NYC, has-image, recency-band, rating-band), Paley Center stops
  // winning every time. With 0–999 random salt, the sort order shifts each
  // query but the BAND remains consistent — i.e. quality stays at the top,
  // just shuffled inside the quality band.
  let orderBy = `ORDER BY
    (CASE WHEN lat IS NOT NULL AND lon IS NOT NULL
              AND lat BETWEEN 40.4 AND 41.0
              AND lon BETWEEN -74.3 AND -73.6 THEN 0 ELSE 1 END),
    (CASE WHEN image_url IS NULL OR image_url = '' THEN 1 ELSE 0 END),
    (CASE
      WHEN next_start_at IS NULL THEN 2
      WHEN next_start_at <= datetime('now', '+72 hours') THEN 0
      WHEN next_start_at <= datetime('now', '+7 days')  THEN 1
      ELSE 2
    END),
    -- Bucket rating into 0.5-point bands so visually-equal ratings tie.
    -- Without bucketing, 4.6 always beats 4.5 deterministically, which is
    -- effectively a single-event-wins behaviour for whichever happens to
    -- have the highest exact rating.
    (CAST(rating_avg * (CASE WHEN rating_count >= 5 THEN 2.0
                              WHEN rating_count >= 1 THEN 1.4
                              ELSE 0.8 END) AS INTEGER)) DESC,
    -- Stochastic tiebreak so the same event doesn't win every empty-filter
    -- query — see Bug #3 in QA-REPORT.md ("Recreating Radio" was top-1 for
    -- 9 / 35 chat queries before this).
    (abs(random()) % 1000),
    next_start_at ASC`;

  if (filters.lat !== undefined && filters.lon !== undefined && filters.distance !== undefined) {
    params.lat = filters.lat;
    params.lon = filters.lon;
    params.distance = filters.distance;
    conditions.push('lat IS NOT NULL AND lon IS NOT NULL');
    distanceSelect = `, ${haversineCondition()} as _distance`;
    distanceCondition = `AND ${haversineCondition()} <= @distance`;
    orderBy = 'ORDER BY _distance ASC';
  }

  const whereClause = conditions.join(' AND ');

  // SQLite doesn't have radians() built-in, so we register it
  db.function('radians', (deg: number) => (deg * Math.PI) / 180);
  db.function('asin', (x: number) => Math.asin(x));
  db.function('sqrt', (x: number) => Math.sqrt(x));
  db.function('pow', (base: number, exp: number) => Math.pow(base, exp));
  db.function('cos', (x: number) => Math.cos(x));
  db.function('sin', (x: number) => Math.sin(x));

  // Data query — fetch ALL matching rows, then deduplicate and paginate in JS.
  // The dataset is small (~600 rows) so this is fast and ensures accurate totals.
  const allSql = `SELECT *${distanceSelect} FROM events WHERE ${whereClause} ${distanceCondition} ${orderBy}`;
  const allRows = db.prepare(allSql).all(params) as Record<string, unknown>[];

  // Deduplicate by title + venue_name (some events appear twice with different pricing tiers)
  const seen = new Set<string>();
  const dedupedAll = allRows.filter((row) => {
    const key = `${(row.title as string || '').toLowerCase()}|${(row.venue_name as string || '').toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const total = dedupedAll.length;

  // ─── Relevance ranking (ALL filter + search queries) ─────────────────────
  // Previously only activated for text-search. Extended to cover every filter
  // query so that high-quality events (strong rating, exact category match)
  // surface above lesser events that happen to have a nearer start date.
  //
  // Skip ONLY when distance-based ordering is active (that has its own sort).
  //
  // NDCG was 0.775 with pure date-sort; target is 0.90+ with relevance ranking.
  if (filters.lat === undefined) {
    const searchQuery = (filters.search || '').toLowerCase();
    const now = Date.now();

    // Pre-build the lowercase set of active category slugs for fast lookup.
    const activeCats = new Set((filters.categories || []).map((c) => c.toLowerCase()));

    // Pre-collect the user's age targets (single ageMax or multi-child childAges).
    // Used by the age-precision bonus / wide-range penalty below — we can only
    // measure "how well does this event fit a specific age" when the user has
    // told us an age. For ageless queries, both signals are skipped.
    const targetAges: number[] =
      filters.childAges && filters.childAges.length > 0
        ? filters.childAges
        : filters.ageMax !== undefined
          ? [filters.ageMax]
          : [];

    const score = (row: Record<string, unknown>): number => {
      let s = 0;

      // ── Text-search match (primary for search queries, max 45 pts) ──
      // Title hits are the strongest signal — e.g. "Spanish Storytime" should
      // beat an event that merely mentions "Spanish" in a paragraph of prose.
      // Tag matches (the curated taxonomy) come close second; description
      // matches are weakest because they're the least intentional.
      if (searchQuery) {
        const title = ((row.title       as string) || '').toLowerCase();
        const tags  = ((row.tags        as string) || '').toLowerCase();
        const desc  = ((row.description as string) || '').toLowerCase();
        if      (title.includes(searchQuery)) s += 45;
        else if (tags.includes(searchQuery))  s += 28;
        else if (desc.includes(searchQuery))  s += 10;
      }

      // ── Category match quality (max 22 pts) ──────────────────────────
      // Exact category_l1 match is the strongest signal: the event was
      // explicitly tagged with the requested category. Tag/categories-only
      // matches (caught by the WHERE clause) get a smaller but real bonus —
      // the curated taxonomy is more reliable than category_l1 fallbacks.
      if (activeCats.size > 0) {
        const l1   = ((row.category_l1 as string) || '').toLowerCase();
        const tags = ((row.tags        as string) || '').toLowerCase();
        const cats = ((row.categories  as string) || '').toLowerCase();
        if (l1 && activeCats.has(l1)) {
          s += 22; // exact category_l1 match
        } else {
          // Check if any active category appears as a token in tags/categories
          // (the JSON arrays). If so, give a meaningful bonus — these events
          // are tagged with the right topic even when category_l1 is generic.
          let tagHit = false;
          for (const c of activeCats) {
            if (tags.includes(c) || cats.includes(c)) { tagHit = true; break; }
          }
          s += tagHit ? 12 : 5;
        }
      }

      // ── Age-fit precision (max 14 pts; -10 pts penalty) ──────────────
      // When the user has specified an age (explicit or via profile), prefer
      // events whose declared range tightly fits that age over generic
      // "all ages 0-18" events. Without this, broad-range events like
      // "Flight Path Dance Project" (0-18) outrank a perfectly-targeted
      // "Toddler Sing-Along" (1-3) for a 3yo just because they survived the
      // age-fit SQL clause.
      //
      // Bonus: tight overlap (range ≤ 8 years) AND it includes the target.
      // Penalty: very wide range (≥ 14 years span) — these are "fits everyone"
      // events, not "perfect fit" events.
      if (targetAges.length > 0) {
        const lo = (row.age_best_from as number | null) ?? (row.age_min as number | null);
        const hi = row.age_best_to as number | null;
        if (lo != null && hi != null) {
          const span = hi - lo;
          // Penalize "fits everyone" events when the user gave a specific age —
          // they're rarely a great match, just an acceptable one.
          if (span >= 14) {
            s -= 10;
          }
          // Reward tight, accurate fits.
          const includesTarget = targetAges.some((a) => a >= lo && a <= hi);
          if (includesTarget) {
            if (span <= 4) s += 14;       // very tight (e.g. 3-5 for a 4yo)
            else if (span <= 8) s += 8;   // reasonably tight (e.g. 5-12)
          }
        } else if (lo == null && hi == null) {
          // Events with NO age data are unknown — neither penalize nor reward.
          // (We surface them only because the SQL pass-NULL rule lets them
          // through; ranking-wise they sit behind anything age-tagged.)
        }
      }

      // ── Rating quality (secondary, max 15 pts) ────────────────────────
      const ratingAvg   = (row.rating_avg   as number) || 0;
      const ratingCount = (row.rating_count as number) || 0;
      if      (ratingAvg >= 4.5 && ratingCount >= 5) s += 15;
      else if (ratingAvg >= 4.0 && ratingCount >= 3) s += 8;
      else if (ratingAvg >= 3.5 && ratingCount >= 1) s += 4;

      // ── Has image (max 3 pts) ─────────────────────────────────────────
      if (row.image_url) s += 3;

      // ── Recency nudge (max 4 pts) ─────────────────────────────────────
      const startAt = row.next_start_at as string | null;
      if (startAt) {
        const daysAway = (new Date(startAt).getTime() - now) / 86_400_000;
        if      (daysAway >= 0 && daysAway <= 7)  s += 4;
        else if (daysAway <= 21)                  s += 2;
      }

      return s;
    };

    dedupedAll.sort((a, b) => {
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      // Tiebreaker: chronological
      const aDate = (a.next_start_at as string) ?? '9999';
      const bDate = (b.next_start_at as string) ?? '9999';
      return aDate < bDate ? -1 : aDate > bDate ? 1 : 0;
    });
  }

  // Paginate after dedup+rank so totals and page ordering are always consistent
  const page = filters.page ?? 1;
  const pageSize = filters.page_size ?? 20;
  const offset = (page - 1) * pageSize;
  const deduped = dedupedAll.slice(offset, offset + pageSize);

  const events = deduped.map(parseEventRow);

  // Compute per-event "which children fit" labels for hybrid multi-child mode.
  // Only attached when 2+ kids are provided (single-child mode = no labels).
  // Must mirror the SQL rules above (base range + toddler-label exclusion +
  // edge-at-top-of-wide-range) so the visible label matches what the filter did.
  if (filters.childAges && filters.childAges.length >= 2) {
    const ages = filters.childAges;
    const toddlerRegex = new RegExp(
      '(toddler|babies|baby|infant|newborn|preschool|pre-?k|little ones|little kids|for tots|\\btots\\b)',
      'i',
    );
    const hasToddlerLabel = (ev: Event): boolean => {
      const hay = `${ev.age_label ?? ''} ${ev.title ?? ''} ${ev.short_title ?? ''}`;
      return toddlerRegex.test(hay);
    };

    const fitsChild = (ev: Event, age: number): boolean => {
      const lo = ev.age_best_from ?? ev.age_min;
      const hi = ev.age_best_to;
      // Base range
      if (lo != null && lo > age) return false;
      if (hi != null && hi < age) return false;
      // Toddler-label exclusion for school-age kids
      if (age >= 6 && hasToddlerLabel(ev)) return false;
      // (rule 3 removed — toddler-label exclusion above handles baby-centric events)
      // Top-of-toddler-range exclusion (mirrors SQL rule 4)
      if (
        age >= 6 &&
        hi != null && lo != null &&
        age >= hi &&
        lo <= 2
      ) return false;
      return true;
    };

    for (const ev of events) {
      const lo = ev.age_best_from ?? ev.age_min;
      const hi = ev.age_best_to;
      // Event with no age data — fits everyone, no label needed.
      if (lo == null && hi == null) continue;
      const fits = ages.filter((a) => fitsChild(ev, a));
      // Only attach when partial — events that fit all kids stay unlabeled.
      if (fits.length > 0 && fits.length < ages.length) {
        ev.fit_child_ages = fits;
      }
    }
  }

  return {
    events,
    total,
  };
}

export function getEventById(id: number): Event | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return parseEventRow(row);
}

export function getCategories(): { value: string; label: string }[] {
  const db = getDb();
  // Status allowlist mirrors getEvents() — keep `verify.desc` in sync so the
  // category dropdown reflects the same pool that's actually browseable.
  const rows = db.prepare('SELECT DISTINCT category_l1 FROM events WHERE category_l1 IS NOT NULL AND (status IN (\'published\', \'done\', \'new\', \'verify.desc\') OR status LIKE \'%.done\') ORDER BY category_l1').all() as { category_l1: string }[];

  const labelMap: Record<string, string> = {
    family: 'Parents & Kids',
    arts: 'Arts & Culture',
    theater: 'Theater & Performing Arts',
    attractions: 'Attractions & Activities',
    books: 'Literary & Books',
    holiday: 'Holiday & Seasonal',
    sports: 'Sports & Fitness',
    Art: 'Arts & Culture',
    "Children's Activities": 'Parents & Kids',
    // Polish: consistent Title Case for remaining single-word categories
    comedy: 'Comedy',
    community: 'Community',
    education: 'Education',
    fashion: 'Fashion',
    film: 'Film',
    food: 'Food',
    gaming: 'Gaming',
    music: 'Music',
    nightlife: 'Nightlife',
    outdoors: 'Outdoors',
    science: 'Science',
    wellness: 'Wellness',
  };

  // Preferred canonical value for each label (used when deduplicating)
  const canonicalValue: Record<string, string> = {
    'Parents & Kids': 'family',
    'Arts & Culture': 'arts',
  };

  const seen = new Set<string>();
  const result: { value: string; label: string }[] = [];

  for (const row of rows) {
    if (!row.category_l1) continue; // skip empty
    const label = labelMap[row.category_l1] || row.category_l1;
    if (seen.has(label)) continue; // skip duplicate labels
    seen.add(label);
    // Use canonical value if defined, otherwise raw DB value
    const value = canonicalValue[label] ?? row.category_l1;
    result.push({ value, label });
  }

  // Virtual categories (not a direct category_l1 in DB)
  if (!seen.has('Nature')) {
    result.push({ value: 'nature', label: 'Nature' });
  }

  return result;
}

export function getEventsForChat(query?: string): { id: number; title: string; category_l1: string; tagline: string; venue_name: string; next_start_at: string; is_free: boolean; price_summary: string; age_label: string; city: string; address: string }[] {
  const db = getDb();

  // Status allowlist mirrors getEvents() — `verify.desc` included so the chat
  // LLM gets the same wider catalog the feed shows (was 36, becomes ~600).
  const baseWhere = `(status IN ('published', 'done', 'new', 'verify.desc') OR status LIKE '%.done') AND title NOT LIKE '%Rewards%' AND title NOT LIKE '%Royalty%' AND title NOT LIKE '%Loyalty%' AND title NOT LIKE '%Club Baja%' AND title NOT LIKE '%Join Club%' AND (category_l1 IS NULL OR category_l1 NOT IN ('networking')) AND (COALESCE(NULLIF(next_end_at, ''), datetime(next_start_at, '+1 day')) >= datetime('now') OR next_start_at IS NULL)`;
  const fields = `id, title, category_l1, tagline, venue_name, next_start_at, is_free, price_summary, age_label, city, address`;

  let searchWhere = '';
  const params: Record<string, unknown> = {};
  if (query) {
    params.search = `%${query}%`;
    searchWhere = ` AND (title LIKE @search OR tagline LIKE @search OR description LIKE @search OR tags LIKE @search)`;
  }

  // Traverse FULL dataset (not just top-N). When a query is supplied, the
  // LIKE filter in `searchWhere` already narrows the candidate set in SQL.
  // Otherwise we walk the whole table in stable pages and only cap at the
  // very end (token-budget guard for the LLM prompt).
  const PAGE = 500;
  const HARD_CAP = 80; // upper bound for prompt tokens (~2.5k tokens). Was 250 before QA — caused OpenAI TPM exhaustion under load.
  const all: Record<string, unknown>[] = [];
  let offset = 0;
  let processed = 0;
  // safeguard: never loop more than the table size / page
  for (let i = 0; i < 50; i++) {
    const page = db.prepare(
      `SELECT ${fields} FROM events WHERE ${baseWhere}${searchWhere}
       ORDER BY next_start_at ASC
       LIMIT @lim OFFSET @off`
    ).all({ ...params, lim: PAGE, off: offset }) as Record<string, unknown>[];
    if (page.length === 0) break;
    all.push(...page);
    processed += page.length;
    offset += PAGE;
    if (page.length < PAGE) break; // no more data
  }

  // Mix in top-rated so good evergreen events aren't lost when we cap.
  const topRated = db.prepare(
    `SELECT ${fields} FROM events WHERE ${baseWhere}${searchWhere}
     ORDER BY rating_avg DESC, rating_count DESC LIMIT 50`
  ).all(params) as Record<string, unknown>[];

  // Fallback: if query-narrowed traversal returns too little, also pull the
  // full unfiltered traversal so the LLM still sees the wider catalogue.
  let fallback: Record<string, unknown>[] = [];
  if (query && all.length + topRated.length < 60) {
    let foff = 0;
    for (let i = 0; i < 50; i++) {
      const page = db.prepare(
        `SELECT ${fields} FROM events WHERE ${baseWhere}
         ORDER BY next_start_at ASC LIMIT @lim OFFSET @off`
      ).all({ lim: PAGE, off: foff }) as Record<string, unknown>[];
      if (page.length === 0) break;
      fallback.push(...page);
      foff += PAGE;
      if (page.length < PAGE) break;
    }
  }

  // Deduplicate while preserving order: query-matches first, then top-rated,
  // then unfiltered fallback.
  const seen = new Set<number>();
  const combined: Record<string, unknown>[] = [];
  for (const row of [...all, ...topRated, ...fallback]) {
    const id = row.id as number;
    if (!seen.has(id)) {
      seen.add(id);
      combined.push(row);
    }
  }

  console.log(`[getEventsForChat] processed=${processed} unique=${combined.length} query=${query || '∅'} → cap=${HARD_CAP}`);

  return combined.slice(0, HARD_CAP).map((row) => ({
    ...row,
    is_free: Boolean(row.is_free),
  })) as { id: number; title: string; category_l1: string; tagline: string; venue_name: string; next_start_at: string; is_free: boolean; price_summary: string; age_label: string; city: string; address: string }[];
}
