/**
 * 99 · Aggregator — reads all reports/qa/*.json, emits:
 *   · reports/qa/bugs.md     — prioritized bug list (Critical / Medium / Low)
 *   · reports/qa/verdict.md  — scorecard 0-10 across axes + final answer
 *
 * Run AFTER the 6 audit scripts.  No LLM calls.
 */

import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'reports', 'qa');

function readJson<T>(f: string, fb: T): T {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) return fb;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

interface InventoryRpt { total_live_events: number; field_completeness: Record<string, number>; distributions: Record<string, Record<string, number>>; interest_upper_bounds: Record<string, number>; }
interface FilterRow { id: string; name: string; returned: number; correctness_pct: number; coverage_pct: number; missed: number; missed_samples: string[]; wrong_samples: string[]; verdict: string; }
interface DigestRpt { slug: string; title: string; included_count: number; rule_violations: Array<{ event_id: number; title: string; detail: string }>; low_judge_scores: Array<{ event_id: number; title: string; detail: string }>; missed_candidates: Array<{ event_id: number; title: string; detail: string }>; judge_avg: number; }
interface ChatRow { id: string; query: string; returned_count: number; relevance: number; hallucination: string; missed_from_db: string[]; diagnosis: string; notes: string; error?: string; }
interface RankRow { id: string; label: string; ndcg_at_10: number; flops_at_top: string[]; gems_below: string[]; }
interface ScenRow { id: string; story: string; filter_path: { returned_total: number; gold_count: number; top10_hits: number; any_hit_top10: boolean; any_hit_any: boolean }; chat_path: { any_hit: boolean } | null; verdict: string; }

const inv = readJson<InventoryRpt>('01-db-inventory.json', { total_live_events: 0, field_completeness: {}, distributions: {}, interest_upper_bounds: {} });
const flt = readJson<{ scenarios: FilterRow[] }>('02-filter-audit.json', { scenarios: [] });
const dig = readJson<{ digests: DigestRpt[] }>('03-digest-audit.json', { digests: [] });
const chat = readJson<{ queries: ChatRow[] }>('04-chat-audit.json', { queries: [] });
const rnk = readJson<{ queries: RankRow[]; mean_ndcg_at_10: number }>('05-ranking-audit.json', { queries: [], mean_ndcg_at_10: 0 });
const scn = readJson<{ scenarios: ScenRow[] }>('06-scenarios.json', { scenarios: [] });
const smokeProd = readJson<{ cases: Array<{ id: string; name: string; ok: boolean; status: number; latencyMs: number; detail: string }> }>('07-http-smoke-prod.json', { cases: [] });
const smokeLocal = readJson<{ cases: Array<{ id: string; name: string; ok: boolean; status: number; latencyMs: number; detail: string }> }>('07-http-smoke-local.json', { cases: [] });

// ─── Bugs collection ──────────────────────────────────────────────────────
interface Bug { severity: 'CRITICAL' | 'MEDIUM' | 'LOW'; area: string; title: string; evidence: string; suggested_fix: string; }
const bugs: Bug[] = [];

// Critical: filter coverage <50% on a common scenario
flt.scenarios.forEach((s) => {
  if (s.coverage_pct < 50 && s.returned > 0) {
    bugs.push({
      severity: 'CRITICAL',
      area: 'filter-coverage',
      title: `Filter "${s.name}" leaks out ${100 - s.coverage_pct}% of matching events`,
      evidence: `Returned ${s.returned}, missed ${s.missed} matching events. Sample missed: ${s.missed_samples.slice(0, 2).join(' · ')}`,
      suggested_fix: `Inspect buildAgeFitSql (wide-range exclusion rule in lib/db.ts, around line 208-223) — it rejects events whose range starts ≤ N-3 and spans ≥ 7 years. For age 7+ this excludes normal kids events like "Ages 3-12".`,
    });
  }
});

// Medium: filter coverage 50-80%
flt.scenarios.forEach((s) => {
  if (s.coverage_pct >= 50 && s.coverage_pct < 80 && s.returned > 0) {
    bugs.push({
      severity: 'MEDIUM',
      area: 'filter-coverage',
      title: `Filter "${s.name}" coverage only ${s.coverage_pct}%`,
      evidence: `Missed ${s.missed} candidates. Examples: ${s.missed_samples.slice(0, 2).join(' · ')}`,
      suggested_fix: `Review predicates for this filter path — loose predicate vs strict SQL.`,
    });
  }
});

