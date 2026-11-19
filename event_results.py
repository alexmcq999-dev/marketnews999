"""Итоги событий экономического календаря: чем закончилось и как отреагировал рынок.

Для каждого прошедшего события недели (High/Medium):
  1. Реакция рынка: ИЗМЕРЯЕМ, а не угадываем. Берём 5-минутные цены (Yahoo) и считаем изменение
     от последней цены до события до цены через 60 минут: BTC, S&P 500 (фьючерс), DXY, доходность US10Y, золото.
  2. Факт: официальное значение из экономического календаря TradingView (actual / forecast / previous).
     Для решений ЦБ по ставке из него же считается решение: «ставка 4,25% (−25 б.п.)».
  3. Если факта в календаре нет — ищем свежие заголовки в Google News и просим ИИ вытащить значение
     (только если оно явно есть в заголовках). ИИ пишет короткий итог: что вышло, тон (ястребиный/голубиный) и вывод.
     Значение из заголовков проверяется: оно должно дословно встречаться в заголовках, иначе отбрасывается.
Результаты переносятся между запусками через ранее опубликованный app.json, поэтому ИИ вызывается
для каждого события один-два раза.
"""
from __future__ import annotations

import calendar as _cal
import html
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote_plus

import feedparser
import requests

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
TIMEOUT = 20
HORIZON_MIN = 60          # реакция рынка за 60 минут после события
MAX_PER_RUN = 12          # сколько событий максимум обрабатывать за запуск
MAX_ATTEMPTS = 3          # сколько раз пытаться найти фактическое значение

COUNTRY = {"USD": "US", "EUR": "Eurozone", "GBP": "UK", "JPY": "Japan", "CNY": "China", "ALL": ""}
ASSETS = [  # (подпись, источники по порядку, единица). hl: — свечи Hyperliquid, yf: — Yahoo, bn: — Binance
    ("BTC", ("hl:BTC", "bn:BTCUSDT", "yf:BTC-USD"), "pct"),
    ("S&P 500", ("hl:xyz:SP500", "yf:ES=F"), "pct"),
    ("DXY", ("yf:DX-Y.NYB", "hl:xyz:DXY"), "pct"),
    ("US10Y", ("hl:para:10Y", "yf:^TNX"), "bp"),
    ("Золото", ("hl:xyz:GOLD", "bn:PAXGUSDT", "yf:GC=F"), "pct"),
]
PAIR = {  # валютная пара страны события
    "USD": ("EUR/USD", ("hl:xyz:EUR", "bn:EURUSDT", "yf:EURUSD=X"), "pct"),
    "EUR": ("EUR/USD", ("hl:xyz:EUR", "bn:EURUSDT", "yf:EURUSD=X"), "pct"),
    "GBP": ("GBP/USD", ("hl:xyz:GBP", "yf:GBPUSD=X"), "pct"),
    "JPY": ("USD/JPY", ("hl:xyz:JPY", "yf:JPY=X"), "pct"),
}
RESULTS_VERSION = 2   # при смене логики старые итоги пересчитываются
TALK = re.compile(r"\b(speaks?|speech|testif\w*|press conference|minutes|statement|summit|meetings?|hearing)\b", re.I)
EXPAND = [(r"\bm/m\b", "month over month"), (r"\by/y\b", "year over year"), (r"\bq/q\b", "quarter over quarter"),
          (r"\bCPI\b", "CPI inflation"), (r"\bPPI\b", "PPI producer prices"), (r"\bGDP\b", "GDP"),
          (r"\bPMI\b", "PMI"), (r"Federal Funds Rate", "Fed interest rate decision"),
          (r"Non-Farm Employment Change", "nonfarm payrolls jobs report"), (r"Unemployment Claims", "jobless claims"),
          (r"\bFOMC\b", "FOMC Fed"), (r"\bBOJ\b", "Bank of Japan"), (r"\bECB\b", "ECB"), (r"\bBOE\b", "Bank of England")]


def key(ev: dict) -> str:
    return f"{ev['ts']}|{ev.get('country', '')}|{ev.get('title', '')}"


