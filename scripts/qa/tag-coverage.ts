/**
 * Tag-coverage audit — finds tags in the DB that don't match any of our
 * CAT_DEFS tokens. When the DB grows, the LLM-generated tag vocabulary
 * drifts. New theater/science/arts events will appear with tags we've
 * never seen, and our category filter will silently miss them — exactly
 * the "Theater 6% coverage" bug we fixed once.
 *
 * This script surfaces the drift early:
 *   · Loads every distinct tag from live events.
 *   · Checks each tag against CAT_DEFS token patterns (same logic as
 *     the SQL filter — substring / prefix / suffix / exact).
 *   · Reports the top N unmatched tags so you can add them to CAT_DEFS.
 *
 * Usage:
 *   npx tsx scripts/qa/tag-coverage.ts
 *   npx tsx scripts/qa/tag-coverage.ts --limit 50    # more tags
 *   npx tsx scripts/qa/tag-coverage.ts --min-count 3 # only tags seen ≥ 3x
 *
 * Exit code is always 0 — this is an advisory tool, not a gate.
 */

import Database from 'better-sqlite3';
import path from 'path';

// Mirror of CAT_DEFS in lib/db.ts. Keep in sync manually — we'd rather duplicate
// the list once here than import across the build boundary and add coupling.
// If lib/db.ts changes CAT_DEFS, this file must too.
const CAT_DEFS: Record<string, string[]> = {
  arts: ['Art', 'arts', 'art-', '-art', 'visual-arts', 'kids-art', 'artmaking',
         'craft', 'crafts', 'drawing', 'painting', 'ceramics', 'pottery',
         'sculpture', 'collage', 'printmaking', 'illustration', 'creative-'],
  family: ['family', 'family-friendly', "Children's Activities", 'Kids Activities'],
  nature: ['nature', 'park', 'garden', 'hiking', 'wildlife', 'outdoor',
           'ecology', 'environment', 'earth-day', 'nature-'],
  science: ['science', 'Science', 'STEAM', 'STEM', 'stem-', 'steam-',
            'engineering', 'technology', 'coding', 'robotics', 'astronomy',
            'chemistry', 'physics', 'biology'],
  food: ['food', 'cooking', 'culinary', 'Dining', 'baking', 'chef', 'food-'],
  outdoors: ['outdoor', 'nature', 'park', 'hiking', 'outdoor-', 'garden',
             'playground', 'trail', 'camping'],
  education: ['education', 'Educational', 'learning', 'workshop', 'tutorial'],
  music: ['music', 'Music', 'concert', 'musical', 'singing', 'song', 'band',
          'orchestra', 'choir', 'jazz', 'drum', 'guitar', 'piano', 'violin'],
  film: ['film', 'movie', 'cinema', 'Film', 'screening', 'documentary'],
  community: ['community', 'volunteer', 'Community', 'neighborhood'],
  gaming: ['gaming', 'games', 'Gaming', 'video-game', 'board-game', 'esports'],
  sports: ['sports', 'Sports', 'fitness', 'Basketball', 'Soccer', 'swimming',
           'gymnastics', 'martial-arts', 'karate', 'tennis', 'baseball',
           'football', 'volleyball', 'running', 'cycling', 'yoga'],
  theater: ['theater', 'Theatre', 'Theater', 'Performing Arts', 'Broadway',
            'musical', 'dance', 'ballet', 'circus', 'puppet', 'puppetry',
            'improv', 'comedy', 'play-', 'performing-'],
  attractions: ['Attractions', 'museum', 'exhibit', 'exhibition', 'gallery',
                'zoo', 'aquarium', 'planetarium', 'botanical'],
  books: ['books', 'Literary', 'reading', 'library', 'storytime', 'story-time',
          'poetry', 'writing', 'author', 'book-', 'literature'],
  holiday: ['holiday', 'Holiday', 'seasonal', 'festival', 'celebration',
            'Halloween', 'Christmas', 'Hanukkah', 'Easter', 'Thanksgiving'],
};

// Replicates the SQL LIKE matching in buildCatMatch.
// tok is compared against a JSON-array entry (e.g. `"teen-workshop"`).
function tagMatches(tagLower: string, tokLower: string): boolean {
  if (tokLower.endsWith('-')) {
    // "art-" matches "art-workshop" and "art-class" but not "street-art"
    return tagLower.startsWith(tokLower);
  }
  if (tokLower.startsWith('-')) {
    // "-art" matches "pixel-art" but not "art-workshop"
    return tagLower.endsWith(tokLower);
  }
  // Exact match — the JSON entry is exactly this token.
  return tagLower === tokLower;
}

function categoryForTag(tag: string): string | null {
  const tagLower = tag.toLowerCase();
  for (const [cat, tokens] of Object.entries(CAT_DEFS)) {
    for (const tok of tokens) {
      if (tagMatches(tagLower, tok.toLowerCase())) return cat;
    }
  }
  return null;
}

