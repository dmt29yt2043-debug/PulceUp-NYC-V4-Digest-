/**
 * Detailed DB audit — multiple breakdowns with from/to/count/bucket-style tables.
 *
 * Sections:
 *   A. Age range buckets (like the reference screenshot)
 *   B. Price range buckets
 *   C. Time-of-day buckets
 *   D. Day-of-week distribution
 *   E. Format × motivation cross-tabs
 *   F. Description length buckets
 *   G. Image URL host buckets
 *   H. Schedule kind (once / recurring / multi)
 *   I. Source domain buckets (top + tail)
 *   J. Borough × category cross-tab
 *   K. Per-source field-completeness (which scrapers produce dirty data)
 *
 * Run: npx tsx scripts/db-detailed-audit.ts
 */

import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.join(process.cwd(), 'data', 'events.db'), { readonly: true });

// We use TWO populations everywhere to keep the picture honest:
//   · "visible" = what the API actually returns (status filter + future date)
//   · "all-future" = visible + verify.desc with future date (the 8x potential pool)
const STATUS_VISIBLE = `(status IN ('published','done','new') OR status LIKE '%.done')`;
const STATUS_ALL_FUTURE = `(status IN ('published','done','new','verify.desc','verify.intake','verify.latlon','verify.dupe') OR status LIKE '%.done')`;
const FUTURE_DATE = `next_start_at IS NOT NULL AND next_start_at != '' AND COALESCE(NULLIF(next_end_at,''), datetime(next_start_at, '+3 hours')) >= datetime('now')`;

const VISIBLE = `${STATUS_VISIBLE} AND disabled = 0 AND archived = 0 AND ${FUTURE_DATE}`;
const POTENTIAL = `${STATUS_ALL_FUTURE} AND disabled = 0 AND archived = 0 AND ${FUTURE_DATE}`;

const visibleN  = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${VISIBLE}`).get()  as {n:number}).n;
const potentialN = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${POTENTIAL}`).get() as {n:number}).n;

console.log(`Populations:`);
console.log(`  visible   = ${visibleN}  (currently shown to user)`);
console.log(`  potential = ${potentialN}  (visible + verify.desc with future date — the 8x pool)`);
console.log();

// Helper: print a uniform table.
type Row = { from: string | number; to: string | number; count: number; bucket: string };
function printTable(title: string, rows: Row[], opts: { hideZeros?: boolean } = {}) {
  console.log(`━━━ ${title} ━━━`);
  if (rows.length === 0) { console.log('  (no rows)\n'); return; }
  const filtered = opts.hideZeros ? rows.filter(r => r.count > 0) : rows;
  const fromW = Math.max(4, ...filtered.map(r => String(r.from).length));
  const toW   = Math.max(2, ...filtered.map(r => String(r.to).length));
  const cntW  = Math.max(5, ...filtered.map(r => String(r.count).length));
  const total = filtered.reduce((s, r) => s + r.count, 0);
  console.log(`  ${'from'.padEnd(fromW)}  ${'to'.padEnd(toW)}  ${'count'.padStart(cntW)}  bucket`);
  console.log(`  ${'─'.repeat(fromW)}  ${'─'.repeat(toW)}  ${'─'.repeat(cntW)}  ${'─'.repeat(40)}`);
  for (const r of filtered) {
    const pct = total ? `  (${(r.count*100/total).toFixed(1)}%)` : '';
    console.log(`  ${String(r.from).padEnd(fromW)}  ${String(r.to).padEnd(toW)}  ${String(r.count).padStart(cntW)}  ${r.bucket}${pct}`);
  }
  console.log(`  ${'─'.repeat(fromW)}  ${'─'.repeat(toW)}  ${'─'.repeat(cntW)}`);
  console.log(`  ${'TOTAL'.padEnd(fromW + toW + 4)}${String(total).padStart(cntW)}\n`);
}

// ── A. Age range buckets (like the screenshot) ──────────────────────────────
type AgeRow = { from: number; to: number; n: number };

