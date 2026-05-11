/**
 * PulseUp analytics — v2
 *
 * Dual-sink: every event fires to PostHog (primary) AND our SQLite DB
 * (backup + arbitrary SQL queries).
 *
 * Public typed API — use these in new code:
 *   trackSessionStart()
 *   trackFilterApplied(filters, source)
 *   trackChatMessageSent(props?)
 *   trackChatResponseReceived(props)
 *   trackCardExpanded(props)
 *   trackBuyTicketsClicked(props)        ⭐  North Star
 *   trackMapOpened(props?)
 *   trackEmailCapture(props)
 *   trackError(error)
 *
 * Legacy aliases (kept so existing call sites don't break before Phase 3-4):
 *   track(event_name, props?)
 *   trackEvent(event_name, props?)
 *   initAnalytics()
 *   trackPageView(extra?)
 */

import posthog from 'posthog-js';

const DB_ENDPOINT = '/api/analytics/event';

// ─── helpers ────────────────────────────────────────────────────────────────

/** sessionStorage counter — increments on every call, returns new value */
function sessionIncrement(key: string): number {
  try {
    const n = parseInt(sessionStorage.getItem(key) ?? '0', 10) + 1;
    sessionStorage.setItem(key, String(n));
    return n;
  } catch { return 1; }
}

/** localStorage visit counter — increments once per browser lifetime */
function bumpVisitNumber(): number {
  try {
    const n = parseInt(localStorage.getItem('pu_visit_count') ?? '0', 10) + 1;
    localStorage.setItem('pu_visit_count', String(n));
    return n;
  } catch { return 1; }
}

function getVisitNumber(): number {
  try { return parseInt(localStorage.getItem('pu_visit_count') ?? '0', 10); } catch { return 0; }
}

function priceBucket(priceMin: number): string {
  if (priceMin === 0) return 'free';
  if (priceMin < 20) return 'under_20';
  if (priceMin <= 50) return '20_to_50';
  return 'over_50';
}

// ─── stable IDs for the DB sink ─────────────────────────────────────────────
// PostHog's distinct_id / session_id are only stable AFTER posthog.init()
// finishes, which happens in a separate useEffect than our trackSessionStart().
// If we read PostHog's IDs for the DB sink, early events (session_start,
// profile filter_applied) end up with fallback IDs while later ones use
// PostHog's — splitting a single browser session across two session_ids.
// Solution: always use our own stable per-browser / per-tab IDs from storage.
// PostHog can keep its own identity internally — the sinks don't need to share.

function getAnonId(): string {
  try {
    let id = localStorage.getItem('pu_anon_id');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('pu_anon_id', id); }
    return id;
  } catch { return 'anon-' + Date.now(); }
}

function getSessionId(): string {
  try {
    let id = sessionStorage.getItem('pu_session_id');
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('pu_session_id', id); }
    return id;
  } catch { return 'sess-' + Date.now(); }
}

// ─── DB sink (fire-and-forget) ───────────────────────────────────────────────

function sendToDb(event_name: string, props: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  try {
    const anonymousId = getAnonId();
    const sessionId   = getSessionId();
    const body = JSON.stringify({
      events: [{
        event_name,
        event_version: 2,
        anonymous_id: anonymousId,
        session_id:   sessionId,
        page_url:  window.location.href,
        page_path: window.location.pathname,
        event_props: props,
        client_ts: Date.now(),
      }],
    });

    // Prefer navigator.sendBeacon — it's purpose-built for analytics pings at
    // page-unload and survives the "click external link → navigate away" race
    // that was silently dropping buy_tickets_clicked events.
    // PostHog audit (2026-04-24): 4 buy events arrived at PostHog but 0 landed
    // in the SQLite sink — all because async fetch() was killed by browser
    // navigation before the request completed. sendBeacon fixes this.
    //
    // Fall back to keepalive fetch if sendBeacon is missing or the payload
    // exceeds the 64 KB beacon budget (unlikely for single events).
    const beacon = typeof navigator !== 'undefined' ? navigator.sendBeacon : undefined;
    if (beacon) {
      try {
        const blob = new Blob([body], { type: 'application/json' });
        const ok = beacon.call(navigator, DB_ENDPOINT, blob);
        if (ok) return;
      } catch { /* fall through to fetch */ }
    }

    fetch(DB_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body,
    }).catch(() => { /* silent — PostHog is the primary, DB is backup */ });
  } catch { /* ignore */ }
}

