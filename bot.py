#!/usr/bin/env python3
"""Market News Bot — ежедневный дайджест событий, влияющих на акции и крипту.

Запуск:
  python bot.py                 # собрать и отправить в Telegram
  python bot.py --dry-run       # собрать и напечатать, ничего не отправляя
  python bot.py --get-chat-id   # показать chat ID тех, кто написал боту /start

Переменные окружения:
  TELEGRAM_BOT_TOKEN   токен бота (обязательно)
  TELEGRAM_CHAT_ID     один или несколько chat ID через запятую (обязательно для отправки)
  LLM_API_KEY          ключ OpenRouter (или другого OpenAI-совместимого API) для перевода и пересказа
  LLM_BASE_URL         опционально, по умолчанию https://openrouter.ai/api/v1
  LLM_MODEL            опционально: модель или список через запятую (по умолчанию бесплатные Llama → gpt-4o-mini)
  LOOKBACK_HOURS       опционально: принудительное окно в часах (иначе авто по слоту 08:00/16:00)
  MAX_ITEMS            опционально: сколько новостей в дайджесте (по умолчанию 8)
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

from sentiment import sentiment_block
from sources import (CALENDAR_COUNTRIES, FEEDS, INTENSIFIERS, NOISE, THEMES, TIER_WEIGHT)

MSK = timezone(timedelta(hours=3))
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
HTTP_TIMEOUT = 20
MIN_SCORE = 6.0
MIN_KW = 4.0      # минимум «рыночности» по ключевым словам
NON_MARKET_THEMES = {"🏛 Политика США"}  # сами по себе не двигают рынок
MAX_PER_THEME = 3

LAST: dict = {}  # структурированные данные для мини-приложения

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
        if not any(t not in NON_MARKET_THEMES for t in c["themes"]):
            continue  # чистая политика без связи с рынками
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
# (название, Yahoo, CNBC, Stooq, знаков после запятой)
TICKERS = [
    ("S&P 500", "^GSPC", ".SPX", "^spx", 0),
    ("Nasdaq", "^IXIC", ".IXIC", "^ndq", 0),
    ("VIX", "^VIX", ".VIX", None, 2),
    ("DXY", "DX-Y.NYB", ".DXY", "dx.f", 2),
    ("US10Y", "^TNX", "US10Y", "10usy.b", 2),
    ("Gold", "GC=F", "@GC.1", "xauusd", 0),
    ("Brent", "BZ=F", "@LCO.1", "cb.f", 2),
    ("BTC", "BTC-USD", None, None, 0),
    ("ETH", "ETH-USD", None, None, 0),
]


def _num(x):
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    x = str(x).replace(",", "").replace("%", "").replace("+", "").strip()
    try:
        return float(x)
    except ValueError:
        return None


def yahoo_quote(symbol: str):
    last_err = None
    for host in ("query1", "query2"):
        try:
            url = f"https://{host}.finance.yahoo.com/v8/finance/chart/{requests.utils.quote(symbol)}?range=5d&interval=1d"
            r = requests.get(url, headers={"User-Agent": UA}, timeout=HTTP_TIMEOUT)
            if r.status_code == 429:
                last_err = "429"
                time.sleep(1.5)
                continue
            r.raise_for_status()
            res = r.json()["chart"]["result"][0]
            price = res["meta"]["regularMarketPrice"]
            closes = [x for x in res["indicators"]["quote"][0]["close"] if x is not None]
            prev = closes[-2] if len(closes) >= 2 else res["meta"].get("chartPreviousClose")
            return price, (price / prev - 1) * 100 if prev else None
        except Exception as e:  # noqa: BLE001
            last_err = f"{type(e).__name__}"
    raise RuntimeError(f"yahoo {last_err}")


def cnbc_quotes(symbols: list[str]) -> dict:
    url = ("https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols="
           + "|".join(symbols) + "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json")
    r = requests.get(url, headers={"User-Agent": UA}, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    rows = r.json()["FormattedQuoteResult"]["FormattedQuote"]
    if isinstance(rows, dict):
        rows = [rows]
    out = {}
    for q in rows:
        price, chg = _num(q.get("last")), _num(q.get("change_pct"))
        if price is not None:
            out[q.get("symbol")] = (price, chg)
    return out


def stooq_quote(symbol: str):
    r = requests.get(f"https://stooq.com/q/d/l/?s={symbol}&i=d", headers={"User-Agent": UA}, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    rows = [l.split(",") for l in r.text.strip().splitlines()[1:] if l.count(",") >= 4]
    closes = [_num(x[4]) for x in rows if _num(x[4])]
    if len(closes) < 2:
        raise RuntimeError("stooq: нет данных")
    return closes[-1], (closes[-1] / closes[-2] - 1) * 100


def coingecko() -> dict:
    r = requests.get("https://api.coingecko.com/api/v3/simple/price",
                     params={"ids": "bitcoin,ethereum", "vs_currencies": "usd", "include_24hr_change": "true"},
                     headers={"User-Agent": UA}, timeout=HTTP_TIMEOUT)
    r.raise_for_status()
    d = r.json()
    return {"BTC": (d["bitcoin"]["usd"], d["bitcoin"]["usd_24h_change"]),
            "ETH": (d["ethereum"]["usd"], d["ethereum"]["usd_24h_change"])}


def markets() -> list[str]:
    out, log = {}, []
    for name, ysym, _, _, _ in TICKERS:  # последовательно, чтобы не ловить 429
        try:
            out[name] = (yahoo_quote(ysym), "yahoo")
        except Exception as e:  # noqa: BLE001
            log.append(f"{name}: {e}")
        time.sleep(0.4)
    missing = [t for t in TICKERS if t[0] not in out and t[2]]
    if missing:
        try:
            got = cnbc_quotes([t[2] for t in missing])
            for name, _, csym, _, _ in missing:
                if csym in got:
                    out[name] = (got[csym], "cnbc")
        except Exception as e:  # noqa: BLE001
            log.append(f"cnbc: {type(e).__name__} {e}"[:120])
    for name, _, _, ssym, _ in TICKERS:
        if name not in out and ssym:
            try:
                out[name] = (stooq_quote(ssym), "stooq")
            except Exception as e:  # noqa: BLE001
                log.append(f"stooq {name}: {type(e).__name__}")
    if "BTC" not in out or "ETH" not in out:
        try:
            for k, v in coingecko().items():
                out.setdefault(k, (v, "coingecko"))
        except Exception as e:  # noqa: BLE001
            log.append(f"coingecko: {type(e).__name__}")
    print("Рынки: " + ", ".join(f"{k}←{v[1]}" for k, v in out.items())
          + (" | ошибки: " + "; ".join(log) if log else ""), file=sys.stderr)

    LAST["markets"] = [
        {"name": name, "price": out[name][0][0], "chg": out[name][0][1], "dec": dec, "src": out[name][1]}
        for name, _, _, _, dec in TICKERS if name in out]
    lines = []
    for name, _, _, _, dec in TICKERS:
        if name not in out:
            continue
        (price, chg), _src = out[name]
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
    week = []
    for ev in events:
        if ev.get("impact") not in ("High", "Medium") or ev.get("country") not in CALENDAR_COUNTRIES:
            continue
        try:
            t = datetime.fromisoformat(ev["date"]).astimezone(MSK)
        except Exception:  # noqa: BLE001
            continue
        week.append({"ts": t.isoformat(), "country": ev.get("country"), "title": ev.get("title", ""),
                     "impact": ev.get("impact"), "forecast": ev.get("forecast") or "",
                     "previous": ev.get("previous") or "", "actual": ev.get("actual") or ""})
        if ev.get("impact") != "High":
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
    LAST["calendar"] = sorted(week, key=lambda e: e["ts"])
    return [l for _, l in sorted(lines)]


# ---------------------------------------------------------------- ИИ: перевод и развёрнутый пересказ
AI_SYSTEM = (
    "Ты — редактор финансовых новостей для русскоязычного трейдера акций и крипты. Пишешь по-русски, ясно и "
    "по делу, без воды и кликбейта. Факты (что произошло, кто, цифры, даты) бери ТОЛЬКО из переданного текста — "
    "ничего не выдумывай и не добавляй цифр, которых нет в тексте. Для блока «почему важно» можешь использовать "
    "общеизвестный рыночный контекст (как ставки влияют на акции, нефть на инфляцию и т.п.), но без новых фактов. "
    "Названия компаний, тикеры и имена оставляй узнаваемыми. Отвечай строго JSON."
)
BATCH = 3


FREE_PREFER = ["deepseek", "llama-3.3-70b", "llama-4", "qwen3", "qwen", "gemma-3", "mistral", "glm", "kimi", "nex", "ling"]


def free_models(limit: int = 4) -> list[str]:
    """Актуальные бесплатные модели OpenRouter (их список постоянно меняется)."""
    try:
        r = requests.get("https://openrouter.ai/api/v1/models", headers={"User-Agent": UA}, timeout=HTTP_TIMEOUT)
        r.raise_for_status()
        models = r.json().get("data", [])
    except Exception as e:  # noqa: BLE001
        print(f"[LLM] не удалось получить список моделей: {e}", file=sys.stderr)
        return []
    free = []
    for m in models:
        pr = m.get("pricing") or {}
        is_free = m.get("id", "").endswith(":free") or (str(pr.get("prompt")) in ("0", "0.0") and str(pr.get("completion")) in ("0", "0.0"))
        if is_free and (m.get("context_length") or 0) >= 16000 and "openrouter/" not in m.get("id", ""):
            free.append(m)

    def rank(m):
        mid = m["id"].lower()
        pref = next((i for i, p in enumerate(FREE_PREFER) if p in mid), len(FREE_PREFER))
        return (pref, -(m.get("context_length") or 0))
    return [m["id"] for m in sorted(free, key=rank)[:limit]]


_LLM_CFG = "unset"


def llm_config():
    global _LLM_CFG
    if _LLM_CFG == "unset":
        _LLM_CFG = _llm_config()
    return _LLM_CFG


def _llm_config():
    """OpenAI-совместимый API. По умолчанию OpenRouter: сначала бесплатные модели, затем gpt-4o-mini (если есть кредиты)."""
    key = (os.getenv("LLM_API_KEY") or "").strip()
    if not key:
        return None
    base = (os.getenv("LLM_BASE_URL") or "https://openrouter.ai/api/v1").rstrip("/")
    if os.getenv("LLM_MODEL"):
        models = [m.strip() for m in os.environ["LLM_MODEL"].split(",") if m.strip()]
    elif "openrouter.ai" in base:
        # сначала платная (если есть кредиты — быстро и качественно), при 402 — бесплатные
        models = ["openai/gpt-4o-mini"] + free_models()
    else:
        models = ["gpt-4o-mini"]
    extra = {"HTTP-Referer": "https://github.com/market-news-bot", "X-Title": "Market News Bot"} if "openrouter.ai" in base else {}
    return base + "/chat/completions", key, models, extra


_DEAD_MODELS: set[str] = set()
_GOOD_MODEL: list[str] = []


def llm_json(prompt: str, max_tokens: int = 3000) -> dict:
    cfg = llm_config()
    if not cfg:
        raise RuntimeError("LLM не настроен")
    url, key, models, extra = cfg
    errs: list[str] = []
    for model in dict.fromkeys(_GOOD_MODEL + models):
        if model in _DEAD_MODELS:
            continue
        for attempt in range(2):
            try:
                r = requests.post(url, timeout=120,
                                  headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", **extra},
                                  json={"model": model, "temperature": 0.2, "max_tokens": max_tokens,
                                        "messages": [{"role": "system", "content": AI_SYSTEM},
                                                     {"role": "user", "content": prompt}]})
            except requests.RequestException as e:
                errs.append(f"{model}: {type(e).__name__}")
                continue
            if r.status_code == 429:
                errs.append(f"{model}: 429 {r.text[:120]}")
                time.sleep(8 * (attempt + 1))
                continue
            if r.status_code >= 400:
                errs.append(f"{model}: HTTP {r.status_code} {r.text[:160]}")
                if r.status_code in (401, 403) and "openrouter" in url and "credit" not in r.text.lower():
                    raise RuntimeError(f"ключ LLM_API_KEY не принят: {r.text[:200]}")
                _DEAD_MODELS.add(model)
                break  # следующая модель
            try:
                body = r.json()
                content = body["choices"][0]["message"]["content"] or ""
            except Exception:  # noqa: BLE001
                errs.append(f"{model}: не-JSON ответ HTTP {r.status_code}: {r.text[:160]!r}")
                break
            m = re.search(r"\{.*\}", content, re.S)
            if not m:
                errs.append(f"{model}: ответ без JSON: {content[:120]!r}")
                break
            try:
                data = json.loads(m.group(0))
            except json.JSONDecodeError:
                errs.append(f"{model}: битый JSON")
                break
            if model not in _GOOD_MODEL:
                _GOOD_MODEL[:] = [model]
                print(f"[LLM] модель: {model}", file=sys.stderr)
            return data
    raise RuntimeError("LLM недоступен: " + " | ".join(errs[-6:]))


def page_description(url: str) -> str:
    """og:description статьи — ещё 1–2 предложения фактуры (Google News-ссылки пропускаем)."""
    if not url or "news.google.com" in url:
        return ""
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=8)
        head = r.text[:200_000]
    except Exception:  # noqa: BLE001
        return ""
    for pat in (r'<meta[^>]+(?:property|name)=["\'](?:og:description|description)["\'][^>]*content=["\']([^"\']{40,})',
                r'<meta[^>]+content=["\']([^"\']{40,})["\'][^>]*(?:property|name)=["\'](?:og:description|description)'):
        m = re.search(pat, head, re.I)
        if m:
            return html.unescape(m.group(1)).strip()[:500]
    return ""


def cluster_context(c: dict) -> dict:
    heads, facts = [], []
    for i in _uniq_by_outlet(c["items"])[:5]:
        heads.append(f"{i['outlet']}: {i['title']}")
        sm = i["summary"]
        if sm and sm.lower()[:60] != i["title"].lower()[:60] and "news.google.com" not in i["link"]:
            facts.append(sm)
    extra = 0
    for i in _uniq_by_outlet(c["items"]):
        if extra >= 2:
            break
        d = page_description(i["link"])
        if d and all(d[:60] not in f for f in facts):
            facts.append(d)
            extra += 1
    return {"headlines": heads, "details": facts[:5], "official": c["official"]}


def ai_enrich(chosen: list[dict], market_ctx: str = "") -> dict | None:
    if not chosen:
        return None
    if not llm_config():
        print("[LLM] не настроен: нет секрета LLM_API_KEY — использую машинный перевод", file=sys.stderr)
        return None
    with ThreadPoolExecutor(max_workers=6) as pool:
        ctx = list(pool.map(cluster_context, chosen))
    results: dict[int, dict] = {}
    try:
        for b in range(0, len(chosen), BATCH):
            payload = [dict(id=i, **ctx[i]) for i in range(b, min(b + BATCH, len(chosen)))]
            prompt = (
                "Ниже новости (JSON). Для КАЖДОЙ верни объект в массиве items:\n"
                "- id — как во входе;\n"
                "- title_ru — заголовок по-русски, до 14 слов, суть события, живым языком (не дословный перевод);\n"
                "- summary_ru — 3–5 предложений: что произошло; ключевые детали и цифры из текста; кто участники; "
                "предыстория, если она есть в тексте; что ожидается дальше;\n"
                "- why — 2–3 предложения о механизме влияния на рынки: через какой канал (ставки/доходности, доллар, "
                "инфляция, нефть, ликвидность, аппетит к риску, регуляторика) и что это означает для акций США и "
                "для крипты (BTC/ETH). Пиши конкретно: «рост доходностей 10-леток удорожает капитал → давит на "
                "техсектор и BTC», а не общие слова;\n"
                "- watch — 1 предложение: за чем следить дальше (событие, решение, уровень, дата — если это следует "
                "из текста), иначе пустая строка;\n"
                "- assets — затронутые активы кратко (например: «Nasdaq, NVDA, полупроводники, BTC»);\n"
                "- bias — bullish | bearish | mixed (для рынка акций/крипты в целом);\n"
                "- skip — true, если новость на самом деле не про рынки/экономику/геополитику.\n"
                "Формат ответа: {\"items\": [...]}\n\n" + json.dumps(payload, ensure_ascii=False)
            )
            data = llm_json(prompt, max_tokens=4000)
            for it in data.get("items", []):
                try:
                    results[int(it["id"])] = it
                except (KeyError, ValueError, TypeError):
                    pass
        picked = [(chosen[i], results[i]) for i in range(len(chosen))
                  if i in results and results[i].get("title_ru") and not results[i].get("skip")]
        if not picked:
            return None
        mood = ""
        try:
            titles = "\n".join(f"- {it['title_ru']}" for _, it in picked)
            mood = llm_json("Главные события дня:\n" + titles
                            + (f"\n\nИндикаторы рынка: {market_ctx}" if market_ctx else "")
                            + "\n\nОпиши общий фон для рынков акций и крипты "
                            "в 2–3 предложениях: риск-он или риск-офф, какие 1–2 темы сейчас главные драйверы и что это значит для "
                            "акций США и крипты. "
                            "Формат: {\"mood\": \"...\"}", max_tokens=400).get("mood", "")
        except Exception as e:  # noqa: BLE001
            print(f"[LLM] mood: {e}", file=sys.stderr)
        print(f"[LLM] обработано {len(picked)}/{len(chosen)} новостей", file=sys.stderr)
        return {"mood": mood, "items": picked}
    except Exception as e:  # noqa: BLE001
        print(f"[LLM] ошибка, перехожу на простой перевод: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------- запасной вариант: машинный перевод
def _google_tr(text: str) -> str:
    r = requests.get("https://translate.googleapis.com/translate_a/single",
                     params={"client": "gtx", "sl": "en", "tl": "ru", "dt": "t", "q": text[:1500]},
                     headers={"User-Agent": UA}, timeout=10)
    r.raise_for_status()
    return "".join(seg[0] for seg in r.json()[0] if seg and seg[0]).strip()


def _mymemory_tr(text: str) -> str:
    r = requests.get("https://api.mymemory.translated.net/get", params={"q": text[:480], "langpair": "en|ru"},
                     headers={"User-Agent": UA}, timeout=10)
    r.raise_for_status()
    d = r.json()
    t = (d.get("responseData") or {}).get("translatedText") or ""
    if d.get("responseStatus") not in (200, "200") or "MYMEMORY WARNING" in t.upper():
        raise RuntimeError(f"mymemory {d.get('responseStatus')}: {t[:100]}")
    return html.unescape(t).strip()


_TR_DEAD: set[str] = set()


def translate(text: str) -> str:
    if not text:
        return ""
    for name, fn in (("google", _google_tr), ("mymemory", _mymemory_tr)):
        if name in _TR_DEAD:
            continue
        try:
            out = fn(text)
            if out:
                return out
        except Exception as e:  # noqa: BLE001
            print(f"[translate] {name}: {type(e).__name__} {str(e)[:150]}", file=sys.stderr)
            _TR_DEAD.add(name)  # после первой ошибки этот сервис больше не дёргаем
    return ""


def translate_items(chosen: list[dict]) -> dict:
    out = {}
    for n, c in enumerate(chosen):
        l = c["lead"]
        sm = next((i["summary"] for i in c["items"]
                   if i["summary"] and "news.google.com" not in i["link"]
                   and i["summary"].lower()[:60] != i["title"].lower()[:60]), "")
        out[n] = {"title_ru": translate(l["title"]), "summary_ru": translate(sm[:500]) if sm else ""}
    return out


# ---------------------------------------------------------------- форматирование
BIAS = {"bullish": "🟢 позитив", "bearish": "🔴 негатив", "mixed": "🟡 неоднозначно"}


def fmt_item(n: int, c: dict, ai: dict | None) -> str:
    l = c["lead"]
    ai = ai or {}
    theme = c["themes"][0] if c["themes"] else ""
    emoji = theme.split(" ")[0] if theme else "•"
    ts = c["ts"].astimezone(MSK)
    t_msk = ts.strftime("%H:%M") if ts.date() == datetime.now(MSK).date() else ts.strftime("%d.%m %H:%M")
    links = " · ".join(
        f'<a href="{html.escape(i["link"], quote=True)}">{html.escape(i["outlet"])}</a>'
        for i in _uniq_by_outlet(c["items"])[:4])
    title = ai.get("title_ru") or l["title"]
    lines = [f"{n}. {emoji} <b>{html.escape(title)}</b>"]
    if ai.get("summary_ru"):
        lines.append(html.escape(ai["summary_ru"]))
    if ai.get("why"):
        lines.append(f"💡 <b>Влияние на рынки:</b> {html.escape(ai['why'])}")
    if ai.get("watch"):
        lines.append(f"👀 <b>Следить:</b> {html.escape(ai['watch'])}")
    meta = []
    if ai.get("assets"):
        meta.append(f"🎯 {html.escape(ai['assets'])}")
    if ai.get("bias") in BIAS:
        meta.append(BIAS[ai["bias"]])
    if meta:
        lines.append(" · ".join(meta))
    elif not ai.get("summary_ru") and theme:
        lines.append(f"<i>{html.escape(', '.join(c['themes'][:3]))}</i>")
    lines.append(f"{trust_badge(c)} · {t_msk} МСК · {links}")
    return "\n".join(lines)


def _uniq_by_outlet(items):
    seen, out = set(), []
    for i in items:
        if i["outlet"] not in seen:
            seen.add(i["outlet"])
            out.append(i)
    return out


def build_message(now: datetime, since: datetime, chosen, ai, mkts, cal, ok_sources: int, total_sources: int,
                  sentiment: list[str] | None = None) -> str:
    slot = "☀️ Утренний" if now.astimezone(MSK).hour < 12 else "🌆 Дневной"
    parts = [f"<b>{slot} дайджест рынков</b> — {now.astimezone(MSK):%d.%m.%Y, %H:%M} МСК",
             f"<i>Новости с {since.astimezone(MSK):%d.%m %H:%M} МСК</i>"]
    if ai and ai.get("mood"):
        parts.append(f"🧭 <b>Общий фон:</b> {html.escape(ai['mood'])}")
    if mkts:
        parts.append("<b>📈 Рынки</b>\n" + "\n".join(mkts))
    if sentiment:
        parts.append("<b>🌡 Настроения и перекупленность</b>\n" + "\n".join(sentiment))
    if ai:
        rows = [fmt_item(n, c, it) for n, (c, it) in enumerate(ai["items"], 1)]
    else:
        tr = LAST.get("translations")
        if tr is None:
            tr = LAST["translations"] = translate_items(chosen)
        rows = [fmt_item(n + 1, c, tr.get(n)) for n, c in enumerate(chosen)]
    parts.append("<b>🔥 Главные события</b>\n\n" + ("\n\n".join(rows) if rows else "Значимых событий не найдено."))
    if cal:
        parts.append("<b>📅 Календарь (high impact)</b>\n" + "\n".join(cal))
    parts.append(f"<i>Источники: {ok_sources}/{total_sources} доступны. 🏛 — официальный первоисточник, "
                 "✅ — история подтверждена несколькими независимыми изданиями. Не является инвест-рекомендацией.</i>")
    return "\n\n".join(parts)


# ---------------------------------------------------------------- данные для мини-приложения
def news_export(chosen, ai, tr) -> list[dict]:
    pairs = ai["items"] if ai else [(c, (tr or {}).get(n) or {}) for n, c in enumerate(chosen)]
    out = []
    for c, it in pairs:
        it = it or {}
        l = c["lead"]
        theme = c["themes"][0] if c["themes"] else ""
        out.append({
            "title": it.get("title_ru") or l["title"],
            "title_en": l["title"],
            "summary": it.get("summary_ru", ""),
            "why": it.get("why", ""),
            "watch": it.get("watch", ""),
            "assets": it.get("assets", ""),
            "bias": it.get("bias", ""),
            "emoji": theme.split(" ")[0] if theme else "•",
            "themes": [t.split(" ", 1)[1] for t in c["themes"][:3]],
            "official": c["official"],
            "outlets": len(c["outlets"]),
            "trust": re.sub(r"<[^>]+>", "", trust_badge(c)),
            "ts": c["ts"].isoformat(),
            "links": [{"outlet": i["outlet"], "url": i["link"]} for i in _uniq_by_outlet(c["items"])[:5]],
        })
    return out


def previous_news() -> dict:
    """В почасовом режиме новости берём из последней опубликованной версии приложения."""
    url = (os.getenv("WEBAPP_URL") or "").rstrip("/")
    if not url:
        return {}
    try:
        r = requests.get(url + "/data/app.json", headers={"User-Agent": UA}, timeout=HTTP_TIMEOUT,
                         params={"t": int(time.time())})
        r.raise_for_status()
        d = r.json()
        return {k: d.get(k) for k in ("news", "mood", "news_updated", "news_since")}
    except Exception as e:  # noqa: BLE001
        print(f"[app] не удалось взять прошлые новости: {e}", file=sys.stderr)
        return {}


def export_site(out_dir: str, now: datetime, payload: dict) -> None:
    import shutil
    src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "webapp")
    if os.path.isdir(src):
        shutil.copytree(src, out_dir, dirs_exist_ok=True)
    os.makedirs(os.path.join(out_dir, "data"), exist_ok=True)
    data = {"updated": now.isoformat(), **payload}
    with open(os.path.join(out_dir, "data", "app.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, default=str)
    print(f"[app] данные записаны: {len(data.get('news') or [])} новостей, "
          f"{len(data.get('markets') or [])} котировок", file=sys.stderr)


def webapp_markup() -> dict | None:
    url = (os.getenv("WEBAPP_URL") or "").strip()
    if not url:
        return None
    return {"inline_keyboard": [[{"text": "📊 Открыть приложение", "web_app": {"url": url}}]]}


def setup_menu_button() -> None:
    url = (os.getenv("WEBAPP_URL") or "").strip()
    if not url:
        return
    try:
        tg("setChatMenuButton", menu_button={"type": "web_app", "text": "Рынки", "web_app": {"url": url}})
    except Exception as e:  # noqa: BLE001
        print(f"[app] кнопка меню не установлена: {e}", file=sys.stderr)


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
    markup = webapp_markup()
    for cid in chat_ids:
        chunks = split_message(text)
        for n, chunk in enumerate(chunks):
            extra = {"reply_markup": markup} if markup and n == len(chunks) - 1 else {}
            try:
                tg("sendMessage", chat_id=cid, text=chunk, parse_mode="HTML",
                   link_preview_options={"is_disabled": True}, **extra)
            except RuntimeError as e:
                if "parse" not in str(e).lower():
                    raise
                print(f"HTML не принят ({e}), отправляю простым текстом", file=sys.stderr)
                plain = html.unescape(re.sub(r"<[^>]+>", "", chunk))
                tg("sendMessage", chat_id=cid, text=plain, link_preview_options={"is_disabled": True}, **extra)
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
    ap.add_argument("--dry-run", action="store_true", help="напечатать дайджест, ничего не отправлять")
    ap.add_argument("--get-chat-id", action="store_true")
    ap.add_argument("--mode", choices=["digest", "data"], default="digest",
                    help="digest — новости + рассылка; data — только котировки/индексы для приложения")
    ap.add_argument("--export", metavar="DIR", help="собрать мини-приложение с данными в папку DIR")
    args = ap.parse_args()

    if args.get_chat_id:
        get_chat_ids()
        return

    now = datetime.now(timezone.utc)
    sent_lines, sent_ctx = sentiment_block()
    mkts = markets()
    cal = econ_calendar(now)
    from sentiment import LAST_SENTIMENT

    if args.mode == "data":
        payload = {"markets": LAST.get("markets", []), "sentiment": LAST_SENTIMENT, "calendar": LAST.get("calendar", []),
                   **previous_news()}
        if args.export:
            export_site(args.export, now, payload)
        return

    since = window_start(now)
    news, report = collect(since)
    print("Статус источников:\n" + "\n".join(report), file=sys.stderr)
    ok_sources = sum(1 for r in report if " ok " in r[:7])

    for n in news:
        score_item(n)
    clusters = cluster(news)
    limit = int(os.getenv("MAX_ITEMS") or 8)
    chosen = select(clusters, limit)
    ai = ai_enrich(chosen, sent_ctx)

    text = build_message(now, since, chosen, ai, mkts, cal, ok_sources, len(FEEDS), sent_lines)

    if args.export:
        export_site(args.export, now, {
            "markets": LAST.get("markets", []), "sentiment": LAST_SENTIMENT, "calendar": LAST.get("calendar", []),
            "news": news_export(chosen, ai, LAST.get("translations")), "mood": (ai or {}).get("mood", ""),
            "news_updated": now.isoformat(), "news_since": since.isoformat()})

    if args.dry_run:
        print(text)
    else:
        send(text)
        setup_menu_button()
        print(f"Отправлено: {len(ai['items']) if ai else len(chosen)} событий", file=sys.stderr)


if __name__ == "__main__":
    main()