function ageBucket(from: number, to: number): string {
  // Mirror the reference's "demographic" labels, adjusted for NYC family-events.
  if (from <= 1 && to <= 3)             return 'baby / infant';
  if (from <= 2 && to <= 5)             return 'toddler';
  if (from >= 2 && to <= 6)             return 'preschool';
  if (from >= 3 && to <= 8)             return 'early kids';
  if (from >= 5 && to <= 12)            return 'school-age kids';
  if (from >= 6 && to <= 12)            return 'school-age kids';
  if (from >= 8 && to <= 14)            return 'tween';
  if (from >= 10 && to <= 13)           return 'tween';
  if (from >= 12 && to <= 17)           return 'teen';
  if (from >= 13 && to <= 18)           return 'teen → 18';
  if (from >= 0 && to >= 12 && to < 18) return 'family / kids';
  if (from <= 5 && to >= 18)            return 'all-ages family';
  if (from >= 16 && to >= 35)           return 'young adult / adult';
  if (from >= 18)                       return 'adult';
  return 'mixed / wide';
}

function ageRowsFor(where: string): AgeRow[] {
  return db.prepare(`
    SELECT age_best_from AS "from", age_best_to AS "to", COUNT(*) AS n
    FROM events WHERE ${where}
      AND age_best_from IS NOT NULL AND age_best_to IS NOT NULL
    GROUP BY age_best_from, age_best_to
    ORDER BY n DESC
    LIMIT 25
  `).all() as AgeRow[];
}

const ageVisible = ageRowsFor(VISIBLE);
const agePotential = ageRowsFor(POTENTIAL);

printTable(
  `A1. AGE RANGES — visible (${visibleN} events) — top 25 (from, to) pairs`,
  ageVisible.map(r => ({ from: r.from, to: r.to, count: r.n, bucket: ageBucket(r.from, r.to) })),
);
printTable(
  `A2. AGE RANGES — potential pool (${potentialN} events) — top 25 (from, to) pairs`,
  agePotential.map(r => ({ from: r.from, to: r.to, count: r.n, bucket: ageBucket(r.from, r.to) })),
);

// Aggregated by bucket label
function aggBuckets(rows: AgeRow[]): Row[] {
  const map = new Map<string, { count: number; minFrom: number; maxTo: number }>();
  for (const r of rows) {
    const b = ageBucket(r.from, r.to);
    const cur = map.get(b);
    if (!cur) map.set(b, { count: r.n, minFrom: r.from, maxTo: r.to });
    else      { cur.count += r.n; cur.minFrom = Math.min(cur.minFrom, r.from); cur.maxTo = Math.max(cur.maxTo, r.to); }
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .map(([bucket, v]) => ({ from: v.minFrom, to: v.maxTo, count: v.count, bucket }));
}

const allAgeRows = db.prepare(`
  SELECT age_best_from AS "from", age_best_to AS "to", COUNT(*) AS n FROM events WHERE ${POTENTIAL}
    AND age_best_from IS NOT NULL AND age_best_to IS NOT NULL
  GROUP BY age_best_from, age_best_to
`).all() as AgeRow[];
printTable('A3. AGE BUCKETS rolled up — potential pool', aggBuckets(allAgeRows));

// Also bucket events with NO age info
const noAgeVisible = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${VISIBLE} AND (age_best_from IS NULL OR age_best_to IS NULL)`).get() as {n:number}).n;
const noAgePotential = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${POTENTIAL} AND (age_best_from IS NULL OR age_best_to IS NULL)`).get() as {n:number}).n;
console.log(`Events without explicit age range:`);
console.log(`  visible:   ${noAgeVisible}/${visibleN}  (${(noAgeVisible*100/visibleN).toFixed(1)}%)`);
console.log(`  potential: ${noAgePotential}/${potentialN}  (${(noAgePotential*100/potentialN).toFixed(1)}%)`);
console.log();

// ── B. Price buckets ────────────────────────────────────────────────────────
function priceBucket(min: number | null, max: number | null, isFree: number): string {
  if (isFree === 1) return 'free';
  if (max === 0) return 'free (price=0)';
  if (max === null && min === null) return 'unknown';
  const m = max ?? min ?? 0;
  if (m <= 10) return 'cheap (≤$10)';
  if (m <= 25) return 'budget ($11–25)';
  if (m <= 50) return 'mid ($26–50)';
  if (m <= 100) return 'pricey ($51–100)';
  if (m <= 200) return 'expensive ($101–200)';
  return 'premium (>$200)';
}

