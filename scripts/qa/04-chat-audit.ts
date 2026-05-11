/**
 * 04 · Chat Audit — 20 realistic NYC-parent queries against prod /api/chat.
 *
 * For each query we record:
 *   · extracted filters
 *   · events returned
 *   · the natural-language reply
 *
 * Then GPT-4o-mini judges:
 *   · relevance of the returned events
 *   · whether the reply hallucinates (mentions events NOT in the list)
 *   · whether the DB likely has better candidates we missed (via a
 *     lightweight DB snippet passed alongside)
 */

import fs from 'fs';
import path from 'path';
import { loadLiveEvents, judge, withRetry, CHAT_URL, fmtEv, sleep, type Ev } from './_lib';

// Throttle between chat API calls — prod has a rate limiter that trips at
// ~1 req/sec sustained. 3500ms between requests is safe.
const CHAT_THROTTLE_MS = 3500;

const OUT = path.join(process.cwd(), 'reports', 'qa', '04-chat-audit.json');

interface Query { id: string; q: string; hint: string; /* topic the DB-snippet should emphasise */ }
const QUERIES: Query[] = [
  { id: 'q01', q: 'Things to do this weekend with 4 and 7 year old',    hint: 'weekend' },
  { id: 'q02', q: 'Science museum for 5 year old',                      hint: 'science' },
  { id: 'q03', q: 'Cheap rainy day activities for kids',                hint: 'indoor' },
  { id: 'q04', q: 'Teen hangouts in Brooklyn',                          hint: 'brooklyn' },
  { id: 'q05', q: 'Stroller-friendly nature walk Sunday',               hint: 'nature' },
  { id: 'q06', q: 'Last minute plan for today, kids 3 and 6',           hint: 'today' },
  { id: 'q07', q: 'After-school Tuesday activity Manhattan',            hint: 'manhattan' },
  { id: 'q08', q: 'Birthday party venue for a 7-year-old',              hint: 'kids' },
  { id: 'q09', q: 'Free outdoor Saturday in Manhattan with 4yo',        hint: 'outdoor' },
  { id: 'q10', q: 'Bilingual Spanish storytime',                        hint: 'spanish' },
  { id: 'q11', q: 'Art classes for kids',                               hint: 'arts' },
  { id: 'q12', q: 'Outdoor activities in Brooklyn this weekend',        hint: 'brooklyn' },
  { id: 'q13', q: 'Dance or music classes for 6yo',                     hint: 'music' },
  { id: 'q14', q: 'Sports activities for boy age 8',                    hint: 'sports' },
  { id: 'q15', q: 'Free things to do with kids under 5',                hint: 'free' },
  { id: 'q16', q: 'Activities under $20 per person',                    hint: 'affordable' },
  { id: 'q17', q: 'Events near Midtown Manhattan',                      hint: 'manhattan' },
  { id: 'q18', q: 'Anything in the Bronx for kids',                     hint: 'bronx' },
  { id: 'q19', q: 'We are bored, suggest something fun for 4yo',        hint: 'any' },
  { id: 'q20', q: 'Best family experience in NYC right now',            hint: 'any' },
];

interface ApiResp {
  message?: string;
  filters?: Record<string, unknown>;
  events?: Array<{ id: number; title: string; category_l1?: string; is_free?: boolean; age_label?: string }>;
  error?: string;
}

async function callChat(q: string, profile?: unknown): Promise<ApiResp> {
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: q, ...(profile ? { profile } : {}) }),
  });
  return (await res.json()) as ApiResp;
}

/** Build a short DB snippet for the judge: events hint-adjacent to the query. */
function dbSnippet(pool: Ev[], hint: string): string {
  const h = hint.toLowerCase();
  const scored = pool
    .map((e) => {
      const blob = [e.title, e.description, e.format, e.category_l1, ...e.tags].filter(Boolean).join(' ').toLowerCase();
      const hits = h === 'any' ? 1 : blob.includes(h) ? 1 : 0;
      return { e, hits };
    })
    .filter((x) => x.hits > 0)
    .slice(0, 20);
  return scored.map((s) => `#${s.e.id} | ${s.e.title} | ${s.e.category_l1 ?? ''} | ${s.e.is_free ? 'free' : ''} | ages ${s.e.age_best_from ?? '?'}-${s.e.age_best_to ?? '?'}`).join('\n');
}