// ─── dev / internal traffic exclusion ────────────────────────────────────────
// Set  localStorage.pulseup_dev = '1'  in any browser you don't want to count
// (your own devices, QA machines, beta testers running from the office).
// PostHogProvider.tsx also calls posthog.opt_out_capturing() for the same flag.
//
// To activate:   localStorage.setItem('pulseup_dev', '1')
// To deactivate: localStorage.removeItem('pulseup_dev')  (then hard-refresh)

function isDevMode(): boolean {
  try { return localStorage.getItem('pulseup_dev') === '1'; } catch { return false; }
}

// ─── core capture ────────────────────────────────────────────────────────────

// Events that DO NOT count as "the user actually did something". These don't
// trip the first-action timer: they fire automatically on page load or are
// purely meta. When we want to measure how fast a user reacts, we wait for an
// event that isn't on this list.
const PASSIVE_EVENTS = new Set([
  'session_start',
  '$web_vitals',
  '$pageview',
  '$pageleave',
  '$identify',
  'first_action',  // emitted by ourselves below — never re-trigger
]);

/**
 * On the FIRST interactive event in a session, also emit `first_action` with
 * the elapsed milliseconds from session_start. This gives us a clean
 * Time-to-first-action metric server-side without having to reconstruct it
 * from event timestamps in HogQL.
 *
 * Idempotent within a session via sessionStorage flag.
 */
function maybeEmitFirstAction(event_name: string): void {
  if (PASSIVE_EVENTS.has(event_name)) return;
  try {
    if (sessionStorage.getItem('pu_first_action_emitted')) return;
    const t0 = parseInt(sessionStorage.getItem('pu_session_t0') ?? '0', 10);
    if (!t0) return; // session_start hasn't run yet — skip silently
    const dtMs = Date.now() - t0;
    sessionStorage.setItem('pu_first_action_emitted', '1');
    posthog.capture('first_action', {
      first_event: event_name,
      time_to_first_action_ms: dtMs,
      time_to_first_action_s: Math.round(dtMs / 100) / 10,
    });
    // Also send to DB sink for offline querying.
    sendToDb('first_action', {
      first_event: event_name,
      time_to_first_action_ms: dtMs,
    });
  } catch { /* ignore */ }
}

function capture(event_name: string, props: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  if (isDevMode()) return;   // don't pollute analytics with own/team traffic
  posthog.capture(event_name, props);
  sendToDb(event_name, props);
  maybeEmitFirstAction(event_name);
}

// ─── typed public API ────────────────────────────────────────────────────────

/**
 * Call once on app mount. Records session_start with visit_number and UTM data.
 * Guards against double-firing within the same browser session.
 */
export function trackSessionStart(): void {
  if (typeof window === 'undefined') return;
  if (sessionStorage.getItem('pu_session_init')) return;
  sessionStorage.setItem('pu_session_init', '1');

  // Persist t0 for the first_action timer (see maybeEmitFirstAction).
  // We store it in sessionStorage so a tab-restore keeps the same baseline.
  sessionStorage.setItem('pu_session_t0', String(Date.now()));

  const visitNumber = bumpVisitNumber();
  const params = new URLSearchParams(window.location.search);

  const utmSource    = params.get('utm_source');
  const utmMedium    = params.get('utm_medium');
  const utmCampaign  = params.get('utm_campaign');
  const utmContent   = params.get('utm_content');
  const utmTerm      = params.get('utm_term');
  const referrer     = document.referrer || null;

  // Stick acquisition data onto EVERY future event in this browser, not just
  // session_start. Without register(), filter_applied / card_expanded etc.
  // arrive at PostHog with no UTM context, and we can't slice "filter usage by
  // ad campaign" in HogQL. register_once makes the FIRST-touch values stick
  // even across same-tab navigations. The non-once register() then overlays
  // last-touch UTMs from the current URL.
  try {
    posthog.register_once({
      first_utm_source:   utmSource,
      first_utm_medium:   utmMedium,
      first_utm_campaign: utmCampaign,
      first_referrer:     referrer,
      first_landing_page: window.location.href,
    });
    // Last-touch (refreshes when user lands again with new UTMs)
    posthog.register({
      utm_source:   utmSource,
      utm_medium:   utmMedium,
      utm_campaign: utmCampaign,
      utm_content:  utmContent,
      utm_term:     utmTerm,
      referrer,
    });
  } catch { /* posthog may not be initialized yet; values still flow via the event below */ }

  capture('session_start', {
    visit_number:  visitNumber,
    is_returning:  visitNumber > 1,
    utm_source:    utmSource,
    utm_medium:    utmMedium,
    utm_campaign:  utmCampaign,
    utm_content:   utmContent,
    utm_term:      utmTerm,
    screen_width:  window.innerWidth,
    screen_height: window.innerHeight,
    referrer,
    landing_page:  window.location.href,
  });
}