const priceRows = db.prepare(`
  SELECT price_min AS pmin, price_max AS pmax, is_free AS fr, COUNT(*) AS n
  FROM events WHERE ${POTENTIAL}
  GROUP BY price_min, price_max, is_free
`).all() as Array<{pmin:number|null, pmax:number|null, fr:number, n:number}>;

const priceMap = new Map<string, { count: number; minP: number; maxP: number }>();
for (const r of priceRows) {
  const b = priceBucket(r.pmin, r.pmax, r.fr);
  const cur = priceMap.get(b);
  const lo = r.pmin ?? 0, hi = r.pmax ?? 0;
  if (!cur) priceMap.set(b, { count: r.n, minP: lo, maxP: hi });
  else      { cur.count += r.n; cur.minP = Math.min(cur.minP, lo); cur.maxP = Math.max(cur.maxP, hi); }
}
const orderedPrice = ['free', 'free (price=0)', 'cheap (≤$10)', 'budget ($11–25)', 'mid ($26–50)', 'pricey ($51–100)', 'expensive ($101–200)', 'premium (>$200)', 'unknown'];
printTable('B. PRICE BUCKETS — potential pool',
  orderedPrice.filter(b => priceMap.has(b)).map(b => {
    const v = priceMap.get(b)!;
    return { from: `$${v.minP}`, to: `$${v.maxP}`, count: v.count, bucket: b };
  }),
);

// ── C. Time-of-day buckets ──────────────────────────────────────────────────
const timeRows = db.prepare(`
  SELECT
    CAST(strftime('%H', next_start_at) AS INTEGER) AS hr,
    COUNT(*) AS n
  FROM events WHERE ${POTENTIAL} GROUP BY hr ORDER BY hr
`).all() as Array<{hr:number, n:number}>;

function todBucket(h: number): string {
  if (h < 6)   return 'night (00–05)';
  if (h < 9)   return 'early morning (06–08)';
  if (h < 12)  return 'morning (09–11)';
  if (h < 14)  return 'midday (12–13)';
  if (h < 17)  return 'afternoon (14–16)';
  if (h < 20)  return 'evening (17–19)';
  return        'late evening (20–23)';
}
const todMap = new Map<string, { count: number; lo: number; hi: number }>();
for (const r of timeRows) {
  const b = todBucket(r.hr);
  const cur = todMap.get(b);
  if (!cur) todMap.set(b, { count: r.n, lo: r.hr, hi: r.hr });
  else      { cur.count += r.n; cur.lo = Math.min(cur.lo, r.hr); cur.hi = Math.max(cur.hi, r.hr); }
}
const orderedTod = ['night (00–05)','early morning (06–08)','morning (09–11)','midday (12–13)','afternoon (14–16)','evening (17–19)','late evening (20–23)'];
printTable('C. TIME-OF-DAY START — potential pool',
  orderedTod.filter(b => todMap.has(b)).map(b => {
    const v = todMap.get(b)!;
    return { from: `${String(v.lo).padStart(2,'0')}h`, to: `${String(v.hi).padStart(2,'0')}h`, count: v.count, bucket: b };
  }),
);

// ── D. Day-of-week ──────────────────────────────────────────────────────────
const dowMap = new Map<number, number>();
const dowRows = db.prepare(`SELECT next_start_at AS s FROM events WHERE ${POTENTIAL}`).all() as Array<{s:string}>;
for (const r of dowRows) {
  const d = new Date(r.s);
  if (isNaN(d.getTime())) continue;
  const dow = d.getDay();
  dowMap.set(dow, (dowMap.get(dow) ?? 0) + 1);
}
const dowNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
printTable('D. DAY OF WEEK — potential pool',
  [0,1,2,3,4,5,6].map(d => ({
    from: dowNames[d].slice(0,3),
    to: dowNames[d].slice(0,3),
    count: dowMap.get(d) ?? 0,
    bucket: dowNames[d] + (d===0||d===6 ? ' (weekend)' : ' (weekday)'),
  })),
);

