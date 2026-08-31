# Game Goods Backend

Самостоятельный backend тестового магазина цифровых товаров. Проект содержит
Fastify API, PostgreSQL, миграции, seed каталога и кодов, фонового worker,
эмуляторы двух поставщиков, reconciliation, double-entry ledger и интеграционные
тесты. Frontend в этот образ не встроен и запускается отдельным проектом.

Парный самостоятельный frontend:
<https://github.com/ps5tur5-sketch/Store-Frontend>.

## Быстрый запуск

Нужен только Docker с Compose plugin. Node.js, npm и PostgreSQL на хосте не нужны.

```bash
docker compose up -d --build
```

После запуска:

- API: <http://127.0.0.1:3000>;
- healthcheck: <http://127.0.0.1:3000/health>;
- PostgreSQL: `127.0.0.1:5432`;
- миграции `001`–`005` и seed выполняются автоматически;
- данные базы сохраняются в именованном volume.

Проверка:

```bash
docker compose ps
curl http://127.0.0.1:3000/health
docker compose logs -f backend
```

Остановка без удаления данных:

```bash
docker compose down
```

Полный сброс тестовой базы — разрушительная операция:

```bash
docker compose down -v
docker compose up -d --build
```

## Настройка через `.env`

Compose читает `.env` из корня backend. Для переноса на сервер код менять не
нужно.

| Переменная | Default | Назначение |
|---|---:|---|
| `BACKEND_BIND_IP` | `0.0.0.0` | интерфейс публикации API |
| `BACKEND_PORT` | `3000` | внешний порт API |
| `POSTGRES_BIND_IP` | `127.0.0.1` | интерфейс публикации PostgreSQL |
| `POSTGRES_PORT` | `5432` | внешний порт PostgreSQL |
| `POSTGRES_DB` | `hr` | имя базы |
| `POSTGRES_USER` | `hr` | пользователь базы |
| `POSTGRES_PASSWORD` | `hr` | пароль тестовой базы |
| `LOG_LEVEL` | `info` | уровень JSON-логов |
| `WORKER_ENABLED` | `true` | автоматическая выдача товаров |
| `WORKER_POLL_MS` | `200` | интервал worker |
| `RECOVERY_POLL_MS` | `5000` | интервал восстановления |
| `SUPPLIER_TIMEOUT_MS` | `300` | HTTP timeout поставщика |
| `SUPPLIER_MAX_ATTEMPTS` | `3` | число попыток |
| `SUPPLIER_BACKOFF_MS` | `50` | база exponential backoff |
| `ENABLE_TEST_CONTROLS` | `true` | вспомогательные endpoints стенда |

Пример публикации на сервере:

```dotenv
BACKEND_BIND_IP=0.0.0.0
BACKEND_PORT=3000
POSTGRES_BIND_IP=127.0.0.1
```

После изменения `.env` достаточно:

```bash
docker compose up -d --build
```

Backend включает универсальный CORS (`origin: true`), поэтому frontend может
работать с другого IP/порта. Это сознательная настройка тестового стенда без
защиты; для production нужны авторизация admin API, ограниченный CORS, HTTPS,
секрет webhook и реальные пароли.

## Пользовательская модель

1. Регистрация выполняется по логину и паролю, без email.
2. Новый пользователь получает ровно 5000 баллов.
3. Товары сначала добавляются в серверную корзину.
4. Checkout оплачивается баллами либо одноразовым кодом и баллами вместе.
5. На каждую единицу корзины создаётся отдельный заказ.
6. Worker случайно резервирует свободный товарный ключ и сохраняет его в покупке.
7. История покупок возвращается от новой к старой.

### Расчёт платёжного кода

Номинал каждого кода хранится в `payment_codes.value_points`. Код никогда не
покрывает всю корзину сам по себе, если его номинал меньше стоимости:

```text
code_applied_points = min(code_value_points, total_points)
points_charged      = total_points - code_applied_points
balance_after       = balance_before - points_charged
```

Пример: корзина `10739`, код `5000`, баланс `5000` → с баланса требуется `5739`,
поэтому checkout отклоняется с `insufficient_points`; код не расходуется.

Пример: корзина `7500`, код `5000`, баланс `5000` → код вычитает `5000`, с
баланса списывается `2500`, остаток баланса `2500`; после commit код одноразово
помечается использованным.

`POST /api/cart/quote` делает read-only расчёт для интерфейса. Он не погашает код.
`POST /api/cart/checkout` повторяет расчёт внутри PostgreSQL-транзакции с lock
пользователя и кода. Ответ checkout содержит:

```json
{
  "checkout_id": "chk_example",
  "method": "code",
  "total_points": 7500,
  "code_value_points": 5000,
  "code_applied_points": 5000,
  "points_charged": 2500,
  "balance_after": 2500,
  "order_ids": ["ord_...", "ord_...", "ord_..."]
}
```

50 конкретных строк из ТЗ seed-ятся и как складские ключи, и как независимые
одноразовые платёжные коды начального номинала 5000. Новые платёжные коды с
произвольным номиналом до 10 000 000 добавляются через admin API. Расходование
платёжного кода не расходует одноимённую складскую запись.