const JUDGE_SYSTEM = `You are a QA judge for a kids-activity chat assistant in NYC.
Given a parent's query, the assistant's response (with events), and a reference DB snippet, output STRICT JSON:
{
  "relevance": 1-5,          // how relevant are the returned events to the query
  "hallucination": "yes|no", // does the reply mention events NOT in the returned list
  "missed_from_db": ["#id reason", ...],  // up to 3 IDs from DB snippet that look like better fits but weren't returned (empty if none)
  "diagnosis": "good_match|db_gap|pipeline_issue|partial_match",
  "notes": "<≤20 words>"
}`;

interface Row {
  id: string;
  query: string;
  extracted_filters: Record<string, unknown>;
  returned_count: number;
  top_titles: string[];
  reply_snippet: string;
  relevance: number;
  hallucination: string;
  missed_from_db: string[];
  diagnosis: string;
  notes: string;
  error?: string;
}

async function main() {
  const pool = loadLiveEvents();
  const rows: Row[] = [];

  console.log('\n════ CHAT AUDIT ════');

  // Standard NYC mom profile (2 kids, 4 and 7)
  const profile = {
    children: [{ age: 4, gender: 'girl', interests: [] }, { age: 7, gender: 'boy', interests: [] }],
    neighborhoods: ['Manhattan'],
    budget: 'Under $50',
  };

  for (const q of QUERIES) {
    process.stdout.write(`  ${q.id}  ${q.q.slice(0, 55).padEnd(55)} ... `);
    try {
      // Throttle before each chat call — prod rate-limits at ~1 req/sec
      await sleep(CHAT_THROTTLE_MS);
      const resp = await withRetry(() => callChat(q.q, profile), 3, 800);
      if (resp.error) {
        rows.push({ id: q.id, query: q.q, extracted_filters: {}, returned_count: 0, top_titles: [], reply_snippet: '', relevance: 0, hallucination: 'n/a', missed_from_db: [], diagnosis: 'pipeline_issue', notes: 'API error', error: resp.error });
        console.log(`✗ API error: ${resp.error}`);
        continue;
      }
      const events = resp.events ?? [];
      const top = events.slice(0, 5).map((e) => `#${e.id} ${e.title}`);
      const snippet = dbSnippet(pool, q.hint);

      const judgePrompt = `Parent query: "${q.q}"

Assistant extracted filters: ${JSON.stringify(resp.filters ?? {})}

Events returned (first 10):
${events.slice(0, 10).map((e) => `  #${e.id} ${e.title} | ${e.category_l1 ?? ''} | ${e.is_free ? 'free' : ''} | ${e.age_label ?? ''}`).join('\n') || '(none)'}

Assistant reply:
"${(resp.message ?? '').slice(0, 500)}"

Reference DB snippet (hint-adjacent events that exist):
${snippet || '(empty)'}`;

      const j = await withRetry(() => judge<{
        relevance: number; hallucination: string; missed_from_db: string[]; diagnosis: string; notes: string;
      }>(JUDGE_SYSTEM, judgePrompt)) as { relevance: number; hallucination: string; missed_from_db: string[]; diagnosis: string; notes: string };

      rows.push({
        id: q.id,
        query: q.q,
        extracted_filters: resp.filters ?? {},
        returned_count: events.length,
        top_titles: top,
        reply_snippet: (resp.message ?? '').slice(0, 200),
        relevance: Number(j.relevance) || 0,
        hallucination: String(j.hallucination),
        missed_from_db: Array.isArray(j.missed_from_db) ? j.missed_from_db : [],
        diagnosis: String(j.diagnosis),
        notes: String(j.notes ?? ''),
      });
      const tag = j.diagnosis === 'good_match' ? '✓' : j.diagnosis === 'partial_match' ? '~' : '✗';
      console.log(`${tag} rel=${j.relevance} diag=${j.diagnosis}`);
    } catch (e) {
      rows.push({ id: q.id, query: q.q, extracted_filters: {}, returned_count: 0, top_titles: [], reply_snippet: '', relevance: 0, hallucination: 'n/a', missed_from_db: [], diagnosis: 'pipeline_issue', notes: `threw: ${(e as Error).message}`, error: (e as Error).message });
      console.log(`✗ ${(e as Error).message.slice(0, 60)}`);
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ queries: rows }, null, 2));

  const good = rows.filter((r) => r.diagnosis === 'good_match').length;
  const part = rows.filter((r) => r.diagnosis === 'partial_match').length;
  const gap  = rows.filter((r) => r.diagnosis === 'db_gap').length;
  const pipe = rows.filter((r) => r.diagnosis === 'pipeline_issue').length;
  console.log(`\nSummary: ${good} good · ${part} partial · ${gap} db_gap · ${pipe} pipeline`);
  const halluc = rows.filter((r) => r.hallucination === 'yes').length;
  console.log(`Hallucinations flagged: ${halluc}/${rows.length}`);
  console.log(`Report → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
