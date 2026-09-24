"""Индексы настроений (Fear & Greed) и перекупленность/перепроданность (RSI 14, дневной)."""
from __future__ import annotations

import html
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
T = 20

RATING_RU = {"extreme fear": "крайний страх", "fear": "страх", "neutral": "нейтрально",
             "greed": "жадность", "extreme greed": "крайняя жадность"}


def _face(v: float) -> str:
    return "😱" if v < 25 else "😨" if v < 45 else "😐" if v <= 55 else "😏" if v < 75 else "🤑"


# ---------------------------------------------------------------- Fear & Greed
def crypto_fng():
    r = requests.get("https://api.alternative.me/fng/?limit=8", headers={"User-Agent": UA}, timeout=T)
    r.raise_for_status()
    d = r.json()["data"]
    now, prev, week = int(d[0]["value"]), int(d[1]["value"]), int(d[min(7, len(d) - 1)]["value"])
    return {"value": now, "rating": d[0]["value_classification"].lower(), "prev": prev, "week": week}


_CNN_CACHE: dict = {}


def _cnn_data():
    if "d" not in _CNN_CACHE:
        r = requests.get("https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
                         headers={"User-Agent": UA, "Accept": "application/json",
                                  "Referer": "https://edition.cnn.com/markets/fear-and-greed",
                                  "Origin": "https://edition.cnn.com"}, timeout=T)
        r.raise_for_status()
        _CNN_CACHE["d"] = r.json()
    return _CNN_CACHE["d"]


def stocks_fng():
    fg = _cnn_data()["fear_and_greed"]
    return {"value": round(float(fg["score"])), "rating": str(fg["rating"]).lower(),
            "prev": round(float(fg["previous_close"])), "week": round(float(fg["previous_1_week"]))}


# ---------------------------------------------------------------- история цен
def _yahoo_closes(sym: str) -> list[float]:
    for host in ("query1", "query2"):
        r = requests.get(f"https://{host}.finance.yahoo.com/v8/finance/chart/{requests.utils.quote(sym)}?range=6mo&interval=1d",
                         headers={"User-Agent": UA}, timeout=T)
        if r.status_code == 429:
            time.sleep(1)
            continue
        r.raise_for_status()
        q = r.json()["chart"]["result"][0]["indicators"]["quote"][0]["close"]
        return [x for x in q if x is not None]
    raise RuntimeError("yahoo 429")


def _stooq_closes(sym: str) -> list[float]:
    r = requests.get(f"https://stooq.com/q/d/l/?s={sym}&i=d", headers={"User-Agent": UA}, timeout=T)
    r.raise_for_status()
    out = []
    for line in r.text.strip().splitlines()[1:]:
        p = line.split(",")
        if len(p) >= 5:
            try:
                out.append(float(p[4]))
            except ValueError:
                pass
    if len(out) < 20:
        raise RuntimeError("stooq: мало данных")
    return out[-150:]


def _cnbc_closes(sym: str) -> list[float]:
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=200)
    url = (f"https://ts-api.cnbc.com/harmony/app/bars/{sym}/1D/{start:%Y%m%d}000000/{end:%Y%m%d}000000/"
           "adjusted/EST5EDT.json")
    r = requests.get(url, headers={"User-Agent": UA}, timeout=T)
    r.raise_for_status()
    bars = r.json()["barData"]["priceBars"]
    return [float(b["close"]) for b in bars if b.get("close") not in (None, "")]


def _cnn_sp500_closes() -> list[float]:
    d = _cnn_data()["market_momentum_sp500"]["data"]
    return [float(p["y"]) for p in d]


def _coingecko_closes(cid: str) -> list[float]:
    r = requests.get(f"https://api.coingecko.com/api/v3/coins/{cid}/market_chart",
                     params={"vs_currency": "usd", "days": "120", "interval": "daily"},
                     headers={"User-Agent": UA}, timeout=T)
    r.raise_for_status()
    return [float(p[1]) for p in r.json()["prices"]]


def _kraken_closes(pair: str) -> list[float]:
    r = requests.get("https://api.kraken.com/0/public/OHLC", params={"pair": pair, "interval": 1440},
                     headers={"User-Agent": UA}, timeout=T)
    r.raise_for_status()
    res = r.json()["result"]
    key = next(k for k in res if k != "last")
    return [float(c[4]) for c in res[key]][-150:]


