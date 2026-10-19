"""Крипто X и Perp DEX для мини-приложения.

Крипто X — посты крупнейших людей и проектов крипторынка из X (CZ, Justin Sun, Виталик, Сэйлор, NEAR, Solana…).
Perp DEX — новости рынка децентрализованных бирж бессрочных фьючерсов: посты Hyperliquid, dYdX, GMX, Aster,
Lighter и др., профильные новости и объёмы торгов по данным DefiLlama.

Отбор: берём только посты с заметной реакцией (min_faves), затем LLM оценивает каждый — влияет ли он на рынок
или показывает настроение, — и оставляет лучшие. Для каждого поста — суть и «что это значит для рынка».

Источник постов X (нужен один из секретов):
  TWITTERAPI_IO_KEY — twitterapi.io (дёшево: ~$0.15 за 1000 постов)
  X_BEARER_TOKEN    — официальный X API (pay-per-use, ~$5 за 1000 постов)
X_REFRESH_MIN — как часто обновлять ленту X, минут (по умолчанию 120). Без ключа раздел X пустой,
но Perp DEX всё равно показывает объёмы (DefiLlama, бесплатно) и новости из RSS.
"""
from __future__ import annotations

import calendar
import html
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import feedparser
import requests

UA = "Mozilla/5.0 (McQCryptoNews)"

# --------------------------------------------------------------- кого читаем (правь список здесь)
# min_faves — минимум лайков, чтобы пост вообще попал на оценку (у проектов реакция ниже, чем у CZ)
X_GROUPS = {
    "leaders": {
        "min_faves": 300,
        "handles": [
            "cz_binance", "justinsuntron", "VitalikButerin", "saylor", "brian_armstrong", "elonmusk",
            "APompliano", "RaoulGMI", "CryptoHayes", "balajis", "aeyakovenko", "haydenzadams",
            "StaniKulechov", "woonomic", "EricBalchunas", "JSeyff", "zachxbt", "lookonchain",
            "WatcherGuru", "tier10k", "whale_alert",
        ],
    },
    "protocols": {
        "min_faves": 80,
        "handles": [
            "ethereum", "solana", "NEARProtocol", "arbitrum", "Optimism", "base", "avax", "Aptos",
            "SuiNetwork", "ton_blockchain", "Polkadot", "Cardano", "chainlink", "Uniswap", "aave",
            "binance", "coinbase", "Tether_to", "Ripple", "trondao", "BNBCHAIN", "LidoFinance",
        ],
    },
    "dex": {
        "min_faves": 40,
        "handles": [
            "HyperliquidX", "dYdX", "GMX_IO", "Aster_DEX", "Lighter_xyz", "JupiterExchange",
            "DriftProtocol", "OrderlyNetwork", "paradex", "edgeX_exchange", "OfficialApeXdex",
            "SynFutures_Defi", "bluefinapp", "AvantisFi", "OstiumLabs", "chameleon_jeff",
        ],
    },
}
GROUP_OF = {h.lower(): g for g, v in X_GROUPS.items() for h in v["handles"]}

# новости рынка perp DEX: ключевые слова в заголовках общей ленты + отдельный поиск Google News
DEX_RX = re.compile(r"\b(perp(etual)?s?\s+dex|perp\s+exchange|decentralized\s+(derivatives|perpetual)|hyperliquid|"
                    r"dydx|gmx|aster\s+dex|\baster\b|lighter|jupiter\s+perps|drift\s+protocol|orderly|paradex|edgex|"
                    r"apex\s+(pro|omni)|synfutures|bluefin|avantis|ostium|on-chain\s+perp)", re.I)
DEX_FEEDS = [
    "https://news.google.com/rss/search?q=%22perp+DEX%22+OR+Hyperliquid+OR+dYdX+OR+%22perpetual+DEX%22+when:2d"
    "&hl=en-US&gl=US&ceid=US:en",
]
LLAMA_URL = ("https://api.llama.fi/overview/derivatives?excludeTotalDataChart=true"
             "&excludeTotalDataChartBreakdown=true")