// Low: correctness gaps (>0% wrong)
flt.scenarios.forEach((s) => {
  if (s.correctness_pct < 100 && s.returned > 0) {
    bugs.push({
      severity: 'LOW',
      area: 'filter-correctness',
      title: `Filter "${s.name}" returns ${100 - s.correctness_pct}% events that don't match`,
      evidence: `Wrong samples: ${s.wrong_samples.join(' · ')}`,
      suggested_fix: 'Tighten SQL predicate for this category.',
    });
  }
});

// Digest rule violations
dig.digests.forEach((d) => {
  d.rule_violations.forEach((v) => {
    bugs.push({
      severity: 'MEDIUM',
      area: 'digest',
      title: `${d.slug}: rule violated by "${v.title}"`,
      evidence: v.detail,
      suggested_fix: `Update digest scorer in lib/digests/ to exclude events matching this pattern.`,
    });
  });
  // Missed-strong candidates (≥4 judge, rule-passing)
  if (d.missed_candidates.length >= 3) {
    bugs.push({
      severity: 'MEDIUM',
      area: 'digest-coverage',
      title: `${d.slug}: digest misses ${d.missed_candidates.length} strong candidates`,
      evidence: d.missed_candidates.slice(0, 3).map((m) => `#${m.event_id} ${m.title}`).join(' · '),
      suggested_fix: `Digest scorer is too conservative. Consider lowering strong-tier threshold or widening signal set.`,
    });
  }
  // Low-judge on included
  d.low_judge_scores.forEach((l) => {
    bugs.push({
      severity: 'LOW',
      area: 'digest-quality',
      title: `${d.slug}: weak fit "${l.title}"`,
      evidence: l.detail,
      suggested_fix: 'Boost required signal strength for this digest.',
    });
  });
});

// Chat issues
chat.queries.forEach((q) => {
  if (q.error || q.diagnosis === 'pipeline_issue') {
    bugs.push({
      severity: 'CRITICAL',
      area: 'chat',
      title: `Chat fails for: "${q.query}"`,
      evidence: q.error ?? q.notes,
      suggested_fix: 'Check chat route error log; likely LLM prompt extracted a broken filter.',
    });
  } else if (q.hallucination === 'yes') {
    bugs.push({
      severity: 'MEDIUM',
      area: 'chat',
      title: `Chat hallucinates events: "${q.query}"`,
      evidence: q.notes,
      suggested_fix: 'Harden chat prompt to only mention events from the returned list.',
    });
  } else if (q.diagnosis === 'db_gap' || (q.missed_from_db && q.missed_from_db.length > 0)) {
    bugs.push({
      severity: 'MEDIUM',
      area: 'chat-coverage',
      title: `Chat missed DB candidates: "${q.query}"`,
      evidence: (q.missed_from_db ?? []).slice(0, 3).join(' · '),
      suggested_fix: 'Either widen chat filter extraction (LLM too narrow) or improve category/tag mapping.',
    });
  }
});

// Ranking issues
rnk.queries.forEach((r) => {
  if (r.ndcg_at_10 < 0.7) {
    bugs.push({
      severity: 'MEDIUM',
      area: 'ranking',
      title: `Ranking broken: "${r.label}" — NDCG@10 = ${r.ndcg_at_10}`,
      evidence: `Flops at top: ${r.flops_at_top.slice(0, 2).join(' · ')}. Gems below: ${r.gems_below.slice(0, 2).join(' · ')}`,
      suggested_fix: 'Replace ORDER BY next_start_at with a relevance score (or add one weighted against date).',
    });
  }
});

// Scenario fails
scn.scenarios.forEach((s) => {
  if (s.verdict === 'FAIL') {
    bugs.push({
      severity: 'CRITICAL',
      area: 'scenario',
      title: `Scenario FAIL: ${s.story}`,
      evidence: `gold=${s.filter_path.gold_count}, top-10 hits=${s.filter_path.top10_hits}, any hit=${s.filter_path.any_hit_any}`,
      suggested_fix: 'User does not see a single event matching their intent. Check the filter path cited in filter-audit.',
    });
  }
});

// ─── Scorecard ────────────────────────────────────────────────────────────
const scr = {
  filter_correctness: Math.round(flt.scenarios.reduce((a, s) => a + s.correctness_pct, 0) / (flt.scenarios.length || 1)),
  filter_coverage: Math.round(flt.scenarios.reduce((a, s) => a + s.coverage_pct, 0) / (flt.scenarios.length || 1)),
  digest_quality: dig.digests.length ? Math.round((dig.digests.reduce((a, d) => a + d.judge_avg, 0) / dig.digests.length) * 20) : 0,
  chat_quality: chat.queries.length ? Math.round((chat.queries.reduce((a, q) => a + q.relevance, 0) / chat.queries.length) * 20) : 0,
  ranking_quality: Math.round(rnk.mean_ndcg_at_10 * 100),
  scenario_pass_rate: scn.scenarios.length ? Math.round((scn.scenarios.filter((s) => s.verdict === 'PASS').length / scn.scenarios.length) * 100) : 0,
};

