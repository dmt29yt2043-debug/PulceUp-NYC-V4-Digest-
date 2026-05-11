# PulseUp — Full System QA Audit Plan

**Scope**: digests · filters · chat · DB-vs-output · ranking · real-user scenarios
**Goal**: прямой ответ на вопрос — "если событие есть в базе, гарантированно ли мы его показываем пользователю в нужный момент?"
**Pool**: 197 live events (42 Kings/Brooklyn, 64 NY/Manhattan, 117 free).

---

## 0 · Что уже есть

| Актив | Покрытие | Статус |
|---|---|---|
| `scripts/test-filters.ts` | 15 filter-сценариев, SQL-level correctness | ✅ работает (14/15 PASS) |
| `scripts/digests-audit.ts` | старый аудит digest'ов (до переписи) | 🟡 нужно актуализировать |
| `scripts/eval-chat.ts` | чат-eval (25 сценариев, GPT-4o judge) | 🟡 есть, но результаты устарели |
| `qa/test_cases/test_cases.json` | набор тест-кейсов | 🟡 устарел (старая схема) |
| `data/events.db` | live pool 197 событий | ✅ свежая БД |

Что НЕ покрыто вообще:
- Digest → contents соответствие (false positives/negatives на semantic уровне)
- DB coverage (сколько потенциально-релевантных событий мы пропускаем)
- Ranking quality (у нас просто `next_start_at ASC` — никакого relevance score)
- End-to-end UX scenarios (filters + chat + digests одновременно)

---

## 1 · Архитектура аудита

Три слоя с разной ценой токенов:

### Layer A — детерминированный (SQL + predicates)
Быстрый, дешёвый, 0 LLM calls. Для всего, что можно выразить правилом.
- Filter correctness (age, price, location, isFree) ← **уже есть**
- Digest rule-based checks (нет outdoor-формата в Indoor digest, Weekend events падают на Sat/Sun, etc.)
- Coverage metric: сколько DB-событий могли бы попасть в ответ vs попали

### Layer B — LLM-judge (GPT-4o-mini)
Для semantic relevance, где правилом не описать.
- Digest semantic fit: "подходит ли event к обещанию digest'а?" — 5 digests × 10-15 events ≈ 65 calls
- Chat response quality: "правильный ли ответ?" — 20 сценариев × 1 call
- Ranking sanity: "являются ли топ-5 лучшими для query?" — 10 сценариев × 1 call
- Total: ~95 LLM calls, ~$0.30-0.50

### Layer C — End-to-end simulation
- 20 реальных user-scenarios (NYC mom persona)
- Полный путь: set filters → look at feed → click digest → send chat message
- Замер: получил ли пользователь top-3 релевантных события в первых 10?

---

## 2 · Deliverables (артефакты)

| Файл | Содержимое | Layer |
|---|---|---|
| `scripts/qa/01-db-inventory.ts` | Перепись DB: distribution по age, county, format, is_free, rating, category. Нужно для baseline. | A |
| `scripts/qa/02-filter-audit.ts` | Расширение `test-filters.ts`: 25+ сценариев, каждый с независимым predicate. | A |
| `scripts/qa/03-digest-audit.ts` | Для каждого из 5 digests: (1) правило-based check, (2) LLM-judge каждого event, (3) false-negative sweep — какие DB-события judge сочёл бы подходящими, но их нет в digest. | A + B |
| `scripts/qa/04-chat-audit.ts` | 20 реалистичных queries → chat API → GPT-4o judge оценивает: correctness, coverage, hallucinations. Сравнивает с "gold set" из DB. | B |
| `scripts/qa/05-ranking-audit.ts` | Для 10 queries: берём top-20 результатов, LLM ранжирует их по релевантности, сравниваем с нашим порядком. Метрика: NDCG@10. | B |
| `scripts/qa/06-scenarios.ts` | 20 NYC-mom persona scenarios end-to-end (filters + chat). Каждый scenario → bug list. | A + B |
| `scripts/qa/run-all.ts` | Orchestrator, запускает все 6 в правильном порядке, агрегирует в отчёт. | — |
| `reports/qa/raw-results.json` | Machine-readable: все сценарии, все diffs, все judge verdicts. | — |
| `reports/qa/bugs.md` | Prioritized bug list (Critical / Medium / Low) с fix suggestions. | — |
| `reports/qa/verdict.md` | Final scorecard (0-10) + ответы на главный вопрос + рекомендации. | — |

