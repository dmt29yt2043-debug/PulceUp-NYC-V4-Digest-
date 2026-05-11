/**
 * Friendly age-range formatting.
 *
 * The `age_label` column in our DB comes from the source data and often reads
 * "Ages 0-99", "Ages 3-100", "Ages 5-120" — technically correct for "no upper
 * bound" but ugly on a card. Kids' events genuinely top out around 17-20, so
 * anything higher is effectively "unlimited" and should collapse to "N+".
 *
 * Threshold of 25 keeps real teen workshops ("Ages 13-18") untouched while
 * catching the "no-bound" noise. Tweak here if we see mis-categorised events.
 */

const UNBOUNDED_MAX = 25;

const RANGE_RE = /^\s*Ages?\s+(\d+)\s*[-\u2013\u2014]\s*(\d+)\s*$/i;

export function formatAgeLabel(raw: string | null | undefined): string {
  const label = (raw ?? '').trim();
  if (!label) return '';
  const m = label.match(RANGE_RE);
  if (!m) return label; // unrecognised shape — show it as-is
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return label;
  if (hi >= UNBOUNDED_MAX) return `Ages ${lo}+`;
  return label;
}
