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
    fetch(DB_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
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
      }),
    }).catch(() => { /* silent — PostHog is the primary, DB is backup */ });
  } catch { /* ignore */ }
}

// ─── core capture ────────────────────────────────────────────────────────────

function capture(event_name: string, props: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  posthog.capture(event_name, props);
  sendToDb(event_name, props);
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

  const visitNumber = bumpVisitNumber();
  const params = new URLSearchParams(window.location.search);

  capture('session_start', {
    visit_number:  visitNumber,
    is_returning:  visitNumber > 1,
    utm_source:    params.get('utm_source')   ?? null,
    utm_medium:    params.get('utm_medium')   ?? null,
    utm_campaign:  params.get('utm_campaign') ?? null,
    screen_width:  window.innerWidth,
    screen_height: window.innerHeight,
    referrer:      document.referrer || null,
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
 * source = 'feed' | 'chat' | 'digest'
 */
export function trackCardExpanded(props: {
  event_id: number;
  event_title?: string;
  source?: 'feed' | 'chat' | 'digest';
}): void {
  capture('card_expanded', props as Record<string, unknown>);
}

/**
 * ⭐ North Star — user clicked "Buy Tickets" or "More Info".
 * price_bucket derived from event's price_min.
 */
export function trackBuyTicketsClicked(props: {
  event_id: number;
  event_title?: string;
  destination_url?: string;
  price_min?: number;
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