// ── E. Format × motivation ──────────────────────────────────────────────────
const fmtRows = db.prepare(`
  SELECT TRIM(LOWER(value)) AS f, COUNT(*) AS n
  FROM events, json_each('[' || REPLACE(REPLACE(REPLACE(format,'[',''),']',''),'"','"') || ']')
  WHERE ${POTENTIAL} AND format IS NOT NULL AND format != '' AND format != '[]'
  GROUP BY f ORDER BY n DESC LIMIT 25
`).all() as Array<{f:string, n:number}>;

// json_each may not work if format is not strict JSON — fall back to GROUP BY raw value.
const fmtRowsFallback = db.prepare(`
  SELECT format AS f, COUNT(*) AS n FROM events WHERE ${POTENTIAL}
    AND format IS NOT NULL AND format != ''
  GROUP BY format ORDER BY n DESC LIMIT 15
`).all() as Array<{f:string, n:number}>;

printTable('E1. FORMAT (raw values, top 15) — potential pool',
  fmtRowsFallback.map(r => ({
    from: '', to: '', count: r.n, bucket: r.f.length > 60 ? r.f.slice(0,57)+'…' : r.f,
  })),
);

const motivRows = db.prepare(`
  SELECT motivation AS m, COUNT(*) AS n FROM events WHERE ${POTENTIAL}
    AND motivation IS NOT NULL AND motivation != ''
  GROUP BY motivation ORDER BY n DESC LIMIT 15
`).all() as Array<{m:string, n:number}>;
printTable('E2. MOTIVATION (raw values, top 15) — potential pool',
  motivRows.map(r => ({ from: '', to: '', count: r.n, bucket: r.m.length > 60 ? r.m.slice(0,57)+'…' : r.m })),
);

// ── F. Description length buckets ───────────────────────────────────────────
const descRows = db.prepare(`SELECT length(description) AS L FROM events WHERE ${POTENTIAL} AND description IS NOT NULL`).all() as Array<{L:number}>;
function descBucket(L: number): string {
  if (L === 0) return 'empty';
  if (L < 50) return 'tiny (<50 ch)';
  if (L < 100) return 'short (50–99 ch)';
  if (L < 200) return 'okay (100–199 ch)';
  if (L < 400) return 'good (200–399 ch)';
  if (L < 800) return 'rich (400–799 ch)';
  return 'long (≥800 ch)';
}
const descMap = new Map<string, {count: number, lo: number, hi: number}>();
for (const r of descRows) {
  const b = descBucket(r.L);
  const cur = descMap.get(b);
  if (!cur) descMap.set(b, { count: 1, lo: r.L, hi: r.L });
  else { cur.count++; cur.lo = Math.min(cur.lo, r.L); cur.hi = Math.max(cur.hi, r.L); }
}
const orderedDesc = ['empty','tiny (<50 ch)','short (50–99 ch)','okay (100–199 ch)','good (200–399 ch)','rich (400–799 ch)','long (≥800 ch)'];
printTable('F. DESCRIPTION LENGTH — potential pool',
  orderedDesc.filter(b => descMap.has(b)).map(b => {
    const v = descMap.get(b)!;
    return { from: v.lo, to: v.hi, count: v.count, bucket: b };
  }),
);

// ── G. Image URL host buckets ───────────────────────────────────────────────
const imgRows = db.prepare(`SELECT image_url AS u FROM events WHERE ${POTENTIAL} AND image_url IS NOT NULL AND image_url != ''`).all() as Array<{u:string}>;
const imgMap = new Map<string, number>();
for (const r of imgRows) {
  try {
    const h = new URL(r.u).hostname.replace(/^www\./,'');
    imgMap.set(h, (imgMap.get(h) ?? 0) + 1);
  } catch { imgMap.set('(invalid url)', (imgMap.get('(invalid url)') ?? 0) + 1); }
}
printTable('G. IMAGE URL HOST (top 15) — potential pool',
  Array.from(imgMap.entries()).sort((a,b)=>b[1]-a[1]).slice(0,15)
    .map(([h, n]) => ({ from: '', to: '', count: n, bucket: h })),
);

