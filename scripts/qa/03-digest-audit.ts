/**
 * 03 · Digest Audit — per-digest correctness + missed-candidate sweep.
 *
 * For each of the 5 programmatic digests:
 *   1. Rule check: deterministic predicates (e.g. Indoor should not contain
 *      outdoor-format events) → immediate bug list.
 *   2. LLM-judge: GPT-4o-mini rates each event 1-5 against the digest title.
 *   3. Missed candidates: scan the full live pool for rule-passing events
 *      that ARE NOT in the digest but scored high by the judge.
 *
 * This answers both "is the digest clean?" AND "is the digest complete?"
 */

import fs from 'fs';
import path from 'path';
import { runAllDigests } from '../../lib/digests';
import { loadLiveEvents, ageFits, looksIndoor, looksOutdoor, looksAffordable, isUpcomingWeekend, hasSocialProof, judge, withRetry, fmtEv, type Ev } from './_lib';

const OUT = path.join(process.cwd(), 'reports', 'qa', '03-digest-audit.json');

const JUDGE_SYSTEM = `You rate whether an NYC kids-activity event fits a themed digest.
Output STRICT JSON: {"score": 1-5, "why": "<≤12 words>"}.
  5 = perfect fit (strong match to digest promise)
  4 = good fit
  3 = plausible, some concerns
  2 = weak fit
  1 = does not fit the theme`;

function judgeUserPrompt(digestTitle: string, digestPromise: string, e: Ev): string {
  // tags may arrive as Array (from loadLiveEvents) or raw JSON string (from
  // runAllDigests). Normalise here so judge prompts don't crash.
  const rawTags = e.tags as unknown;
  const tagArr: string[] = Array.isArray(rawTags)
    ? (rawTags as string[])
    : (() => {
        if (typeof rawTags !== 'string') return [];
        try { const v = JSON.parse(rawTags); return Array.isArray(v) ? v : []; }
        catch { return []; }
      })();
  const details = [
    `Title: ${e.title}`,
    e.description ? `Description: ${e.description.slice(0, 280)}` : '',
    e.age_best_from != null ? `Ages: ${e.age_best_from}-${e.age_best_to ?? '?'}` : '',
    e.format ? `Format: ${e.format}` : '',
    e.is_free ? 'Price: FREE' : e.price_max != null ? `Price up to $${e.price_max}` : '',
    e.country_county ? `Location: ${e.country_county}` : '',
    tagArr.length ? `Tags: ${tagArr.slice(0, 8).join(', ')}` : '',
  ].filter(Boolean).join('\n');
  return `Digest: "${digestTitle}"
What it promises: ${digestPromise}

Event:
${details}

Rate the fit 1-5.`;
}

const DIGEST_META: Record<string, { title: string; promise: string; rules: (e: Ev) => { ok: boolean; why?: string } }> = {
  'weekend-kids-nyc': {
    title: 'Top 10 Things to Do with Kids in NYC This Weekend',
    promise: 'Kids-friendly event happening this upcoming Saturday or Sunday in NYC.',
    rules: (e) => isUpcomingWeekend(e) ? { ok: true } : { ok: false, why: 'next_start_at is not an upcoming Sat/Sun' },
  },
  'indoor-rainy-day': {
    title: 'Top 10 Indoor Activities for Kids in NYC (Rainy Day Edition)',
    promise: 'Indoor, weather-proof kids activity (museum, workshop, class, theater).',
    rules: (e) => {
      if (looksOutdoor(e) && !looksIndoor(e)) return { ok: false, why: 'looks outdoor (festival/park/street)' };
      return { ok: true };
    },
  },
  'easy-no-planning': {
    title: '10 Easy Things to Do with Kids in NYC (No Planning Needed)',
    promise: 'Low-effort, drop-in, no-RSVP kids plan.',
    rules: (e) => {
      const blob = (e.description ?? '').toLowerCase() + ' ' + (e.title ?? '').toLowerCase();
      if (/\b(sold out|registration required|rsvp|ticket required|by appointment)\b/.test(blob)) {
        return { ok: false, why: 'requires registration / sold out' };
      }
      return { ok: true };
    },
  },
  'free-affordable': {
    title: 'Top 15 Free & Affordable Things to Do with Kids in NYC',
    promise: 'Free or ≤ $30/person kid activity.',
    rules: (e) => looksAffordable(e) ? { ok: true } : { ok: false, why: `price_max=${e.price_max} > $30 and not free` },
  },
  'kids-love-parents-approve': {
    title: '10 Things Kids Love (And Parents Don\'t Regret)',
    promise: 'Well-reviewed, high-quality kids event with real engagement.',
    rules: (e) => hasSocialProof(e) ? { ok: true } : { ok: false, why: `only ${e.rating_count ?? 0} reviews / rating=${e.rating_avg}` },
  },
};

