/**
 * Orchestrator — runs all 6 audit scripts in sequence.
 *
 *   npx tsx scripts/qa/run-all.ts
 *
 * Each sub-script writes its own JSON in reports/qa/. The aggregation
 * into bugs.md / verdict.md happens in scripts/qa/99-aggregate.ts
 * (run separately after this).
 */

import { spawnSync } from 'child_process';

const STEPS = [
  ['01-db-inventory.ts',   'DB inventory (0 LLM)'],
  ['02-filter-audit.ts',   'Filter correctness + coverage (0 LLM)'],
  ['03-digest-audit.ts',   'Digest semantic + missed (≈100 LLM)'],
  ['04-chat-audit.ts',     'Chat prod queries (≈20 chat + 20 judge)'],
  ['05-ranking-audit.ts',  'NDCG@10 (10 LLM)'],
  ['06-scenarios.ts',      'End-to-end scenarios (0-20 chat)'],
];

for (const [file, desc] of STEPS) {
  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`  ▶ ${file} — ${desc}`);
  console.log(`════════════════════════════════════════════════════════════════`);
  const r = spawnSync('npx', ['tsx', `scripts/qa/${file}`], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n✗ ${file} failed with status ${r.status}. Continuing to next step.`);
  }
}

console.log('\n════ All steps finished. Reports in reports/qa/*.json ════');
