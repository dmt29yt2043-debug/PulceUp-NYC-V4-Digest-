import OpenAI from 'openai';
import { getEvents, getCategories } from '@/lib/db';
import type { FilterState, ChatMessage, UserProfile, Event } from '@/lib/types';
import { rateLimit, getClientKey } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30000,
});

/**
 * Compute date anchors ("today", "tomorrow", "this weekend", …) that the
 * filter-extraction prompt needs. Shared between both LLM calls.
 */
function computeDateAnchors() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
  const dow = now.getDay(); // 0=Sun, 1=Mon, …, 6=Sat
  const mk = (offset: number) => { const d = new Date(now); d.setDate(d.getDate() + offset); return d.toISOString().split('T')[0]; };

  // "This weekend" — handle the awkward edge cases when today already IS a
  // weekend day. Without this, on a Saturday the old code computed
  // satOffset=7 (next week!) and sunOffset=1 (tomorrow), inverting the range.
  // On a Sunday it shipped Friday→Saturday because the LLM downstream
  // interpreted the strange dates as best it could.
  let saturday: string, sunday: string;
  if (dow === 6) {           // Saturday today
    saturday = today;
    sunday = mk(1);
  } else if (dow === 0) {    // Sunday today — Sat already passed, "this weekend" = today
    saturday = today;
    sunday = today;
  } else {                    // Mon–Fri
    saturday = mk(6 - dow);
    sunday = mk(7 - dow);
  }

  // "This week" — today through the upcoming Saturday (inclusive).
  // On Mon–Fri this gives the rest of the work week + the weekend; on Sun
  // it gives the next 6 days (Sun→Sat); on Sat it just gives today.
  // The previous "today only on Sunday" definition was too narrow and
  // collapsed Brooklyn-this-week to 0 events on Sundays.
  const daysUntilSat = (6 - dow + 7) % 7; // Sun→6, Mon→5, …, Sat→0
  const thisWeekSunday = mk(daysUntilSat); // var name kept for prompt continuity

  // "Next week" starts the Monday AFTER the upcoming Saturday/Sunday block.
  const nextMondayOffset = daysUntilSat + 2; // Sat→Mon = +2; Sun-of-this-week→Mon = +1, but +2 from Sat is fine

  return {
    today, dayOfWeek, year: now.getFullYear(),
    tomorrow,
    saturday,
    sunday,
    thisWeekSunday,
    nextMonday: mk(nextMondayOffset),
  };
}

function buildProfileBlock(profile?: UserProfile): string {
  if (!profile || !('children' in profile) || !Array.isArray(profile.children)) return '';
  const kids = profile.children.map((c) => {
    const g = c.gender === 'girl' ? 'daughter' : c.gender === 'boy' ? 'son' : 'child';
    const interests = c.interests?.length ? ` (${c.interests.join(', ')})` : '';
    return `${g} ${c.age}yo${interests}`;
  }).join(', ');
  return `User has: ${kids}. Personalize recommendations.`;
}

/**
 * STEP 1 — Filter extraction prompt.
 *
 * Small, focused prompt whose only job is to return a JSON filters object.
 * No event list is shown here — we can't generate a message yet because we
 * don't know which events will be returned for these filters. (That was the
 * old single-call design that caused 60% hallucination rate.)
 */
