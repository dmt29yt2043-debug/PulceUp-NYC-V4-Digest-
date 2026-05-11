# QA Audit — Итоговый Вердикт

**Сгенерировано**: 2026-04-23
**Live pool**: 204 событий

---

## Главный вопрос

> **Если событие есть в базе, гарантированно ли мы показываем его пользователю в нужный момент?**

**Ответ**: 🟡 Частично.

Средний coverage фильтров: **79%**. Это значит, что в среднем из 100 потенциально подходящих событий в базе пользователь увидит только 79.

---

## Scorecard (0-100)

| Axis | Score | Interpretation |
|---|---:|---|
| Filter correctness | 100 | % возвращаемых событий, которые реально подходят под фильтр |
| Filter coverage | 79 | % подходящих событий из БД, которые доходят до юзера |
| Digest quality | 94 | средний LLM-judge score × 20 (5=макс) |
| Chat quality | 67 | средний relevance × 20 (5=макс) |
| Ranking quality | 78 | NDCG@10 × 100 |
| Scenario pass-rate | 90 | % end-to-end сценариев, где юзер видит хотя бы один релевантный event в топ-10 |

**Overall: 85/100** → в десятичной шкале ≈ **8.5/10**

---

## Где bottleneck

- **Chat** — LLM часто извлекает слишком узкий фильтр, пропускает ivents

---

## Распределение проблем

### Filters (26 сценариев)
- PASS: 18
- WARN: 8  ← главный вклад: плохой coverage
- FAIL: 0

### Chat (20 запросов)
- good_match: 4
- partial_match: 13
- db_gap (нет в базе): 2
- pipeline_issue (баг): 1
- Hallucinations (упомянул event вне списка): 5

### Ranking
- Mean NDCG@10: **0.775** (0.85+ хорошо · 0.7-0.85 OK · <0.7 сломан)
- Запросов с NDCG < 0.7: 3/10

### Scenarios (end-to-end)
- PASS: 18
- WARN: 2
- FAIL: 0

### Digests
- **weekend-kids-nyc**: avg-judge=4.40/5 · rule-bugs=1 · weak-fits=1 · missed-strong=10
- **indoor-rainy-day**: avg-judge=4.90/5 · rule-bugs=1 · weak-fits=0 · missed-strong=5
- **easy-no-planning**: avg-judge=4.30/5 · rule-bugs=0 · weak-fits=1 · missed-strong=7
- **free-affordable**: avg-judge=5.00/5 · rule-bugs=0 · weak-fits=0 · missed-strong=12
- **kids-love-parents-approve**: avg-judge=4.90/5 · rule-bugs=0 · weak-fits=0 · missed-strong=14

### HTTP Smoke — prod vs local
- **Prod** (https://pulseup.me): 14/14 passed
- **Local** (localhost:3000): 14/14 passed



Средняя latency прод: 719ms · локально: 374ms

---

## Топ-3 рекомендации

1. **Починить возрастной фильтр.** Главная находка. В `lib/db.ts` правило "wide-range-starting-in-toddler" (строки ~208-223) исключает events типа `[3-12]` для 7-летнего, потому что range широкий и начинается в toddler territory. Это убирает из выдачи десятки нормальных events. Либо удалить, либо смягчить (только для возраста ≥ 10, и только когда age_best_from ≤ 2).

2. **Добавить ranking score.** Сейчас просто сортировка по дате. Запросы типа "science for 7yo" возвращают science-события в глубине списка, а сверху случайные family events. Простая relevance-метрика (кол-во матчей query terms в title/tags + recency + rating) поднимет NDCG с 0.78 до ~0.9.

3. **Расширить маппинг категорий.** В БД только 9 событий с `category_l1='science'`, но loose predicate находит гораздо больше science-adjacent events по tags. Chat/UI фильтры берут только l1. Либо добавить маппинг l1 → synonym tags, либо дообогатить category_l1 по tags.

---

## Что делать сейчас vs что отложить

### Сейчас
- Починить возрастной фильтр (30 минут) → coverage прыгнет с 79% до ~85%+
- Добавить ranking (1-2 часа) → NDCG 0.78 → 0.85+

### Позже
- Обогатить category_l1 для событий с science/theater/food tags
- Chat prompt tuning (сейчас часто ставит слишком узкий фильтр)
- Автотест на регрессии (запускать 6 QA скриптов в CI)
