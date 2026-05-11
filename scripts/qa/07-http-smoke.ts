/**
 * 07 · HTTP smoke tests — hit the same endpoints the UI / Chrome extension
 * hits (prod by default, can override to localhost with QA_BASE_URL).
 *
 * Why separate from 02-filter-audit: that one goes straight to `getEvents()`.
 * This one goes over HTTP so we also cover: JSON serialization, query-param
 * parsing, Next.js middleware, caching, and any API-route bugs that don't
 * show up against the raw DB layer.
 */

import fs from 'fs';
import path from 'path';

const BASE = process.env.QA_BASE_URL || 'https://pulseup.me';
const OUT = path.join(process.cwd(), 'reports', 'qa', `07-http-smoke-${BASE.includes('localhost') ? 'local' : 'prod'}.json`);

interface Case {
  id: string;
  name: string;
  url: string;
  check: (data: unknown, status: number) => { ok: boolean; detail: string };
}

interface Ev { id: number; title: string; is_free?: boolean; age_best_from?: number; age_best_to?: number; country_county?: string; category_l1?: string; }
interface ListResp { events?: Ev[]; total?: number; error?: string; }

const ok = (detail: string) => ({ ok: true, detail });
const bad = (detail: string) => ({ ok: false, detail });

const CASES: Case[] = [
  {
    id: 'h01',
    name: 'GET /api/events (baseline)',
    url: '/api/events?page_size=500',
    check: (d, s) => {
      const r = d as ListResp;
      if (s !== 200) return bad(`status=${s} error=${r.error}`);
      if (!Array.isArray(r.events) || r.events.length === 0) return bad('no events');
      return ok(`${r.total} total events`);
    },
  },
  {
    id: 'h02',
    name: 'Age=4 — no events outside bounds',
    url: '/api/events?age=4&page_size=200',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as ListResp;
      const wrong = (r.events ?? []).filter(
        (e) => (e.age_best_from != null && e.age_best_from > 4) || (e.age_best_to != null && e.age_best_to < 4)
      );
      return wrong.length === 0 ? ok(`${r.total} events, all age-fit`) : bad(`${wrong.length} out-of-range: ${wrong.slice(0, 2).map((e) => `#${e.id}`).join(',')}`);
    },
  },
  {
    id: 'h03',
    name: 'Age=7 + girl (regression: was HTTP 500)',
    url: '/api/events?age=7&child_genders=girl&page_size=50',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as ListResp;
      return (r.events ?? []).length > 0 ? ok(`${r.total} events returned`) : bad('zero returned');
    },
  },
  {
    id: 'h04',
    name: 'Brooklyn — no Manhattan leaks',
    url: '/api/events?neighborhoods=Brooklyn&page_size=200',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as ListResp;
      const leak = (r.events ?? []).filter(
        (e) => e.country_county && e.country_county !== 'Kings County'
      );
      return leak.length === 0 ? ok(`${r.total} events, all in Kings County`) : bad(`${leak.length} non-Brooklyn: ${leak.slice(0, 2).map((e) => `${e.country_county}#${e.id}`).join(',')}`);
    },
  },
  {
    id: 'h05',
    name: 'Manhattan filter',
    url: '/api/events?neighborhoods=Manhattan&page_size=200',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as ListResp;
      return (r.events ?? []).length > 0 ? ok(`${r.total} Manhattan events`) : bad('zero results');
    },
  },
  {
    id: 'h06',
    name: 'Free-only filter',
    url: '/api/events?is_free=true&page_size=200',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as ListResp;
      const paid = (r.events ?? []).filter((e) => e.is_free === false);
      return paid.length === 0 ? ok(`${r.total} free events`) : bad(`${paid.length} paid events leaked`);
    },
  },
  {
    id: 'h07',
    name: 'Science category returns something',
    url: '/api/events?categories=science&page_size=50',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as ListResp;
      return (r.events ?? []).length > 0 ? ok(`${r.total} science events`) : bad('zero returned (DB is known scarce, but >0 expected)');
    },
  },
  {
    id: 'h08',
    name: 'Combo: 4yo + Brooklyn + free',
    url: '/api/events?age=4&neighborhoods=Brooklyn&is_free=true&page_size=50',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as ListResp;
      const bad_age = (r.events ?? []).filter((e) => (e.age_best_from ?? 0) > 4 || (e.age_best_to != null && e.age_best_to < 4));
      const bad_geo = (r.events ?? []).filter((e) => e.country_county && e.country_county !== 'Kings County');
      const bad_price = (r.events ?? []).filter((e) => e.is_free === false);
      const issues = bad_age.length + bad_geo.length + bad_price.length;
      return issues === 0 ? ok(`${r.total} events, all clean`) : bad(`age-wrong=${bad_age.length} geo-wrong=${bad_geo.length} price-wrong=${bad_price.length}`);
    },
  },
  {
    id: 'h09',
    name: 'GET /api/digests',
    url: '/api/digests',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      // Response can be either {digests:[...]} or Array<{name,digests:[]}>
      let count = 0;
      if (Array.isArray(d)) {
        count = (d as Array<{ digests?: unknown[] }>).flatMap((c) => c.digests ?? []).length;
      } else if (d && typeof d === 'object' && Array.isArray((d as { digests?: unknown[] }).digests)) {
        count = ((d as { digests: unknown[] }).digests).length;
      }
      return count >= 5 ? ok(`${count} digests`) : bad(`only ${count} digests`);
    },
  },
  {
    id: 'h10',
    name: 'Digest by slug: weekend-kids-nyc',
    url: '/api/digests/weekend-kids-nyc',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as { digest?: { title?: string }; events?: unknown[] };
      return Array.isArray(r.events) && r.events.length > 0 ? ok(`${r.events.length} events`) : bad('no events in digest');
    },
  },
  {
    id: 'h11',
    name: 'Digest by slug: indoor-rainy-day',
    url: '/api/digests/indoor-rainy-day',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as { events?: unknown[] };
      return Array.isArray(r.events) && r.events.length > 0 ? ok(`${r.events.length} events`) : bad('no events');
    },
  },
  {
    id: 'h12',
    name: 'GET /api/categories',
    url: '/api/categories',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      return Array.isArray(d) && d.length > 5 ? ok(`${(d as unknown[]).length} categories`) : bad('too few categories');
    },
  },
  {
    id: 'h13',
    name: 'Chat API — simple query',
    url: '__CHAT__:Things to do this weekend',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as { events?: unknown[]; message?: string; filters?: unknown };
      if (!r.message) return bad('no reply message');
      if (!Array.isArray(r.events)) return bad('events field missing');
      return ok(`${r.events.length} events, filters: ${JSON.stringify(r.filters ?? {}).slice(0, 60)}`);
    },
  },
  {
    id: 'h14',
    name: 'Chat API — age + gender (was 500)',
    url: '__CHAT__:What can my 7 year old girl do today',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as { events?: unknown[] };
      return Array.isArray(r.events) ? ok(`${r.events.length} events`) : bad('no events array');
    },
  },

  // ── Bug #4 (May-11): /api/events/personalized was returning categories/tags
  // as RAW JSON STRINGS ('[]', '["x","y"]') instead of arrays. The frontend
  // crashed with `(e.categories || []).map is not a function` because '[]'
  // is truthy and skips the `|| []` fallback. Without this case the regression
  // ships clean. Same shape check applies to other event-returning endpoints.
  {
    id: 'h15',
    name: '/api/events/personalized returns events (was untested)',
    url: '/api/events/personalized?gender=boy&child_age=8&borough=manhattan&interests=arts_crafts',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as { events?: Array<{ categories?: unknown; tags?: unknown }> };
      if (!Array.isArray(r.events)) return bad('events not an array');
      if (r.events.length === 0) return bad('zero events for valid profile');
      return ok(`${r.events.length} events`);
    },
  },
  {
    id: 'h16',
    name: '/api/events/personalized — categories field is an ARRAY (Bug #4 May-11)',
    url: '/api/events/personalized?gender=boy&child_age=8&borough=manhattan&interests=arts_crafts',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as { events?: Array<{ categories?: unknown; tags?: unknown }> };
      const ev = r.events?.[0];
      if (!ev) return bad('no events to inspect');
      if (!Array.isArray(ev.categories)) return bad(`categories is ${typeof ev.categories}: ${JSON.stringify(ev.categories).slice(0, 40)} — frontend will crash on .map()`);
      if (!Array.isArray(ev.tags))       return bad(`tags is ${typeof ev.tags}`);
      return ok('categories + tags are proper arrays');
    },
  },
  {
    id: 'h17',
    name: '/api/digests — nested event.categories is an ARRAY (Bug #5 May-11)',
    url: '/api/digests',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as { digests?: Array<{ events?: Array<{ categories?: unknown; tags?: unknown }> }> };
      const firstEvent = r.digests?.[0]?.events?.[0];
      if (!firstEvent) return bad('no nested events in digests');
      if (!Array.isArray(firstEvent.categories)) return bad(`digest event categories is ${typeof firstEvent.categories}`);
      if (!Array.isArray(firstEvent.tags))       return bad(`digest event tags is ${typeof firstEvent.tags}`);
      return ok('digest events have proper arrays');
    },
  },
  {
    id: 'h18',
    name: '/api/digests/[slug] — nested event.categories is an ARRAY (Bug #5)',
    url: '/api/digests/weekend-kids-nyc',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as { events?: Array<{ categories?: unknown; tags?: unknown }> };
      const ev = r.events?.[0];
      if (!ev) return bad('no events in digest');
      if (!Array.isArray(ev.categories)) return bad(`digest-slug event categories is ${typeof ev.categories}`);
      if (!Array.isArray(ev.tags))       return bad(`digest-slug event tags is ${typeof ev.tags}`);
      return ok('digest-slug events have proper arrays');
    },
  },

  // ── Bug #2 (May-11): SQLite couldn't parse next_start_at with "+00" suffix,
  // so datetime() + 3h returned NULL and the live-event filter excluded 100%
  // of rows. The endpoint returned 200 with total=0, which db-inventory caught
  // — but we want an explicit "next_start_at parses cleanly" guard.
  {
    id: 'h19',
    name: 'next_start_at parses (Bug #2 May-11 — timezone-suffix issue)',
    url: '/api/events?page_size=3',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as { events?: Array<{ next_start_at?: string }> };
      const ev = r.events?.[0];
      if (!ev?.next_start_at) return bad('no next_start_at on first event');
      const ms = new Date(ev.next_start_at).getTime();
      if (!Number.isFinite(ms)) return bad(`next_start_at='${ev.next_start_at}' fails new Date() — frontend will show "Invalid Date"`);
      return ok(`first event date=${ev.next_start_at}`);
    },
  },

  // ── Bug #1 (May-11): CSV column rename (geo_lat → lat) silently produced
  // a DB with 0% lat/lon coverage. Map view + nearby filter then break.
  // db-inventory catches a fully empty DB; this guards the geo-specific case.
  {
    id: 'h20',
    name: 'lat/lon coverage ≥ 80% (Bug #1 May-11 — column rename)',
    url: '/api/events?page_size=50',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as { events?: Array<{ lat?: number | null; lon?: number | null }> };
      if (!r.events?.length) return bad('no events to inspect');
      const withGeo = r.events.filter((e) => typeof e.lat === 'number' && typeof e.lon === 'number').length;
      const pct = withGeo / r.events.length;
      if (pct < 0.8) return bad(`only ${Math.round(pct * 100)}% of events have lat/lon — map view will be sparse`);
      return ok(`${Math.round(pct * 100)}% have lat/lon`);
    },
  },

  // ── Bug #3 (May-11): When age_best_to was NULL the SQL filter was a no-op
  // for the upper bound, so an 8-year-old would see "Yo Mama's so fast 5K"
  // (adult 0-NULL event). After fix: parseEventRow synthesises bounds from
  // category_l1 when missing. This case verifies the fix is still active.
  {
    id: 'h21',
    name: 'age=8 NEVER returns events with age_best_to=null (Bug #3 May-11)',
    url: '/api/events?age=8&page_size=100',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as { events?: Array<{ id: number; title: string; age_best_to?: number | null; category_l1?: string }> };
      if (!r.events?.length) return bad('no events for age=8');
      const open = r.events.filter((e) => e.age_best_to === null || e.age_best_to === undefined);
      if (open.length > 0) {
        const sample = open.slice(0, 2).map((e) => `#${e.id} ${e.title.slice(0, 30)} [cat=${e.category_l1}]`).join('; ');
        return bad(`${open.length} events have no upper age bound — synthesis is broken. Sample: ${sample}`);
      }
      return ok(`all ${r.events.length} events have proper age bounds`);
    },
  },
  {
    id: 'h22',
    name: 'age=2 (toddler) — no clearly-teen events returned',
    url: '/api/events?age=2&page_size=50',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as { events?: Array<{ id: number; title: string; age_best_from?: number | null }> };
      if (!r.events?.length) return bad('no events for age=2');
      const teenOnly = r.events.filter((e) => typeof e.age_best_from === 'number' && e.age_best_from >= 10);
      if (teenOnly.length > 0) {
        const sample = teenOnly.slice(0, 2).map((e) => `#${e.id} ${e.title.slice(0, 30)} [from=${e.age_best_from}]`).join('; ');
        return bad(`toddler age=2 got teen-only events: ${sample}`);
      }
      return ok(`${r.events.length} toddler events, none teen-only`);
    },
  },
  {
    id: 'h23',
    name: 'age=14 (teen) — no clearly-toddler events returned',
    url: '/api/events?age=14&page_size=50',
    check: (d, s) => {
      if (s !== 200) return bad(`status=${s}`);
      const r = d as { events?: Array<{ id: number; title: string; age_best_to?: number | null }> };
      if (!r.events?.length) return bad('no events for age=14');
      const babyOnly = r.events.filter((e) => typeof e.age_best_to === 'number' && e.age_best_to <= 5);
      if (babyOnly.length > 0) {
        const sample = babyOnly.slice(0, 2).map((e) => `#${e.id} ${e.title.slice(0, 30)} [to=${e.age_best_to}]`).join('; ');
        return bad(`teen age=14 got baby-only events: ${sample}`);
      }
      return ok(`${r.events.length} teen events, none baby-only`);
    },
  },
];