function buildFilterExtractionPrompt(profile?: UserProfile): string {
  const d = computeDateAnchors();
  const profileBlock = buildProfileBlock(profile);

  let categoryList: string;
  try {
    categoryList = getCategories().map((c) => c.value).join(', ');
  } catch {
    categoryList = 'family, arts, theater, attractions, books, holiday, sports, music, science, film, gaming, community';
  }

  return `You extract structured search filters for an NYC family-events app. Return ONLY a JSON object: {"filters": {...}}.

TODAY: ${d.today} (${d.dayOfWeek}), year ${d.year}.
DATES: "tomorrow"=${d.tomorrow}. "this weekend"=dateFrom:"${d.saturday}",dateTo:"${d.sunday}". "this week"=dateFrom:"${d.today}",dateTo:"${d.thisWeekSunday}". "next week" starts ${d.nextMonday}. WEEKEND=Sat+Sun ONLY.
${profileBlock ? '\n' + profileBlock + '\n' : ''}

━━━ EXTRACTION RULES ━━━
• Extract EVERY filter the user explicitly or implicitly mentions. Missing a clear filter is worse than including it.
• Each message is a FRESH independent search — don't carry over from previous turns.

LOCATION (always extract when mentioned):
• "in Brooklyn" / "Brooklyn" → neighborhoods:["Brooklyn"]
• "Manhattan" / "in Manhattan" → neighborhoods:["Upper Manhattan","Midtown","Lower Manhattan"]
• "Midtown" / "Midtown Manhattan" / "near Midtown" → neighborhoods:["Midtown"]
• "Upper Manhattan" / "Uptown" → neighborhoods:["Upper Manhattan"]
• "Lower Manhattan" / "Downtown" → neighborhoods:["Lower Manhattan"]
• "Queens" → neighborhoods:["Queens"]; "Bronx"/"the Bronx" → neighborhoods:["Bronx"]
• "Staten Island" → neighborhoods:["Staten Island"]
• "near me" / "close by" = NO location filter (we don't have user location)

DATE — STRICT, no inference:
• ONLY extract dateFrom/dateTo if the user EXPLICITLY uses a time word.
• If the user does NOT mention a time word, do NOT add date filters even if it
  feels natural. Default = no dateFrom, no dateTo.
• Specifically these phrases extract dates — and ONLY these:
   - "today" → dateFrom:"${d.today}", dateTo:"${d.today}"
   - "tonight" → dateFrom:"${d.today}", dateTo:"${d.today}"
   - "tomorrow" → dateFrom:"${d.tomorrow}", dateTo:"${d.tomorrow}"
   - "this weekend" / "Saturday" / "Sunday" / "Sat" / "Sun" → dateFrom:"${d.saturday}", dateTo:"${d.sunday}"
   - "this week" → dateFrom:"${d.today}", dateTo:"${d.thisWeekSunday}"
   - "next week" → dateFrom:"${d.nextMonday}", dateTo:""
• Phrases that LOOK temporal but DO NOT extract dates:
   - "now", "right now", "soon", "later", "any time", "whenever"
   - "after school", "after pickup" (these are TIMES OF DAY, not dates)
   - "last minute", "quickly", "ASAP" (these are urgency, not dates)
   - "for spring break", "this season" (too vague)
• Examples:
   - "Not theater — something educational"            → NO date filter (no time word)
   - "Best 5 options I don't have to think about"     → NO date filter
   - "Pick something for me"                          → NO date filter
   - "Find something free for my 5yo tomorrow"        → tomorrow ✓
   - "Sunday plan not too far"                        → weekend ✓

PRICE:
• "free" → isFree:true
• "cheap" / "affordable" / "budget" → priceMax:25
• "under \$N" / "less than \$N" / "cheaper than \$N" → priceMax:N

AGE (CRITICAL — extract whenever mentioned):
NOTE: ageMax means "find events that INCLUDE age N in their range" (NOT "up to N"). So ageMax:5 returns events suitable for a 5-year-old; ageMax:18 returns events that explicitly go up to age 18, which are mostly adult-only (18+ nightlife, 18+ shows). Use the CHILD'S age, not the upper bound.
• "5yo" / "5 year old" / "my 5 year old" / "age 5" / "kids 5" → ageMax:5
• "4 and 7 year old" → ageMax:7 (widest)
• "toddler" → ageMax:3. "preschool" → ageMax:5. "tweens" → ageMax:12.
• "teen" / "teenager" / "13+" / "13 and up" / "for teens" → ageMax:13, search:"teen"
  (NEVER use ageMax:18 for teens — that returns adult 18+ events. 13 finds events whose declared age range includes 13.)
• "baby" / "infant" / "under 2" → ageMax:2

CATEGORIES — PREFER categories[] OVER search:
• "art" / "arts" / "drawing" / "painting" / "craft" → categories:["arts"]
• "museum" / "exhibit" → categories:["attractions","arts"]
• "theater" / "show" / "play" / "ballet" / "circus" / "puppet" → categories:["theater"]
• "music" / "concert" / "sing" → categories:["music"]
• "dance" → categories:["theater","music"]
• "science" / "STEM" / "STEAM" / "robotics" → categories:["science"]
• "nature" / "hike" / "park" / "outdoor" → categories:["outdoors"]
• "sports" / "running" / "swim" / "soccer" / "basketball" → categories:["sports"]
• "reading" / "books" / "storytime" / "library" → categories:["books"]
• "cooking for kids" / "baking for kids" / "kids cooking" / "cooking class" → categories:["family"], search:"cooking"
• "cooking" / "food" / "baking" (adult/general context) → categories:["food"]
• "movie" / "film" → categories:["film"]
• "holiday" / "seasonal" / "Halloween" / "Christmas" / "Easter" / "Thanksgiving" → categories:["holiday"]
• "birthday party venue" / "birthday party" → search:"birthday" (no category — venues span multiple categories)
• Broad query ("things to do") → no category filter.
• If the user says "art classes" and also "museum" → include BOTH: categories:["arts","attractions"].

SEARCH (fallback for specific phrases that no category captures):
• "birthday" → search:"birthday"
• "indoor" / "rainy day" → search:"indoor"
• "after school" / "after-school" / "after 3pm" / "weekday afternoon" → search:"after-school"
• "stroller" / "stroller-friendly" already handled via strollerFriendly:true — do NOT also add search
• Single keyword only — never multi-word search phrases.

LANGUAGE / BILINGUAL (CRITICAL — never skip when language is mentioned):
• "bilingual" / "Spanish" / "in Spanish" / "Spanish storytime" / "Hispanic" / "Latino" → search:"Spanish"
• "French" / "in French" / "Francophone" → search:"French"
• "Mandarin" / "Chinese" / "in Chinese" → search:"Mandarin"
• "Russian" / "in Russian" → search:"Russian"
• Examples:
   - "Bilingual Spanish events for kids" → search:"Spanish" (DO NOT return empty filters)
   - "Spanish storytime for toddlers" → search:"Spanish", ageMax:3
   - "French immersion class" → search:"French"

ACCESSIBILITY:
• "wheelchair" / "accessible" → wheelchairAccessible:true
• "stroller" / "stroller-friendly" → strollerFriendly:true

NEGATION — handle "not X", "without X", "no X" patterns:
• "not theater" / "no theater" → excludeCategories:["theater"]
• "not loud" / "quiet" / "calm" / "soft" / "low-key" → search:"calm"
  (we don't have a noise category; search keyword is the best we can do)
• "without baby stuff" / "no baby" / "no toddlers" → if profile has older
  kids, use their age in ageMax. If no profile, do NOT add an age filter,
  rely on category fit instead.
• "nothing scary" / "not scary" → search:"family"
Don't strip negations silently — at minimum drop the offending category.

TONE / VIBE words (extract as search keyword if no other category fits):
• "wow" / "amazing" / "memorable" → search:"unique"
• "interactive" / "hands-on" → search:"interactive"
• "boring" or "not boring" → use rating quality (no extra filter)
• "spontaneous" / "easy" / "low-stress" → no extra filter (relax everything else)

━━━ BALANCE RULES ━━━
• LEAN BROAD. If you're deciding between one narrow category and two broader ones, pick the broader option. We'd rather show too many decent events than zero matches.
• Don't combine highly restrictive filters unless the user is specific. e.g. "theater for 7yo girl in Brooklyn on Sat" = all four filters. But "fun things for 7yo" = just ageMax:7.
• Never invent filters the user didn't imply.

Available fields: categories(string[]), isFree(bool), ageMax(number), priceMax(number), dateFrom(YYYY-MM-DD), dateTo(YYYY-MM-DD), search(string), neighborhoods(string[]), wheelchairAccessible(bool), strollerFriendly(bool)
Valid categories: ${categoryList}
Valid neighborhoods: "Upper Manhattan","Midtown","Lower Manhattan","Brooklyn","Queens","Bronx","Staten Island"

RESPONSE: {"filters":{...}}   (filters only — no message, no commentary)`;
}

