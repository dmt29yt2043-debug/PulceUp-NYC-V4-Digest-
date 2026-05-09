import * as dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '.env.local') });
const PHX = process.env.POSTHOG_PERSONAL_KEY;
async function hogql(sql: string) {
  const res = await fetch(`https://us.posthog.com/api/projects/389973/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PHX}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql } }),
  });
  return (await res.json()).results ?? [];
}

async function main() {
  const r = await hogql(`
    SELECT
      countIf(properties.$host='quiz.pulseup.me' AND event='$pageview') AS came_to_quiz,
      countIf(properties.$host='pulseup.me' AND event='session_start') AS on_main,
      countIf(properties.$host='pulseup.me' AND event='quiz_arrival') AS from_quiz,
      countIf(properties.$host='pulseup.me' AND event IN ('filter_applied','digest_selected','card_expanded')) AS engaged,
      countIf(properties.$host='pulseup.me' AND event='buy_tickets_clicked') AS clicked_buy,
      countIf(properties.$host='pulseup.me' AND event='research_shown') AS saw_research,
      countIf(properties.$host='pulseup.me' AND event='research_cta_clicked') AS clicked_research
    FROM events
    WHERE timestamp >= now() - INTERVAL 7 DAY
  `);
  const [q,m,fq,e,b,sr,cr] = r[0]||[];
  console.log('═══ Цифры за 7 дней ═══');
  console.log(`1. Пришли на КВИЗ:            ${q}`);
  console.log(`2. Открыли главный САЙТ:      ${m}`);
  console.log(`3. С квиза перешли на сайт:   ${fq}`);
  console.log(`4. Кликнули что-то на сайте:  ${e}  (filter+digest+card)`);
  console.log(`5. Нажали "Buy ticket":       ${b}`);
  console.log(`6. Увидели исследование:      ${sr}  (только начнут считаться после деплоя)`);
  console.log(`   Кликнули "Tell me more":   ${cr}`);
}
main();