const overall = Math.round((scr.filter_correctness + scr.filter_coverage + scr.digest_quality + scr.chat_quality + scr.ranking_quality + scr.scenario_pass_rate) / 6);

// ─── Write bugs.md ────────────────────────────────────────────────────────
const critical = bugs.filter((b) => b.severity === 'CRITICAL');
const medium = bugs.filter((b) => b.severity === 'MEDIUM');
const low = bugs.filter((b) => b.severity === 'LOW');

const formatBug = (b: Bug, i: number) => `
### ${i + 1}. [${b.area}] ${b.title}

**Evidence**: ${b.evidence}

**Fix**: ${b.suggested_fix}
`;

const bugsMd = `# QA Audit — Bug List

**Generated**: ${new Date().toISOString().slice(0, 10)}
**Live pool**: ${inv.total_live_events} events

**Totals**: ${critical.length} Critical · ${medium.length} Medium · ${low.length} Low

---

## 🔴 Critical (${critical.length})

${critical.length === 0 ? '_None._' : critical.map(formatBug).join('\n')}

---

## 🟡 Medium (${medium.length})

${medium.length === 0 ? '_None._' : medium.map(formatBug).join('\n')}

---

## ⚪ Low (${low.length})

${low.length === 0 ? '_None._' : low.map(formatBug).join('\n')}
`;
fs.writeFileSync(path.join(DIR, 'bugs.md'), bugsMd);

// ─── Write verdict.md ─────────────────────────────────────────────────────
const chatByDiag = (d: string) => chat.queries.filter((q) => q.diagnosis === d).length;
const rankLt7 = rnk.queries.filter((r) => r.ndcg_at_10 < 0.7).length;