Любой новый складской ключ из `POST /api/admin/inventory` автоматически становится
и платёжным кодом. Его номинал равен цене выбранного SKU, а `source_sku` хранит
источник. Если код уже был явно создан как платёжный, его ручной номинал не
перезаписывается. Миграция `005` регистрирует этим же способом ранее добавленные
складские ключи.

## Основные API

Все ответы JSON. Пользовательские endpoints после регистрации требуют заголовок
`Authorization: Bearer TOKEN`.

| Method | Path | Назначение |
|---|---|---|
| `GET` | `/health` | readiness API и базы |
| `GET` | `/api/catalog` | каталог, поиск, фильтр, пагинация |
| `GET` | `/api/catalog/:sku` | товар, описание и характеристики |
| `POST` | `/api/auth/register` | регистрация login/password + 5000 |
| `POST` | `/api/auth/login` | новая bearer-session |
| `POST` | `/api/auth/logout` | удалить текущую session |
| `GET` | `/api/account` | пользователь, баланс, транзакции |
| `GET` | `/api/cart` | корзина пользователя |
| `POST` | `/api/cart/items` | добавить SKU и количество |
| `PUT` | `/api/cart/items/:sku` | установить количество |
| `DELETE` | `/api/cart/items/:sku` | удалить строку |
| `POST` | `/api/cart/quote` | рассчитать код и остаток оплаты |
| `POST` | `/api/cart/checkout` | атомарно купить корзину |
| `GET` | `/api/account/purchases` | история, новые сверху |
| `GET` | `/api/account/purchases/:id` | полная карточка и выданный код |
| `POST` | `/api/orders` | низкоуровневое создание заказа |
| `GET` | `/api/orders/:id` | состояние и попытки доставки |
| `POST` | `/api/orders/:id/simulate-payment` | эмуляция `paid`/`failed` |
| `POST` | `/webhook/payment` | контракт платёжного webhook |

Admin/recovery endpoints открыты намеренно:

| Method | Path | Назначение |
|---|---|---|
| `GET/POST` | `/api/admin/inventory` | складские ключи + автосоздание кода по цене SKU |
| `GET/POST` | `/api/admin/payment-codes` | одноразовые платёжные коды и номиналы |
| `GET` | `/api/admin/suppliers` | chaos-настройки поставщиков |
| `PUT` | `/api/admin/suppliers/:provider` | изменить режим A/B |
| `POST` | `/api/admin/workers/run` | вручную обработать delivery jobs |
| `GET` | `/api/admin/summary` | заказы, склад и ledger |
| `GET` | `/api/reconciliation` | найти аномалии |
| `POST` | `/api/reconciliation/recover` | безопасное восстановление |

Добавление платёжных кодов:

```bash
curl -X POST http://127.0.0.1:3000/api/admin/payment-codes \
  -H 'content-type: application/json' \
  -d '{"codes":["MY-CODE-5000"],"value_points":5000}'
```

## Надёжность выдачи

- `payment_events.event_id` уникален, повторы webhook идемпотентны;
- advisory transaction lock сериализует изменения заказа;
- один durable `delivery_job` и стабильный `request_id` на заказ;
- worker использует `FOR UPDATE SKIP LOCKED` и lease;
- поставщик идемпотентен по `(provider, request_id)`;
- delivery, складской code и наблюдаемый delivery fact уникальны;
- `timeout_after_issue` повторяется на том же поставщике без unsafe fallback;
- явные `5xx`/`out_of_stock` разрешают A→B fallback;
- recovery поднимает pending events, истёкшие leases и оплаченные заказы без
  доставки;
- каждая операция оплаты создаёт сбалансированную double-entry проводку.

## Тесты

Тесты полностью запускаются в Docker и используют отдельный PostgreSQL на tmpfs:

```bash
docker compose --profile test run --rm --build tests
```

13 интеграционных сценариев проверяют параллельные webhook, повторы event ID,
webhook до заказа, out-of-order события, timeout-after-issue, fallback,
out-of-stock/restock, recovery, double-entry ledger, параллельную выдачу,
регистрацию, серверную корзину, идемпотентный checkout, частичную оплату кодом,
одноразовость кода и admin API.

Дополнительные сценарии против работающего backend:

```bash
docker compose exec backend node dist/scripts/race.js
docker compose exec backend node dist/scripts/scenario-timeout.js
docker compose exec backend node dist/scripts/scenario-fallback.js
docker compose exec backend node dist/scripts/scenario-out-of-stock.js
docker compose exec backend node dist/scripts/reconcile.js
docker compose exec backend node dist/scripts/explain-catalog.js
```

## Разработка без Docker

Требуются Node.js 22+ и PostgreSQL 17.

```bash
npm ci
npm run db:migrate
npm run db:seed
npm run dev
```

Проверки:

```bash
npm run typecheck
npm test
npm run build
```

## Структура

```text
src/          Fastify API, worker и бизнес-логика
migrations/   PostgreSQL schema и индексы
scripts/      migration/seed и воспроизводимые сценарии
tests/        интеграционные acceptance tests
Dockerfile    multi-stage production image
docker-compose.yml  backend + PostgreSQL + test profile
```
