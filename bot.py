#!/usr/bin/env python3
"""Market News Bot — ежедневный дайджест событий, влияющих на акции и крипту.

Запуск:
  python bot.py                 # собрать и отправить в Telegram
  python bot.py --dry-run       # собрать и напечатать, ничего не отправляя
  python bot.py --get-chat-id   # показать chat ID тех, кто написал боту /start

Переменные окружения:
  TELEGRAM_BOT_TOKEN   токен бота (обязательно)
  TELEGRAM_CHAT_ID     один или несколько chat ID через запятую (обязательно для отправки)
  LLM_API_KEY          опционально: ключ OpenAI-совместимого API для ИИ-сводки на русском
  LLM_BASE_URL         опционально, по умолчанию https://openrouter.ai/api/v1
  LLM_MODEL            опционально, по умолчанию openai/gpt-4o-mini
  LOOKBACK_HOURS       опционально: принудительное окно в часах (иначе авто по слоту 08:00/16:00)
  MAX_ITEMS            опционально: сколько новостей в дайджесте (по умолчанию 10)
"""
from __future__ import annotations

import argparse
import calendar
import html
import json
import math
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import feedparser
import requests

from sources import (CALENDAR_COUNTRIES, FEEDS, INTENSIFIERS, NOISE, THEMES, TIER_WEIGHT)

MSK = timezone(timedelta(hours=3))
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
HTTP_TIMEOUT = 20
MIN_SCORE = 6.0
MIN_KW = 4.0      # минимум «рыночности» по ключевым словам
MAX_PER_THEME = 3

STOPWORDS = set("""a an the and or of to in on for at by with from as is are was were be been it its this that
after over into amid says said say will would could new us u.s. vs than up down about more most not no
""".split())


def _compile(patterns):
    return re.compile(r"\b(?:" + "|".join(patterns) + r")\b", re.IGNORECASE)


THEME_RX = [(name, w, _compile(p)) for name, w, p in THEMES]
INTENS_RX = _compile(INTENSIFIERS)
NOISE_RX = _compile(NOISE)