# ------------------------------------------------------------------ цены
def _yahoo(symbol: str) -> list[tuple[int, float]]:
    for host in ("query1", "query2"):
        try:
            r = requests.get(f"https://{host}.finance.yahoo.com/v8/finance/chart/{requests.utils.quote(symbol)}",
                             params={"range": "7d", "interval": "5m"}, headers={"User-Agent": UA}, timeout=TIMEOUT)
            if r.status_code == 429:
                time.sleep(1.5)
                continue
            r.raise_for_status()
            res = r.json()["chart"]["result"][0]
            ts, cl = res.get("timestamp") or [], res["indicators"]["quote"][0]["close"]
            return [(t, c) for t, c in zip(ts, cl) if c is not None]
        except Exception as e:  # noqa: BLE001
            print(f"[results] yahoo {symbol}: {type(e).__name__}", file=sys.stderr)
    return []


def _hyperliquid(coin: str) -> list[tuple[int, float]]:
    now = int(time.time() * 1000)
    try:
        r = requests.post("https://api.hyperliquid.xyz/info", timeout=TIMEOUT,
                          json={"type": "candleSnapshot", "req": {"coin": coin, "interval": "5m",
                                                                   "startTime": now - 8 * 86400 * 1000, "endTime": now}})
        r.raise_for_status()
        rows = r.json() or []
        return [(int(x["t"]) // 1000, float(x["c"])) for x in rows if isinstance(x, dict) and x.get("c")]
    except Exception as e:  # noqa: BLE001
        print(f"[results] hyperliquid {coin}: {type(e).__name__}", file=sys.stderr)
        return []


def _binance(symbol: str) -> list[tuple[int, float]]:
    out, end = [], int(time.time() * 1000)
    try:
        for _ in range(3):  # 3 × 1000 пятиминуток ≈ 10 дней
            r = requests.get("https://data-api.binance.vision/api/v3/klines", timeout=TIMEOUT,
                             params={"symbol": symbol, "interval": "5m", "limit": 1000, "endTime": end})
            r.raise_for_status()
            rows = r.json() or []
            if not rows:
                break
            out = [(int(k[0]) // 1000, float(k[4])) for k in rows] + out
            end = int(rows[0][0]) - 1
        return out
    except Exception as e:  # noqa: BLE001
        print(f"[results] binance {symbol}: {type(e).__name__}", file=sys.stderr)
        return out


_SERIES: dict[str, list] = {}


def series_for(sources: tuple) -> list[tuple[int, float]]:
    """Первая непустая серия 5-минутных цен из списка источников (результат кэшируется на запуск)."""
    for src in sources:
        if src not in _SERIES:
            kind, sym = src.split(":", 1)
            _SERIES[src] = {"hl": _hyperliquid, "bn": _binance, "yf": _yahoo}[kind](sym)
            if _SERIES[src]:
                print(f"[results] цены {src}: {len(_SERIES[src])} свечей", file=sys.stderr)
        if _SERIES[src]:
            return _SERIES[src]
    return []


def intraday(symbol: str) -> list[tuple[int, float]]:   # совместимость
    return _yahoo(symbol)


def _price_at(series, t: int) -> float | None:
    """Последняя цена с меткой ≤ t (5-минутные бары: метка = начало бара → берём бар, закончившийся до t)."""
    best = None
    for ts, c in series:
        if ts + 300 <= t:
            best = c
        else:
            break
    return best


def reaction(ev: dict, t_event: datetime, now: datetime) -> tuple[list[dict], bool]:
    """Изменение цены за HORIZON_MIN минут после события (BTC, S&P 500, DXY, US10Y, золото, пара страны)."""
    t0 = int(t_event.timestamp())
    t1 = t0 + HORIZON_MIN * 60
    full = now.timestamp() >= t1 + 300
    assets = list(ASSETS)
    if ev.get("country") in PAIR:
        assets.insert(2, PAIR[ev["country"]])
    out = []
    for name, sources, unit in assets:
        s = series_for(sources)
        if not s or s[-1][0] < t0:  # нет данных после события
            continue
        p0 = _price_at(s, t0)
        p1 = _price_at(s, min(t1, int(now.timestamp())))
        if p0 is None or p1 is None or p0 == 0:
            continue
        v = (p1 - p0) * 100 if unit == "bp" else (p1 / p0 - 1) * 100
        out.append({"asset": name, "unit": unit, "value": round(v, 2 if unit == "pct" else 1)})
    return out, full


def reaction_label(rx: list[dict]) -> str:
    m = {r["asset"]: r["value"] for r in rx}
    btc, spx = m.get("BTC"), m.get("S&P 500")
    vals = [abs(v) for v in (btc, spx) if v is not None]
    if not vals:
        return ""
    if max(vals) < 0.25:
        return "рынок почти не отреагировал"
    up = sum(1 for v in (btc, spx) if v is not None and v > 0.15)
    dn = sum(1 for v in (btc, spx) if v is not None and v < -0.15)
    if up and not dn:
        return "рисковые активы выросли"
    if dn and not up:
        return "рисковые активы снизились"
    return "реакция разнонаправленная"


# ------------------------------------------------------------------ заголовки
def _query(ev: dict) -> str:
    title = ev.get("title", "")
    for pat, rep in EXPAND:
        title = re.sub(pat, rep, title)
    return f"{COUNTRY.get(ev.get('country'), '')} {title}".strip()


def headlines(ev: dict, t_event: datetime, limit: int = 8) -> list[dict]:
    url = ("https://news.google.com/rss/search?q=" + quote_plus(_query(ev) + " when:2d")
           + "&hl=en-US&gl=US&ceid=US:en")
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=TIMEOUT)
        r.raise_for_status()
        feed = feedparser.parse(r.content)
    except Exception as e:  # noqa: BLE001
        print(f"[results] news {ev.get('title')}: {type(e).__name__}", file=sys.stderr)
        return []
    lo, hi = t_event - timedelta(minutes=30), t_event + timedelta(hours=20)
    out = []
    for e in feed.entries:
        ts = e.get("published_parsed")
        if not ts:
            continue
        t = datetime.fromtimestamp(_cal.timegm(ts), tz=timezone.utc)
        if not (lo <= t <= hi):
            continue
        title = html.unescape(re.sub(r"<[^>]+>", "", e.get("title", ""))).strip()
        src = (e.get("source") or {}).get("title", "") if isinstance(e.get("source"), dict) else ""
        out.append({"title": title, "source": src, "link": e.get("link", ""), "ts": t.isoformat()})
        if len(out) >= limit:
            break
    return out


# ------------------------------------------------------------------ сверка чисел
NUM = re.compile(r"-?\d+(?:[.,]\d+)?")


def _num(s: str) -> float | None:
    m = NUM.search(str(s or "").replace(",", "."))
    if not m:
        return None
    v = float(m.group(0))
    mult = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}
    tail = str(s).strip()[-1:].upper()
    return v * mult.get(tail, 1)


def compare(actual: str, forecast: str) -> str:
    a, f = _num(actual), _num(forecast)
    if a is None or f is None:
        return ""
    tol = max(abs(f) * 0.001, 1e-9)
    return "above" if a > f + tol else "below" if a < f - tol else "inline"


def _in_headlines(actual: str, heads: list[dict]) -> bool:
    if not actual:
        return False
    core = NUM.search(actual.replace(",", "."))
    if not core:
        return False
    blob = " ".join(h["title"] for h in heads).replace(",", ".")
    return core.group(0) in blob



# ------------------------------------------------------------------ официальные значения: календарь TradingView
TV_CC = {"USD": "US", "EUR": "EU", "GBP": "GB", "JPY": "JP", "CNY": "CN", "AUD": "AU", "CAD": "CA", "CHF": "CH", "NZD": "NZ"}
RATE = re.compile(r"(interest rate decision|rate decision|federal funds rate|funds rate|cash rate|bank rate|main refinancing|"
                  r"refinancing rate|deposit (facility )?rate|policy rate|official bank rate|overnight rate|loan prime rate)", re.I)
ALIAS = [  # названия ForexFactory → как в календаре TradingView
    (r"unemployment claims", "initial jobless claims"), (r"federal funds rate", "fed interest rate decision"),
    (r"core retail sales", "retail sales ex autos"), (r"non-farm employment change", "non farm payrolls"),
    (r"\bcore cpi\b", "core inflation rate"), (r"\bcpi\b", "inflation rate"), (r"\bcore pce price index\b", "core pce price index"),
    (r"main refinancing rate", "ecb interest rate decision"), (r"official bank rate", "boe interest rate decision"),
    (r"boj policy rate", "boj interest rate decision"), (r"average earnings index", "average earnings incl bonus"),
    (r"prelim gdp", "gdp growth rate"), (r"advance gdp", "gdp growth rate"), (r"final gdp", "gdp growth rate"),
    (r"\bism manufacturing pmi\b", "ism manufacturing pmi"), (r"\bism services pmi\b", "ism services pmi"),
    (r"flash manufacturing pmi", "manufacturing pmi"), (r"flash services pmi", "services pmi"),
    (r"jolts job openings", "jolts job openings"), (r"\bppi\b", "ppi"),
]
STOPW = {"the", "of", "and", "sa", "nsa", "final", "prelim", "flash", "advance", "change", "index", "s"}


def _norm(title: str, ff: bool) -> set[str]:
    t = str(title or "").lower()
    t = re.sub(r"\bm/m\b", " mom ", t); t = re.sub(r"\by/y\b", " yoy ", t); t = re.sub(r"\bq/q\b", " qoq ", t)
    t = re.sub(r"\b3m/y\b", " 3mo yoy ", t); t = t.replace("(3mo/yr)", " 3mo yoy ")
    if ff:
        for pat, rep in ALIAS:
            t = re.sub(pat, rep, t)
    return {w for w in re.findall(r"[a-z0-9]+", t) if w not in STOPW and len(w) > 1}


def tv_events(t_from: datetime, t_to: datetime) -> list[dict]:
    try:
        r = requests.get("https://economic-calendar.tradingview.com/events",
                         params={"from": t_from.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "to": t_to.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                                 "countries": ",".join(sorted(set(TV_CC.values())))},
                         headers={"User-Agent": UA, "Origin": "https://www.tradingview.com", "Referer": "https://www.tradingview.com/"},
                         timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()
        res = data.get("result") if isinstance(data, dict) else data
        out = [e for e in (res or []) if isinstance(e, dict) and e.get("date")]
        print(f"[results] TradingView: {len(out)} событий", file=sys.stderr)
        return out
    except Exception as e:  # noqa: BLE001
        print(f"[results] TradingView: {type(e).__name__} {e}", file=sys.stderr)
        return []


def tv_value(v, ev: dict) -> str:
    """Число из календаря TradingView → строка в стиле ForexFactory: «0.4%», «254K», «1.38M», «3.75%»."""
    if v is None or v == "":
        return ""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return str(v)
    unit = str(ev.get("unit") or "").strip()
    scale = str(ev.get("scale") or "").strip()
    num = f"{x:.2f}".rstrip("0").rstrip(".") if abs(x) < 1000 else f"{x:,.0f}".replace(",", " ")
    if unit == "%":
        return f"{num}%"
    if scale in ("K", "M", "B", "T"):
        return f"{num}{scale}"
    if unit in ("K", "M", "B", "T"):
        return f"{num}{unit}"
    return num


def tv_match(ev: dict, t: datetime, pool: list[dict]) -> dict | None:
    cc = TV_CC.get(ev.get("country"))
    if not cc:
        return None
    cands = []
    for x in pool:
        if str(x.get("country", "")).upper() != cc:
            continue
        try:
            tx = datetime.fromisoformat(str(x["date"]).replace("Z", "+00:00"))
        except Exception:  # noqa: BLE001
            continue
        if abs((tx - t).total_seconds()) > 15 * 60:
            continue
        a, b = _norm(ev.get("title"), True), _norm(f"{x.get('title', '')} {x.get('indicator', '')}", False)
        score = len(a & b) / max(1, len(a | b))
        if RATE.search(ev.get("title", "")) and RATE.search(f"{x.get('title', '')} {x.get('indicator', '')}"):
            score += 0.5
        cands.append((score, x))
    if not cands:
        return None
    cands.sort(key=lambda c: -c[0])
    best, x = cands[0]
    if best >= 0.34 or (len(cands) == 1 and best >= 0.15):
        return x
    return None


def _pct(s: str) -> float | None:
    m = NUM.search(str(s or "").replace(",", "."))
    return float(m.group(0)) if m else None


def rate_decision(actual: str, previous: str) -> str:
    a, p = _pct(actual), _pct(previous)
    if a is None:
        return ""
    if p is None:
        return f"ставка {actual}"
    bp = round((a - p) * 100)
    if bp == 0:
        return f"ставка без изменений: {actual}"
    return f"ставка {actual} ({'+' if bp > 0 else '−'}{abs(bp)} б.п., было {previous})"


def enrich_official(cal: list[dict], results: dict, now: datetime) -> int:
    """Проставляет факт (и решение по ставке) из календаря TradingView. Возвращает число обновлённых событий."""
    past = []
    for ev in cal:
        try:
            t = datetime.fromisoformat(ev["ts"]).astimezone(timezone.utc)
        except Exception:  # noqa: BLE001
            continue
        if now - timedelta(days=7) <= t <= now - timedelta(minutes=2):
            past.append((t, ev))
    if not past:
        return 0
    pool = tv_events(min(t for t, _ in past) - timedelta(hours=1), now + timedelta(minutes=5))
    n = 0
    for t, ev in past:
        x = tv_match(ev, t, pool)
        if not x or x.get("actual") is None:
            continue
        k = key(ev)
        r = dict(results.get(k) or {})
        actual = tv_value(x.get("actual"), x)
        if not actual or r.get("actual_src") == "tradingview" and r.get("actual") == actual:
            continue
        r["actual"], r["actual_src"] = actual, "tradingview"
        fc = ev.get("forecast") or tv_value(x.get("forecast"), x)
        prev = ev.get("previous") or tv_value(x.get("previous"), x)
        r["vs_forecast"] = compare(actual, fc)
        if RATE.search(ev.get("title", "")) or RATE.search(str(x.get("title", ""))):
            r["decision"] = rate_decision(actual, prev)
        # итог мог быть написан без факта («результат в новостях не найден») — перепишем с фактом
        if "не найден" in str(r.get("summary", "")).lower() or not r.get("summary"):
            r.pop("summary", None)
            r.pop("summary_i18n", None)
            r["final"] = False
            r["attempts"] = min(r.get("attempts", 0), MAX_ATTEMPTS - 1)
        results[k] = r
        n += 1
    print(f"[results] TradingView: факт найден для {n} событий", file=sys.stderr)
    return n

# ------------------------------------------------------------------ основной проход
PROMPT = (
    "Ниже прошедшие события экономического календаря (JSON). Для каждого есть прогноз/предыдущее значение, "
    "свежие заголовки новостей и ИЗМЕРЕННАЯ реакция рынка за 60 минут после события. Пиши ТОЛЬКО по-русски. "
    "Для КАЖДОГО события верни объект в items:\n"
    "- id — как во входе;\n"
    "- actual — фактическое значение в тех же единицах, что прогноз (например «0.4%», «254K»), ТОЛЬКО если оно явно "
    "есть в заголовках; иначе пустая строка. Для выступлений, протоколов и обзоров — пустая строка. Если во входе есть "
    "official_actual — это официальный факт: верни его же;\n"
    "- decision — для решений ЦБ по ставке: новая ставка и изменение (например «ставка 4.25%, −25 б.п.»), иначе пусто;\n"
    "- tone — hawkish | dovish | neutral | '' (для ЦБ, выступлений, протоколов и инфляции/занятости — как результат "
    "влияет на ставки);\n"
    "- summary — 1–2 предложения: что вышло или что сказали.\n"
    "  • Для статистики — с цифрами: факт против прогноза и прошлого значения (official_actual, если есть).\n"
    "  • Для выступлений, протоколов (minutes), обзоров и пресс-конференций — главные тезисы из заголовков: что сказали "
    "о ставке, инфляции, экономике, рисках. Заголовки и есть результат — перескажи их суть своими словами.\n"
    "  • Если по заголовкам действительно нельзя понять содержание — пустая строка. Никогда не пиши фразы вроде "
    "«результат не найден» или «нет данных»;\n"
    "- impact — 1 предложение: что это значит для доллара, акций и крипты. Опирайся на измеренную реакцию рынка "
    "(market_reaction_60m) и называй реальные движения из неё; если её нет — коротко, чего ждать, без выдуманных цифр. "
    "Никогда не пиши «реакция не зафиксирована» или «не найден».\n"
    "Формат ответа: {\"items\": [...]}\n\n"
)
JUNK = re.compile(r"не найден|не зафиксирован|нет данных|not found|no data", re.I)


def _migrate(results: dict) -> None:
    """Итоги, посчитанные прошлой логикой (без реакции рынка, с «не найден»), пересчитываем заново."""
    for r in results.values():
        if r.get("v") == RESULTS_VERSION:
            continue
        for f in ("summary", "impact", "reaction_label"):
            if JUNK.search(str(r.get(f) or "")):
                r.pop(f, None)
                r.pop(f + "_i18n", None)
        if not any(x.get("asset") == "BTC" for x in r.get("reaction") or []):
            r.pop("reaction", None)
            r.pop("reaction_full", None)
            r.pop("reaction_label", None)
        if r.get("summary") and not re.search(r"[а-яё]", r["summary"], re.I):   # итог по-английски — перепишем
            r.pop("summary", None)
            r.pop("summary_i18n", None)
        r["final"] = False
        r["attempts"] = 0
        r["v"] = RESULTS_VERSION


def build(cal: list[dict], prev: dict, now: datetime, llm_json=None) -> dict:
    """Возвращает {key: result} для прошедших событий. prev — результаты прошлых запусков."""
    results = {k: v for k, v in (prev or {}).items()}
    _migrate(results)
    try:
        enrich_official(cal, results, now)
    except Exception as e:  # noqa: BLE001
        print(f"[results] TradingView: {e}", file=sys.stderr)
    past = []
    for ev in cal:
        try:
            t = datetime.fromisoformat(ev["ts"]).astimezone(timezone.utc)
        except Exception:  # noqa: BLE001
            continue
        if t > now - timedelta(minutes=10) or t < now - timedelta(days=7):
            continue
        r = results.get(key(ev)) or {}
        done = r.get("final")
        if not done:
            past.append((t, ev))
    past.sort(key=lambda x: (x[1].get("impact") != "High", -x[0].timestamp()))
    past = past[:MAX_PER_RUN]
    if not past:
        return {k: v for k, v in results.items() if any(key(e) == k for e in cal)}

    pending = []
    for t, ev in past:
        k = key(ev)
        r = dict(results.get(k) or {})
        rx, full = reaction(ev, t, now)
        if rx:
            r["reaction"], r["reaction_full"] = rx, full
            r["reaction_label"] = reaction_label(rx)
        heads = headlines(ev, t)
        if not heads and r.get("sources"):   # поиск не ответил — используем заголовки прошлого запуска
            heads = [{"title": x.get("title", ""), "source": x.get("source", ""), "link": x.get("url", ""), "ts": ""}
                     for x in r["sources"]]
        if heads:
            r["sources"] = [{"title": h["title"], "source": h["source"], "url": h["link"]} for h in heads[:3]]
        r["attempts"] = r.get("attempts", 0) + 1
        results[k] = r
        pending.append((k, ev, t, heads))

    if llm_json:
        for i in range(0, len(pending), 4):
            chunk = pending[i:i + 4]
            payload = [{"id": n, "event": ev.get("title"), "country": ev.get("country"),
                        "time_utc": t.strftime("%Y-%m-%d %H:%M"), "forecast": ev.get("forecast", ""),
                        "previous": ev.get("previous", ""),
                        "official_actual": results[k].get("actual", "") if results[k].get("actual_src") == "tradingview" else "",
                        "official_decision": results[k].get("decision", ""),
                        "headlines": [f"{h['title']} ({h['source']})" for h in heads],
                        "market_reaction_60m": {x["asset"]: f"{x['value']:+}{'%' if x['unit'] == 'pct' else ' bp'}"
                                                for x in results[k].get("reaction", [])}}
                       for n, (k, ev, t, heads) in enumerate(chunk)]
            try:
                import json
                data = llm_json(PROMPT + json.dumps(payload, ensure_ascii=False), max_tokens=1800)
            except Exception as e:  # noqa: BLE001
                print(f"[results] LLM: {e}", file=sys.stderr)
                break
            for it in data.get("items", []):
                try:
                    k, ev, t, heads = chunk[int(it["id"])]
                except (KeyError, ValueError, IndexError, TypeError):
                    continue
                r = results[k]
                actual = str(it.get("actual") or "").strip()
                if r.get("actual_src") == "tradingview":
                    actual = ""                                  # официальный факт уже есть — не трогаем
                if actual and _in_headlines(actual, heads):   # защита от выдуманных чисел
                    r["actual"] = actual
                    r["vs_forecast"] = compare(actual, ev.get("forecast", ""))
                for f in ("decision", "summary", "impact"):
                    if f == "decision" and r.get("actual_src") == "tradingview" and r.get("decision"):
                        continue
                    val = str(it.get(f) or "").strip()
                    if val and not JUNK.search(val):
                        r[f] = val
                if it.get("tone") in ("hawkish", "dovish", "neutral"):
                    r["tone"] = it["tone"]

    for k, ev, t, heads in pending:
        r = results[k]
        r["final"] = bool((r.get("reaction_full") or r.get("attempts", 0) >= MAX_ATTEMPTS + 2)
                          and (r.get("summary") or not llm_json or r.get("attempts", 0) >= MAX_ATTEMPTS)
                          and (r.get("actual") or r.get("attempts", 0) >= MAX_ATTEMPTS or TALK.search(ev.get("title", ""))))
        r["v"] = RESULTS_VERSION
    keep = {key(e) for e in cal}
    return {k: v for k, v in results.items() if k in keep}


def attach(cal: list[dict], results: dict) -> list[dict]:
    out = []
    for ev in cal:
        r = results.get(key(ev))
        e = dict(ev)
        if r:
            e["result"] = r
            if r.get("actual") and not e.get("actual"):
                e["actual"] = r["actual"]
        out.append(e)
    return out


VS = {"above": "выше прогноза", "below": "ниже прогноза", "inline": "в рамках прогноза"}
TONE = {"hawkish": "ястребино", "dovish": "голубино", "neutral": "нейтрально"}


def digest_lines(cal: list[dict], since: datetime, now: datetime) -> list[str]:
    """Строки «📌 Итоги» для Telegram: High-события с результатом за период."""
    lines = []
    msk = timezone(timedelta(hours=3))
    for ev in cal:
        r = ev.get("result")
        if not r or ev.get("impact") != "High":
            continue
        t = datetime.fromisoformat(ev["ts"])
        if not (since <= t.astimezone(timezone.utc) <= now):
            continue
        head = f"<b>{ev.get('country')}</b> {html.escape(ev.get('title', ''))}"
        bits = []
        if r.get("actual"):
            fc = f" (прогноз {html.escape(ev['forecast'])})" if ev.get("forecast") else ""
            bits.append(f"факт <b>{html.escape(r['actual'])}</b>{fc}" + (f" — {VS[r['vs_forecast']]}" if r.get("vs_forecast") in VS else ""))
        if r.get("decision"):
            bits.append(html.escape(r["decision"]))
        if r.get("tone") in TONE:
            bits.append(TONE[r["tone"]])
        rx = " · ".join(f"{x['asset']} {x['value']:+.2f}%" if x["unit"] == "pct" else f"{x['asset']} {x['value']:+.0f} б.п."
                        for x in (r.get("reaction") or []) if x["asset"] in ("BTC", "S&P 500", "DXY", "US10Y"))
        line = f"🕐 {t.astimezone(msk):%d.%m %H:%M} {head}"
        if bits:
            line += "\n   " + "; ".join(bits)
        if rx:
            line += f"\n   ⏱ за час: {rx}"
        if r.get("impact"):
            line += f"\n   <i>{html.escape(r['impact'])}</i>"
        lines.append(line)
    return lines