async function main() {
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const minCountArg = process.argv.find(a => a.startsWith('--min-count='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 30;
  const minCount = minCountArg ? parseInt(minCountArg.split('=')[1], 10) : 2;

  const db = new Database(path.join(process.cwd(), 'data', 'events.db'), { readonly: true });
  const rows = db
    .prepare("SELECT tags FROM events WHERE tags IS NOT NULL AND (status IN ('published','done','new') OR status LIKE '%.done')")
    .all() as { tags: string | null }[];

  const tagCount = new Map<string, number>();
  for (const r of rows) {
    if (!r.tags) continue;
    try {
      const arr = JSON.parse(r.tags);
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        if (typeof t !== 'string') continue;
        tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
      }
    } catch { /* ignore bad JSON — they're already a known data-quality issue */ }
  }

  const totalTags = tagCount.size;

  // Split into matched / unmatched
  const unmatched: { tag: string; count: number }[] = [];
  let matchedCount = 0;
  for (const [tag, count] of tagCount.entries()) {
    if (categoryForTag(tag) !== null) matchedCount++;
    else unmatched.push({ tag, count });
  }
  unmatched.sort((a, b) => b.count - a.count);

  // Filter by min count for practical signal (1-off tags are usually noise).
  const signal = unmatched.filter(u => u.count >= minCount);

  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  Tag-coverage audit                                        ║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);
  console.log(`Total distinct tags:        ${totalTags}`);
  console.log(`Matched to some CAT_DEFS:   ${matchedCount} (${Math.round(100 * matchedCount / totalTags)}%)`);
  console.log(`Unmatched:                  ${unmatched.length}`);
  console.log(`Unmatched with count ≥ ${minCount}:   ${signal.length}`);

  console.log(`\nTop ${Math.min(limit, signal.length)} unmatched tags (count ≥ ${minCount}):`);
  console.log(`Pick ones that represent a known category and add them to CAT_DEFS.`);
  console.log(`─`.repeat(60));
  signal.slice(0, limit).forEach(({ tag, count }) => {
    // Heuristic hint: guess the most likely category by substring match.
    const hint = guessCategory(tag);
    console.log(`  ${String(count).padStart(3)}  ${tag.padEnd(40)} ${hint ? '→ ' + hint : ''}`);
  });

  // Suggest specific tokens that would cover many of the unmatched entries.
  console.log(`\nHigh-leverage additions (tokens that would cover ≥ 3 events each):`);
  console.log(`─`.repeat(60));
  const substringGain = new Map<string, number>();
  for (const { tag, count } of signal) {
    // Build candidate substrings: whole words separated by hyphens
    const parts = tag.toLowerCase().split(/[-_\s]+/).filter(p => p.length >= 4);
    for (const p of parts) {
      substringGain.set(p, (substringGain.get(p) ?? 0) + count);
    }
  }
  const suggestions = [...substringGain.entries()]
    .filter(([s, total]) => total >= 3 && !isAlreadyInDefs(s))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  for (const [s, total] of suggestions) {
    console.log(`  +${String(total).padStart(3)} events if you add "${s}-" to some category`);
  }

  db.close();
  console.log('');
}

/** Rough category guess based on keyword substring. Used for hints only. */
function guessCategory(tag: string): string | null {
  const t = tag.toLowerCase();
  if (/dance|ballet|theater|theatre|puppet|circus|broadway|musical|performance|show|improv/.test(t)) return 'theater?';
  if (/music|song|sing|concert|band|orchestra|jazz|drum|piano|guitar/.test(t)) return 'music?';
  if (/art|paint|draw|craft|ceramic|pottery|sculpt|collage|illustrat|creative/.test(t)) return 'arts?';
  if (/science|stem|steam|coding|robot|engineer|chemistry|physics|biology|tech/.test(t)) return 'science?';
  if (/sport|fitness|soccer|basketball|swim|gym|karate|tennis|baseball|yoga|running/.test(t)) return 'sports?';
  if (/food|cook|bak|culinary|chef|dining/.test(t)) return 'food?';
  if (/book|story|poetry|literary|literac|reading|library|author|writing/.test(t)) return 'books?';
  if (/museum|exhibit|gallery|zoo|aquarium/.test(t)) return 'attractions?';
  if (/nature|park|garden|outdoor|hiking|ecolog|environment/.test(t)) return 'nature/outdoors?';
  if (/holiday|festival|halloween|christmas|easter|seasonal/.test(t)) return 'holiday?';
  if (/film|movie|cinema|screening|documentary/.test(t)) return 'film?';
  if (/game|gaming|esports/.test(t)) return 'gaming?';
  return null;
}

function isAlreadyInDefs(substring: string): boolean {
  for (const tokens of Object.values(CAT_DEFS)) {
    for (const tok of tokens) {
      if (tok.toLowerCase().includes(substring)) return true;
    }
  }
  return false;
}

main();