interface Issue {
  type: 'rule_violation' | 'low_judge_score' | 'missed_candidate';
  event_id: number;
  title: string;
  detail: string;
}

interface DigestReport {
  slug: string;
  title: string;
  included_count: number;
  rule_violations: Issue[];
  low_judge_scores: Issue[];
  missed_candidates: Issue[];
  judge_avg: number;
  judge_scores: Array<{ id: number; title: string; score: number; why: string }>;
}

async function judgeEvent(digestTitle: string, promise: string, e: Ev): Promise<{ score: number; why: string }> {
  try {
    const res = await withRetry(() => judge<{ score: number; why: string }>(
      JUDGE_SYSTEM,
      judgeUserPrompt(digestTitle, promise, e)
    ));
    if (typeof res === 'object' && res && 'score' in res) {
      return { score: Number((res as { score: number }).score), why: String((res as { why?: string }).why ?? '') };
    }
    return { score: 0, why: 'parse error' };
  } catch (err) {
    return { score: 0, why: `judge error: ${(err as Error).message}` };
  }
}

async function main() {
  console.log('\n════ DIGEST AUDIT ════');
  const pool = loadLiveEvents();
  const digests = runAllDigests();

  const reports: DigestReport[] = [];

  for (const d of digests) {
    const meta = DIGEST_META[d.meta.slug];
    if (!meta) { console.log(`Skipping unknown digest ${d.meta.slug}`); continue; }
    console.log(`\n── ${d.meta.slug} — ${d.events.length} events`);

    const included = d.events as unknown as Ev[];
    const includedIds = new Set(included.map((e) => e.id));

    // 1. Rule check on included
    const rule_violations: Issue[] = [];
    included.forEach((e) => {
      const r = meta.rules(e);
      if (!r.ok) rule_violations.push({ type: 'rule_violation', event_id: e.id, title: e.title ?? '', detail: r.why ?? '' });
    });

    // 2. LLM judge on included
    const judge_scores: Array<{ id: number; title: string; score: number; why: string }> = [];
    for (const e of included) {
      const j = await judgeEvent(meta.title, meta.promise, e);
      judge_scores.push({ id: e.id, title: e.title ?? '', score: j.score, why: j.why });
      process.stdout.write(`    judged #${e.id}: ${j.score}\r`);
    }
    const valid = judge_scores.filter((s) => s.score > 0);
    const judge_avg = valid.length === 0 ? 0 : valid.reduce((a, b) => a + b.score, 0) / valid.length;
    const low_judge_scores: Issue[] = judge_scores
      .filter((s) => s.score > 0 && s.score <= 2)
      .map((s) => ({ type: 'low_judge_score', event_id: s.id, title: s.title, detail: `judge=${s.score}: ${s.why}` }));

    // 3. Missed candidates — rule-passing events NOT in the digest, judged high
    const candidates = pool.filter((e) => !includedIds.has(e.id) && meta.rules(e).ok);
    // Keep it cheap — only judge top 15 candidates ranked by basic heuristic
    // (has image, has description, has rating). Skip old-start events.
    const shortlisted = candidates
      .filter((e) => e.description && e.description.length > 40)
      .sort((a, b) => (b.rating_count ?? 0) - (a.rating_count ?? 0))
      .slice(0, 15);
    const missed: Issue[] = [];
    for (const e of shortlisted) {
      const j = await judgeEvent(meta.title, meta.promise, e);
      if (j.score >= 4) {
        missed.push({ type: 'missed_candidate', event_id: e.id, title: e.title ?? '', detail: `judge=${j.score}: ${j.why}` });
      }
    }
    console.log(`    rule_violations=${rule_violations.length}  low_judge=${low_judge_scores.length}  missed(candidates judged ≥4)=${missed.length}  avg_judge=${judge_avg.toFixed(2)}`);

    reports.push({
      slug: d.meta.slug,
      title: meta.title,
      included_count: included.length,
      rule_violations,
      low_judge_scores,
      missed_candidates: missed,
      judge_avg,
      judge_scores,
    });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ digests: reports }, null, 2));

  console.log('\n── Summary ──');
  reports.forEach((r) => {
    console.log(`${r.slug}: avg-judge=${r.judge_avg.toFixed(2)}, rule-bugs=${r.rule_violations.length}, low-judge=${r.low_judge_scores.length}, missed-strong=${r.missed_candidates.length}`);
  });
  console.log(`\nReport → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
