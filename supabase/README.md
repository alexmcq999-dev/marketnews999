# Вход в McQCryptoNews (Telegram и Google через Supabase)

Пока переменные `SUPABASE_URL` / `SUPABASE_ANON_KEY` не заданы, вход выключен и приложение работает без него.

1. **Проект Supabase** — supabase.com → New project (бесплатный план).
   Project Settings → API: скопируй `Project URL` и `anon public` ключ.
2. **Таблица профилей** — SQL Editor → вставь `supabase/migrations/001_profiles.sql` → Run.
3. **Адреса** — Authentication → URL Configuration:
   Site URL и Redirect URLs: `https://mcqcryptonews.pages.dev/` (и старый `https://alexmcq999-dev.github.io/marketnews999/`)
4. **Google** — Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application).
   Authorized redirect URI: `https://<project>.supabase.co/auth/v1/callback`.
   Client ID и Secret вставь в Supabase → Authentication → Providers → Google → Enable.
5. **Telegram** — функция `supabase/functions/telegram-auth`:
   Edge Functions → Deploy a new function → имя `telegram-auth` → вставь код `index.ts` → в настройках функции
   выключи «Verify JWT». Secrets функции: `TELEGRAM_BOT_TOKEN` = токен бота новостного приложения.
   (или CLI: `supabase functions deploy telegram-auth --no-verify-jwt`, `supabase secrets set TELEGRAM_BOT_TOKEN=...`)
   В @BotFather: `/setdomain` → выбери бота → `mcqcryptonews.pages.dev`.
6. **GitHub (marketnews999)** → Settings → Secrets and variables → Actions → **Variables**:
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TG_BOT_ID` (число до двоеточия в токене бота).
7. Запусти Actions → Market digest → Run workflow (mode = data).

В мини-приложении Telegram вход происходит сам (по данным Telegram), формы нет.
В браузере и в приложении на телефоне — экран входа: Telegram или Google. После входа пуши OneSignal
привязываются к аккаунту (можно слать персональные уведомления).

---

# McQ Pro Chart (интеллектуальный чарт + ИИ-ассистент)

Чарт работает сразу, без настроек: свечи и объёмы берутся из публичных API 9 бирж прямо в приложении.
Для ИИ-ассистента и будущей подписки:

8. **Таблицы подписки** — SQL Editor → вставь `supabase/migrations/002_pro.sql` → Run.
9. **Функция ИИ** — Edge Functions → Deploy a new function → имя `chart-ai` → код из
   `supabase/functions/chart-ai/index.ts`. «Verify JWT» оставь **включённым**.
   Secrets функции: `LLM_API_KEY` — тот же ключ OpenRouter, что у бота (секрет `LLM_API_KEY` в GitHub).
   Необязательно: `LLM_MODEL` (по умолчанию `openai/gpt-4o-mini`), `AI_FREE_LIMIT` (вопросов в день без подписки, 15),
   `AI_PRO_LIMIT` (с подпиской, 100), `PREMIUM_MODE`.
   (CLI: `supabase functions deploy chart-ai`, `supabase secrets set LLM_API_KEY=...`)
10. **Режим доступа** — пока `PREMIUM_MODE` не задан, чарт и ИИ открыты всем (ИИ — только вошедшим, с дневным лимитом).
    Когда запустишь подписку: GitHub → Variables → `PREMIUM_MODE` = `paid` **и** такой же секрет `PREMIUM_MODE=paid` у функции `chart-ai`.
    Тогда без подписки откроется экран «McQ PRO» с кнопкой «Оформить McQ Pro».
11. **Выдать подписку вручную** (Authentication → Users → скопируй id):
    ```sql
    insert into public.subscriptions (user_id, plan, until, source)
    values ('<uuid>', 'pro', now() + interval '30 days', 'manual')
    on conflict (user_id) do update set plan = excluded.plan, until = excluded.until, source = excluded.source;
    ```
    Сюда же пишет оплата (функция `billing`) — клиент таблицу только читает.

---

# Оплата McQ Pro: Telegram Stars + USDT

В мини-приложении Telegram — **только Stars** (правило Telegram для цифровых товаров): ежемесячная подписка,
продлевается сама, отмена — Настройки Telegram → Мои звёзды. В браузере / PWA — **USDT через Crypto Pay** (@CryptoBot),
разово на 30 дней. Подписка привязана к аккаунту: оплатил на сайте — PRO работает и в Telegram.

12. **Таблица платежей** — SQL Editor → `supabase/migrations/003_billing.sql` → Run.
13. **Функция** — Edge Functions → Deploy a new function → имя `billing` → код `supabase/functions/billing/index.ts`.
    «Verify JWT» — **выключить** (вебхуки Telegram и Crypto Pay приходят без JWT, пользователя функция проверяет сама).
    Secrets функции (Edge Functions → Secrets — общие для всех функций): `TELEGRAM_BOT_TOKEN` уже есть.
    Необязательно: `OWNER_CHAT_ID` (твой chat id — сюда бот пересылает вопросы пользователей), `PRO_PRICE_STARS` (1500),
    `PRO_PRICE_USDT` (29.9), `PRO_TRIAL_DAYS` (3, `0` — без пробного), `PAY_BOT_TOKEN` (если оплату принимает другой бот).
14. **Вебхук бота** — один раз открыть в браузере консоль и выполнить (или любой POST):
    `fetch("https://<project>.supabase.co/functions/v1/billing",{method:"POST",body:JSON.stringify({action:"setup"})}).then(r=>r.json()).then(console.log)`
    ⚠️ После этого бот получает сообщения через функцию, `getUpdates` для этого бота перестаёт работать
    (`bot.py --get-chat-id`). Если тот же токен использует другой скрипт с `getUpdates` — заведи отдельного бота для оплаты
    (`PAY_BOT_TOKEN`).
15. **USDT** — в Telegram открыть @CryptoBot → Crypto Pay → Create App → скопировать токен →
    секрет `CRYPTOPAY_TOKEN` в Supabase. В приложении Crypto Pay: Webhooks → включить →
    URL `https://<project>.supabase.co/functions/v1/billing`. Тест без денег: @CryptoTestnetBot и секрет `CRYPTOPAY_TESTNET=1`.
16. Пока нет `CRYPTOPAY_TOKEN`, кнопка USDT скрыта. Пока `PREMIUM_MODE` не `paid`, всё остаётся открытым, а купить подписку уже можно.

Платежи — таблица `payments` (возвраты Stars отмечаются автоматически и снимают оплаченные дни).
Вернуть звёзды пользователю: Bot API `refundStarPayment(user_id, telegram_payment_charge_id)`.