/**
 * STEP 2 — Message-generation prompt.
 *
 * Takes the events that `getEvents()` actually returned and generates a
 * 2-3 sentence reply. Because the LLM sees EXACTLY what the user will see,
 * it cannot invent events. This is the architectural fix for the 60%
 * hallucination rate.
 */
function buildMessagePrompt(
  userMessage: string,
  events: Event[],
  filters: FilterState,
  profile?: UserProfile,
  wasRelaxed?: boolean,
): string {
  const profileBlock = buildProfileBlock(profile);

  const eventsBlock = events.length === 0
    ? '(no events matched — apologize briefly and suggest the user relax a filter)'
    : events.slice(0, 15).map((e, i) => {
        const date = e.next_start_at ? String(e.next_start_at).slice(0, 10) : 'date TBD';
        const price = e.is_free ? 'FREE' : (e.price_summary || 'paid');
        const venue = e.venue_name || 'TBA';
        const ages = e.age_best_from != null ? `ages ${e.age_best_from}-${e.age_best_to ?? '?'}` : 'ages unrestricted';
        return `${i + 1}. "${e.title}" | ${venue} | ${date} | ${price} | ${ages}`;
      }).join('\n');

  const activeFilters = Object.entries(filters).filter(([, v]) =>
    v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)
  );
  const filterSummary = activeFilters.length === 0
    ? 'no active filters'
    : activeFilters.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(', ');

  // Infer the age/topic focus of the user's query so personalization is honest.
  const queryHasAge = /\b(\d{1,2})\s?(yo|y\.o\.|year[- ]?old)|\b(toddler|teen|teenager|preschool|tween|baby|infant)\b/i.test(userMessage);
  const queryHasTopic = /\b(teen|toddler|baby|infant|preschool|tween|adult)\b/i.test(userMessage);

  // The chat assistant should NOT describe events in detail — the user has the
  // event cards visible in the feed (with images, dates, venues, prices, links).
  // Long descriptions in chat are unreadable AND can't be clicked. The chat's
  // job is to (1) confirm we matched the request, (2) point at the feed,
  // (3) optionally name 1 event by title as a teaser. That's it.
  const eventCount = events.length;

  return `You are PulseUp, a warm NYC family-events concierge. Write a VERY SHORT reply (1–2 sentences max, ≤25 words) that points the user to the event feed on the right.

User asked: "${userMessage}"
Filters applied: ${filterSummary}
Events shown in the feed: ${eventCount}
${wasRelaxed ? '\n⚠  We had to relax some filters to find matches — acknowledge this briefly ("Couldn\'t find exact X — here\'s the closest").' : ''}
${profileBlock ? '\n' + profileBlock : ''}

━━━ EVENTS NOW IN THE FEED (you may name AT MOST one as a teaser) ━━━
${eventsBlock}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━ HOW TO REPLY ━━━
The feed (event cards) is visible to the user — they will browse it themselves. Your reply must be a short pointer, not a description.

GOOD examples (copy this style):
  • "Found ${eventCount} events for you — check the feed →"
  • "Here are ${eventCount} options that fit. ${eventCount > 0 ? 'Tap any card for details.' : ''}"
  • "${eventCount > 0 ? 'Got it — see the feed for ' + eventCount + ' matching events.' : 'Sorry, no matches — try loosening your filters.'}"

OK to mention ONE event by exact title as a teaser (no details):
  • "${eventCount} options — including \"<exact-title>\". See the feed →"

BAD (never do this):
  ✗ "I recommend the 'Recycled Ocean Crafts' at The Whaling Museum on April 23, which is free for ages 5-10. Another option is..."  ← long description, no link, useless
  ✗ Listing 2+ events with details
  ✗ Multiple sentences describing what each event is

━━━ STRICT RULES ━━━
1. ${eventCount === 0
    ? 'Empty feed — apologize in ONE short sentence and suggest one filter to relax (location, date, or category). Do NOT invent alternatives.'
    : 'Reply MUST be ≤ 25 words. Direct the user to the feed. Optionally name ONE event by EXACT title from the list — never describe it in detail.'}
2. NEVER invent events, venues, dates, prices, or quote events not in the list.
3. NEVER write descriptions like "designed for ages X-Y", "perfect for", "great option", "another good one is" — these belong on the event card, not in chat.

━━━ FORBIDDEN PHRASES (enforced by post-processing) ━━━
4. NEVER write "for your X-year-old", "your kid(s) will love", "your child", "your little one", "your family will enjoy" — the app strips these automatically.
5. ${queryHasAge ? 'User mentioned a specific age — be brief, point at feed.' : queryHasTopic ? 'User mentioned an age group — be brief, point at feed.' : 'No age focus — keep the reply brief and neutral.'}

━━━ FORMAT ━━━
6. 1–2 short sentences MAX, ≤ 25 words total. Plain text. No emoji except → if natural. No markdown.
7. Never say "I'll search", "let me know", "stay tuned".

Return JSON: {"message":"your ≤25-word reply"}`;
}