# (название, [(источник, функция, аргумент)])
ASSETS = [
    ("S&P 500", [("yahoo", _yahoo_closes, "^GSPC"), ("cnn", lambda _: _cnn_sp500_closes(), None),
                 ("stooq", _stooq_closes, "^spx"), ("cnbc", _cnbc_closes, ".SPX")]),
    ("Nasdaq", [("yahoo", _yahoo_closes, "^IXIC"), ("stooq", _stooq_closes, "^ndq"), ("cnbc", _cnbc_closes, ".IXIC")]),
    ("Gold", [("yahoo", _yahoo_closes, "GC=F"), ("stooq", _stooq_closes, "xauusd"), ("cnbc", _cnbc_closes, "@GC.1")]),
    ("Brent", [("yahoo", _yahoo_closes, "BZ=F"), ("stooq", _stooq_closes, "cb.f"), ("cnbc", _cnbc_closes, "@LCO.1")]),
    ("BTC", [("coingecko", _coingecko_closes, "bitcoin"), ("kraken", _kraken_closes, "XBTUSD"),
             ("yahoo", _yahoo_closes, "BTC-USD")]),
    ("ETH", [("coingecko", _coingecko_closes, "ethereum"), ("kraken", _kraken_closes, "ETHUSD"),
             ("yahoo", _yahoo_closes, "ETH-USD")]),
]


def rsi(closes: list[float], n: int = 14) -> float | None:
    if len(closes) < n + 1:
        return None
    gains = [max(closes[i] - closes[i - 1], 0) for i in range(1, len(closes))]
    losses = [max(closes[i - 1] - closes[i], 0) for i in range(1, len(closes))]
    ag, al = sum(gains[:n]) / n, sum(losses[:n]) / n
    for g, l in zip(gains[n:], losses[n:]):
        ag, al = (ag * (n - 1) + g) / n, (al * (n - 1) + l) / n
    if al == 0:
        return 100.0
    return 100 - 100 / (1 + ag / al)


def rsi_label(v: float) -> str:
    if v >= 70:
        return "🔴 перекуплен"
    if v >= 60:
        return "🟠 близко к перекупленности"
    if v <= 30:
        return "🟢 перепродан"
    if v <= 40:
        return "🟡 близко к перепроданности"
    return "⚪ нейтрально"


# ---------------------------------------------------------------- сборка блока
def sentiment_block() -> tuple[list[str], str]:
    """Возвращает (строки для Telegram, краткий контекст для ИИ)."""
    lines, ctx, log = [], [], []
    for title, fn in (("Акции (CNN)", stocks_fng), ("Крипта", crypto_fng)):
        try:
            f = fn()
            rating = RATING_RU.get(f["rating"], f["rating"])
            delta = f["value"] - f["week"]
            lines.append(f"{_face(f['value'])} Fear &amp; Greed — {title}: <b>{f['value']}</b> {rating} "
                         f"<i>(вчера {f['prev']}, неделю назад {f['week']}, {delta:+d})</i>")
            ctx.append(f"Fear&Greed {title}: {f['value']} ({rating}), неделю назад {f['week']}")
        except Exception as e:  # noqa: BLE001
            log.append(f"F&G {title}: {type(e).__name__}")

    rsi_lines = []
    for name, sources in ASSETS:
        val = None
        for src, fn, arg in sources:
            try:
                closes = fn(arg)
                val = rsi(closes)
                if val is not None:
                    break
            except Exception as e:  # noqa: BLE001
                log.append(f"RSI {name}/{src}: {type(e).__name__}")
        if val is None:
            continue
        rsi_lines.append(f"{html.escape(name)}: <b>{val:.0f}</b> {rsi_label(val)}")
        ctx.append(f"RSI14 {name}: {val:.0f}")
    if rsi_lines:
        lines.append("<b>RSI(14), дневной</b> <i>(&gt;70 перекуплен, &lt;30 перепродан)</i>\n" + "\n".join(rsi_lines))

    print("Настроения: " + ("; ".join(ctx) or "нет данных") + (" | ошибки: " + "; ".join(log) if log else ""),
          file=sys.stderr)
    return lines, "; ".join(ctx)
