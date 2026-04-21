/**
 * Audit script for the digest signal layer.
 *
 * Run: `npx tsx scripts/digests-audit.ts [signals|<digest-slug>]`
 *
 * Without args: prints signal distribution over all live events.
 * With `signals`: same as no-args.
 * With a digest slug: runs that digest and prints top 20 results with reasons.
 *
 * This script is read-only — it never writes to the DB.
 */

import Database from 'better-sqlite3';
import path from 'path';
import type { EventRow } from '../lib/digests/types';
import { LIVE_STATUS_FILTER } from '../lib/digests/constants';
import { enrich } from '../lib/digests/event-parser';
import {
  classifyNYC, classifyManhattan, classifyIndoor, classifyOutdoor,
  classifyFamily, classifyEasy, classifyAffordable, classifyWeekend,
  classifyQuality, classifyCompleteness,
} from '../lib/digests/signals';

const DB = path.join(__dirname, '..', 'data', 'events.db');

function loadLiveEvents(): EventRow[] {
  const db = new Database(DB, { readonly: true });
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE ${LIVE_STATUS_FILTER}
      AND disabled = 0 AND archived = 0
  `).all() as EventRow[];
  db.close();
  return rows;
}

function bucket(v: number): string {
  if (v >= 0.8) return '0.8–1.0 (strong)';
  if (v >= 0.5) return '0.5–0.8 (medium)';
  if (v >  0)   return '0.0–0.5 (weak)';
  return '0';
}

function histogram(label: string, values: number[]): void {
  const buckets: Record<string, number> = {
    '0.8–1.0 (strong)': 0,
    '0.5–0.8 (medium)': 0,
    '0.0–0.5 (weak)': 0,
    '0': 0,
  };
  for (const v of values) buckets[bucket(v)]++;
  console.log(`\n=== ${label} ===`);
  for (const [k, n] of Object.entries(buckets)) {
    const pct = Math.round(n / values.length * 100);
    console.log(`  ${k.padEnd(20)} ${String(n).padStart(4)} (${String(pct).padStart(3)}%)`);
  }
}

function auditSignals(): void {
  const rows = loadLiveEvents();
  console.log(`Live events: ${rows.length}\n`);
  const enriched = rows.map(enrich);

  const now = Date.now();

  const nyc       = enriched.map((e) => classifyNYC(e).confidence);
  const manhattan = enriched.map((e) => classifyManhattan(e).confidence);
  const indoor    = enriched.map((e) => classifyIndoor(e).confidence);
  const outdoor   = enriched.map((e) => classifyOutdoor(e).confidence);
  const family    = enriched.map((e) => classifyFamily(e).confidence);
  const easy      = enriched.map((e) => classifyEasy(e).confidence);
  const afford    = enriched.map((e) => classifyAffordable(e).confidence);
  const weekend   = enriched.map((e) => classifyWeekend(e, now, 14).confidence);
  const weekend28 = enriched.map((e) => classifyWeekend(e, now, 28).confidence);
  const quality   = enriched.map((e) => classifyQuality(e).confidence);
  const complete  = enriched.map((e) => classifyCompleteness(e).confidence);

  histogram('NYC',              nyc);
  histogram('Manhattan',        manhattan);
  histogram('Indoor',           indoor);
  histogram('Outdoor',          outdoor);
  histogram('Family',           family);
  histogram('Easy',             easy);
  histogram('Affordable',       afford);
  histogram('Weekend (14d)',    weekend);
  histogram('Weekend (28d)',    weekend28);
  histogram('Quality',          quality);
  histogram('Completeness',     complete);

  // Cross-signals for digest planning:
  const strongNyc = enriched.filter((e) => classifyNYC(e).confidence >= 0.5).length;
  const strongFamily = enriched.filter((e) => classifyFamily(e).confidence >= 0.5).length;
  const indoorOverlap = enriched.filter((e) =>
    classifyNYC(e).confidence >= 0.3 && classifyIndoor(e).confidence >= 0.5
  ).length;
  const weekendOverlap = enriched.filter((e) =>
    classifyWeekend(e, now, 14).confidence > 0 && classifyNYC(e).confidence >= 0.3
  ).length;
  const affordableOverlap = enriched.filter((e) =>
    classifyAffordable(e).confidence >= 0.5
  ).length;

  console.log('\n=== Cross-signal pools (rough digest candidates) ===');
  console.log(`  NYC (strong ≥0.5):                      ${strongNyc}`);
  console.log(`  Family (strong ≥0.5):                   ${strongFamily}`);
  console.log(`  NYC + Indoor:                            ${indoorOverlap}`);
  console.log(`  NYC + upcoming weekend:                  ${weekendOverlap}`);
  console.log(`  Affordable (≥0.5):                       ${affordableOverlap}`);
}

// ─── Digest runners ──────────────────────────────────────────────────────────

import { getWeekendDigest } from '../lib/digests/weekend';
import { getIndoorDigest } from '../lib/digests/indoor';
import { getEasyDigest } from '../lib/digests/easy';
import { getAffordableDigest } from '../lib/digests/affordable';
import { getWorthItDigest } from '../lib/digests/worth-it';
import type { DigestResult } from '../lib/digests/types';

function printDigest(result: DigestResult, limit = 10): void {
  const m = result.meta;
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${m.title}`);
  console.log(`  ${m.subtitle}`);
  console.log('═'.repeat(80));
  console.log(`  events=${m.event_count}  strong=${result.coverage.strong_candidates}  weak=${result.coverage.weak_candidates}  skipped=${result.coverage.skipped_low_quality}`);
  if (result.coverage.notes.length) {
    for (const n of result.coverage.notes) console.log(`  NOTE: ${n}`);
  }
  console.log('');
  result.scored.slice(0, limit).forEach((s, i) => {
    const pad = String(i + 1).padStart(2);
    const score = String(s.score).padStart(3);
    const title = (s.event.title || '').slice(0, 48).padEnd(50);
    const city = (s.event.city || '?').slice(0, 12).padEnd(12);
    // Prefer digest-specific reasons (everything after the 3 base reasons) for display
    const digestReasons = s.reasons.slice(3);
    const shown = digestReasons.length > 0 ? digestReasons : s.reasons;
    console.log(`  ${pad}. [${score}] ${title} ${city} ${shown.slice(0, 3).join(' · ')}`);
  });
}

function auditAllDigests(): void {
  const rows = loadLiveEvents();
  console.log(`Live events: ${rows.length}`);
  const enriched = rows.map(enrich);
  const now = Date.now();

  printDigest(getWeekendDigest(enriched, now));
  printDigest(getIndoorDigest(enriched));
  printDigest(getEasyDigest(enriched));
  printDigest(getAffordableDigest(enriched), 15);
  printDigest(getWorthItDigest(enriched));
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const cmd = process.argv[2] || 'signals';
if (cmd === 'signals') {
  auditSignals();
} else if (cmd === 'digests' || cmd === 'all') {
  auditAllDigests();
} else {
  console.log(`Unknown command: ${cmd}`);
  console.log('Usage: npx tsx scripts/digests-audit.ts [signals|digests]');
  process.exit(1);
}