async function main() {
  console.log(`\n════ HTTP SMOKE (${BASE}) ════`);
  const rows: Array<{ id: string; name: string; ok: boolean; detail: string; latencyMs: number; status: number }> = [];
  for (const c of CASES) {
    const start = Date.now();
    try {
      let res: Response;
      if (c.url.startsWith('__CHAT__:')) {
        const msg = c.url.replace('__CHAT__:', '');
        res = await fetch(`${BASE}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg }),
        });
      } else {
        res = await fetch(`${BASE}${c.url}`);
      }
      const latencyMs = Date.now() - start;
      const data = await res.json().catch(() => ({}));
      const verdict = c.check(data, res.status);
      rows.push({ id: c.id, name: c.name, ok: verdict.ok, detail: verdict.detail, latencyMs, status: res.status });
      const icon = verdict.ok ? '✓' : '✗';
      console.log(`  ${c.id} ${icon} ${(res.status + '').padStart(3)} ${String(latencyMs).padStart(5)}ms  ${c.name.padEnd(45)}  ${verdict.detail}`);
    } catch (e) {
      const latencyMs = Date.now() - start;
      rows.push({ id: c.id, name: c.name, ok: false, detail: `THROWN: ${(e as Error).message}`, latencyMs, status: 0 });
      console.log(`  ${c.id} ✗ ERR  ${(e as Error).message.slice(0, 60)}`);
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ base: BASE, cases: rows }, null, 2));
  const pass = rows.filter((r) => r.ok).length;
  console.log(`\nSummary: ${pass}/${rows.length} passed · base=${BASE}`);
  console.log(`Report → ${OUT}`);
  process.exit(pass === rows.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