// ── H. Schedule kind ────────────────────────────────────────────────────────
const schedRows = db.prepare(`SELECT schedule AS s FROM events WHERE ${POTENTIAL} AND schedule IS NOT NULL AND schedule != ''`).all() as Array<{s:string}>;
const kindMap = new Map<string, number>();
for (const r of schedRows) {
  let kind = 'other';
  try {
    const j = JSON.parse(r.s);
    kind = j.kind || j.type || 'other';
  } catch { kind = 'invalid-json'; }
  kindMap.set(kind, (kindMap.get(kind) ?? 0) + 1);
}
printTable('H. SCHEDULE.kind — potential pool',
  Array.from(kindMap.entries()).sort((a,b)=>b[1]-a[1])
    .map(([k, n]) => ({ from: '', to: '', count: n, bucket: k })),
);

// ── I. Source domain buckets ────────────────────────────────────────────────
const srcRows = db.prepare(`SELECT source_url AS u FROM events WHERE ${POTENTIAL} AND source_url IS NOT NULL AND source_url != ''`).all() as Array<{u:string}>;
const srcMap = new Map<string, number>();
for (const r of srcRows) {
  try {
    const h = new URL(r.u).hostname.replace(/^www\./,'');
    srcMap.set(h, (srcMap.get(h) ?? 0) + 1);
  } catch { /* skip */ }
}
const sortedSrc = Array.from(srcMap.entries()).sort((a,b)=>b[1]-a[1]);
printTable('I1. TOP 15 SOURCE DOMAINS — potential pool',
  sortedSrc.slice(0,15).map(([h, n]) => ({ from: '', to: '', count: n, bucket: h })),
);

// Domain concentration buckets
const concBuckets = [
  { lbl: 'mega (≥50)', min: 50, max: Infinity, n: 0, doms: 0 },
  { lbl: 'large (10–49)', min: 10, max: 49, n: 0, doms: 0 },
  { lbl: 'medium (5–9)', min: 5, max: 9, n: 0, doms: 0 },
  { lbl: 'small (2–4)', min: 2, max: 4, n: 0, doms: 0 },
  { lbl: 'singleton (1)', min: 1, max: 1, n: 0, doms: 0 },
];
for (const [, n] of sortedSrc) {
  for (const b of concBuckets) {
    if (n >= b.min && n <= b.max) { b.n += n; b.doms += 1; break; }
  }
}
printTable('I2. SOURCE CONCENTRATION — potential pool',
  concBuckets.filter(b => b.doms > 0).map(b => ({
    from: b.min, to: b.max === Infinity ? '∞' : b.max, count: b.n,
    bucket: `${b.lbl} — ${b.doms} domain${b.doms>1?'s':''}`,
  })),
);

// ── J. Borough × category cross-tab ─────────────────────────────────────────
const xRows = db.prepare(`
  SELECT
    LOWER(COALESCE(country_county,'(unknown)')) AS borough,
    LOWER(COALESCE(category_l1,'(uncat)')) AS cat,
    COUNT(*) AS n
  FROM events WHERE ${POTENTIAL}
  GROUP BY borough, cat ORDER BY borough, n DESC
`).all() as Array<{borough:string, cat:string, n:number}>;
const boroughs = new Map<string, Map<string, number>>();
for (const r of xRows) {
  if (!boroughs.has(r.borough)) boroughs.set(r.borough, new Map());
  boroughs.get(r.borough)!.set(r.cat, r.n);
}
console.log('━━━ J. BOROUGH × CATEGORY (potential pool) ━━━');
const allCats = Array.from(new Set(xRows.map(r => r.cat))).sort();
const allBoroughs = Array.from(boroughs.keys()).sort();
const w = 16;
const colW = 9;
process.stdout.write('  ' + 'borough'.padEnd(w));
for (const c of allCats.slice(0,8)) process.stdout.write(c.slice(0,8).padStart(colW));
process.stdout.write('   tot\n');
process.stdout.write('  ' + '─'.repeat(w) + '─'.repeat(colW * Math.min(allCats.length, 8)) + '\n');
for (const b of allBoroughs) {
  const row = boroughs.get(b)!;
  let total = 0;
  process.stdout.write('  ' + b.padEnd(w));
  for (const c of allCats.slice(0,8)) {
    const n = row.get(c) ?? 0;
    total += n;
    process.stdout.write((n === 0 ? '·' : String(n)).padStart(colW));
  }
  for (const c of allCats.slice(8)) total += row.get(c) ?? 0;
  process.stdout.write('   ' + String(total).padStart(3) + '\n');
}
console.log();

