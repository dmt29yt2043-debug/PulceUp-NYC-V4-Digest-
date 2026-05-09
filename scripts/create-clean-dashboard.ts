/**
 * Create the "PulseUp Funnel — Simple" dashboard.
 *
 * One clear answer per insight. No technical jargon. Maps directly to the
 * 5 questions the user asked:
 *   1. How many came to quiz
 *   2. How many came from quiz to main site
 *   3. How many engaged on main site (clicked anything)
 *   4. How many clicked Buy Ticket
 *   5. How many saw the research bubble + clicked it + filled it
 *
 * Designed so a non-engineer can open the dashboard and immediately see:
 *   - the daily numbers (Bold Number widgets)
 *   - the trend over time (Line chart)
 *   - the conversion funnel (Funnel widget)
 */

import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env.local') });

const PHX = process.env.POSTHOG_PERSONAL_KEY;
const PID = '389973';
const HOST = 'https://us.posthog.com';

if (!PHX) { console.error('Missing POSTHOG_PERSONAL_KEY'); process.exit(1); }

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers: { Authorization: `Bearer ${PHX}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
  return JSON.parse(text) as T;
}

const QUIZ_HOST = [{ key: '$host', value: 'quiz.pulseup.me', operator: 'exact', type: 'event' }];
const MAIN_HOST = [{ key: '$host', value: 'pulseup.me', operator: 'exact', type: 'event' }];

function evt(event: string, name: string, host: 'quiz' | 'main', math: 'dau' | 'total' = 'dau') {
  return {
    kind: 'EventsNode',
    event,
    name,
    math,
    properties: host === 'quiz' ? QUIZ_HOST : MAIN_HOST,
  };
}

interface InsightDef {
  name: string;
  description: string;
  query: Record<string, unknown>;
}

const INSIGHTS: InsightDef[] = [
  // ============== BIG NUMBERS — Top of dashboard ==============

  // 1. Came to quiz
  {
    name: '1️⃣ Сколько людей пришло на КВИЗ',
    description: 'Уникальные пользователи которые открыли quiz.pulseup.me. Сравни с FB Ads "Link Clicks".',
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'TrendsQuery',
        dateRange: { date_from: '-7d' },
        interval: 'day',
        series: [evt('$pageview', 'Came to quiz', 'quiz')],
        trendsFilter: { display: 'BoldNumber' },
      },
    },
  },

  // 2. Came to main site (any way — via quiz or direct)
  {
    name: '2️⃣ Сколько ДОШЛО до сайта (pulseup.me)',
    description: 'Уникальные пользователи на главном сайте. Включает приходящих с квиза и напрямую.',
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'TrendsQuery',
        dateRange: { date_from: '-7d' },
        interval: 'day',
        series: [evt('session_start', 'On main site', 'main')],
        trendsFilter: { display: 'BoldNumber' },
      },
    },
  },

  // 3. From quiz → main (cross-domain bridge)
  {
    name: '3️⃣ Из них с КВИЗА перешли на сайт',
    description: 'Пользователи которые прошли весь квиз и долетели до pulseup.me. Identity-bridged через quiz_phid.',
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'TrendsQuery',
        dateRange: { date_from: '-7d' },
        interval: 'day',
        series: [evt('quiz_arrival', 'From quiz', 'main')],
        trendsFilter: { display: 'BoldNumber' },
      },
    },
  },

  // 4. Engaged on site (clicked anything)
  {
    name: '4️⃣ Кликнули что-то на сайте (filter / digest / card)',
    description: 'Любое осмысленное действие: применили фильтр, выбрали дайджест, открыли карточку. Не считается просто прокрутка.',
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'TrendsQuery',
        dateRange: { date_from: '-7d' },
        interval: 'day',
        series: [
          evt('filter_applied', 'engaged_filter', 'main'),
          evt('digest_selected', 'engaged_digest', 'main'),
          evt('card_expanded', 'engaged_card', 'main'),
        ],
        trendsFilter: { display: 'BoldNumber', formula: 'A+B+C' },
      },
    },
  },

  // 5. Clicked Buy Ticket
  {
    name: '5️⃣ Нажали "Купить билет"',
    description: 'Конверсия в покупку: клик на кнопку "Buy ticket" в карточке события.',
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'TrendsQuery',
        dateRange: { date_from: '-7d' },
        interval: 'day',
        series: [evt('buy_tickets_clicked', 'Buy clicks', 'main')],
        trendsFilter: { display: 'BoldNumber' },
      },
    },
  },

  // 6. Research funnel
  {
    name: '6️⃣ Воронка ИССЛЕДОВАНИЯ',
    description: 'Кому показалась плашка "We\'re still improving this" → кто кликнул "Tell me more" → дошли до research4.pulseup.me. Заполнение исследования трекается отдельно (research4 — другой домен).',
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'FunnelsQuery',
        dateRange: { date_from: '-14d' },
        series: [
          evt('research_shown', 'Saw research bubble', 'main', 'total'),
          evt('research_cta_clicked', 'Clicked "Tell me more"', 'main', 'total'),
        ],
        funnelsFilter: { funnelVizType: 'steps', funnelOrderType: 'ordered' },
      },
    },
  },

  // 7. THE FULL FUNNEL — across domains
  {
    name: '🎯 ПОЛНАЯ ВОРОНКА: FB → Квиз → Сайт → Покупка',
    description: 'Главный график. От FB-клика до покупки билета. Включает ВСЕ шаги.',
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'FunnelsQuery',
        dateRange: { date_from: '-14d' },
        series: [
          evt('$pageview', '1. Пришёл на квиз', 'quiz', 'total'),
          evt('quiz_started', '2. Квиз загрузился', 'quiz', 'total'),
          evt('quiz_completed', '3. Прошёл квиз до конца', 'quiz', 'total'),
          evt('quiz_arrival', '4. Долетел до сайта', 'main', 'total'),
          evt('card_expanded', '5. Открыл карточку', 'main', 'total'),
          evt('buy_tickets_clicked', '6. Нажал Купить', 'main', 'total'),
        ],
        funnelsFilter: {
          funnelVizType: 'steps',
          funnelOrderType: 'ordered',
          funnelWindowInterval: 24,
          funnelWindowIntervalUnit: 'hour',
        },
      },
    },
  },

  // 8. Daily trend chart
  {
    name: '📈 Тренд по дням — landing → engagement → buy',
    description: 'Видно как все 4 ключевые метрики меняются от дня к дню. Полезно сравнивать с ad spend в FB.',
    query: {
      kind: 'InsightVizNode',
      source: {
        kind: 'TrendsQuery',
        dateRange: { date_from: '-14d' },
        interval: 'day',
        series: [
          evt('$pageview', 'Came to quiz', 'quiz'),
          evt('session_start', 'On main site', 'main'),
          evt('card_expanded', 'Opened card', 'main'),
          evt('buy_tickets_clicked', 'Clicked Buy', 'main'),
        ],
        trendsFilter: { display: 'ActionsLineGraph' },
      },
    },
  },
];

interface CreatedDashboard { id: number }
interface CreatedInsight { id: number; short_id: string }

async function main() {
  console.log('Creating clean dashboard...');

  const dash = await api<CreatedDashboard>('POST', `/api/projects/${PID}/dashboards/`, {
    name: '🎯 PulseUp — главные метрики',
    description:
      'Простой дашборд под 5 ключевых вопросов:\n' +
      '1. Сколько пришло на квиз\n' +
      '2. Сколько дошло до сайта\n' +
      '3. Сколько с квиза перешло на сайт\n' +
      '4. Сколько кликнуло на сайте\n' +
      '5. Сколько нажало Купить\n' +
      '6. Сколько увидели/открыли исследование\n\n' +
      `Создан: ${new Date().toISOString().slice(0, 10)}`,
    pinned: true,
  });
  console.log(`  Dashboard id=${dash.id}`);

  for (const def of INSIGHTS) {
    const insight = await api<CreatedInsight>('POST', `/api/projects/${PID}/insights/`, {
      name: def.name,
      description: def.description,
      query: def.query,
      dashboards: [dash.id],
    });
    console.log(`  ✓ ${def.name}`);
  }

  console.log(`\n✅ Готово:`);
  console.log(`   ${HOST}/project/${PID}/dashboard/${dash.id}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
