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
