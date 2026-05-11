/**
 * CI orchestrator — runs the right suite based on depth and enforces thresholds.
 *
 * Usage:
 *   npx tsx scripts/qa/ci.ts quick    # fast, no-LLM suite (PR checks, ~20s)
 *   npx tsx scripts/qa/ci.ts full     # full suite (nightly, ~5 min, uses OpenAI)
 *   npx tsx scripts/qa/ci.ts smoke    # prod/local HTTP smoke only (~5s)
 *
 * Exit codes:
 *   0  — all thresholds met
 *   1  — one or more regressions detected (see console output)
 *   2  — infrastructure / setup error (missing report, crashed sub-script)
 *
 * Design notes:
 *   · Thresholds are intentionally LOOSER than the current measured numbers so
 *     we don't fail CI on normal LLM variance. Tighten them when the pipeline
 *     has shown stability for a while.
 *   · `quick` runs only the deterministic (zero-LLM) checks, so it's cheap
 *     enough to run on every PR.
 *   · `full` includes LLM-scored checks and is meant for a nightly job or a
 *     pre-release gate — expect it to cost ~$0.05–$0.15 per run.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

type Severity = 'fail' | 'warn';
interface Check { name: string; passed: boolean; detail: string; severity: Severity; }

const REPORTS_DIR = path.join(process.cwd(), 'reports', 'qa');

function run(file: string): boolean {
  console.log(`\n══ ▶ ${file} ══════════════════════════════════════════════════════`);
  const r = spawnSync('npx', ['tsx', `scripts/qa/${file}`], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`✗ ${file} exited with status ${r.status}`);
    return false;
  }
  return true;
}

function readJson<T>(filename: string): T | null {
  const full = path.join(REPORTS_DIR, filename);
  if (!fs.existsSync(full)) return null;
  try { return JSON.parse(fs.readFileSync(full, 'utf8')) as T; }
  catch (e) { console.error(`✗ Failed to parse ${filename}:`, (e as Error).message); return null; }
}

// ─── Threshold checks ───────────────────────────────────────────────────────

function checkFilterAudit(): Check {
  interface FilterReport { scenarios: Array<{ verdict: 'PASS' | 'WARN' | 'FAIL'; correctness_pct: number; name?: string }> }
  const report = readJson<FilterReport>('02-filter-audit.json');
  if (!report?.scenarios) return { name: 'filter-audit', passed: false, detail: 'missing report', severity: 'fail' };
  const fails = report.scenarios.filter(r => r.verdict === 'FAIL');
  const minCorrect = Math.min(...report.scenarios.map(r => r.correctness_pct));
  // Hard rule: NO scenarios may fail (returning wrong-type events is a bug).
  // Soft rule: correctness floor 85 — warn if any scenario dips lower.
  if (fails.length > 0) return { name: 'filter-audit', passed: false, detail: `${fails.length} scenarios FAIL: ${fails.slice(0, 3).map(f => f.name).join(', ')}`, severity: 'fail' };
  if (minCorrect < 85) return { name: 'filter-audit', passed: false, detail: `min correctness ${minCorrect}% < 85%`, severity: 'warn' };
  return { name: 'filter-audit', passed: true, detail: `${report.scenarios.length} scenarios, all correctness ≥ 85%`, severity: 'warn' };
}

function checkHttpSmoke(prodOrLocal: 'prod' | 'local'): Check {
  interface SmokeReport { cases: Array<{ ok: boolean; name: string; detail: string }> }
  const report = readJson<SmokeReport>(`07-http-smoke-${prodOrLocal}.json`);
  if (!report?.cases) return { name: `http-smoke-${prodOrLocal}`, passed: false, detail: 'missing report', severity: 'fail' };
  const failed = report.cases.filter(c => !c.ok);
  if (failed.length > 0) return { name: `http-smoke-${prodOrLocal}`, passed: false, detail: `${failed.length} endpoints failed: ${failed.slice(0, 3).map(f => f.name).join(', ')}`, severity: 'fail' };
  return { name: `http-smoke-${prodOrLocal}`, passed: true, detail: `${report.cases.length}/${report.cases.length} endpoints healthy`, severity: 'fail' };
}

function checkChatAudit(): Check {
  interface ChatReport { queries: Array<{ hallucination: string; diagnosis: string; relevance: number }> }
  const report = readJson<ChatReport>('04-chat-audit.json');
  if (!report?.queries) return { name: 'chat-audit', passed: false, detail: 'missing report', severity: 'fail' };
  const halluc = report.queries.filter(q => q.hallucination === 'yes').length;
  const avgRel = report.queries.reduce((a, q) => a + (q.relevance || 0), 0) / report.queries.length;
  // Thresholds (loose — tighten as pipeline stabilises):
  //   hallucinations: ≤ 3/20 (15%)
  //   avg relevance: ≥ 3.2/5
  if (halluc > 3) return { name: 'chat-audit', passed: false, detail: `${halluc}/${report.queries.length} hallucinations (threshold ≤ 3)`, severity: 'fail' };
  if (avgRel < 3.2) return { name: 'chat-audit', passed: false, detail: `avg relevance ${avgRel.toFixed(2)} < 3.2`, severity: 'warn' };
  return { name: 'chat-audit', passed: true, detail: `${halluc} hallucinations, avg rel ${avgRel.toFixed(2)}`, severity: 'fail' };
}

function checkRankingAudit(): Check {
  interface RankReport { mean_ndcg_at_10: number; queries: Array<{ ndcg_at_10: number }> }
  const report = readJson<RankReport>('05-ranking-audit.json');
  if (!report?.queries) return { name: 'ranking-audit', passed: false, detail: 'missing report', severity: 'fail' };
  const mean = report.mean_ndcg_at_10 ?? (report.queries.reduce((a, q) => a + q.ndcg_at_10, 0) / report.queries.length);
  // Threshold: mean NDCG@10 ≥ 0.65 (below this, ordering is noticeably broken).
  if (mean < 0.65) return { name: 'ranking-audit', passed: false, detail: `mean NDCG@10 ${mean.toFixed(3)} < 0.65`, severity: 'warn' };
  return { name: 'ranking-audit', passed: true, detail: `mean NDCG@10 ${mean.toFixed(3)}`, severity: 'warn' };
}

function checkScenarios(): Check {
  interface ScenarioReport { scenarios: Array<{ verdict: 'PASS' | 'WARN' | 'FAIL' }> }
  const report = readJson<ScenarioReport>('06-scenarios.json');
  if (!report?.scenarios) return { name: 'scenarios', passed: false, detail: 'missing report', severity: 'fail' };
  const fails = report.scenarios.filter(r => r.verdict === 'FAIL').length;
  if (fails > 2) return { name: 'scenarios', passed: false, detail: `${fails} end-to-end scenarios failed (threshold ≤ 2)`, severity: 'warn' };
  return { name: 'scenarios', passed: true, detail: `${fails}/${report.scenarios.length} scenarios failed (≤ 2 allowed)`, severity: 'warn' };
}

function checkDbInventory(): Check {
  interface DbReport { total_live_events: number; }
  const report = readJson<DbReport>('01-db-inventory.json');
  if (!report) return { name: 'db-inventory', passed: false, detail: 'missing report', severity: 'fail' };
  const total = report.total_live_events ?? 0;
  if (total < 50) return { name: 'db-inventory', passed: false, detail: `only ${total} live events — DB is empty or broken`, severity: 'fail' };
  return { name: 'db-inventory', passed: true, detail: `${total} live events`, severity: 'fail' };
}

// Browser-smoke check — gates on any scenario failing. Catches frontend-only
// bugs (Invalid Date, .map crashes, /results redirect dropping params).
function checkBrowserSmoke(): Check {
  interface BrowserReport { cases: Array<{ ok: boolean; name: string; detail: string }> }
  const report = readJson<BrowserReport>('10-browser-smoke.json');
  if (!report?.cases) return { name: 'browser-smoke', passed: false, detail: 'missing report (puppeteer crashed?)', severity: 'fail' };
  const failed = report.cases.filter((c) => !c.ok);
  if (failed.length > 0) return { name: 'browser-smoke', passed: false, detail: `${failed.length} failed: ${failed.slice(0, 2).map((f) => `${f.name} — ${f.detail.slice(0, 60)}`).join(' | ')}`, severity: 'fail' };
  return { name: 'browser-smoke', passed: true, detail: `${report.cases.length}/${report.cases.length} scenarios green`, severity: 'fail' };
}

// ─── Suite runners ──────────────────────────────────────────────────────────

function runSchemaCheck(): Check {
  // schema-check.ts exits 1 (hard fail) or 2 (soft warn) — map both to Check.
  console.log(`\n══ ▶ schema-check.ts ══════════════════════════════════════════════`);
  const r = spawnSync('npx', ['tsx', 'scripts/qa/schema-check.ts'], { stdio: 'inherit' });
  if (r.status === 0) return { name: 'schema-check', passed: true, detail: 'all required columns present', severity: 'fail' };
  if (r.status === 2) return { name: 'schema-check', passed: true, detail: 'all REQUIRED columns present (some recommended missing)', severity: 'fail' };
  return { name: 'schema-check', passed: false, detail: 'required columns missing — see output above', severity: 'fail' };
}

function runQuick(): Check[] {
  // schema-check first so we fail fast if a required column is gone.
  const schemaResult = runSchemaCheck();
  if (!schemaResult.passed) return [schemaResult]; // stop early — further checks will crash on missing cols

  // Browser-smoke is in `quick` because the bugs it catches (Invalid Date,
  // .map crashes, /results param-drop) take real users seconds to discover.
  // ~30 s overhead is acceptable.
  const scripts = ['01-db-inventory.ts', '02-filter-audit.ts', '07-http-smoke.ts', '10-browser-smoke.ts'];
  for (const s of scripts) run(s);
  return [
    schemaResult,
    checkDbInventory(),
    checkFilterAudit(),
    checkHttpSmoke('prod'),
    checkBrowserSmoke(),
  ];
}

function runSmoke(): Check[] {
  run('07-http-smoke.ts');
  run('10-browser-smoke.ts');
  return [checkHttpSmoke('prod'), checkBrowserSmoke()];
}

function runFull(): Check[] {
  const schemaResult = runSchemaCheck();
  if (!schemaResult.passed) return [schemaResult];

  const scripts = [
    '01-db-inventory.ts',
    '02-filter-audit.ts',
    '03-digest-audit.ts',
    '04-chat-audit.ts',
    '05-ranking-audit.ts',
    '06-scenarios.ts',
    '07-http-smoke.ts',
    '10-browser-smoke.ts',
  ];
  for (const s of scripts) run(s);
  return [
    schemaResult,
    checkDbInventory(),
    checkFilterAudit(),
    checkHttpSmoke('prod'),
    checkBrowserSmoke(),
    checkChatAudit(),
    checkRankingAudit(),
    checkScenarios(),
  ];
}

// ─── Entry point ────────────────────────────────────────────────────────────

async function main() {
  const mode = (process.argv[2] || 'quick').toLowerCase();
  if (!['quick', 'full', 'smoke'].includes(mode)) {
    console.error(`Unknown mode: ${mode}. Use "quick", "full", or "smoke".`);
    process.exit(2);
  }

  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  QA CI runner — mode: ${mode.padEnd(38)}║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);

  let checks: Check[];
  try {
    if (mode === 'quick') checks = runQuick();
    else if (mode === 'smoke') checks = runSmoke();
    else checks = runFull();
  } catch (e) {
    console.error(`\n✗ Suite crashed: ${(e as Error).message}`);
    process.exit(2);
  }

  // ─── Summary ────────────────────────────────────────────────────────────
  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  Threshold summary                                         ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);

  const hardFails = checks.filter(c => !c.passed && c.severity === 'fail');
  const warns    = checks.filter(c => !c.passed && c.severity === 'warn');

  for (const c of checks) {
    const icon = c.passed ? '✓' : (c.severity === 'fail' ? '✗' : '!');
    const label = c.passed ? 'PASS' : (c.severity === 'fail' ? 'FAIL' : 'WARN');
    console.log(`  ${icon} ${label.padEnd(4)}  ${c.name.padEnd(22)} ${c.detail}`);
  }

  console.log('');
  if (hardFails.length > 0) {
    console.log(`✗ ${hardFails.length} hard failure(s). Blocking CI.`);
    process.exit(1);
  }
  if (warns.length > 0) {
    console.log(`! ${warns.length} soft warning(s). Not blocking CI — investigate when possible.`);
  } else {
    console.log(`✓ All thresholds met.`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(2); });
