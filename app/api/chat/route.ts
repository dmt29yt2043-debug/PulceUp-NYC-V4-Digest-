import OpenAI from 'openai';
import { getEvents, getEventsForChat, getCategories } from '@/lib/db';
import type { FilterState, ChatMessage, UserProfile } from '@/lib/types';
import { rateLimit, getClientKey } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30000,
});

function buildSingleCallPrompt(profile?: UserProfile, userMessage?: string): string {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });

  let categoryList: string;
  try {
    const cats = getCategories();
    categoryList = cats.map((c) => c.value).join(', ');
  } catch {
    categoryList = 'family, arts, theater, attractions, books, holiday, sports, music, science, film, gaming, community';
  }

  const tomorrow = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
  const satOffset = (6 - now.getDay() + 7) % 7 || 7;
  const sunOffset = (7 - now.getDay()) % 7 || 7;
  const nextMonOffset = sunOffset + 1;
  const saturday = (() => { const d = new Date(now); d.setDate(d.getDate() + satOffset); return d.toISOString().split('T')[0]; })();
  const sunday = (() => { const d = new Date(now); d.setDate(d.getDate() + sunOffset); return d.toISOString().split('T')[0]; })();
  const nextMonday = (() => { const d = new Date(now); d.setDate(d.getDate() + nextMonOffset); return d.toISOString().split('T')[0]; })();
  const thisWeekSunday = sunday;

  let profileBlock = '';
  if (profile && 'children' in profile && Array.isArray(profile.children)) {
    const kids = profile.children.map((c) => {
      const g = c.gender === 'girl' ? 'daughter' : c.gender === 'boy' ? 'son' : 'child';
      const interests = c.interests?.length ? ` (${c.interests.join(', ')})` : '';
      return `${g} ${c.age}yo${interests}`;
    }).join(', ');
    profileBlock = `\nUser has: ${kids}. Personalize recommendations.`;
  }

  // Get event context for the AI to reference specific events.
  // Pass the raw user message so the SQL layer can pre-narrow the candidate
  // set across the FULL dataset instead of always seeing the same top-N.
  const eventsSummary = getEventsForChat(userMessage);
  const eventsBlock = eventsSummary.map((e) =>
    `[${e.id}] "${e.title}" | ${e.category_l1 || 'general'} | ${e.venue_name} | ${e.next_start_at} | ${e.is_free ? 'Free' : e.price_summary} | ${e.age_label}`
  ).join('\n');

  return `You are PulseUp, an event discovery assistant for NYC families. Return a JSON object with "filters" and "message".

TODAY: ${today} (${dayOfWeek}), year ${now.getFullYear()}.
DATES: "tomorrow"=${tomorrow}. "this weekend"=dateFrom:"${saturday}",dateTo:"${sunday}". "this week"=dateFrom:"${today}",dateTo:"${thisWeekSunday}". "next week" starts ${nextMonday}. WEEKEND=Sat+Sun ONLY.
${profileBlock}

FILTER RULES:
- Each message is a FRESH independent search. Extract ONLY what the user explicitly says.
- "near me" = NO location filter. "in Brooklyn" = neighborhoods:["Brooklyn"].
- No date mentioned = NO dateFrom/dateTo. "this weekend"/"tomorrow" = add date filter.
- "free" = isFree:true. "under \$N" or "cheap(er than) \$N" or "less than \$N" → priceMax:N.
- PREFER categories[] over search when the topic maps to a known category. Examples:
  • "art"/"drawing"/"painting" → categories:["arts"] (NOT search)
  • "museum" → categories:["arts"]
  • "cooking" → categories:["food"]
  • "science"/"STEM"/"robotics" → categories:["science"]
  • "theater"/"show"/"play"/"ballet" → categories:["theater"]
  • "nature"/"hike"/"park"/"outdoors" → categories:["outdoors"]
  • "music"/"concert" → categories:["music"]
  • "sports"/"running"/"swim" → categories:["sports"]
  • "reading"/"books"/"storytime" → categories:["books"]
  • "movie"/"film" → categories:["film"]
- Use search only for very specific terms like "Easter egg hunt" → search:"Easter", or when no category fits.
- Language/bilingual queries: "Spanish" or "bilingual" → search:"Spanish" (single keyword, never multi-word search phrases).
- Age semantics (VERY IMPORTANT):
  • "5yo"/"5 year old"/"my 5 year old" → ageMax:5 (event must suit a 5yo)
  • "teens" or "13+" or "13 and up" → ageMax:18 AND search:"teen" (or skip ageMax if too restrictive; teens need events with upper age range >= 13)
  • "toddler" → ageMax:3. "preschool" → ageMax:5. "tweens" → ageMax:12.
  • "under 2"/"under 1"/"infant"/"baby" → ageMax:2 only (do NOT combine with ageMax:0)
- Intent hints:
  • "indoor" → add search:"indoor" (not a category, but narrows)
  • "birthday party"/"birthday" → search:"birthday"
  • "rainy day" → hint about indoor — add search:"indoor"
- "wheelchair"/"accessible" → wheelchairAccessible:true. "stroller" → strollerFriendly:true.
- FEWER filters is better than empty results. If a combination would yield 0 results, drop the most restrictive filter.

Available filter fields: categories(string[]), isFree(bool), ageMax(number), priceMax(number), dateFrom(YYYY-MM-DD), dateTo(YYYY-MM-DD), search(string), neighborhoods(string[]), location(string), wheelchairAccessible(bool), strollerFriendly(bool)
Categories: ${categoryList}
Neighborhoods: "Upper Manhattan","Midtown","Lower Manhattan","Brooklyn","Queens","Bronx","Staten Island"
Borough mapping: "Manhattan"→["Upper Manhattan","Midtown","Lower Manhattan"], "Brooklyn"→["Brooklyn"], etc.

MESSAGE RULES:
- 2-3 SHORT sentences. You MUST mention 1-2 specific event names from the list below.
- Include key details (free/paid, date). Personalize for kids if profile provided.
- NEVER say "I'll search", "stay tuned", or "let me know". You already HAVE the events — recommend them NOW.
- Always start with a recommendation, e.g. "Check out 'Event Name' (free, Apr 12) — perfect for your 5-year-old!"

Available events:
${eventsBlock}

RESPONSE FORMAT (JSON only):
{"filters":{...},"message":"your 2-3 sentence response mentioning specific events"}`;
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

    // ===== SINGLE API CALL: Extract filters + generate response =====
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      max_tokens: 350,
      messages: [
        { role: 'system', content: buildSingleCallPrompt(profile, message) },
        { role: 'user', content: message },
      ],
    });

    let extractedFilters: FilterState = {};
    let responseText = '';

    try {
      const result = JSON.parse(completion.choices[0].message.content || '{}');
      extractedFilters = result.filters || {};
      responseText = result.message || '';
    } catch {
      responseText = 'Sorry, something went wrong. Please try again.';
    }

    // Normalize location
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

    // Get events with extracted filters
    let eventsResult = getEvents({ ...extractedFilters, page: 1, page_size: 10 });

    // Auto-broaden: if 0 or very few results (< 3), progressively remove restrictive filters
    // This covers sparse queries like "sports for 8yo" that return only 1 hit after strict filtering.
    if (eventsResult.total < 3) {
      const broadeningSteps: { label: string; modify: (f: FilterState) => FilterState }[] = [
        {
          label: 'location',
          modify: (f) => { const nf = { ...f }; delete nf.neighborhoods; delete nf.location; return nf; },
        },
        {
          label: 'dates',
          modify: (f) => { const nf = { ...f }; delete nf.dateFrom; delete nf.dateTo; return nf; },
        },
        {
          label: 'categories',
          modify: (f) => { const nf = { ...f }; delete nf.categories; return nf; },
        },
        {
          label: 'all filters',
          modify: (f) => {
            const nf: FilterState = {};
            if (f.search) nf.search = f.search;
            if (f.ageMax !== undefined) nf.ageMax = f.ageMax;
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
            return nf;
          },
        },
      ];

      let currentFilters = { ...extractedFilters };
      for (const step of broadeningSteps) {
        currentFilters = step.modify(currentFilters);
        const tryResult = getEvents({ ...currentFilters, page: 1, page_size: 10 });
        if (tryResult.total >= 3) {
          eventsResult = tryResult;
          extractedFilters = currentFilters;
          break;
        }
      }
    }

    return Response.json({
      message: responseText,
      filters: extractedFilters,
      events: eventsResult.events,
      total: eventsResult.total,
    });
  } catch (error) {
    console.error('Error in chat:', error);
    return Response.json({ error: 'Failed to process chat message' }, { status: 500 });
  }
}
