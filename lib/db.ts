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

function parseEventRow(row: Record<string, unknown>): Event {
  return {
    ...row,
    is_free: Boolean(row.is_free),
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
    '(status IN (\'published\', \'done\', \'new\') OR status LIKE \'%.done\')',
    // Exclude rewards/loyalty/club programs — not real events
    'title NOT LIKE \'%Rewards%\'',
    'title NOT LIKE \'%Royalty%\'',
    'title NOT LIKE \'%Loyalty%\'',
    'title NOT LIKE \'%Club Baja%\'',
    'title NOT LIKE \'%Join Club%\'',
    '(category_l1 IS NULL OR category_l1 NOT IN (\'networking\'))',
    // Hide past events: keep if it hasn't ended yet (or, if no end time, hasn't started > 1 day ago)
    "(COALESCE(NULLIF(next_end_at, ''), datetime(next_start_at, '+1 day')) >= datetime('now') OR next_start_at IS NULL)",
  ];
  const params: Record<string, unknown> = {};

  // Map canonical filter slugs to all known DB variants (category_l1, categories JSON, tags)
  const CAT_ALIASES: Record<string, string[]> = {
    'arts': ['arts', 'Art', 'art', 'Arts & Crafts', 'Painting', 'creativity'],
    'family': ['family', "Children's Activities", 'Family Activities', 'Family Events', 'Kids Activities'],
    'nature': ['outdoors', 'nature', 'park', 'garden', 'hiking', 'wildlife'],
    'science': ['science', 'STEAM', 'STEM', 'Science'],
    'food': ['food', 'cooking', 'culinary', 'dining', 'Dining', 'Food'],
    'outdoors': ['outdoors', 'outdoor', 'nature', 'park', 'garden', 'hiking'],
    'education': ['education', 'learning', 'educational', 'workshop'],
    'music': ['music', 'concert', 'musical', 'Music'],
    'film': ['film', 'movie', 'cinema', 'Film'],
    'community': ['community', 'volunteer', 'Community'],
    'gaming': ['gaming', 'games', 'Gaming'],
    'networking': ['networking', 'Networking'],
    'sports': ['sports', 'Sports', 'fitness', 'athletic', 'Basketball', 'Soccer'],
    'theater': ['theater', 'Theatre', 'Theater', 'Performing Arts', 'Broadway'],
    'attractions': ['attractions', 'Attractions', 'museum', 'exhibit'],
    'books': ['books', 'Literary', 'reading', 'Reading', 'library'],
    'holiday': ['holiday', 'Holiday', 'seasonal', 'Seasonal'],
  };

  if (filters.categories && filters.categories.length > 0) {
    const catConditions = filters.categories.map((cat, i) => {
      const aliases = CAT_ALIASES[cat] || [cat];
      const matchConds = aliases.map((alias, j) => {
        params[`cat_${i}_${j}`] = `%${alias}%`;
        params[`cat_exact_${i}_${j}`] = alias;
        // Search across category_l1, categories JSON, AND tags
        return `(category_l1 = @cat_exact_${i}_${j} OR categories LIKE @cat_${i}_${j} OR tags LIKE @cat_${i}_${j})`;
      });
      return `(${matchConds.join(' OR ')})`;
    });
    conditions.push(`(${catConditions.join(' OR ')})`);
  }

  if (filters.excludeCategories && filters.excludeCategories.length > 0) {
    filters.excludeCategories.forEach((cat, i) => {
      const aliases = CAT_ALIASES[cat] || [cat];
      aliases.forEach((alias, j) => {
        params[`excat_${i}_${j}`] = `%${alias}%`;
        params[`excat_exact_${i}_${j}`] = alias;
        conditions.push(`(category_l1 != @excat_exact_${i}_${j} AND categories NOT LIKE @excat_${i}_${j} AND tags NOT LIKE @excat_${i}_${j})`);
      });
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
    params.is_free = filters.isFree ? 1 : 0;
    conditions.push('is_free = @is_free');
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
  //   3. No wide-toddler-range: reject events where the range starts 3+
  //      years below the child (i.e. starts in toddler territory for this
  //      child), the range is wide (≥7 years), and it's a kids' event
  //      (upper bound ≤18, not an "all ages" 0-100 community event).
  //      Only applies to school-age kids (N ≥ 6).
  //      e.g. child 6 vs event 2-10 → excluded; child 6 vs 4-10 → kept.
  //      e.g. child 9 vs event 3-12 → excluded; child 9 vs 6-12 → kept.
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
      // (3) wide range starting in toddler territory for this child
      ' AND NOT (' +
        `@${paramKey} >= 6` +
        ' AND age_best_to IS NOT NULL AND age_best_from IS NOT NULL' +
        ' AND age_best_to <= 18' +
        ' AND (age_best_to - age_best_from) >= 7' +
        ` AND age_best_from <= @${paramKey} - 3` +
      ')' +
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
    conditions.push('next_end_at >= @date_from');
  }

  if (filters.dateTo) {
    params.date_to = filters.dateTo;
    conditions.push('next_start_at <= @date_to');
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

  // Neighborhood filter: bounding-box for events with coordinates + text fallback for events without
  if (filters.neighborhoods && filters.neighborhoods.length > 0 && !filters.neighborhoods.includes('Anywhere in NYC')) {
    const nbConds: string[] = [];
    const textConds: string[] = [];
    filters.neighborhoods.forEach((nb, i) => {
      const bounds = NEIGHBORHOOD_BOUNDS[nb];
      if (bounds) {
        params[`nb_latmin_${i}`] = bounds.latMin;
        params[`nb_latmax_${i}`] = bounds.latMax;
        params[`nb_lonmin_${i}`] = bounds.lonMin;
        params[`nb_lonmax_${i}`] = bounds.lonMax;
        nbConds.push(`(lat BETWEEN @nb_latmin_${i} AND @nb_latmax_${i} AND lon BETWEEN @nb_lonmin_${i} AND @nb_lonmax_${i})`);
      }
      // Text fallback: match city, address, or venue_name
      params[`nb_text_${i}`] = `%${nb}%`;
      textConds.push(`(city LIKE @nb_text_${i} OR address LIKE @nb_text_${i} OR venue_name LIKE @nb_text_${i})`);
    });
    // Events WITH coordinates: match by bounding box only
    // Events WITHOUT coordinates: fall back to text matching on city/address/venue
    const geoCond = nbConds.length > 0
      ? `(lat IS NOT NULL AND lon IS NOT NULL AND (${nbConds.join(' OR ')}))`
      : '';
    const txtCond = textConds.length > 0
      ? `(lat IS NULL OR lon IS NULL) AND (${textConds.join(' OR ')})`
      : '';
    const combined = [geoCond, txtCond].filter(Boolean).join(' OR ');
    if (combined) conditions.push(`(${combined})`);
  }

  // Gender-fit filter: exclude events tagged for a different gender.
  // Only applied when ALL children share the same gender (boy or girl).
  if (filters.childGenders && filters.childGenders.length > 0) {
    const unique = [...new Set(filters.childGenders)];
    if (unique.length === 1 && unique[0] !== 'other') {
      // All children are the same gender — exclude events for the opposite gender
      const oppositeGender = unique[0] === 'boy' ? 'girl' : 'boy';
      params.excludeGender = oppositeGender;
      conditions.push("(gender_fit IS NULL OR gender_fit = 'all' OR gender_fit != @excludeGender)");
    }
  }

  let distanceSelect = '';
  let distanceCondition = '';
  // Prioritize NYC events with coordinates over nationwide ones
  let orderBy = 'ORDER BY (CASE WHEN lat IS NOT NULL AND lon IS NOT NULL AND lat BETWEEN 40.4 AND 41.0 AND lon BETWEEN -74.3 AND -73.6 THEN 0 ELSE 1 END), next_start_at ASC';

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

  // Paginate after dedup so total always matches actual results
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
      // Wide-toddler-range exclusion (mirrors SQL rule 3)
      if (
        age >= 6 &&
        hi != null && lo != null &&
        hi <= 18 &&
        (hi - lo) >= 7 &&
        lo <= age - 3
      ) return false;
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
  const rows = db.prepare('SELECT DISTINCT category_l1 FROM events WHERE category_l1 IS NOT NULL AND (status IN (\'published\', \'done\', \'new\') OR status LIKE \'%.done\') ORDER BY category_l1').all() as { category_l1: string }[];

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

  const baseWhere = `(status IN ('published', 'done', 'new') OR status LIKE '%.done') AND title NOT LIKE '%Rewards%' AND title NOT LIKE '%Royalty%' AND title NOT LIKE '%Loyalty%' AND title NOT LIKE '%Club Baja%' AND title NOT LIKE '%Join Club%' AND (category_l1 IS NULL OR category_l1 NOT IN ('networking')) AND (COALESCE(NULLIF(next_end_at, ''), datetime(next_start_at, '+1 day')) >= datetime('now') OR next_start_at IS NULL)`;
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
  const HARD_CAP = 250; // upper bound for prompt tokens (~7.5k tokens)
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