---

## 3 · Тест-сценарии (детализация)

### Block 1 — Digest Validation (5 digests)

Для каждого digest:
1. **Rule check**: применимо правило к каждому event? (Weekend → есть Sat/Sun date; Indoor → format не в OUTDOOR_FORMATS; Affordable → price_max ≤ 30 или is_free; etc.)
2. **Semantic check** (LLM): "Is this event a good fit for '{digest_title}'? Rate 1-5."
3. **False-negative sweep**: взять все live events, найти те, что rule-match, но отсутствуют в digest.

Ожидаемый output per digest:
```json
{
  "digest": "indoor-rainy-day",
  "target_size": 10,
  "actual_size": 10,
  "rule_violations": [{ "event_id": 882, "title": "...", "reason": "format=outdoor-festival" }],
  "semantic_scores": { "avg": 4.2, "below_3": ["event_id 1234"] },
  "missed_candidates": [
    { "event_id": 1017, "title": "Meet the Animals", "why_should_fit": "...", "judge_score": 5 }
  ]
}
```

### Block 2 — Filter Testing (25+ scenarios)

Расширяю `test-filters.ts` — покрытие:
- Age: 0, 2, 4, 7, 10, 14 (6 bands)
- Age + gender: 7yo girl, 10yo boy (2)
- Multi-child: [4,10], [2,7,12] (2)
- Single category: arts, science, music, outdoors, theater, books (6)
- Location: Manhattan, Brooklyn, Queens, Bronx (4)
- Price: free, under-$25, under-$50 (3)
- Date: today, tomorrow, this weekend (3)
- Combos: 4yo+Brooklyn+free, 7yo+science+Manhattan, teen+Brooklyn (3+)

Для каждого:
- **Correctness**: каждый returned event проходит predicate
- **Coverage**: сколько events из DB должны были пройти (independent predicate) vs прошло
- **Precision/Recall** numbers

### Block 3 — DB vs Output (самый важный)

Для 15 ключевых queries:
1. Run query через `getEvents()`
2. Independently scan всю live DB с более slack predicate ("could reasonably fit")
3. Gold set = DB scan results
4. Actual set = what we return in top-20
5. Metrics:
   - Recall = |actual ∩ gold| / |gold|
   - Precision = |actual ∩ gold| / |actual|
   - False negatives list (gold but not shown)

### Block 4 — Chat Testing (20 queries)

Realistic NYC-mom queries:
- "things to do this weekend with 4 and 7 year old"
- "science museum for 5yo"
- "cheap rainy-day activities"
- "teen hangouts Brooklyn"
- "stroller-friendly nature walk"
- "last-minute plan today"
- "after-school Tuesday"
- "birthday party venue"
- "free outdoor Saturday Manhattan"
- "bilingual Spanish storytime"
- ... (20 total)

Для каждого:
1. POST /api/chat с профилем "NYC mom, 2 kids ages 4 and 7"
2. Parse response: какие events упомянуты? какие filters extracted?
3. Судья GPT-4o-mini: "Are the mentioned events relevant? Are filters correct? Are there obvious missed candidates from the DB snippet?"
4. Bug tags: hallucinated / missed-strong-candidate / wrong-filters / too-narrow / good

### Block 5 — Ranking Quality (10 queries)

Проблема: у нас сейчас `ORDER BY next_start_at ASC` — ранжирования по релевантности нет вообще.

Для 10 queries:
- Fetch top-20 returned events
- GPT-4o-mini ranks them 1-20 by relevance to query
- Compute NDCG@10 между нашим порядком и LLM-порядком
- Score > 0.7 = OK, < 0.5 = ranking фактически не работает

