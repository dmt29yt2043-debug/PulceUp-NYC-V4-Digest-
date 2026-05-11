import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';

let _db: Database.Database | null = null;

function getAnalyticsDb(): Database.Database {
  if (!_db) {
    const dbPath = path.join(process.cwd(), 'data', 'analytics.db');
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('busy_timeout = 5000');

    _db.exec(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id              TEXT PRIMARY KEY,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),

        event_name      TEXT NOT NULL,
        event_version   INTEGER NOT NULL DEFAULT 1,

        user_id         TEXT,
        anonymous_id    TEXT NOT NULL,
        session_id      TEXT NOT NULL,

        page_url        TEXT,
        page_path       TEXT,
        referrer        TEXT,
        landing_page    TEXT,

        utm_source      TEXT,
        utm_medium      TEXT,
        utm_campaign    TEXT,
        utm_term        TEXT,
        utm_content     TEXT,

        device_type     TEXT,
        browser         TEXT,
        os              TEXT,
        screen_width    INTEGER,
        screen_height   INTEGER,

        event_props     TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_ae_created_at    ON analytics_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_ae_event_name    ON analytics_events(event_name);
      CREATE INDEX IF NOT EXISTS idx_ae_anonymous_id  ON analytics_events(anonymous_id);
      CREATE INDEX IF NOT EXISTS idx_ae_session_id    ON analytics_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_ae_user_id       ON analytics_events(user_id);
      CREATE INDEX IF NOT EXISTS idx_ae_utm_source    ON analytics_events(utm_source);
    `);

    // Migration: drop legacy table if it has the old schema (column "type" exists, no "event_name")
    try {
      const cols = _db.prepare(`PRAGMA table_info(analytics_events)`).all() as { name: string }[];
      const names = cols.map((c) => c.name);
      if (names.includes('type') && !names.includes('event_name')) {
        _db.exec(`ALTER TABLE analytics_events RENAME TO analytics_events_legacy_v1`);
        // Re-create new table
        _db.exec(`
          CREATE TABLE analytics_events (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            event_name TEXT NOT NULL,
            event_version INTEGER NOT NULL DEFAULT 1,
            user_id TEXT,
            anonymous_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            page_url TEXT, page_path TEXT, referrer TEXT, landing_page TEXT,
            utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
            device_type TEXT, browser TEXT, os TEXT, screen_width INTEGER, screen_height INTEGER,
            event_props TEXT NOT NULL DEFAULT '{}'
          );
        `);
      }
    } catch {
      /* ignore migration errors */
    }
  }
  return _db;
}

export interface AnalyticsEventInput {
  event_name: string;
  event_version?: number;
  user_id?: string | null;
  anonymous_id: string;
  session_id: string;
  page_url?: string | null;
  page_path?: string | null;
  referrer?: string | null;
  landing_page?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_term?: string | null;
  utm_content?: string | null;
  device_type?: string | null;
  browser?: string | null;
  os?: string | null;
  screen_width?: number | null;
  screen_height?: number | null;
  event_props?: Record<string, unknown>;
  created_at?: string | null;
}

const EVENT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function insertAnalyticsEvents(events: AnalyticsEventInput[]): number {
  if (!events || events.length === 0) return 0;
  const db = getAnalyticsDb();
  const stmt = db.prepare(`
    INSERT INTO analytics_events (
      id, created_at, event_name, event_version, user_id, anonymous_id, session_id,
      page_url, page_path, referrer, landing_page,
      utm_source, utm_medium, utm_campaign, utm_term, utm_content,
      device_type, browser, os, screen_width, screen_height,
      event_props
    ) VALUES (
      @id, COALESCE(@created_at, datetime('now')), @event_name, @event_version, @user_id, @anonymous_id, @session_id,
      @page_url, @page_path, @referrer, @landing_page,
      @utm_source, @utm_medium, @utm_campaign, @utm_term, @utm_content,
      @device_type, @browser, @os, @screen_width, @screen_height,
      @event_props
    )
  `);

  const insertMany = db.transaction((items: AnalyticsEventInput[]) => {
    let count = 0;
    for (const it of items) {
      if (!it || typeof it.event_name !== 'string' || !EVENT_NAME_RE.test(it.event_name)) continue;
      if (!it.anonymous_id || !it.session_id) continue;
      try {
        stmt.run({
          id: crypto.randomUUID(),
          created_at: it.created_at ?? null,
          event_name: it.event_name,
          event_version: it.event_version ?? 1,
          user_id: it.user_id ?? null,
          anonymous_id: String(it.anonymous_id).slice(0, 128),
          session_id: String(it.session_id).slice(0, 128),
          page_url: it.page_url ?? null,
          page_path: it.page_path ?? null,
          referrer: it.referrer ?? null,
          landing_page: it.landing_page ?? null,
          utm_source: it.utm_source ?? null,
          utm_medium: it.utm_medium ?? null,
          utm_campaign: it.utm_campaign ?? null,
          utm_term: it.utm_term ?? null,
          utm_content: it.utm_content ?? null,
          device_type: it.device_type ?? null,
          browser: it.browser ?? null,
          os: it.os ?? null,
          screen_width: it.screen_width ?? null,
          screen_height: it.screen_height ?? null,
          event_props: JSON.stringify(it.event_props ?? {}),
        });
        count++;
      } catch {
        /* skip bad row */
      }
    }
    return count;
  });

  return insertMany(events);
}

// ─── Returning user check ───
export function isReturningAnonymous(anonymous_id: string, before_iso?: string): boolean {
  const db = getAnalyticsDb();
  const row = db.prepare(`
    SELECT 1 FROM analytics_events
    WHERE anonymous_id = ? ${before_iso ? 'AND created_at < ?' : ''}
    LIMIT 1
  `).get(...(before_iso ? [anonymous_id, before_iso] : [anonymous_id]));
  return !!row;
}

// ─── Reporting helpers ───
function whereRange(from?: string, to?: string) {
  const params: Record<string, string> = {};
  let where = '1=1';
  if (from) { where += ' AND created_at >= @from'; params.from = from; }
  if (to)   { where += ' AND created_at <= @to';   params.to   = to + ' 23:59:59'; }
  return { where, params };
}

export interface AnalyticsSummary {
  total_events: number;
  unique_anonymous: number;
  unique_sessions: number;
  page_views: number;
  session_started: number;
  chat_started: number;
  message_sent: number;
  onboarding_completed: number;
  recommendations_shown: number;
  card_clicked: number;
  buy_clicked: number;
  return_visit: number;
}

export function getSummary(from?: string, to?: string): AnalyticsSummary {
  const db = getAnalyticsDb();
  const { where, params } = whereRange(from, to);
  // NOTE: the dashboard labels below use historical "semantic" names
  // (session_started, chat_started, card_clicked, etc.), but the ACTUAL
  // events our client fires are session_start, chat_message_sent,
  // card_expanded, buy_tickets_clicked, chat_response_received.
  // This query maps real event_name → dashboard label so the dashboard
  // actually reflects what's happening instead of displaying zeros.
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_events,
      COUNT(DISTINCT anonymous_id) AS unique_anonymous,
      COUNT(DISTINCT session_id)   AS unique_sessions,
      SUM(CASE WHEN event_name='page_view'                                       THEN 1 ELSE 0 END) AS page_views,
      SUM(CASE WHEN event_name IN ('session_start','session_started')            THEN 1 ELSE 0 END) AS session_started,
      -- "chat_started" = session-unique first chat_message_sent
      (SELECT COUNT(DISTINCT session_id) FROM analytics_events
        WHERE event_name='chat_message_sent' AND ${where})                                           AS chat_started,
      SUM(CASE WHEN event_name IN ('chat_message_sent','message_sent')           THEN 1 ELSE 0 END) AS message_sent,
      SUM(CASE WHEN event_name='onboarding_completed'                            THEN 1 ELSE 0 END) AS onboarding_completed,
      SUM(CASE WHEN event_name IN ('chat_response_received','recommendations_shown') THEN 1 ELSE 0 END) AS recommendations_shown,
      SUM(CASE WHEN event_name IN ('card_expanded','card_clicked')               THEN 1 ELSE 0 END) AS card_clicked,
      SUM(CASE WHEN event_name IN ('buy_tickets_clicked','buy_clicked')          THEN 1 ELSE 0 END) AS buy_clicked,
      SUM(CASE WHEN event_name='return_visit'                                    THEN 1 ELSE 0 END) AS return_visit
    FROM analytics_events WHERE ${where}
  `).get(params) as AnalyticsSummary;
  return row;
}