export async function POST(request: Request) {
  try {
    // ===== Rate limiting =====
    // Protects /api/chat from bursting and exhausting OpenAI TPM quota.
    // Load-test evidence: without this, 25+ concurrent requests collapse
    // to near-zero success rate because the 200K TPM limit is shared.
    // 20 req/min per IP is generous for a real user (1 every 3s), but
    // cuts off scripted abuse and same-IP bursts.
    const ipKey = getClientKey(request);
    // Per-IP: 20 req/min — generous for a real user (1 every 3s)
    const rl = rateLimit(`chat:${ipKey}`, 20, 60_000);
    if (!rl.allowed) {
      return Response.json(
        { error: 'Too many requests. Please slow down.', retry_after_sec: rl.retryAfterSec },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      );
    }
    // Global TPM guard — even across many IPs we cap at ~40 calls/min
    // (each ~2.5k tokens = 100k TPM, under OpenAI's 200k/min limit with headroom).
    const globalRl = rateLimit('chat:global', 40, 60_000);
    if (!globalRl.allowed) {
      return Response.json(
        { error: 'Service is busy. Please try again in a moment.', retry_after_sec: globalRl.retryAfterSec },
        { status: 503, headers: { 'Retry-After': String(globalRl.retryAfterSec) } }
      );
    }

    const body = await request.json();

    // Mode: parse_children
    if (body.mode === 'parse_children') {
      const text = body.message as string;
      if (!text) return Response.json({ error: 'Message is required' }, { status: 400 });

      const parseResult = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Extract children information from the user's text. Return a JSON object with a "children" array.
Detect gender from keywords: daughter/son/girl/boy (also Russian: дочь/сын/девочка/мальчик).
Each child object: { "age": number, "gender": "boy"|"girl"|"unknown", "name": string|null }
If age is unclear, make a reasonable guess. If gender is unclear, use "unknown".
Return ONLY the JSON object.`,
          },
          { role: 'user', content: text },
        ],
      });

      const parsed = JSON.parse(parseResult.choices[0].message.content || '{"children": []}');
      const children = (parsed.children || []).map((c: Record<string, unknown>) => ({
        age: Math.max(0, Math.min(18, Number(c.age) || 5)),
        gender: ['boy', 'girl', 'unknown'].includes(c.gender as string) ? c.gender : 'unknown',
        name: c.name || null,
        interests: [],
      }));

      return Response.json({ children });
    }

    const { message, filters: existingFilters, profile } = body as {
      message: string;
      filters?: FilterState;
      history?: ChatMessage[];
      profile?: UserProfile;
    };

    if (!message) {
      return Response.json({ error: 'Message is required' }, { status: 400 });
    }

    // ═══════════════════════════════════════════════════════════════════
    // TWO-CALL PIPELINE (eliminates hallucinations by design)
    //
    // Old single-call approach: LLM saw events from `getEventsForChat(query)`
    // and wrote a message referencing them, but the user's actual results
    // came from a separate `getEvents(extractedFilters)` call. The two sets
    // diverged → LLM mentioned events the user never saw (60% hallucination
    // rate in chat audit).
    //
    // New flow:
    //   1. LLM call #1 → extract filters only (no events in context).
    //   2. Run filters through getEvents() + auto-broaden if too few results.
    //   3. LLM call #2 → write a message that may only reference events
    //      from the final returned list. No other events are shown to it,
    //      so inventing them is impossible.
    // ═══════════════════════════════════════════════════════════════════

    // ----- STEP 1: Filter extraction -----
    const extractionStart = Date.now();
    const filterCompletion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      max_tokens: 250,
      messages: [
        { role: 'system', content: buildFilterExtractionPrompt(profile) },
        { role: 'user', content: message },
      ],
    });
    const extractionLatencyMs = Date.now() - extractionStart;

    let extractedFilters: FilterState = {};
    try {
      const parsed = JSON.parse(filterCompletion.choices[0].message.content || '{}');
      extractedFilters = parsed.filters || {};
    } catch {
      // Leave filters empty — we'll fall through and show unfiltered results
    }

    // ─── Auto-inject profile age bias when query is generic ───
    // Without this, queries like "What's happening in Brooklyn this week?" with
    // a profile (children 3yo + 6yo) return adult-only events ranked by date —
    // 18+ Brooklyn events crowd out family options because the SQL has no age
    // filter at all.
    //
    // We inject childAges ONLY when:
    //   • profile has children, AND
    //   • the LLM didn't extract any age signal (no ageMax, no childAges).
    //
    // If the LLM extracted ageMax (user explicitly mentioned "teen", "toddler",
    // "5yo", etc.), we trust their intent and skip injection — they're asking
    // for a specific age that may differ from their own kids.
    if (
      profile?.children?.length &&
      extractedFilters.ageMax === undefined &&
      !(extractedFilters.childAges && extractedFilters.childAges.length > 0)
    ) {
      const ages = profile.children
        .map((c) => Number(c.age))
        .filter((a) => Number.isFinite(a) && a >= 0 && a <= 18);
      if (ages.length > 0) {
        extractedFilters.childAges = ages;
      }
    }

    // Normalize location field (LLM sometimes uses `location` instead of `neighborhoods`)
    if (extractedFilters.location) {
      const loc = extractedFilters.location.toLowerCase().trim();
      const stripTerms = ['new york city', 'nyc', 'new york, ny', 'new york city, ny', 'new york'];
      if (stripTerms.includes(loc)) {
        delete extractedFilters.location;
      }
      const boroughMap: Record<string, string[]> = {
        'manhattan': ['Upper Manhattan', 'Midtown', 'Lower Manhattan'],
        'brooklyn': ['Brooklyn'],
        'queens': ['Queens'],
        'bronx': ['Bronx'],
        'the bronx': ['Bronx'],
        'staten island': ['Staten Island'],
        'midtown': ['Midtown'],
        'upper manhattan': ['Upper Manhattan'],
        'lower manhattan': ['Lower Manhattan'],
        'downtown': ['Lower Manhattan'],
        'uptown': ['Upper Manhattan'],
      };
      if (boroughMap[loc]) {
        extractedFilters.neighborhoods = boroughMap[loc];
        delete extractedFilters.location;
      }
    }

    // ----- STEP 2: Query DB + auto-broaden -----
    // Return 20 events instead of 10 — increases DB surface coverage from 28%→55%+
    // (QA audit finding: chat was the most constrained path at page_size=10)
    let eventsResult = getEvents({ ...extractedFilters, page: 1, page_size: 20 });
    let wasRelaxed = false;

    // Auto-broaden: progressively remove restrictive filters when too few results.
    // Intent filters (strollerFriendly, wheelchairAccessible) express explicit needs
    // — only broaden when those filters themselves return 0 results.
    const hasIntentFilters = !!(extractedFilters.strollerFriendly || extractedFilters.wheelchairAccessible);
    const broadenAt = hasIntentFilters ? 0 : 2;

    if (eventsResult.total <= broadenAt) {
      const broadeningSteps: { label: string; modify: (f: FilterState) => FilterState }[] = [
        { label: 'location',   modify: (f) => { const nf = { ...f }; delete nf.neighborhoods; delete nf.location; return nf; } },
        { label: 'dates',      modify: (f) => { const nf = { ...f }; delete nf.dateFrom; delete nf.dateTo; return nf; } },
        { label: 'categories', modify: (f) => { const nf = { ...f }; delete nf.categories; return nf; } },
        {
          label: 'all filters',
          // Drop categories/dates/location/search but PRESERVE family-context
          // filters (childAges, ageMax, accessibility, isFree). Without this,
          // when a narrow keyword query (e.g. "Spanish") returns ≤2 events,
          // we'd wipe the age bias and let adult-only events (18+ nightlife)
          // float to the top because they sort early by date.
          modify: (f) => {
            const nf: FilterState = {};
            if (f.search) nf.search = f.search;
            if (f.ageMax !== undefined) nf.ageMax = f.ageMax;
            if (f.childAges && f.childAges.length > 0) nf.childAges = f.childAges;
            if (f.strollerFriendly) nf.strollerFriendly = f.strollerFriendly;
            if (f.wheelchairAccessible) nf.wheelchairAccessible = f.wheelchairAccessible;
            if (f.isFree !== undefined) nf.isFree = f.isFree;
            return nf;
          },
        },
        {
          label: 'search simplification',
          modify: (f) => {
            const nf: FilterState = {};
            if (f.search && f.search.includes(' ')) {
              const words = f.search.split(/\s+/).filter(w => w.length > 3);
              nf.search = words.length > 0 ? words[0] : f.search.split(/\s+/)[0];
            }
            if (f.ageMax !== undefined) nf.ageMax = f.ageMax;
            if (f.childAges && f.childAges.length > 0) nf.childAges = f.childAges;
            if (f.strollerFriendly) nf.strollerFriendly = f.strollerFriendly;
            if (f.wheelchairAccessible) nf.wheelchairAccessible = f.wheelchairAccessible;
            if (f.isFree !== undefined) nf.isFree = f.isFree;
            return nf;
          },
        },
        {
          // Last resort: drop everything including childAges. Avoids returning
          // empty results, but is rarely hit in practice for the family persona.
          label: 'profile age',
          modify: (f) => {
            const nf: FilterState = {};
            if (f.search) nf.search = f.search;
            if (f.strollerFriendly) nf.strollerFriendly = f.strollerFriendly;
            if (f.wheelchairAccessible) nf.wheelchairAccessible = f.wheelchairAccessible;
            if (f.isFree !== undefined) nf.isFree = f.isFree;
            return nf;
          },
        },
      ];

      let currentFilters = { ...extractedFilters };
      for (const step of broadeningSteps) {
        currentFilters = step.modify(currentFilters);
        const tryResult = getEvents({ ...currentFilters, page: 1, page_size: 20 });
        if (tryResult.total >= 3) {
          eventsResult = tryResult;
          extractedFilters = currentFilters;
          wasRelaxed = true;
          break;
        }
      }
    }

    // ----- STEP 3: Message generation (grounded in returned events) -----
    let responseText: string;
    try {
      const messageCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        max_tokens: 250,
        messages: [
          { role: 'system', content: buildMessagePrompt(message, eventsResult.events, extractedFilters, profile, wasRelaxed) },
          { role: 'user', content: message },
        ],
      });
      const parsed = JSON.parse(messageCompletion.choices[0].message.content || '{}');
      responseText = String(parsed.message || '').trim();

      // Post-hoc hallucination guard: if the LLM still mentions a title that
      // isn't in the returned events (e.g. picked up from training data),
      // fall back to a safe deterministic template. This is defence-in-depth
      // — the prompt should prevent this, but we never want to ship a lie.
      if (responseText && eventsResult.events.length > 0) {
        const titles = eventsResult.events.map(e => (e.title || '').toLowerCase());
        const mentionsRealEvent = titles.some(t =>
          t.length > 6 && responseText.toLowerCase().includes(t.slice(0, Math.min(30, t.length)))
        );
        if (!mentionsRealEvent) {
          responseText = buildFallbackMessage(eventsResult.events, profile);
        }
      } else if (!responseText) {
        responseText = eventsResult.events.length > 0
          ? buildFallbackMessage(eventsResult.events, profile)
          : "I couldn't find events matching all your criteria. Try loosening the location or date.";
      }

      // Post-hoc personalization guard — strip "for your X-year-old" phrases
      // (gpt-4o-mini reflexively generates them; see stripFalsePersonalization).
      if (responseText && eventsResult.events.length > 0) {
        responseText = stripFalsePersonalization(responseText, eventsResult.events);
      }
    } catch (err) {
      console.error('[chat] message-generation call failed:', err);
      responseText = eventsResult.events.length > 0
        ? buildFallbackMessage(eventsResult.events, profile)
        : "Sorry, something went wrong generating a reply. The events below should still match your search.";
    }

    return Response.json({
      message: responseText,
      filters: extractedFilters,
      events: eventsResult.events,
      total: eventsResult.total,
      // Pipeline meta — consumed by client-side analytics (trackChatFiltersExtracted)
      meta: {
        extraction_latency_ms: extractionLatencyMs,
        was_relaxed: wasRelaxed,
      },
    });
  } catch (error) {
    console.error('Error in chat:', error);
    return Response.json({ error: 'Failed to process chat message' }, { status: 500 });
  }
}

/**
 * Strip phrases like "great for your 4-year-old" or "perfect for your kid"
 * when none of the mentioned events actually fit that age. gpt-4o-mini has
 * a persistent habit of forcing profile-age personalization even when the
 * event list is clearly for teens or adults — this is the deterministic
 * guard that removes those false claims.
 *
 * Strategy:
 *   1. Find every "<N>-year-old" reference in the reply.
 *   2. For each referenced age, check if any returned event's age range
 *      contains that age.
 *   3. If not, strip the false personalization phrase.
 */
function stripFalsePersonalization(message: string, events: Event[]): string {
  // Strategy: unconditionally strip every "for your X-year-old" / "your kid will…"
  // phrase. gpt-4o-mini reflexively generates them from the profile regardless
  // of whether the mentioned event actually fits that age. Checking coverage
  // across the full event list is unreliable (it usually contains some events
  // with 0-18 ranges even when the LLM mentions only teen/adult events), so we
  // don't try — we just remove the phrase. The prompt already forbids it.
  void events; // reserved for future per-event verification if we ever need it

  let cleaned = message;

  // 1) "— great for your 4-year-old" / ", perfect for your kid"
  //    Do NOT consume the trailing period/exclamation — leave it as the
  //    natural sentence terminator (e.g. "Event (free). Or try…").
  cleaned = cleaned.replace(
    /\s*[—\-,]?\s*(?:great|perfect|fantastic|awesome|ideal|fun|lovely|super|wonderful|exciting)\s+for\s+your\s+(?:\d{1,2}[- ]?(?:year[- ]?old|yo)|kid|child|little one|family|toddler|teen|son|daughter|boys?|girls?)s?\b/gi,
    '',
  );

  // 2) "your kid(s) will love …" / "your 4yo will enjoy …" — consume up to
  //    sentence terminator so the whole clause goes.
  cleaned = cleaned.replace(
    /\s*[—\-,]?\s*your\s+(?:kid|child|little one|family|son|daughter|toddler|teen|\d{1,2}[- ]?(?:year[- ]?old|yo))s?\s+(?:will\s+)?(?:love|enjoy|adore|have fun|get a kick out|be excited)[^.!]*(?=[.!])/gi,
    '',
  );

  // 3) Bare "for your 4-year-old" / "for your kid" without a preceding adjective
  cleaned = cleaned.replace(
    /\s+for\s+your\s+(?:\d{1,2}[- ]?(?:year[- ]?old|yo)|kid|child|little one|family|toddler)s?\b/gi,
    '',
  );

  // 4) "ideal/suitable/appropriate for your <anything>"
  cleaned = cleaned.replace(
    /\s*[—\-,]?\s*(?:ideal|suitable|appropriate)\s+for\s+your\s+[^.!,]+(?=[.!,])/gi,
    '',
  );

  // Clean up leftover punctuation, spacing, and orphan connectors
  cleaned = cleaned
    .replace(/\s*—\s*(?=[.!,])/g, '')                 // "…—." → "…."
    .replace(/\s*[—\-]\s*$/gm, '')                     // dangling em-dash at end
    .replace(/\s+(?:that|which|and|option\s+that)\s*(?=[.!,])/gi, '') // orphan connectors
    .replace(/\s+is\s+a\s+(?:fantastic|great|lovely|perfect|wonderful)\s+option\s*(?=[.!,])/gi, '') // "is a fantastic option."
    .replace(/\s{2,}/g, ' ')                            // collapse double spaces
    .replace(/\s+([.!,])/g, '$1')                       // " ." → "."
    .replace(/([.!])\s*\1+/g, '$1')                     // ".." → "."
    .replace(/^\s*[—\-,.]+\s*/g, '')                    // leading punct after strip
    .trim();

  return cleaned || message;
}

/**
 * Deterministic fallback message built from real events — used when the LLM
 * fails, returns empty, or hallucinates. Always truthful because it reads
 * directly from the event list.
 */
function buildFallbackMessage(events: Event[], profile?: UserProfile): string {
  void profile; // intentionally ignored — we never make unverifiable age claims
  if (events.length === 0) {
    return "I couldn't find events matching your criteria. Try loosening the location or date.";
  }
  const describe = (e: Event): string => {
    const date = e.next_start_at ? new Date(String(e.next_start_at)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    const price = e.is_free ? 'free' : (e.price_summary || '');
    const ages = e.age_best_from != null ? `ages ${e.age_best_from}${e.age_best_to != null && e.age_best_to !== e.age_best_from ? '–' + e.age_best_to : '+'}` : '';
    const parts = [price, date, ages].filter(Boolean).join(', ');
    return `"${e.title}"${parts ? ` (${parts})` : ''}`;
  };
  let msg = `Check out ${describe(events[0])}.`;
  if (events.length > 1) msg += ` Or try ${describe(events[1])}.`;
  return msg;
}