/**
 * Every time the active filter set changes.
 * source = 'chat'    — AI chat updated the filters
 *          'ui'      — user clicked a filter button manually
 *          'digest'  — user selected a digest
 *          'reset'   — user hit "Clear / Reset"
 * change_number counts how many times filters changed in this session —
 * key metric for Качество выдачи.
 */
export function trackFilterApplied(
  filterData: Record<string, unknown>,
  source: 'chat' | 'ui' | 'digest' | 'reset'
): void {
  const change_number = sessionIncrement('pu_filter_count');
  capture('filter_applied', { ...filterData, source, change_number });
}

/**
 * User pressed Send in the chat.
 * message_number counts messages in this session — key metric for chat quality.
 */
export function trackChatMessageSent(props: Record<string, unknown> = {}): void {
  const message_number = sessionIncrement('pu_msg_count');
  capture('chat_message_sent', { ...props, message_number });
}

/**
 * AI responded. Records latency and how many events came back (0 = empty result).
 */
export function trackChatResponseReceived(props: {
  latency_ms: number;
  events_count: number;
  query?: string;
}): void {
  capture('chat_response_received', props as Record<string, unknown>);
}

/**
 * User opened an event card (expanded it inline).
 *
 * New properties enable ranking-quality analysis:
 *   position      — 1-based rank in the visible list (essential for CTR@k, NDCG)
 *   list_total    — total items currently in the list
 *   came_from_tab — 'foryou' | 'feed' (which tab the user was on)
 *   came_from_digest — slug if a curated digest was active
 *   has_filters   — any sidebar filter active (non-default)
 *   active_categories / active_neighborhoods — to join with query intent
 */
export function trackCardExpanded(props: {
  event_id: number;
  event_title?: string;
  source?: 'feed' | 'chat' | 'digest';
  position?: number;
  list_total?: number;
  came_from_tab?: 'foryou' | 'feed';
  came_from_digest?: string | null;
  has_filters?: boolean;
  active_categories?: string[];
  active_neighborhoods?: string[];
}): void {
  capture('card_expanded', props as Record<string, unknown>);
}

/**
 * An event card became visible in the viewport for ≥ IMPRESSION_THRESHOLD_MS.
 * Without this, click-through rate is meaningless — we don't know the
 * denominator. Fires once per (session, event_id, position) tuple.
 */
export function trackEventImpression(props: {
  event_id: number;
  position: number;
  list_total?: number;
  source?: 'feed' | 'chat' | 'digest';
  came_from_tab?: 'foryou' | 'feed';
  came_from_digest?: string | null;
}): void {
  capture('event_impression', props as Record<string, unknown>);
}

/**
 * ⭐ North Star — user clicked "Buy Tickets" or "More Info".
 * price_bucket derived from event's price_min. The additional context fields
 * let us answer "when users convert, what were they doing?" without
 * post-hoc session stitching.
 */
export function trackBuyTicketsClicked(props: {
  event_id: number;
  event_title?: string;
  destination_url?: string;
  price_min?: number;
  source?: 'feed' | 'chat' | 'digest';
  position?: number;
  came_from_tab?: 'foryou' | 'feed';
  came_from_digest?: string | null;
  active_categories?: string[];
  active_neighborhoods?: string[];
  has_filters?: boolean;
}): void {
  const price_bucket = priceBucket(props.price_min ?? 0);
  capture('buy_tickets_clicked', { ...props, price_bucket } as Record<string, unknown>);
}

/**
 * User switched to map view.
 */
export function trackMapOpened(props: Record<string, unknown> = {}): void {
  capture('map_opened', props);
}