export function getFunnel(from?: string, to?: string): { step: string; sessions: number }[] {
  const db = getAnalyticsDb();
  const { where, params } = whereRange(from, to);
  // Each funnel step is expressed as an event_name filter. The human-readable
  // label is kept for UI; the filter matches both current and historical names.
  const funnelSteps: { step: string; names: string[] }[] = [
    { step: 'session_started',       names: ['session_start', 'session_started'] },
    { step: 'chat_started',          names: ['chat_message_sent'] },
    { step: 'recommendations_shown', names: ['chat_response_received', 'recommendations_shown'] },
    { step: 'card_clicked',          names: ['card_expanded', 'card_clicked'] },
    { step: 'buy_clicked',           names: ['buy_tickets_clicked', 'buy_clicked'] },
  ];
  return funnelSteps.map(({ step, names }) => {
    const placeholders = names.map((_, i) => `@n${i}`).join(',');
    const nameParams = Object.fromEntries(names.map((n, i) => [`n${i}`, n]));
    const r = db.prepare(`
      SELECT COUNT(DISTINCT session_id) AS sessions
      FROM analytics_events
      WHERE event_name IN (${placeholders}) AND ${where}
    `).get({ ...params, ...nameParams }) as { sessions: number };
    return { step, sessions: r.sessions };
  });
}