// ── K. Per-source field completeness ────────────────────────────────────────
console.log('━━━ K. PER-SOURCE FIELD COMPLETENESS — potential pool ━━━');
console.log(`  ${'domain'.padEnd(28)}${'#'.padStart(4)}  ${'age'.padStart(5)}  ${'price'.padStart(5)}  ${'desc≥100'.padStart(8)}  ${'img'.padStart(5)}  ${'lat/lon'.padStart(7)}  ${'rating'.padStart(6)}`);
console.log(`  ${'─'.repeat(28)}${'─'.repeat(6)}  ${'─'.repeat(5)}  ${'─'.repeat(5)}  ${'─'.repeat(8)}  ${'─'.repeat(5)}  ${'─'.repeat(7)}  ${'─'.repeat(6)}`);

const allSrcRows = db.prepare(`
  SELECT source_url AS u, age_best_from AS af, age_best_to AS at, is_free AS fr, price_max AS pmax,
         length(description) AS dl, image_url AS img, lat, lon, rating_count AS rc
  FROM events WHERE ${POTENTIAL}
`).all() as Array<{u:string|null, af:number|null, at:number|null, fr:number|null, pmax:number|null, dl:number|null, img:string|null, lat:number|null, lon:number|null, rc:number|null}>;

const perDomain = new Map<string, {n:number, age:number, price:number, desc:number, img:number, geo:number, rating:number}>();
for (const r of allSrcRows) {
  let h = '(no source_url)';
  if (r.u) { try { h = new URL(r.u).hostname.replace(/^www\./,''); } catch { h = '(invalid)'; } }
  const cur = perDomain.get(h) ?? { n:0, age:0, price:0, desc:0, img:0, geo:0, rating:0 };
  cur.n++;
  if (r.af !== null && r.at !== null) cur.age++;
  if (r.fr === 1 || (r.pmax !== null && r.pmax > 0)) cur.price++;
  if ((r.dl ?? 0) >= 100) cur.desc++;
  if (r.img) cur.img++;
  if (r.lat !== null && r.lon !== null) cur.geo++;
  if ((r.rc ?? 0) >= 1) cur.rating++;
  perDomain.set(h, cur);
}
const sortedDomains = Array.from(perDomain.entries()).sort((a,b)=>b[1].n-a[1].n).slice(0,15);
for (const [h, s] of sortedDomains) {
  const pct = (x: number) => s.n ? `${Math.round(x*100/s.n)}%` : '0%';
  console.log(`  ${h.slice(0,27).padEnd(28)}${String(s.n).padStart(4)}  ${pct(s.age).padStart(5)}  ${pct(s.price).padStart(5)}  ${pct(s.desc).padStart(8)}  ${pct(s.img).padStart(5)}  ${pct(s.geo).padStart(7)}  ${pct(s.rating).padStart(6)}`);
}
console.log();

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('━━━ SUMMARY ━━━');
console.log(`Total in DB:                 ${(db.prepare('SELECT COUNT(*) AS n FROM events').get() as {n:number}).n}`);
console.log(`Currently visible (live):    ${visibleN}`);
console.log(`Unlockable potential pool:   ${potentialN}  (= visible + verify.* with future date)`);
console.log(`Distinct source domains (visible):   ${new Set([...sortedSrc].slice(0,sortedSrc.length).map(([h])=>h)).size}`);
console.log(`Source concentration: top domain holds ${sortedSrc[0]?.[1] ?? 0}/${potentialN} (${((sortedSrc[0]?.[1]??0)*100/potentialN).toFixed(0)}%)`);

db.close();
