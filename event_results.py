"""Итоги событий экономического календаря: чем закончилось и как отреагировал рынок.

Для каждого прошедшего события недели (High/Medium):
  1. Реакция рынка: ИЗМЕРЯЕМ, а не угадываем. Берём 5-минутные цены (Yahoo) и считаем изменение
     от последней цены до события до цены через 60 минут: BTC, S&P 500 (фьючерс), DXY, доходность US10Y, золото.
  2. Результат: ищем свежие заголовки в Google News и просим ИИ вытащить фактическое значение
     (только если оно явно есть в заголовках), сравнение с прогнозом, тон (ястребиный/голубиный) и вывод.
     Фактическое значение проверяется: оно должно дословно встречаться в заголовках, иначе отбрасывается.
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
ASSETS = [  # (подпись, тикер Yahoo, единица)
    ("BTC", "BTC-USD", "pct"),
    ("S&P 500", "ES=F", "pct"),
    ("DXY", "DX-Y.NYB", "pct"),
    ("US10Y", "^TNX", "bp"),
    ("Золото", "GC=F", "pct"),
]
TALK = re.compile(r"\b(speaks?|speech|testif\w*|press conference|minutes|statement|summit|meetings?|hearing)\b", re.I)
EXPAND = [(r"\bm/m\b", "month over month"), (r"\by/y\b", "year over year"), (r"\bq/q\b", "quarter over quarter"),
          (r"\bCPI\b", "CPI inflation"), (r"\bPPI\b", "PPI producer prices"), (r"\bGDP\b", "GDP"),
          (r"\bPMI\b", "PMI"), (r"Federal Funds Rate", "Fed interest rate decision"),
          (r"Non-Farm Employment Change", "nonfarm payrolls jobs report"), (r"Unemployment Claims", "jobless claims"),
          (r"\bFOMC\b", "FOMC Fed"), (r"\bBOJ\b", "Bank of Japan"), (r"\bECB\b", "ECB"), (r"\bBOE\b", "Bank of England")]


def key(ev: dict) -> str:
    return f"{ev['ts']}|{ev.get('country', '')}|{ev.get('title', '')}"


# ------------------------------------------------------------------ цены
def intraday(symbol: str) -> list[tuple[int, float]]:
    for host in ("query1", "query2"):
        try:
            r = requests.get(f"https://{host}.finance.yahoo.com/v8/finance/chart/{requests.utils.quote(symbol)}",
                             params={"range": "5d", "interval": "5m"}, headers={"User-Agent": UA}, timeout=TIMEOUT)
            if r.status_code == 429:
                time.sleep(1.5)
                continue
            r.raise_for_status()
            res = r.json()["chart"]["result"][0]
            ts, cl = res.get("timestamp") or [], res["indicators"]["quote"][0]["close"]
            return [(t, c) for t, c in zip(ts, cl) if c is not None]
        except Exception as e:  # noqa: BLE001
            print(f"[results] {symbol}: {type(e).__name__}", file=sys.stderr)
    return []


def _price_at(series, t: int) -> float | None:
    """Последняя цена с меткой ≤ t (5-минутные бары: метка = начало бара → берём бар, закончившийся до t)."""
    best = None
    for ts, c in series:
        if ts + 300 <= t:
            best = c
        else:
            break
    return best


def reaction(series: dict, t_event: datetime, now: datetime) -> tuple[list[dict], bool]:
    t0 = int(t_event.timestamp())
    t1 = t0 + HORIZON_MIN * 60
    full = now.timestamp() >= t1 + 300
    out = []
    for name, sym, unit in ASSETS:
        s = series.get(sym) or []
        p0 = _price_at(s, t0)
        p1 = _price_at(s, min(t1, int(now.timestamp())))
        if p0 is None or p1 is None or p0 == 0:
            continue
        if not s or s[-1][0] < t0:  # рынок закрыт — данных после события нет
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


# ------------------------------------------------------------------ основной проход
PROMPT = (
    "Ниже прошедшие события экономического календаря (JSON). Для каждого есть прогноз/предыдущее значение, "
    "свежие заголовки новостей и ИЗМЕРЕННАЯ реакция рынка за 60 минут после события. Для КАЖДОГО верни объект в items:\n"
    "- id — как во входе;\n"
    "- actual — фактическое значение в тех же единицах, что прогноз (например «0.4%», «254K»), ТОЛЬКО если оно явно "
    "есть в заголовках; иначе пустая строка. Для выступлений и решений без числа — пустая строка;\n"
    "- decision — для решений ЦБ по ставке: новая ставка и изменение (например «ставка 4.25%, −25 б.п.»), иначе пусто;\n"
    "- tone — hawkish | dovish | neutral | '' (для ЦБ, выступлений и инфляции/занятости — как результат влияет на ставки);\n"
    "- summary — 1–2 предложения по-русски: что вышло или что сказали. Только факты из заголовков; если в заголовках "
    "результата нет — так и напиши: «результат в новостях не найден»;\n"
    "- impact — 1 предложение по-русски: что это значит для доллара, акций и крипты. Опирайся на измеренную реакцию рынка "
    "из входа, не придумывай движения, которых там нет.\n"
    "Формат ответа: {\"items\": [...]}\n\n"
)


def build(cal: list[dict], prev: dict, now: datetime, llm_json=None) -> dict:
    """Возвращает {key: result} для прошедших событий. prev — результаты прошлых запусков."""
    results = {k: v for k, v in (prev or {}).items()}
    past = []
    for ev in cal:
        try:
            t = datetime.fromisoformat(ev["ts"]).astimezone(timezone.utc)
        except Exception:  # noqa: BLE001
            continue
        if t > now - timedelta(minutes=10) or t < now - timedelta(days=7):
            continue
        r = results.get(key(ev)) or {}
        done = r.get("final") or (r.get("reaction_full") and (r.get("summary") or not llm_json)
                                  and (r.get("actual") or r.get("attempts", 0) >= MAX_ATTEMPTS
                                       or TALK.search(ev.get("title", ""))))
        if not done:
            past.append((t, ev))
    past.sort(key=lambda x: (x[1].get("impact") != "High", -x[0].timestamp()))
    past = past[:MAX_PER_RUN]
    if not past:
        return {k: v for k, v in results.items() if any(key(e) == k for e in cal)}

    series = {sym: intraday(sym) for _, sym, _ in ASSETS}
    pending = []
    for t, ev in past:
        k = key(ev)
        r = dict(results.get(k) or {})
        rx, full = reaction(series, t, now)
        if rx:
            r["reaction"], r["reaction_full"] = rx, full
            r["reaction_label"] = reaction_label(rx)
        heads = headlines(ev, t)
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
                if actual and _in_headlines(actual, heads):   # защита от выдуманных чисел
                    r["actual"] = actual
                    r["vs_forecast"] = compare(actual, ev.get("forecast", ""))
                for f in ("decision", "summary", "impact"):
                    if it.get(f):
                        r[f] = str(it[f]).strip()
                if it.get("tone") in ("hawkish", "dovish", "neutral"):
                    r["tone"] = it["tone"]

    for k, ev, t, heads in pending:
        r = results[k]
        r["final"] = bool(r.get("reaction_full") and (r.get("summary") or not llm_json)
                          and (r.get("actual") or r.get("attempts", 0) >= MAX_ATTEMPTS or TALK.search(ev.get("title", ""))))
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