export function getDailyUniqueUsers(from?: string, to?: string): { day: string; dau: number; sessions: number }[] {
  const db = getAnalyticsDb();
  const { where, params } = whereRange(from, to);
  return db.prepare(`
    SELECT date(created_at) AS day,
           COUNT(DISTINCT anonymous_id) AS dau,
           COUNT(DISTINCT session_id)   AS sessions
    FROM analytics_events
    WHERE ${where}
    GROUP BY day ORDER BY day DESC
  `).all(params) as { day: string; dau: number; sessions: number }[];
}

export function getReturningUsersPct(from?: string, to?: string): number {
  const db = getAnalyticsDb();
  const { where, params } = whereRange(from, to);
  const r = db.prepare(`
    WITH per_user AS (
      SELECT anonymous_id, COUNT(DISTINCT session_id) AS sess
      FROM analytics_events WHERE ${where}
      GROUP BY anonymous_id
    )
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN sess > 1 THEN 1 ELSE 0 END) AS returning
    FROM per_user
  `).get(params) as { total: number; returning: number };
  if (!r || !r.total) return 0;
  return r.returning / r.total;
}

export function getUtmPerformance(from?: string, to?: string): { utm_source: string; sessions: number; buy_clicked: number; rec_shown: number }[] {
  const db = getAnalyticsDb();
  const { where, params } = whereRange(from, to);
  return db.prepare(`
    SELECT
      COALESCE(utm_source, '(direct)') AS utm_source,
      COUNT(DISTINCT session_id) AS sessions,
      SUM(CASE WHEN event_name IN ('buy_tickets_clicked','buy_clicked') THEN 1 ELSE 0 END) AS buy_clicked,
      SUM(CASE WHEN event_name IN ('chat_response_received','recommendations_shown') THEN 1 ELSE 0 END) AS rec_shown
    FROM analytics_events
    WHERE ${where}
    GROUP BY utm_source
    ORDER BY sessions DESC
    LIMIT 25
  `).all(params) as { utm_source: string; sessions: number; buy_clicked: number; rec_shown: number }[];
}

export function getTopClickedEvents(from?: string, to?: string, limit = 20): { event_id: string; clicks: number; buys: number }[] {
  const db = getAnalyticsDb();
  const { where, params } = whereRange(from, to);
  return db.prepare(`
    SELECT
      json_extract(event_props, '$.event_id') AS event_id,
      SUM(CASE WHEN event_name IN ('card_expanded','card_clicked')         THEN 1 ELSE 0 END) AS clicks,
      SUM(CASE WHEN event_name IN ('buy_tickets_clicked','buy_clicked')    THEN 1 ELSE 0 END) AS buys
    FROM analytics_events
    WHERE ${where} AND json_extract(event_props, '$.event_id') IS NOT NULL
    GROUP BY event_id
    ORDER BY clicks DESC
    LIMIT @limit
  `).all({ ...params, limit }) as { event_id: string; clicks: number; buys: number }[];
}

export function getAvgRecommendationsLatency(from?: string, to?: string): number {
  const db = getAnalyticsDb();
  const { where, params } = whereRange(from, to);
  const r = db.prepare(`
    SELECT AVG(CAST(json_extract(event_props, '$.latency_ms') AS REAL)) AS avg_ms
    FROM analytics_events
    WHERE event_name IN ('chat_response_received','recommendations_shown') AND ${where}
      AND json_extract(event_props, '$.latency_ms') IS NOT NULL
  `).get(params) as { avg_ms: number | null };
  return Math.round(r?.avg_ms || 0);
}

export function getRecentEvents(from?: string, to?: string, limit = 200): { created_at: string; event_name: string; anonymous_id: string; session_id: string; page_path: string | null; utm_source: string | null; event_props: string }[] {
  const db = getAnalyticsDb();
  const { where, params } = whereRange(from, to);
  return db.prepare(`
    SELECT created_at, event_name, anonymous_id, session_id, page_path, utm_source, event_props
    FROM analytics_events
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT @limit
  `).all({ ...params, limit }) as never;
}
