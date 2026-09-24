# Market News Bot (@marketnews999bot)

Дважды в день (≈08:00 и ≈16:00 МСК) присылает в Telegram:

- **📈 Рынки** — S&P 500, Nasdaq, VIX, DXY, US10Y, золото, Brent, BTC, ETH и их изменение.
- **🔥 Главные события** — до 10 новостей, которые двигают акции и крипту: ставки и ЦБ, макро, тарифы, санкции и войны, нефть, регуляторика (SEC/ETF/стейблкоины), крупная крипта.
- **📅 Календарь** — важные (high impact) макро-релизы на сегодня по USD/EUR/CNY/GBP/JPY.

## Как бот решает, чему доверять

| Метка | Что значит |
|---|---|
| 🏛 первоисточник | Опубликовано официально: Белый дом, ФРС, SEC, ЕЦБ, Минфин США |
| ✅ N независимых источника | Одна и та же история найдена у N разных изданий |
| ☑️ 1 источник | Только одно издание первого эшелона — отнестись осторожнее |

Источники: White House, Federal Reserve, SEC, ECB, US Treasury/OFAC, Reuters, AP, Bloomberg, WSJ, FT, BBC, CNN, CNBC, Guardian, CoinDesk, The Block. Одиночные заметки только из крипто-СМИ отсекаются, если они не очень значимые.

**Про X (Twitter):** API X платный, а бесплатные «зеркала» ненадёжны. Поэтому официальные аккаунты (@WhiteHouse, @federalreserve, @SECGov и т.д.) бот берёт напрямую с их сайтов — это тот же первоисточник, только без посредника.

## Запуск на GitHub (≈5 минут, бесплатно)

1. Зайди на github.com → **New repository** → имя `market-news-bot` → выбери **Private** → **Create repository**.
2. Загрузи файлы. Проще всего через Терминал, находясь в папке с ботом:
   ```bash
   cd ~/Projects/market-news-bot
   git init && git add . && git commit -m "Market news bot"
   git branch -M main
   git remote add origin https://github.com/<ТВОЙ_ЛОГИН>/market-news-bot.git
   git push -u origin main
   ```
   Через браузер тоже можно: **uploading an existing file** и перетащи всё содержимое папки. Папка `.github` на Mac скрыта — в Finder нажми **Cmd+Shift+.**, чтобы её увидеть, и перетащи её тоже.
3. В репозитории: **Settings → Secrets and variables → Actions → New repository secret** и добавь два секрета:
   - `TELEGRAM_BOT_TOKEN` = токен бота
   - `TELEGRAM_CHAT_ID` = `6542171685`
4. Открой вкладку **Actions**, если попросит — нажми включить workflows. Выбери **Market digest → Run workflow**. Через ~1 минуту дайджест придёт в Telegram.

Дальше он будет приходить сам. Cron на GitHub иногда опаздывает на 5–20 минут, это нормально.

## ИИ-сводка на русском (по желанию)

Без ключа бот работает на правилах, и заголовки остаются на английском. С ключом каждая новость получает перевод, строку «почему важно», затронутые активы и направление (🟢/🔴/🟡), а в начале — общий фон рынка. ИИ выбирает только из уже проверенных новостей и не добавляет фактов от себя.

1. Зарегистрируйся на openrouter.ai (можно пополнить криптой), создай API-ключ.
2. Добавь секрет `LLM_API_KEY` = ключ.
3. По желанию: **Settings → Secrets and variables → Actions → Variables** → `LLM_MODEL` (по умолчанию `openai/gpt-4o-mini`, это стоит копейки).
   Подходит любой OpenAI-совместимый API: укажи `LLM_BASE_URL` (например, `https://api.groq.com/openai/v1`) и `LLM_MODEL`.

## Настройка

- **Время:** `.github/workflows/digest.yml`, строки `cron` (время в UTC: МСК − 3 часа).
- **Источники, темы, ключевые слова:** `sources.py`.
- **Сколько новостей:** переменная `MAX_ITEMS` (по умолчанию 10).
- **Проверка локально:** `pip install -r requirements.txt`, затем `TELEGRAM_BOT_TOKEN=... python bot.py --dry-run` (печатает дайджест, ничего не отправляет).
- **Узнать chat ID:** `python bot.py --get-chat-id` (сначала напиши боту /start).
- **Добавить друга или канал:** перечисли ID через запятую в `TELEGRAM_CHAT_ID`. Для канала добавь бота админом и используй ID канала.

Статус каждого источника (ok/FAIL) виден в логах запуска на вкладке Actions.