/**
 * Email capture form shown or submitted.
 * event = 'shown' | 'submitted'
 */
export function trackEmailCapture(props: {
  event: 'shown' | 'submitted';
  source?: string;
}): void {
  capture('email_capture', props as Record<string, unknown>);
}

/**
 * Something broke. Captures type + optional context.
 */
export function trackError(error: {
  type: string;
  message?: string;
  context?: unknown;
}): void {
  capture('error', error as Record<string, unknown>);
}

// ─── user identity (cohort tracking) ─────────────────────────────────────────

/**
 * Bind the current anonymous PostHog user to a durable email-based identity.
 * Call this AFTER the user submits their email (email_ask_submitted).
 *
 * Why: PostHog lets us build "signed-up users" cohorts, email-filtered funnels,
 * and cross-device tracking. Without identify(), every browser instance is a
 * separate anonymous user even for the same person.
 *
 * Also sets person properties so PostHog's "person view" surfaces them.
 */
export function identifyUser(email: string, props: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined' || !email) return;
  try {
    posthog.identify(email, {
      email,
      identified_at: new Date().toISOString(),
      ...props,
    });
  } catch { /* posthog not ready — silent */ }
}

// ─── chat pipeline events ───────────────────────────────────────────────────
//
// These events let us debug and tune the AI chat. Today we only see "message
// sent → response received" at the endpoints; the steps in between (filter
// extraction, auto-broaden, LLM generation) are opaque. If chat quality drops
// we can't tell which stage broke. The three events below expose the pipeline.

/**
 * Fires after the filter-extraction LLM call. Lets us measure extraction
 * quality ("did it pick up the location?") and extraction latency separately
 * from the message-generation latency.
 */
export function trackChatFiltersExtracted(props: {
  query: string;
  extracted_filters: Record<string, unknown>;
  extraction_latency_ms?: number;
  was_relaxed?: boolean;
}): void {
  capture('chat_filters_extracted', props as Record<string, unknown>);
}

/**
 * Fires when the chat/quiz auto-broaden logic silently widens filters because
 * the strict combo would have returned too few events. Critical signal: if
 * this fires a lot it means our DB is under-populated for common queries.
 */
export function trackAutoBroadened(props: {
  strict_count: number;
  broadened_count?: number;
  dropped: string[];           // e.g. ['categories']
  // 'quiz' / 'chat' / partner labels / 'unknown' fallback — kept open since
  // new entry points (fb-direct landing, partner deeplinks) keep arriving
  // and we want to slice broaden-rate by source without code changes.
  source: string;
  borough?: string;
}): void {
  capture('auto_broadened', props as Record<string, unknown>);
}

// ─── feed engagement ────────────────────────────────────────────────────────

/**
 * Scroll-depth milestones in the events feed (25/50/75/100%). Fires at most
 * once per depth per session so we get one data point per milestone.
 * Key engagement metric — tells us if users are actually looking past page 1.
 */
export function trackFeedScroll(props: {
  depth_pct: 25 | 50 | 75 | 100;
  events_visible: number;
  tab?: 'feed' | 'foryou';
}): void {
  const key = `pu_feed_scroll_${props.depth_pct}`;
  try {
    if (sessionStorage.getItem(key)) return; // already fired this session
    sessionStorage.setItem(key, '1');
  } catch { /* ignore */ }
  capture('feed_scroll', props as Record<string, unknown>);
}

// ─── legacy aliases ──────────────────────────────────────────────────────────
// Kept so existing call-sites in page.tsx / ChatSidebar.tsx / EventDetail.tsx
// continue to work without changes during Phase 2.
// Will be replaced with typed calls in Phase 3-4.

/** @deprecated use typed trackXxx functions instead */
export const track = (event_name: string, props: Record<string, unknown> = {}) =>
  capture(event_name, props);

/** @deprecated use typed trackXxx functions instead */
export const trackEvent = track;

/** @deprecated use trackSessionStart() instead */
export function initAnalytics(): void {
  trackSessionStart();
}

/** @deprecated PostHog records page views automatically */
export function trackPageView(extraProps: Record<string, unknown> = {}): void {
  capture('page_view', {
    title: typeof document !== 'undefined' ? document.title : undefined,
    ...extraProps,
  });
}