# ---------------------------------------------------------------- сбор новостей
def fetch_feed(src: dict) -> tuple[dict, list[dict], str | None]:
    try:
        r = requests.get(src["url"], headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*"},
                         timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        parsed = feedparser.parse(r.content)
    except Exception as e:  # noqa: BLE001
        return src, [], f"{type(e).__name__}: {e}"[:160]

    items = []
    for e in parsed.entries:
        ts = e.get("published_parsed") or e.get("updated_parsed")
        if not ts:
            continue
        title = html.unescape(re.sub(r"<[^>]+>", "", e.get("title", ""))).strip()
        outlet = src["outlet"]
        # Google News добавляет « - Reuters» в конец заголовка и может подмешать другой сайт
        if "news.google.com" in src["url"]:
            src_name = (e.get("source") or {}).get("title", "") if isinstance(e.get("source"), dict) else ""
            m = re.search(r"\s+-\s+([^-]+)$", title)
            if m:
                title = title[: m.start()].strip()
                src_name = src_name or m.group(1).strip()
            if src_name and not _same_outlet(src_name, outlet):
                continue  # только разрешённые издания
        summary = html.unescape(re.sub(r"<[^>]+>", " ", e.get("summary", "") or "")).strip()
        summary = re.sub(r"\s+", " ", summary)[:400]
        items.append({
            "title": title,
            "summary": summary,
            "link": e.get("link", ""),
            "ts": datetime.fromtimestamp(calendar.timegm(ts), tz=timezone.utc),
            "outlet": outlet,
            "tier": src["tier"],
        })
    return src, items, None


def _same_outlet(name: str, outlet: str) -> bool:
    n = name.lower()
    o = outlet.lower()
    aliases = {"ap": ["associated press", "ap news", "ap"], "us treasury": ["treasury", "u.s. department of the treasury", "ofac"]}
    return any(a in n for a in aliases.get(o, [o]))


def collect(since: datetime) -> tuple[list[dict], list[str]]:
    news, report = [], []
    with ThreadPoolExecutor(max_workers=10) as pool:
        for src, items, err in pool.map(fetch_feed, FEEDS):
            fresh = [i for i in items if i["ts"] >= since]
            label = f"{src['outlet']:<16} {src['url'][:70]}"
            report.append(f"  {'FAIL' if err else 'ok  '} {label}  " + (err or f"{len(fresh)}/{len(items)} свежих"))
            news.extend(fresh)
    return news, report


# ---------------------------------------------------------------- скоринг и подтверждение
def score_item(item: dict) -> None:
    title, text = item["title"], item["title"] + " " + item["summary"]
    themes, s = [], 0.0
    for name, w, rx in THEME_RX:
        t_hits = len(rx.findall(title))
        b_hits = len(rx.findall(item["summary"]))
        if t_hits or b_hits:
            themes.append(name)
            s += w * (1.0 if t_hits else 0.45) + min(t_hits + b_hits - 1, 3) * 0.4
    if INTENS_RX.search(title):
        s += 1.5
    if NOISE_RX.search(text):
        s -= 6
    item["themes"] = themes
    item["kw_score"] = s


def _norm_numbers(t: str) -> str:
    t = t.lower().replace("$", " ")
    t = re.sub(r"(\d+)(?:[.,]\d+)?\s*(?:billion|bn)\b", r"\1b", t)
    t = re.sub(r"(\d+)(?:[.,]\d+)?\s*(?:million|mln)\b", r"\1m", t)
    t = re.sub(r"(\d+),000\b", r"\1k", t)
    return t


def tokens(title: str) -> set[str]:
    words = re.findall(r"[a-z0-9%&.']+", _norm_numbers(title))
    out = set()
    for w in words:
        w = w.strip(".'")
        if len(w) < 2 or w in STOPWORDS:
            continue
        out.add(w[:6])  # грубый стемминг: liquidations/liquidated -> liquid
    return out


def cluster(items: list[dict]) -> list[dict]:
    """Склеивает одну и ту же историю из разных источников."""
    items = sorted(items, key=lambda i: (TIER_WEIGHT[i["tier"]], i["kw_score"]), reverse=True)
    clusters: list[dict] = []
    for it in items:
        tk = tokens(it["title"])
        best, best_sim = None, 0.0
        for c in clusters:
            inter = len(tk & c["tokens"])
            if inter < 3:
                continue
            sim = inter / max(1, min(len(tk), len(c["tokens"])))
            if sim > best_sim:
                best, best_sim = c, sim
        if best and best_sim >= 0.5:
            best["items"].append(it)
            best["tokens"] |= tk
        else:
            clusters.append({"items": [it], "tokens": set(tk)})

    for c in clusters:
        lead = c["items"][0]
        outlets = []
        for i in c["items"]:
            if i["outlet"] not in outlets:
                outlets.append(i["outlet"])
        c["lead"] = lead
        c["outlets"] = outlets
        c["official"] = any(i["tier"] == "official" for i in c["items"])
        c["themes"] = sorted({t for i in c["items"] for t in i["themes"]}, key=lambda t: [x[0] for x in THEMES].index(t))
        kw = max(i["kw_score"] for i in c["items"])
        tier = max(TIER_WEIGHT[i["tier"]] for i in c["items"])
        confirm = 2.0 * math.log2(len(outlets)) if len(outlets) > 1 else 0.0
        c["score"] = kw + tier + confirm if kw > 0 else kw
        c["ts"] = max(i["ts"] for i in c["items"])
    return sorted(clusters, key=lambda c: c["score"], reverse=True)


def select(clusters: list[dict], limit: int) -> list[dict]:
    chosen, per_theme = [], {}
    for c in clusters:
        if c["score"] < MIN_SCORE or not c["themes"] or max(i["kw_score"] for i in c["items"]) < MIN_KW:
            continue
        main = c["themes"][0]
        if per_theme.get(main, 0) >= MAX_PER_THEME:
            continue
        # одиночная непроверенная заметка из крипто-СМИ должна быть очень сильной
        if len(c["outlets"]) == 1 and c["lead"]["tier"] == "crypto" and c["score"] < MIN_SCORE + 3:
            continue
        per_theme[main] = per_theme.get(main, 0) + 1
        chosen.append(c)
        if len(chosen) >= limit:
            break
    return chosen


def trust_badge(c: dict) -> str:
    n = len(c["outlets"])
    parts = []
    if c["official"]:
        parts.append("🏛 первоисточник")
    if n >= 2:
        parts.append(f"✅ {n} независимых источника" if n < 5 else f"✅ {n} независимых источников")
    return " + ".join(parts) if parts else "☑️ 1 источник"


# ---------------------------------------------------------------- рынки
YAHOO = [("S&P 500", "^GSPC", 0), ("Nasdaq", "^IXIC", 0), ("VIX", "^VIX", 2), ("DXY", "DX-Y.NYB", 2),
         ("US10Y", "^TNX", 2), ("Gold", "GC=F", 0), ("Brent", "BZ=F", 2), ("BTC", "BTC-USD", 0), ("ETH", "ETH-USD", 0)]


def yahoo_quote(symbol: str):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{requests.utils.quote(symbol)}?range=5d&interval=1d"
    r = requests.get(url, headers={"User-Agent": UA}, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    res = r.json()["chart"]["result"][0]
    price = res["meta"]["regularMarketPrice"]
    closes = [x for x in res["indicators"]["quote"][0]["close"] if x is not None]
    prev = closes[-2] if len(closes) >= 2 else res["meta"].get("chartPreviousClose")
    return price, (price / prev - 1) * 100 if prev else None


def coingecko() -> dict:
    r = requests.get("https://api.coingecko.com/api/v3/simple/price",
                     params={"ids": "bitcoin,ethereum", "vs_currencies": "usd", "include_24hr_change": "true"},
                     headers={"User-Agent": UA}, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    d = r.json()
    return {"BTC": (d["bitcoin"]["usd"], d["bitcoin"]["usd_24h_change"]),
            "ETH": (d["ethereum"]["usd"], d["ethereum"]["usd_24h_change"])}


def markets() -> list[str]:
    out = {}

    def one(row):
        name, sym, dec = row
        try:
            return name, dec, yahoo_quote(sym)
        except Exception:  # noqa: BLE001
            return name, dec, None

    with ThreadPoolExecutor(max_workers=6) as pool:
        for name, dec, q in pool.map(one, YAHOO):
            if q:
                out[name] = (dec, q)
    if "BTC" not in out or "ETH" not in out:
        try:
            for k, v in coingecko().items():
                out.setdefault(k, (0, v))
        except Exception:  # noqa: BLE001
            pass
    lines = []
    for name, _, dec in YAHOO:
        if name not in out:
            continue
        dec, (price, chg) = out[name]
        arrow = "🟢" if (chg or 0) > 0.05 else "🔴" if (chg or 0) < -0.05 else "⚪"
        p = f"{price:,.{dec}f}".replace(",", " ")
        c = f"{chg:+.2f}%" if chg is not None else ""
        lines.append(f"{arrow} {name}: <b>{p}</b> {c}")
    return lines


# ---------------------------------------------------------------- экономический календарь
def econ_calendar(now: datetime) -> list[str]:
    try:
        r = requests.get("https://nfs.faireconomy.media/ff_calendar_thisweek.json", headers={"User-Agent": UA},
                         timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        events = r.json()
    except Exception:  # noqa: BLE001
        return []
    start = now.astimezone(MSK)
    end = start.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1, hours=6)  # до 06:00 след. дня
    lines = []
    for ev in events:
        if ev.get("impact") != "High" or ev.get("country") not in CALENDAR_COUNTRIES:
            continue
        try:
            t = datetime.fromisoformat(ev["date"]).astimezone(MSK)
        except Exception:  # noqa: BLE001
            continue
        if not (start - timedelta(minutes=30) <= t <= end):
            continue
        extra = []
        if ev.get("forecast"):
            extra.append(f"прогноз {ev['forecast']}")
        if ev.get("previous"):
            extra.append(f"пред. {ev['previous']}")
        tail = f" <i>({', '.join(extra)})</i>" if extra else ""
        lines.append((t, f"🕐 {t:%H:%M} <b>{ev['country']}</b> {html.escape(ev['title'])}{tail}"))
    return [l for _, l in sorted(lines)]


# ---------------------------------------------------------------- ИИ-сводка (опционально)
def llm_enrich(chosen: list[dict], candidates: list[dict]) -> dict | None:
    key = os.getenv("LLM_API_KEY")
    if not key:
        return None
    base = (os.getenv("LLM_BASE_URL") or "https://openrouter.ai/api/v1").rstrip("/")
    model = os.getenv("LLM_MODEL") or "openai/gpt-4o-mini"
    pool = candidates[:30]
    lines = []
    for idx, c in enumerate(pool):
        l = c["lead"]
        lines.append(json.dumps({"id": idx, "title": l["title"], "summary": l["summary"][:300],
                                 "sources": c["outlets"], "official": c["official"]}, ensure_ascii=False))
    prompt = (
        "Ты — аналитик рынков. Ниже новости за последние часы из проверенных источников (JSON по строкам).\n"
        "Выбери до 8 событий, которые реально могут сдвинуть ценовые диапазоны акций США и/или крипты. "
        "Отбрось то, что не влияет на рынки. Используй ТОЛЬКО факты из текста — не додумывай цифры и детали.\n"
        "Верни строго JSON: {\"mood\": \"1-2 предложения об общем фоне\", \"items\": [{\"id\": <id>, "
        "\"title_ru\": \"суть по-русски, до 15 слов\", \"why\": \"почему важно для рынка, 1 предложение\", "
        "\"assets\": \"какие активы затронет, кратко\", \"bias\": \"bullish|bearish|mixed\"}]}. "
        "Порядок — по важности.\n\n" + "\n".join(lines)
    )
    try:
        r = requests.post(f"{base}/chat/completions", timeout=90,
                          headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                          json={"model": model, "temperature": 0.2,
                                "response_format": {"type": "json_object"},
                                "messages": [{"role": "user", "content": prompt}]})
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]
        content = re.sub(r"^```(?:json)?|```$", "", content.strip()).strip()
        data = json.loads(content)
        picked = []
        for it in data.get("items", [])[:8]:
            i = int(it["id"])
            if 0 <= i < len(pool):
                picked.append((pool[i], it))
        if not picked:
            return None
        return {"mood": data.get("mood", ""), "items": picked}
    except Exception as e:  # noqa: BLE001
        print(f"[LLM] ошибка, использую правила: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------- форматирование
BIAS = {"bullish": "🟢 позитив", "bearish": "🔴 негатив", "mixed": "🟡 неоднозначно"}


def fmt_item(n: int, c: dict, ai: dict | None) -> str:
    l = c["lead"]
    theme = c["themes"][0] if c["themes"] else ""
    emoji = theme.split(" ")[0] if theme else "•"
    t_msk = c["ts"].astimezone(MSK).strftime("%H:%M")
    links = " · ".join(
        f'<a href="{html.escape(i["link"], quote=True)}">{html.escape(i["outlet"])}</a>'
        for i in _uniq_by_outlet(c["items"])[:4])
    if ai:
        head = f"{n}. {emoji} <b>{html.escape(ai.get('title_ru', l['title']))}</b>"
        body = [f"<i>{html.escape(l['title'])}</i>"]
        if ai.get("why"):
            body.append(f"💡 {html.escape(ai['why'])}")
        meta = []
        if ai.get("assets"):
            meta.append(f"🎯 {html.escape(ai['assets'])}")
        if ai.get("bias") in BIAS:
            meta.append(BIAS[ai["bias"]])
        if meta:
            body.append(" | ".join(meta))
    else:
        head = f"{n}. {emoji} <b>{html.escape(l['title'])}</b>"
        body = []
        if theme:
            body.append(f"<i>{html.escape(', '.join(c['themes'][:3]))}</i>")
    body.append(f"{trust_badge(c)} · {t_msk} МСК · {links}")
    return head + "\n" + "\n".join(body)


def _uniq_by_outlet(items):
    seen, out = set(), []
    for i in items:
        if i["outlet"] not in seen:
            seen.add(i["outlet"])
            out.append(i)
    return out


def build_message(now: datetime, since: datetime, chosen, ai, mkts, cal, ok_sources: int, total_sources: int) -> str:
    slot = "☀️ Утренний" if now.astimezone(MSK).hour < 12 else "🌆 Дневной"
    parts = [f"<b>{slot} дайджест рынков</b> — {now.astimezone(MSK):%d.%m.%Y, %H:%M} МСК",
             f"<i>Новости с {since.astimezone(MSK):%d.%m %H:%M} МСК</i>"]
    if ai and ai.get("mood"):
        parts.append(f"🧭 {html.escape(ai['mood'])}")
    if mkts:
        parts.append("<b>📈 Рынки</b>\n" + "\n".join(mkts))
    if ai:
        rows = [fmt_item(n, c, it) for n, (c, it) in enumerate(ai["items"], 1)]
    else:
        rows = [fmt_item(n, c, None) for n, c in enumerate(chosen, 1)]
    parts.append("<b>🔥 Главные события</b>\n\n" + ("\n\n".join(rows) if rows else "Значимых событий не найдено."))
    if cal:
        parts.append("<b>📅 Календарь (high impact)</b>\n" + "\n".join(cal))
    parts.append(f"<i>Источники: {ok_sources}/{total_sources} доступны. 🏛 — официальный первоисточник, "
                 "✅ — история подтверждена несколькими независимыми изданиями. Не является инвест-рекомендацией.</i>")
    return "\n\n".join(parts)


# ---------------------------------------------------------------- Telegram
def tg(method: str, **payload):
    token = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
    if not token:
        raise SystemExit("ОШИБКА: секрет TELEGRAM_BOT_TOKEN не задан (Settings → Secrets and variables → Actions)")
    r = requests.post(f"https://api.telegram.org/bot{token}/{method}", json=payload, timeout=HTTP_TIMEOUT)
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"Telegram {method}: {data.get('error_code')} {data.get('description')}")
    return data["result"]


def split_message(text: str, limit: int = 4000) -> list[str]:
    chunks, cur = [], ""
    for block in text.split("\n\n"):
        if len(cur) + len(block) + 2 > limit and cur:
            chunks.append(cur)
            cur = ""
        cur = (cur + "\n\n" + block) if cur else block
    if cur:
        chunks.append(cur)
    return chunks


def send(text: str) -> None:
    chat_ids = [c.strip() for c in (os.getenv("TELEGRAM_CHAT_ID") or "").split(",") if c.strip()]
    if not chat_ids:
        raise SystemExit("ОШИБКА: секрет TELEGRAM_CHAT_ID не задан (Settings → Secrets and variables → Actions)")
    for cid in chat_ids:
        for chunk in split_message(text):
            try:
                tg("sendMessage", chat_id=cid, text=chunk, parse_mode="HTML",
                   link_preview_options={"is_disabled": True})
            except RuntimeError as e:
                if "parse" not in str(e).lower():
                    raise
                print(f"HTML не принят ({e}), отправляю простым текстом", file=sys.stderr)
                plain = html.unescape(re.sub(r"<[^>]+>", "", chunk))
                tg("sendMessage", chat_id=cid, text=plain, link_preview_options={"is_disabled": True})
            time.sleep(0.5)


def get_chat_ids() -> None:
    upd = tg("getUpdates")
    seen = {}
    for u in upd:
        msg = u.get("message") or u.get("channel_post") or u.get("my_chat_member") or {}
        chat = msg.get("chat")
        if chat:
            seen[chat["id"]] = chat.get("username") or chat.get("title") or chat.get("first_name")
    if not seen:
        print("Нет сообщений. Напиши боту /start в Telegram и запусти снова.")
    for cid, name in seen.items():
        print(f"chat_id={cid}  ({name})")


# ---------------------------------------------------------------- main
def window_start(now: datetime) -> datetime:
    if os.getenv("LOOKBACK_HOURS"):
        return now - timedelta(hours=float(os.environ["LOOKBACK_HOURS"]))
    m = now.astimezone(MSK)
    if m.hour < 12:  # утренний выпуск: с 15:00 МСК вчера
        start = (m - timedelta(days=1)).replace(hour=15, minute=0, second=0, microsecond=0)
    else:            # дневной: с 07:00 МСК сегодня
        start = m.replace(hour=7, minute=0, second=0, microsecond=0)
    return start.astimezone(timezone.utc)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--get-chat-id", action="store_true")
    args = ap.parse_args()

    if args.get_chat_id:
        get_chat_ids()
        return

    now = datetime.now(timezone.utc)
    since = window_start(now)
    news, report = collect(since)
    print("Статус источников:\n" + "\n".join(report), file=sys.stderr)
    ok_sources = sum(1 for r in report if " ok " in r[:7])

    for n in news:
        score_item(n)
    clusters = cluster(news)
    limit = int(os.getenv("MAX_ITEMS") or 10)
    chosen = select(clusters, limit)
    candidates = [c for c in clusters if c["score"] >= MIN_SCORE - 2 and c["themes"]]
    ai = llm_enrich(chosen, candidates) if candidates else None

    text = build_message(now, since, chosen, ai, markets(), econ_calendar(now), ok_sources, len(FEEDS))
    if args.dry_run:
        print(text)
    else:
        send(text)
        print(f"Отправлено: {len(ai['items']) if ai else len(chosen)} событий", file=sys.stderr)


if __name__ == "__main__":
    main()