Ожидаю: все 10 будут failed. Это ground truth что ranking system отсутствует.

### Block 6 — Real User Simulation (20 scenarios)

Каждый scenario = состояние (filters + chat history):
```
S1: Mom opens app → sets "Who: 4yo girl" → browses feed
  Checks: feed has kid-appropriate events? No teen events?

S2: Mom sets filters + sends "any science this weekend" in chat
  Checks: chat response fuses filter state? Mentions weekend science?

S3: Mom clicks "Easy" digest
  Checks: all events look low-effort / free / drop-in?

...
```
Каждый scenario — bug/no-bug + описание.

### Block 7 — Bug Report
Сведу все issues:
- **Critical**: событие в базе есть, но пользователь его не увидит (false negatives, broken queries, 500s)
- **Medium**: ranking misses, частичные category mismatches
- **Low**: UX / label mismatches

### Block 8 — Final Verdict
Scorecard 0-10 по осям:
- Filter correctness
- Filter coverage
- Digest quality
- Chat quality
- Ranking quality
- Overall DB utilization

---

## 4 · Стоимость и время

| Ресурс | Оценка |
|---|---|
| LLM calls (GPT-4o-mini) | ~150-200 calls, **$0.50-$0.80** |
| Кодинг (test harness) | **2-3 часа** моего времени |
| Test execution | **10-15 минут** (включая LLM round-trips) |
| Репорт генерация | **5 минут** |

---

## 5 · Что делаю, что НЕ делаю

### Делаю
- Все 6 тест-скриптов
- Полный отчёт (JSON + Markdown)
- Prioritized bug list с конкретными fix pointers
- NDCG ranking metric
- False-negative DB sweeps

### НЕ делаю (out of scope)
- Map functionality (вы сказали игнорировать)
- Load testing / performance (уже есть в qa/scripts/)
- Security audit (уже есть)
- Actual fixes (сначала диагноз, потом решим что чинить)

### Assumptions
- БД snapshot не меняется во время аудита (использую `data/events.db` на момент запуска)
- OpenAI API key в `.env.local` работает (для LLM-judge)
- Chat API endpoint доступен локально (нужен `npm run dev` или удар по prod)

---

## 6 · Execution plan (порядок)

**Phase 1 — Baseline (30 мин, $0)**
- `01-db-inventory.ts`
- `02-filter-audit.ts` (расширенная версия test-filters)
- Вывод: числа по coverage каждого поля, filter correctness %

**Phase 2 — Digest deep-dive (45 мин, ~$0.15)**
- `03-digest-audit.ts`
- Вывод: per-digest issues, missed candidates

**Phase 3 — Chat & Ranking (60 мин, ~$0.40)**
- `04-chat-audit.ts`
- `05-ranking-audit.ts`
- Вывод: chat hallucinations, ranking NDCG

**Phase 4 — Scenarios & Report (30 мин, ~$0.15)**
- `06-scenarios.ts`
- Aggregation into `bugs.md` and `verdict.md`

Суммарно: **~2.5-3 часа**, **~$0.70** в токенах.

---

## 7 · Открытые вопросы перед стартом

1. **Судья**: GPT-4o-mini или GPT-4o? Mini в 10× дешевле и достаточен для классификации; 4o даёт качественнее reasoning. Моё мнение: 4o-mini.
2. **Chat API**: бьём локально (нужен dev server) или по prod (https://pulseup.me/api/chat)? Prod быстрее и реалистичнее — предлагаю prod.
3. **Scope digests**: аудит всех 5 или только первых 3? Предлагаю всех 5 — работа параллельна, не стоит экономить.
4. **Output language**: markdown-отчёты на русском или английском? Код + JSON всегда English; репорты — на русском, чтобы ты мог читать прямо.

---

**Готов начать** по твоему ОК. Можно запустить целиком или по блокам. Если хочешь — сначала покажу 1-2 скрипта в детали, обсудим, потом всё остальное.
