# Вход в McQCryptoNews (Telegram и Google через Supabase)

Пока переменные `SUPABASE_URL` / `SUPABASE_ANON_KEY` не заданы, вход выключен и приложение работает без него.

1. **Проект Supabase** — supabase.com → New project (бесплатный план).
   Project Settings → API: скопируй `Project URL` и `anon public` ключ.
2. **Таблица профилей** — SQL Editor → вставь `supabase/migrations/001_profiles.sql` → Run.
3. **Адреса** — Authentication → URL Configuration:
   Site URL и Redirect URLs: `https://alexmcq999-dev.github.io/marketnews999/`
4. **Google** — Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application).
   Authorized redirect URI: `https://<project>.supabase.co/auth/v1/callback`.
   Client ID и Secret вставь в Supabase → Authentication → Providers → Google → Enable.
5. **Telegram** — функция `supabase/functions/telegram-auth`:
   Edge Functions → Deploy a new function → имя `telegram-auth` → вставь код `index.ts` → в настройках функции
   выключи «Verify JWT». Secrets функции: `TELEGRAM_BOT_TOKEN` = токен бота новостного приложения.
   (или CLI: `supabase functions deploy telegram-auth --no-verify-jwt`, `supabase secrets set TELEGRAM_BOT_TOKEN=...`)
   В @BotFather: `/setdomain` → выбери бота → `alexmcq999-dev.github.io`.
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
    Тогда без подписки откроется экран «McQ PRO» с кнопкой «Хочу McQ Pro» (заявки — таблица `pro_waitlist`).
11. **Выдать подписку вручную** (Authentication → Users → скопируй id):
    ```sql
    insert into public.subscriptions (user_id, plan, until, source)
    values ('<uuid>', 'pro', now() + interval '30 days', 'manual')
    on conflict (user_id) do update set plan = excluded.plan, until = excluded.until, source = excluded.source;
    ```
    Позже сюда же будет писать оплата (Telegram Stars / Stripe) — клиент таблицу только читает.