KEEP = {"x": 24, "dex": 16}       # сколько постов держим в ленте
TTL_H = 48                        # посты старше 48 часов убираем
APP_LANGS = {"en": "English", "es": "Spanish", "fr": "French", "ko": "Korean", "zh": "Simplified Chinese"}


def log(msg: str) -> None:
    print(f"[cryptox] {msg}", file=sys.stderr)


# --------------------------------------------------------------- X: загрузка постов
def provider() -> str | None:
    if os.getenv("TWITTERAPI_IO_KEY"):
        return "twitterapi.io"
    if os.getenv("X_BEARER_TOKEN"):
        return "x-api"
    return None


def _ts_twitterapi(s: str) -> datetime | None:
    for fmt in ("%a %b %d %H:%M:%S %z %Y", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            d = datetime.strptime(s, fmt)
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
    return None


def _norm(raw: dict, src: str) -> dict | None:
    """Пост в общем формате приложения."""
    if src == "twitterapi.io":
        a = raw.get("author") or {}
        if raw.get("isReply") or raw.get("retweeted_tweet"):
            return None
        ts = _ts_twitterapi(raw.get("createdAt", ""))
        handle = a.get("userName", "")
        return {"id": str(raw.get("id")), "url": raw.get("url") or f"https://x.com/{handle}/status/{raw.get('id')}",
                "text": raw.get("text", ""), "ts": ts, "handle": handle, "name": a.get("name", handle),
                "avatar": a.get("profilePicture", ""), "verified": bool(a.get("isBlueVerified")),
                "followers": a.get("followers"), "likes": raw.get("likeCount", 0), "rts": raw.get("retweetCount", 0),
                "replies": raw.get("replyCount", 0), "views": raw.get("viewCount", 0)}
    return raw  # x-api нормализуется в fetch_xapi


def fetch_twitterapi(handles: list[str], min_faves: int, since: datetime) -> list[dict]:
    key = os.environ["TWITTERAPI_IO_KEY"]
    out = []
    for i in range(0, len(handles), 10):
        chunk = handles[i:i + 10]
        q = "(" + " OR ".join(f"from:{h}" for h in chunk) + f") min_faves:{min_faves} -filter:replies " \
            f"since_time:{int(since.timestamp())}"
        try:
            r = requests.get("https://api.twitterapi.io/twitter/tweet/advanced_search",
                             params={"query": q, "queryType": "Latest"}, headers={"X-API-Key": key}, timeout=25)
            r.raise_for_status()
            for t in r.json().get("tweets") or []:
                p = _norm(t, "twitterapi.io")
                if p and p["ts"]:
                    out.append(p)
        except Exception as e:  # noqa: BLE001
            log(f"twitterapi.io: {type(e).__name__} {str(e)[:150]}")
    return out


def fetch_xapi(handles: list[str], min_faves: int, since: datetime) -> list[dict]:
    tok = os.environ["X_BEARER_TOKEN"]
    out = []
    for i in range(0, len(handles), 10):
        chunk = handles[i:i + 10]
        q = "(" + " OR ".join(f"from:{h}" for h in chunk) + ") -is:reply -is:retweet"
        try:
            r = requests.get("https://api.x.com/2/tweets/search/recent", headers={"Authorization": f"Bearer {tok}"},
                             params={"query": q, "max_results": 50, "start_time": since.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                     "tweet.fields": "created_at,public_metrics", "expansions": "author_id",
                                     "user.fields": "name,username,profile_image_url,verified,public_metrics"},
                             timeout=25)
            r.raise_for_status()
            d = r.json()
            users = {u["id"]: u for u in (d.get("includes") or {}).get("users", [])}
            for t in d.get("data") or []:
                m = t.get("public_metrics") or {}
                if m.get("like_count", 0) < min_faves:
                    continue
                u = users.get(t.get("author_id"), {})
                h = u.get("username", "")
                out.append({"id": t["id"], "url": f"https://x.com/{h}/status/{t['id']}", "text": t.get("text", ""),
                            "ts": datetime.fromisoformat(t["created_at"].replace("Z", "+00:00")), "handle": h,
                            "name": u.get("name", h), "avatar": u.get("profile_image_url", ""),
                            "verified": bool(u.get("verified")),
                            "followers": (u.get("public_metrics") or {}).get("followers_count"),
                            "likes": m.get("like_count", 0), "rts": m.get("retweet_count", 0),
                            "replies": m.get("reply_count", 0), "views": m.get("impression_count", 0)})
        except Exception as e:  # noqa: BLE001
            log(f"X API: {type(e).__name__} {str(e)[:150]}")
    return out


def fetch_posts(since: datetime) -> list[dict]:
    src = provider()
    if not src:
        return []
    fn = fetch_twitterapi if src == "twitterapi.io" else fetch_xapi
    posts = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        for res in pool.map(lambda g: fn(X_GROUPS[g]["handles"], X_GROUPS[g]["min_faves"], since), X_GROUPS):
            posts.extend(res)
    uniq = {}
    for p in posts:
        p["group"] = GROUP_OF.get(p["handle"].lower(), "leaders")
        uniq[p["id"]] = p
    log(f"{src}: {len(uniq)} постов с реакцией с {since:%d.%m %H:%M} UTC")
    return list(uniq.values())


# --------------------------------------------------------------- LLM: отбор и пояснения
def llm_score(posts: list[dict], llm_json) -> dict[str, dict]:
    """{id: {keep, score, sentiment, summary, why, assets}} — только для новых постов."""
    res: dict[str, dict] = {}
    for b in range(0, len(posts), 25):
        batch = [{"id": p["id"], "author": f"{p['name']} (@{p['handle']})", "text": p["text"][:700],
                  "likes": p["likes"], "reposts": p["rts"]} for p in posts[b:b + 25]]
        prompt = (
            "Ниже посты из X от крупных людей и проектов крипторынка. Для КАЖДОГО верни объект:\n"
            "- id — как во входе;\n"
            "- keep — true, только если пост может повлиять на рынок или явно показывает настроение рынка/крупного "
            "игрока: запуски, листинги, взломы, решения регуляторов, ETF и потоки, покупки/продажи крупными игроками, "
            "макро-комментарии, прогнозы известных людей, важные обновления сетей и протоколов, объёмы и рекорды. "
            "false — реклама, розыгрыши, мемы без смысла, приветствия, ответы ни о чём;\n"
            "- score — 1..10, насколько сильно это может повлиять на цены или настроение;\n"
            "- sentiment — bullish | bearish | neutral (для упомянутых активов или рынка в целом);\n"
            "- summary — по-русски, 1–2 предложения: суть поста простыми словами;\n"
            "- why — по-русски, 1–2 предложения для новичка: что это значит для рынка и каких монет касается, "
            "конкретно («рост притока в ETF → спрос на BTC»), без общих слов;\n"
            "- assets — тикеры/проекты через запятую (BTC, ETH, NEAR…).\n"
            "Формат: {\"items\": [...]}\n\n" + json.dumps(batch, ensure_ascii=False))
        try:
            for it in llm_json(prompt, max_tokens=4000).get("items", []):
                if it.get("id") is not None:
                    res[str(it["id"])] = it
        except Exception as e:  # noqa: BLE001
            log(f"LLM оценка: {e}")
    return res


def llm_summary(posts: list[dict], title: str, llm_json) -> str:
    if not posts:
        return ""
    lines = "\n".join(f"- @{p['handle']}: {p.get('summary') or p['text'][:200]}" for p in posts[:15])
    try:
        return llm_json(f"{title}. Самое важное за последние сутки:\n{lines}\n\nОпиши по-русски в 2–3 предложениях, "
                        "о чём сейчас говорят и какое настроение (оптимизм/страх/нейтрально), что это значит "
                        "для рынка. Формат: {\"summary\": \"...\"}", max_tokens=400).get("summary", "")
    except Exception as e:  # noqa: BLE001
        log(f"LLM сводка: {e}")
        return ""


def llm_translate(texts: dict[str, str], llm_json) -> dict[str, dict[str, str]]:
    """{lang: {key: перевод}} для языков приложения; пустые тексты пропускаются."""
    texts = {k: v for k, v in texts.items() if v}
    if not texts:
        return {}

    def one(lang):
        prompt = (f"Translate each Russian value into {APP_LANGS[lang]} for retail crypto traders. Keep tickers, "
                  "numbers and names. Return JSON {\"t\": {same keys: translation}}.\n\n"
                  + json.dumps({"t": texts}, ensure_ascii=False))
        return lang, (llm_json(prompt, max_tokens=4000).get("t") or {})

    out = {}
    with ThreadPoolExecutor(max_workers=len(APP_LANGS)) as pool:
        for f in [pool.submit(one, l) for l in APP_LANGS]:
            try:
                lang, d = f.result()
                out[lang] = {k: str(v) for k, v in d.items() if k in texts}
            except Exception as e:  # noqa: BLE001
                log(f"LLM перевод: {e}")
    return out


# --------------------------------------------------------------- Perp DEX: объёмы и новости
def dex_volumes() -> dict | None:
    try:
        r = requests.get(LLAMA_URL, headers={"User-Agent": UA}, timeout=25)
        r.raise_for_status()
        d = r.json()
    except Exception as e:  # noqa: BLE001
        log(f"DefiLlama: {type(e).__name__} {str(e)[:120]}")
        return None
    rows = []
    for p in d.get("protocols") or []:
        v = p.get("total24h")
        if not v:
            continue
        rows.append({"name": p.get("displayName") or p.get("name"), "logo": p.get("logo", ""),
                     "vol24h": float(v), "change_1d": p.get("change_1d"), "vol7d": p.get("total7d")})
    rows.sort(key=lambda x: -x["vol24h"])
    total = float(d.get("total24h") or sum(r["vol24h"] for r in rows) or 0)
    for r in rows:
        r["share"] = round(r["vol24h"] / total * 100, 2) if total else None
    return {"total24h": total, "change_1d": d.get("change_1d"), "change_7d": d.get("change_7d"), "top": rows[:10],
            "source": "DefiLlama"}


def dex_news(general_items: list[dict] | None) -> list[dict]:
    items = [i for i in (general_items or []) if DEX_RX.search(i.get("title", ""))]
    for url in DEX_FEEDS:
        try:
            r = requests.get(url, headers={"User-Agent": UA}, timeout=20)
            r.raise_for_status()
            for e in feedparser.parse(r.content).entries:
                ts = e.get("published_parsed") or e.get("updated_parsed")
                if not ts:
                    continue
                title = html.unescape(re.sub(r"<[^>]+>", "", e.get("title", ""))).strip()
                outlet = ""
                m = re.search(r"\s+-\s+([^-]+)$", title)
                if m:
                    title, outlet = title[: m.start()].strip(), m.group(1).strip()
                items.append({"title": title, "link": e.get("link", ""), "outlet": outlet,
                              "ts": datetime.fromtimestamp(calendar.timegm(ts), tz=timezone.utc)})
        except Exception as e:  # noqa: BLE001
            log(f"DEX RSS: {type(e).__name__}")
    seen, out = set(), []
    for i in sorted(items, key=lambda x: x["ts"], reverse=True):
        k = re.sub(r"\W+", "", i["title"].lower())[:60]
        if k in seen:
            continue
        seen.add(k)
        out.append({"title": i["title"], "link": i["link"], "outlet": i.get("outlet", ""), "ts": i["ts"].isoformat()})
    return out[:15]


# --------------------------------------------------------------- сборка разделов
def _iso(p: dict) -> dict:
    return {**p, "ts": p["ts"].isoformat() if isinstance(p["ts"], datetime) else p["ts"]}


def build(now: datetime, prev: dict, llm_json=None, general_items: list[dict] | None = None,
          with_news: bool = False) -> dict:
    """Возвращает {"cryptox": {...}, "dex": {...}} для app.json. prev — прошлая версия app.json."""
    px, pd_ = prev.get("cryptox") or {}, prev.get("dex") or {}
    edge = now - timedelta(hours=TTL_H)
    keep_old = [p for p in (px.get("posts") or []) + (pd_.get("posts") or [])
                if datetime.fromisoformat(p["ts"]) >= edge]
    src = provider()
    refresh = int(os.getenv("X_REFRESH_MIN") or 120)
    last = px.get("updated")
    due = src and (not last or now - datetime.fromisoformat(last) >= timedelta(minutes=refresh))

    posts_all = {p["id"]: p for p in keep_old}
    x_upd, summaries_changed = last, False
    if due:
        known = set(posts_all) | set(px.get("seen") or [])
        fresh = [p for p in fetch_posts(now - timedelta(hours=24)) if p["id"] not in known]
        scored = llm_score(fresh, llm_json) if (fresh and llm_json) else {}
        new_kept = []
        for p in fresh:
            s = scored.get(p["id"])
            if llm_json and (not s or not s.get("keep")):
                continue
            s = s or {}
            new_kept.append({**_iso(p), "score": int(s.get("score") or 0), "sentiment": s.get("sentiment", "neutral"),
                             "summary": s.get("summary", ""), "why": s.get("why", ""), "assets": s.get("assets", "")})
        # переводы суть/пояснение для новых постов
        if new_kept and llm_json:
            tr = llm_translate({f"{p['id']}|{k}": p[k] for p in new_kept for k in ("summary", "why")}, llm_json)
            for p in new_kept:
                p["i18n"] = {l: {k: d.get(f"{p['id']}|{k}", "") for k in ("summary", "why")} for l, d in tr.items()}
        for p in new_kept:
            posts_all[p["id"]] = p
        summaries_changed = bool(new_kept)
        x_upd = now.isoformat()
        # если LLM не ответил — не помечаем посты просмотренными, оценим в следующий раз
        judged = {p["id"] for p in fresh} if (scored or not llm_json) else set()
        seen = list(set(px.get("seen") or []) | judged)[-1500:]
    else:
        seen = px.get("seen") or []

    def ranked(group_filter, n):
        ps = [p for p in posts_all.values() if group_filter(p.get("group"))]
        # свежесть + сила влияния: за каждые 6 часов возраста −1 балл
        def key(p):
            age_h = (now - datetime.fromisoformat(p["ts"])).total_seconds() / 3600
            return (p.get("score") or 0) - age_h / 6
        return sorted(sorted(ps, key=key, reverse=True)[:n], key=lambda p: p["ts"], reverse=True)

    x_posts = ranked(lambda g: g in ("leaders", "protocols"), KEEP["x"])
    d_posts = ranked(lambda g: g == "dex", KEEP["dex"])

    cryptox = {"updated": x_upd, "provider": src, "posts": x_posts, "seen": seen,
               "summary": px.get("summary", ""), "summary_i18n": px.get("summary_i18n") or {}}
    dex = {"updated": now.isoformat(), "posts": d_posts,
           "news": dex_news(general_items) if with_news else (pd_.get("news") or []),
           "volumes": dex_volumes() or pd_.get("volumes"),
           "summary": pd_.get("summary", ""), "summary_i18n": pd_.get("summary_i18n") or {}}
    if llm_json and (summaries_changed or (with_news and not dex["summary"])):
        cryptox["summary"] = llm_summary(x_posts, "Посты крупнейших людей и проектов крипторынка в X", llm_json) \
            or cryptox["summary"]
        heads = d_posts + [{"handle": n["outlet"] or "news", "text": n["title"]} for n in dex["news"][:8]]
        dex["summary"] = llm_summary(heads, "Рынок децентрализованных бирж бессрочных фьючерсов (perp DEX)",
                                     llm_json) or dex["summary"]
        tr = llm_translate({"x": cryptox["summary"], "dex": dex["summary"]}, llm_json)
        cryptox["summary_i18n"] = {l: d.get("x", "") for l, d in tr.items()}
        dex["summary_i18n"] = {l: d.get("dex", "") for l, d in tr.items()}
    return {"cryptox": cryptox, "dex": dex}