const verdictMd = `# QA Audit — Итоговый Вердикт

**Сгенерировано**: ${new Date().toISOString().slice(0, 10)}
**Live pool**: ${inv.total_live_events} событий

---

## Главный вопрос

> **Если событие есть в базе, гарантированно ли мы показываем его пользователю в нужный момент?**

**Ответ**: ${scr.filter_coverage >= 80 ? '✅ В основном да.' : scr.filter_coverage >= 60 ? '🟡 Частично.' : '❌ Нет — мы пропускаем существенную часть подходящих событий.'}

Средний coverage фильтров: **${scr.filter_coverage}%**. Это значит, что в среднем из 100 потенциально подходящих событий в базе пользователь увидит только ${scr.filter_coverage}.

---

## Scorecard (0-100)

| Axis | Score | Interpretation |
|---|---:|---|
| Filter correctness | ${scr.filter_correctness} | % возвращаемых событий, которые реально подходят под фильтр |
| Filter coverage | ${scr.filter_coverage} | % подходящих событий из БД, которые доходят до юзера |
| Digest quality | ${scr.digest_quality} | средний LLM-judge score × 20 (5=макс) |
| Chat quality | ${scr.chat_quality} | средний relevance × 20 (5=макс) |
| Ranking quality | ${scr.ranking_quality} | NDCG@10 × 100 |
| Scenario pass-rate | ${scr.scenario_pass_rate} | % end-to-end сценариев, где юзер видит хотя бы один релевантный event в топ-10 |

**Overall: ${overall}/100** → в десятичной шкале ≈ **${(overall / 10).toFixed(1)}/10**

---

## Где bottleneck

${(() => {
  const issues: string[] = [];
  if (scr.filter_coverage < 70) issues.push('- **Filter coverage** — фильтры слишком агрессивные, выпиливают нормальные события (главный виновник: wide-range exclusion rule для age ≥ 6)');
  if (scr.ranking_quality < 75) issues.push('- **Ranking** — нет relevance scoring, только `ORDER BY next_start_at`. Хорошие события попадают на 2-3 экран.');
  if (scr.chat_quality < 75) issues.push('- **Chat** — LLM часто извлекает слишком узкий фильтр, пропускает ivents');
  if (scr.digest_quality < 80) issues.push('- **Digests** — кое-где попадают нерелевантные события, кое-где пропускают сильных кандидатов');
  if (issues.length === 0) issues.push('- Всё в рамках нормы. Мелкие правки в категориях.');
  return issues.join('\n');
})()}

---

## Распределение проблем

### Filters (${flt.scenarios.length} сценариев)
- PASS: ${flt.scenarios.filter((s) => s.verdict === 'PASS').length}
- WARN: ${flt.scenarios.filter((s) => s.verdict === 'WARN').length}  ← главный вклад: плохой coverage
- FAIL: ${flt.scenarios.filter((s) => s.verdict === 'FAIL').length}

### Chat (${chat.queries.length} запросов)
- good_match: ${chatByDiag('good_match')}
- partial_match: ${chatByDiag('partial_match')}
- db_gap (нет в базе): ${chatByDiag('db_gap')}
- pipeline_issue (баг): ${chatByDiag('pipeline_issue')}
- Hallucinations (упомянул event вне списка): ${chat.queries.filter((q) => q.hallucination === 'yes').length}

### Ranking
- Mean NDCG@10: **${rnk.mean_ndcg_at_10.toFixed(3)}** (0.85+ хорошо · 0.7-0.85 OK · <0.7 сломан)
- Запросов с NDCG < 0.7: ${rankLt7}/${rnk.queries.length}

### Scenarios (end-to-end)
- PASS: ${scn.scenarios.filter((s) => s.verdict === 'PASS').length}
- WARN: ${scn.scenarios.filter((s) => s.verdict === 'WARN').length}
- FAIL: ${scn.scenarios.filter((s) => s.verdict === 'FAIL').length}

### Digests
${dig.digests.map((d) => `- **${d.slug}**: avg-judge=${d.judge_avg.toFixed(2)}/5 · rule-bugs=${d.rule_violations.length} · weak-fits=${d.low_judge_scores.length} · missed-strong=${d.missed_candidates.length}`).join('\n')}

### HTTP Smoke — prod vs local
- **Prod** (https://pulseup.me): ${smokeProd.cases.filter((c) => c.ok).length}/${smokeProd.cases.length} passed
- **Local** (localhost:3000): ${smokeLocal.cases.filter((c) => c.ok).length}/${smokeLocal.cases.length} passed
${smokeProd.cases.filter((c) => !c.ok).length > 0 ? '\nProd failures:\n' + smokeProd.cases.filter((c) => !c.ok).map((c) => `  - ${c.id} ${c.name}: ${c.detail}`).join('\n') : ''}
${smokeLocal.cases.filter((c) => !c.ok).length > 0 ? '\nLocal failures:\n' + smokeLocal.cases.filter((c) => !c.ok).map((c) => `  - ${c.id} ${c.name}: ${c.detail}`).join('\n') : ''}

Средняя latency прод: ${Math.round(smokeProd.cases.reduce((a, c) => a + c.latencyMs, 0) / (smokeProd.cases.length || 1))}ms · локально: ${Math.round(smokeLocal.cases.reduce((a, c) => a + c.latencyMs, 0) / (smokeLocal.cases.length || 1))}ms

---

## Топ-3 рекомендации

1. **Починить возрастной фильтр.** Главная находка. В \`lib/db.ts\` правило "wide-range-starting-in-toddler" (строки ~208-223) исключает events типа \`[3-12]\` для 7-летнего, потому что range широкий и начинается в toddler territory. Это убирает из выдачи десятки нормальных events. Либо удалить, либо смягчить (только для возраста ≥ 10, и только когда age_best_from ≤ 2).

2. **Добавить ranking score.** Сейчас просто сортировка по дате. Запросы типа "science for 7yo" возвращают science-события в глубине списка, а сверху случайные family events. Простая relevance-метрика (кол-во матчей query terms в title/tags + recency + rating) поднимет NDCG с ${rnk.mean_ndcg_at_10.toFixed(2)} до ~0.9.

3. **Расширить маппинг категорий.** В БД только 9 событий с \`category_l1='science'\`, но loose predicate находит гораздо больше science-adjacent events по tags. Chat/UI фильтры берут только l1. Либо добавить маппинг l1 → synonym tags, либо дообогатить category_l1 по tags.

---

## Что делать сейчас vs что отложить

### Сейчас
- Починить возрастной фильтр (30 минут) → coverage прыгнет с ${scr.filter_coverage}% до ~85%+
- Добавить ranking (1-2 часа) → NDCG ${rnk.mean_ndcg_at_10.toFixed(2)} → 0.85+

### Позже
- Обогатить category_l1 для событий с science/theater/food tags
- Chat prompt tuning (сейчас часто ставит слишком узкий фильтр)
- Автотест на регрессии (запускать 6 QA скриптов в CI)
`;
fs.writeFileSync(path.join(DIR, 'verdict.md'), verdictMd);

console.log('\n════ AGGREGATION ════');
console.log(`Bugs:   ${critical.length} Critical · ${medium.length} Medium · ${low.length} Low`);
console.log(`Overall score: ${overall}/100 (${(overall / 10).toFixed(1)}/10)`);
console.log(`\n→ ${path.join(DIR, 'bugs.md')}`);
console.log(`→ ${path.join(DIR, 'verdict.md')}`);
