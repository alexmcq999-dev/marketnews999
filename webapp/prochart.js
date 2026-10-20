/* McQ Pro Chart — интеллектуальный чарт для продвинутых трейдеров.
   • Свечи агрегированы с 9 бирж (11 рынков: спот + бессрочные фьючерсы) прямо из публичных API бирж.
   • В каждой свече — её собственный VWAP (Σ оборот / Σ объём по всем биржам) и разбивка объёма по биржам.
   • Сессионный VWAP с ±1σ/±2σ, якорный VWAP (тап по свече), профиль объёма видимого диапазона (POC/VAH/VAL),
     CVD (по тейкерам Binance, экстраполяция на весь объём), агрегированный открытый интерес, фандинг.
   • ИИ-ассистент (функция Supabase chart-ai) читает всё это и рисует уровни на графике.
   Доступ: APP_CONFIG.premium = "open" (всем) или "paid" (только подписка McQ Pro). */
(function () {
  "use strict";
  const I18 = window.I18N || { t: (s) => s, lang: "ru", locale: "ru-RU" };
  const _t = I18.t;
  const CFG = window.APP_CONFIG || {};
  const tg = window.Telegram && window.Telegram.WebApp;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const LWC_URL = "https://cdn.jsdelivr.net/npm/lightweight-charts@5.1.0/dist/lightweight-charts.standalone.production.js";
  const PREMIUM = CFG.premium === "paid" ? "paid" : "open";

  const ASSETS = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "SUI", "HYPE", "LINK", "AVAX"];
  const TFS = [["5m", 300, "5м"], ["15m", 900, "15м"], ["1h", 3600, "1ч"], ["4h", 14400, "4ч"], ["1d", 86400, "1Д"]];
  const LIMIT = 300;
  const C = { up: "#3ddc84", down: "#ff5a52", gold: "#f5c451", text: "rgba(250,250,250,.62)", hair: "rgba(255,255,255,.06)" };

  // ================================================================ биржи
  const typ = (h, l, c) => (h + l + c) / 3;
  function row(t, o, h, l, c, b, q, tb) {
    o = +o; h = +h; l = +l; c = +c; b = +b || 0; q = +q || 0;
    const tp = typ(h, l, c);
    if (!(b > 0) && q > 0) b = q / tp;
    if (!(q > 0) && b > 0) q = b * tp;
    return { t: Math.round(+t), o, h, l, c, b, q, tb: tb == null ? null : +tb };
  }
  async function getJSON(url, opt) {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetch(url, Object.assign({ signal: ctl.signal }, opt || {}));
      if (!r.ok) throw new Error(`${r.status}`);
      return await r.json();
    } finally { clearTimeout(tm); }
  }
  function resample(rows, sec) {
    const m = new Map();
    for (const r of rows) {
      const k = Math.floor(r.t / sec) * sec;
      const a = m.get(k);
      if (!a) m.set(k, Object.assign({}, r, { t: k }));
      else { a.h = Math.max(a.h, r.h); a.l = Math.min(a.l, r.l); a.c = r.c; a.b += r.b; a.q += r.q; if (a.tb != null && r.tb != null) a.tb += r.tb; }
    }
    return [...m.values()].sort((x, y) => x.t - y.t);
  }
  const IV = {
    bin: { "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" },
    byb: { "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" },
    okx: { "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1Dutc" },
    krk: { "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 },
    cb: { "5m": 300, "15m": 900, "1h": 3600, "4h": 0, "1d": 86400 },
  };
  const binance = (base) => async (s, tf, n) =>
    (await getJSON(`${base}?symbol=${s}USDT&interval=${IV.bin[tf]}&limit=${n}`)).map((r) => row(r[0] / 1000, r[1], r[2], r[3], r[4], r[5], r[7], r[10]));
  const bybit = (cat) => async (s, tf, n) =>
    ((await getJSON(`https://api.bybit.com/v5/market/kline?category=${cat}&symbol=${s}USDT&interval=${IV.byb[tf]}&limit=${n}`)).result.list || [])
      .map((r) => row(r[0] / 1000, r[1], r[2], r[3], r[4], r[5], r[6])).reverse();
  const okx = (swap) => async (s, tf, n) =>
    ((await getJSON(`https://www.okx.com/api/v5/market/candles?instId=${s}-USDT${swap ? "-SWAP" : ""}&bar=${IV.okx[tf]}&limit=${Math.min(n, 300)}`)).data || [])
      .map((r) => row(r[0] / 1000, r[1], r[2], r[3], r[4], swap ? r[6] : r[5], r[7])).reverse();
  async function bitget(s, tf, n) {
    const d = await getJSON(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${s}USDT&productType=usdt-futures&granularity=${IV.okx[tf]}&limit=${n}`);
    return (d.data || []).map((r) => row(r[0] / 1000, r[1], r[2], r[3], r[4], r[5], r[6])).sort((a, b) => a.t - b.t);
  }
  async function gate(s, tf, n) {
    const d = await getJSON(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${s}_USDT&interval=${IV.bin[tf]}&limit=${n}`);
    return (d || []).map((r) => row(r.t, r.o, r.h, r.l, r.c, 0, r.sum));
  }
  async function hyper(s, tf, n, sec) {
    const now = Date.now();
    const d = await getJSON("https://api.hyperliquid.xyz/info", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: s, interval: IV.bin[tf], startTime: now - (n + 1) * sec * 1000, endTime: now } }),
    });
    return (d || []).map((r) => row(r.t / 1000, r.o, r.h, r.l, r.c, r.v, 0));
  }
  async function coinbase(s, tf, n, sec) {
    const g = IV.cb[tf] || 3600;
    const need = Math.ceil((n * sec) / g);
    let end = Math.floor(Date.now() / 1000), out = [];
    for (let p = 0; p < 4 && out.length < need; p++) {
      const start = end - 300 * g;
      const d = await getJSON(`https://api.exchange.coinbase.com/products/${s}-USD/candles?granularity=${g}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`);
      if (!d || !d.length) break;
      out = out.concat(d.map((r) => row(r[0], r[3], r[2], r[1], r[4], r[5], 0)));
      end = start;
      if (n <= 10) break;
    }
    out.sort((a, b) => a.t - b.t);
    return g === sec ? out : resample(out, sec);
  }
  async function kraken(s, tf) {
    const pair = (s === "BTC" ? "XBT" : s === "DOGE" ? "XDG" : s) + "USD";
    const d = await getJSON(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${IV.krk[tf]}`);
    if (d.error && d.error.length) throw new Error(d.error[0]);
    const k = Object.keys(d.result).find((x) => x !== "last");
    return d.result[k].map((r) => row(r[0], r[1], r[2], r[3], r[4], r[6], +r[5] * +r[6]));
  }
  const SOURCES = [
    { id: "binF", ex: "Binance", kind: "perp", f: binance("https://fapi.binance.com/fapi/v1/klines") },
    { id: "binS", ex: "Binance", kind: "spot", f: binance("https://data-api.binance.vision/api/v3/klines") },
    { id: "bybF", ex: "Bybit", kind: "perp", f: bybit("linear") },
    { id: "bybS", ex: "Bybit", kind: "spot", f: bybit("spot") },
    { id: "okxF", ex: "OKX", kind: "perp", f: okx(true) },
    { id: "okxS", ex: "OKX", kind: "spot", f: okx(false) },
    { id: "bgF", ex: "Bitget", kind: "perp", f: bitget },
    { id: "gateF", ex: "Gate", kind: "perp", f: gate },
    { id: "hl", ex: "Hyperliquid", kind: "perp", f: hyper },
    { id: "cb", ex: "Coinbase", kind: "spot", f: coinbase },
    { id: "krk", ex: "Kraken", kind: "spot", f: kraken },
  ];
  const SRC = Object.fromEntries(SOURCES.map((s) => [s.id, s]));
  const EXCHANGES = [...new Set(SOURCES.map((s) => s.ex))];

  async function fetchAll(sym, tf, sec, n) {
    const res = {};
    await Promise.all(SOURCES.map(async (s) => {
      try {
        const rows = (await s.f(sym, tf, n, sec)).filter((r) => r.t % sec === 0 && r.c > 0);
        if (rows.length) res[s.id] = rows.slice(-n);
      } catch (e) { /* биржа недоступна или нет такого рынка — просто без неё */ }
    }));
    return res;
  }

  // ================================================================ агрегирование
  function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; }
  function aggregate(bySrc) {
    const times = new Map();
    for (const [id, rows] of Object.entries(bySrc)) for (const r of rows) {
      if (!times.has(r.t)) times.set(r.t, []);
      times.get(r.t).push([id, r]);
    }
    const out = [];
    for (const t of [...times.keys()].sort((a, b) => a - b)) {
      let list = times.get(t);
      // защита: рынок с ценой, сильно отличной от медианы (другой токен с тем же тикером, сбой API), отбрасываем
      const med = median(list.map(([, r]) => r.c));
      list = list.filter(([, r]) => Math.abs(r.c / med - 1) < 0.03);
      let Q = 0, B = 0, o = 0, h = 0, l = 0, c = 0, spot = 0, perp = 0, tbQ = 0, binQ = 0;
      const ex = {};
      for (const [id, r] of list) {
        Q += r.q; B += r.b;
        o += r.o * r.q; h += r.h * r.q; l += r.l * r.q; c += r.c * r.q;
        if (SRC[id].kind === "spot") spot += r.q; else perp += r.q;
        const e = SRC[id].ex;
        ex[e] = (ex[e] || 0) + r.q;
        if (r.tb != null) { tbQ += r.tb; binQ += r.q; }
      }
      if (!(Q > 0)) continue;
      o /= Q; h /= Q; l /= Q; c /= Q;
      h = Math.max(h, o, c); l = Math.min(l, o, c);
      const vwap = B > 0 ? Q / B : typ(h, l, c);
      // дельта по тейкерам Binance (спот + фьючерсы), пересчитанная на весь объём
      const dBin = binQ > 0 ? 2 * tbQ - binQ : 0;
      const delta = binQ > 0 ? (dBin * Q) / binQ : 0;
      out.push({ t, o, h, l, c, vwap: Math.min(h, Math.max(l, vwap)), Q, B, spot, perp, ex, delta, cover: binQ / Q, n: list.length });
    }
    return out;
  }

  // ================================================================ индикаторы
  function anchorOf(t, sec) {
    if (sec <= 3600) return Math.floor(t / 86400) * 86400;                       // день (UTC)
    if (sec <= 14400) return Math.floor((t - 4 * 86400) / 604800) * 604800 + 4 * 86400; // неделя с понедельника
    const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; // месяц
  }
  function vwapFrom(cs, startIdx) {
    const out = [];
    let sQ = 0, sB = 0, sP2 = 0;
    for (let i = startIdx; i < cs.length; i++) {
      const k = cs[i];
      sQ += k.Q; sB += k.B; sP2 += k.B * k.vwap * k.vwap;
      const v = sQ / sB;
      out.push({ t: k.t, v, sd: Math.sqrt(Math.max(0, sP2 / sB - v * v)) });
    }
    return out;
  }
  function indicators(cs, sec, anchorT) {
    const sess = [];
    let sQ = 0, sB = 0, sP2 = 0, cur = null;
    cs.forEach((k) => {
      const a = anchorOf(k.t, sec);
      const reset = a !== cur;
      if (reset) { cur = a; sQ = 0; sB = 0; sP2 = 0; }
      sQ += k.Q; sB += k.B; sP2 += k.B * k.vwap * k.vwap;
      const v = sQ / sB;
      sess.push({ t: k.t, v, sd: Math.sqrt(Math.max(0, sP2 / sB - v * v)), reset });
    });
    let cvd = 0;
    const cvdArr = cs.map((k) => ({ t: k.t, v: (cvd += k.delta) }));
    const spikes = [];
    for (let i = 20; i < cs.length; i++) {
      let s = 0; for (let j = i - 20; j < i; j++) s += cs[j].Q;
      const avg = s / 20;
      if (cs[i].Q > 2.5 * avg) spikes.push({ i, x: cs[i].Q / avg });
    }
    let av = null;
    if (anchorT != null) {
      const idx = cs.findIndex((k) => k.t >= anchorT);
      if (idx >= 0) av = vwapFrom(cs, idx);
    }
    return { sess, cvd: cvdArr, spikes, av };
  }
  function profile(cs, from, to, bins) {
    from = Math.max(0, Math.floor(from)); to = Math.min(cs.length - 1, Math.ceil(to));
    if (to <= from) return null;
    let lo = Infinity, hi = -Infinity;
    for (let i = from; i <= to; i++) { lo = Math.min(lo, cs[i].l); hi = Math.max(hi, cs[i].h); }
    if (!(hi > lo)) return null;
    const step = (hi - lo) / bins, vol = new Array(bins).fill(0), buy = new Array(bins).fill(0);
    for (let i = from; i <= to; i++) {
      const k = cs[i];
      const a = Math.max(0, Math.floor((k.l - lo) / step)), b = Math.min(bins - 1, Math.floor((k.h - lo) / step));
      const share = k.Q / (b - a + 1);
      const up = k.Q > 0 ? Math.max(0, Math.min(1, 0.5 + k.delta / (2 * k.Q))) : 0.5;
      for (let j = a; j <= b; j++) { vol[j] += share; buy[j] += share * up; }
    }
    let poc = 0; vol.forEach((v, j) => { if (v > vol[poc]) poc = j; });
    const total = vol.reduce((s, v) => s + v, 0);
    let vaLo = poc, vaHi = poc, acc = vol[poc];
    while (acc < total * 0.7 && (vaLo > 0 || vaHi < bins - 1)) {
      const dn = vaLo > 0 ? vol[vaLo - 1] : -1, upv = vaHi < bins - 1 ? vol[vaHi + 1] : -1;
      if (upv >= dn) acc += vol[++vaHi]; else acc += vol[--vaLo];
    }
    return { lo, step, vol, buy, max: vol[poc], poc: lo + (poc + 0.5) * step, vah: lo + (vaHi + 1) * step, val: lo + vaLo * step, pocI: poc, vaLo, vaHi };
  }

  // ================================================================ контекст рынка (OI, фандинг, 24ч)
  const OIP = { bin: { "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" }, byb: { "5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1d" } };
  async function fetchOI(sym, tf) {
    const [b, y] = await Promise.all([
      getJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${sym}USDT&period=${OIP.bin[tf]}&limit=500`).catch(() => []),
      getJSON(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${sym}USDT&intervalTime=${OIP.byb[tf]}&limit=200`).then((d) => d.result.list || []).catch(() => []),
    ]);
    const bm = new Map((b || []).map((r) => [Math.round(r.timestamp / 1000), +r.sumOpenInterest]));
    const ym = new Map((y || []).map((r) => [Math.round(r.timestamp / 1000), +(r.singleOpenInterest || r.openInterest)]));
    return { bm, ym };
  }
  async function fetchMarket(sym) {
    const m = { funding: {}, oi: {}, vol24: 0, chg24: null };
    const jobs = [
      getJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}USDT`).then((d) => { m.funding.Binance = +d.lastFundingRate; }),
      getJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}USDT`).then((d) => { m.oi.Binance = +d.openInterest; }),
      getJSON(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${sym}USDT`).then((d) => { m.chg24 = +d.priceChangePercent; }),
      getJSON(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}USDT`).then((d) => {
        const r = d.result.list[0]; m.funding.Bybit = +r.fundingRate; m.oi.Bybit = +(r.singleOpenInterest || r.openInterest);
        if (m.chg24 == null) m.chg24 = +r.price24hPcnt * 100;
      }),
      getJSON(`https://www.okx.com/api/v5/public/funding-rate?instId=${sym}-USDT-SWAP`).then((d) => { m.funding.OKX = +d.data[0].fundingRate; }),
      getJSON(`https://www.okx.com/api/v5/public/open-interest?instId=${sym}-USDT-SWAP`).then((d) => { m.oi.OKX = +d.data[0].oiCcy; }),
      getJSON("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }) }).then((d) => {
        const i = d[0].universe.findIndex((u) => u.name === sym);
        if (i >= 0) { m.funding.Hyperliquid = +d[1][i].funding * 8; m.oi.Hyperliquid = +d[1][i].openInterest; } // HL фандинг почасовой → 8ч
      }),
    ];
    await Promise.all(jobs.map((p) => p.catch(() => null)));
    return m;
  }

  // ================================================================ форматирование
  function fmtP(v) {
    if (v == null || !isFinite(v)) return "—";
    const a = Math.abs(v);
    return Number(v).toLocaleString(I18.locale, { minimumFractionDigits: a >= 1000 ? 1 : a >= 1 ? 2 : 4, maximumFractionDigits: a >= 1000 ? 1 : a >= 1 ? 3 : 6 });
  }
  function fmtUsd(v) {
    const a = Math.abs(v || 0), s = v < 0 ? "−" : "";
    return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(0)}K` : `${s}$${a.toFixed(0)}`;
  }
  const fmtPct = (v, d = 2) => (v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
  function precisionFor(p) { return p >= 1000 ? 1 : p >= 100 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 5 : 7; }
  function fmtTime(t, sec) {
    const d = new Date(t * 1000);
    return d.toLocaleString(I18.locale, sec >= 86400 ? { day: "2-digit", month: "short" } : { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  // ================================================================ примитив графика: VWAP каждой свечи + профиль объёма
  class Overlay {
    constructor() { this.cs = []; this.prof = null; this.showTicks = true; this.showVP = true; this._views = [{ zOrder: () => "top", renderer: () => this }]; }
    attached(p) { this.chart = p.chart; this.series = p.series; this.req = p.requestUpdate; }
    detached() { this.chart = null; }
    paneViews() { return this._views; }
    updateAllViews() {}
    update() { if (this.req) this.req(); }
    draw(target) {
      if (!this.chart || !this.series) return;
      const ts = this.chart.timeScale(), s = this.series;
      target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
        // профиль объёма видимого диапазона — справа, под ценовой шкалой
        const P = this.prof;
        if (this.showVP && P) {
          const W = Math.min(110, mediaSize.width * 0.28), x0 = mediaSize.width;
          for (let j = 0; j < P.vol.length; j++) {
            const yTop = s.priceToCoordinate(P.lo + (j + 1) * P.step), yBot = s.priceToCoordinate(P.lo + j * P.step);
            if (yTop == null || yBot == null) continue;
            const hgt = Math.max(1, yBot - yTop - 1), w = (P.vol[j] / P.max) * W, wb = P.vol[j] ? (P.buy[j] / P.vol[j]) * w : 0;
            const inVA = j >= P.vaLo && j <= P.vaHi;
            ctx.fillStyle = j === P.pocI ? "rgba(245,196,81,.55)" : inVA ? "rgba(255,255,255,.16)" : "rgba(255,255,255,.07)";
            ctx.fillRect(x0 - w, yTop, w, hgt);
            if (j !== P.pocI) { ctx.fillStyle = inVA ? "rgba(61,220,132,.16)" : "rgba(61,220,132,.07)"; ctx.fillRect(x0 - w, yTop, wb, hgt); }
          }
          const yPoc = s.priceToCoordinate(P.poc);
          if (yPoc != null) {
            ctx.strokeStyle = "rgba(245,196,81,.7)"; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
            ctx.beginPath(); ctx.moveTo(0, Math.round(yPoc) + 0.5); ctx.lineTo(mediaSize.width, Math.round(yPoc) + 0.5); ctx.stroke(); ctx.setLineDash([]);
          }
        }
        // короткая риска VWAP внутри каждой свечи
        if (this.showTicks && this.cs.length) {
          const r = ts.getVisibleLogicalRange();
          if (!r) return;
          const bs = ts.options().barSpacing;
          if (bs < 3) return;
          const half = Math.max(1.5, Math.min(7, bs * 0.42));
          ctx.lineWidth = bs > 10 ? 2 : 1.5;
          ctx.strokeStyle = C.gold;
          ctx.beginPath();
          const a = Math.max(0, Math.floor(r.from)), b = Math.min(this.cs.length - 1, Math.ceil(r.to));
          for (let i = a; i <= b; i++) {
            const k = this.cs[i];
            const x = ts.timeToCoordinate(k.t), y = s.priceToCoordinate(k.vwap);
            if (x == null || y == null) continue;
            ctx.moveTo(x - half, Math.round(y) + 0.5); ctx.lineTo(x + half, Math.round(y) + 0.5);
          }
          ctx.stroke();
        }
      });
    }
  }

  // ================================================================ состояние
  const S = {
    open: false, sym: "BTC", tf: "1h", sec: 3600, cs: [], bySrc: {}, ind: null, mkt: null, oi: null, anchorT: null, anchorMode: false,
    show: { vwap: true, bands: true, ticks: true, vp: true, cvd: true, oi: true }, hover: null, aiLines: [], sigLines: [], signal: null,
    timer: null, loadId: 0, chat: [],
  };
  try { Object.assign(S.show, JSON.parse(localStorage.getItem("amq-pc-show") || "{}")); const tf = localStorage.getItem("amq-pc-tf"); if (tf && TFS.some((x) => x[0] === tf)) S.tf = tf; } catch (e) { /* noop */ }
  S.sec = TFS.find((x) => x[0] === S.tf)[1];
  let LW = null, chart = null, ser = {}, overlay = null, markersApi = null;

  let lwLoading = null;
  function loadLW() {
    if (window.LightweightCharts) return Promise.resolve();
    if (!lwLoading) lwLoading = new Promise((res, rej) => { const s = document.createElement("script"); s.src = LWC_URL; s.onload = res; s.onerror = () => { lwLoading = null; rej(new Error("lwc")); }; document.head.appendChild(s); });
    return lwLoading;
  }

  // ================================================================ разметка
  function shell() {
    let el = $("#pc");
    if (el) return el;
    el = document.createElement("div");
    el.id = "pc";
    el.className = "pc";
    el.hidden = true;
    el.innerHTML = `
      <div class="pc-top">
        <button class="pc-x" data-act="close" aria-label="${esc(_t("Закрыть"))}"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>
        <div class="pc-title"><b>McQ Pro Chart</b><span class="pc-pro">PRO</span></div>
        <div class="pc-src" id="pc-src"></div>
      </div>
      <div class="pc-assets" id="pc-assets" role="tablist"></div>
      <div class="pc-head">
        <div class="pc-px"><b id="pc-price">—</b><span id="pc-chg"></span></div>
        <div class="segmented glass pc-tf" id="pc-tf" role="radiogroup"></div>
      </div>
      <div class="pc-stats" id="pc-stats"></div>
      <div class="pc-tools" id="pc-tools"></div>
      <div class="pc-chart-wrap">
        <div class="pc-chart" id="pc-chart"></div>
        <div class="pc-legend" id="pc-legend"></div>
        <div class="pc-msg" id="pc-msg"></div>
        <button class="pc-fit" id="pc-fit" hidden aria-label="${esc(_t("Вернуть масштаб"))}"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${esc(_t("Авто"))}</span></button>
      </div>
      <div class="pc-ex" id="pc-ex"></div>
      <button class="pc-ai-fab" data-act="ai"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 3l1.8 4.9L19 9.7l-4.3 3 1.4 5.3L12 15l-4.1 3 1.4-5.3L5 9.7l5.2-1.8z" fill="currentColor"/></svg><span>${esc(_t("ИИ-ассистент"))}</span></button>
      <div class="pc-ai" id="pc-ai" hidden>
        <div class="pc-ai-grab" data-act="ai-close"></div>
        <div class="pc-ai-head"><b>McQ AI</b><small id="pc-ai-sub"></small><button class="pc-x sm" data-act="ai-close" aria-label="${esc(_t("Закрыть"))}"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button></div>
        <div class="pc-ai-body" id="pc-ai-body"></div>
        <div class="pc-ai-quick" id="pc-ai-quick"></div>
        <form class="pc-ai-input" id="pc-ai-form"><input id="pc-ai-q" maxlength="400" autocomplete="off" placeholder="${esc(_t("Спроси про этот график…"))}"><button type="submit" aria-label="${esc(_t("Отправить"))}"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 12l16-8-6 16-2.5-6.5z" fill="currentColor"/></svg></button></form>
      </div>
      <div class="pc-pay" id="pc-pay" hidden></div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => {
      const a = e.target.closest("[data-act]");
      if (!a) return;
      const act = a.dataset.act;
      if (act === "close") close();
      else if (act === "ai") openAI();
      else if (act === "ai-close") closeAI();
    });
    $("#pc-ai-form").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#pc-ai-q").value.trim(); if (q) { $("#pc-ai-q").value = ""; ask(q); } });
    return el;
  }

  function renderControls() {
    const assets = [...new Set([S.sym, ...ASSETS])];
    $("#pc-assets").innerHTML = assets.map((a) => `<button class="${a === S.sym ? "active" : ""}" data-sym="${esc(a)}">${esc(a)}</button>`).join("")
      + `<button class="pc-add" data-sym="+" aria-label="${esc(_t("Другая монета"))}">+</button>`;
    $("#pc-assets").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      let s = b.dataset.sym;
      if (s === "+") { addInput(b); return; }
      if (s !== S.sym) { S.sym = s; S.anchorT = null; S.signal = findSignal(s); clearAI(); renderControls(); load(); }
    }));
    const i = TFS.findIndex((x) => x[0] === S.tf);
    $("#pc-tf").style.setProperty("--n", TFS.length);
    $("#pc-tf").style.setProperty("--i", i);
    $("#pc-tf").innerHTML = `<span class="thumb-glass"></span>` + TFS.map(([k, , l]) => `<button class="${k === S.tf ? "active" : ""}" data-tf="${k}">${esc(_t(l))}</button>`).join("");
    $("#pc-tf").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.tf === S.tf) return;
      S.tf = b.dataset.tf; S.sec = TFS.find((x) => x[0] === S.tf)[1];
      try { localStorage.setItem("amq-pc-tf", S.tf); } catch (e) { /* noop */ }
      renderControls(); load();
    }));
    const tools = [
      ["vwap", "VWAP"], ["bands", "±σ"], ["ticks", _t("VWAP свечи")], ["vp", _t("Профиль")], ["cvd", "CVD"], ["oi", "OI"],
    ];
    $("#pc-tools").innerHTML = tools.map(([k, l]) => `<button class="${S.show[k] ? "on" : ""}" data-t="${k}">${esc(l)}</button>`).join("")
      + `<button class="${S.anchorMode || S.anchorT != null ? "on gold" : ""}" data-t="anchor" title="${esc(_t("Якорный VWAP: нажми, затем коснись свечи"))}">⚓ AVWAP</button>`;
    $("#pc-tools").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.t;
      if (k === "anchor") {
        if (S.anchorT != null || S.anchorMode) { S.anchorT = null; S.anchorMode = false; draw(); }
        else { S.anchorMode = true; msg(_t("Коснись свечи, от которой считать VWAP"), 2500); }
      } else {
        S.show[k] = !S.show[k];
        try { localStorage.setItem("amq-pc-show", JSON.stringify(S.show)); } catch (e) { /* noop */ }
        layoutPanes(); draw();
      }
      renderControls();
    }));
  }

  // своя монета: поле ввода прямо в ряду (window.prompt в Telegram работает не везде)
  function addInput(btn) {
    const inp = document.createElement("input");
    inp.className = "pc-sym-in"; inp.maxLength = 12; inp.placeholder = "PEPE"; inp.autocapitalize = "characters"; inp.enterKeyHint = "go";
    btn.replaceWith(inp);
    inp.focus();
    const go = () => {
      const s = inp.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (s && s !== S.sym) { S.sym = s; S.anchorT = null; S.signal = findSignal(s); clearAI(); load(); }
      renderControls();
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } if (e.key === "Escape") { inp.value = ""; inp.blur(); } });
    inp.addEventListener("blur", go);
  }

  let msgTimer = null;
  function msg(text, ms) {
    const m = $("#pc-msg");
    if (!m) return;
    m.innerHTML = text ? `<span>${text}</span>` : "";
    m.classList.toggle("show", !!text);
    clearTimeout(msgTimer);
    if (text && ms) msgTimer = setTimeout(() => msg(""), ms);
  }

  // ================================================================ график
  function buildChart() {
    LW = window.LightweightCharts;
    const box = $("#pc-chart");
    box.innerHTML = "";
    chart = LW.createChart(box, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: C.text, fontSize: 11,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif",
        panes: { separatorColor: "rgba(255,255,255,.08)", separatorHoverColor: "rgba(255,255,255,.14)", enableResize: true } },
      grid: { vertLines: { color: C.hair }, horzLines: { color: C.hair } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.06 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 7 },
      crosshair: { mode: LW.CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,.28)", labelBackgroundColor: "#1c1c1c" },
        horzLine: { color: "rgba(255,255,255,.28)", labelBackgroundColor: "#1c1c1c" } },
      localization: { locale: I18.locale },
    });
    ser.candle = chart.addSeries(LW.CandlestickSeries, {
      upColor: C.up, downColor: C.down, wickUpColor: C.up, wickDownColor: C.down, borderVisible: false, priceLineColor: "rgba(255,255,255,.5)",
    });
    const line = (color, width, style, extra) => chart.addSeries(LW.LineSeries, Object.assign({ color, lineWidth: width, lineStyle: style || 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }, extra || {}));
    ser.vwap = line("#ffffff", 2, 0, { lastValueVisible: true, title: "VWAP" });
    ser.u1 = line("rgba(255,255,255,.32)", 1, 2); ser.d1 = line("rgba(255,255,255,.32)", 1, 2);
    ser.u2 = line("rgba(255,255,255,.18)", 1, 1); ser.d2 = line("rgba(255,255,255,.18)", 1, 1);
    ser.av = line(C.gold, 2, 0, { lastValueVisible: true, title: "AVWAP" });
    overlay = new Overlay();
    ser.candle.attachPrimitive(overlay);
    markersApi = LW.createSeriesMarkers(ser.candle, []);
    ser.vol = chart.addSeries(LW.HistogramSeries, { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false }, 1);
    ser.volSpot = chart.addSeries(LW.HistogramSeries, { color: "rgba(255,255,255,.38)", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false }, 1);
    ser.cvd = chart.addSeries(LW.LineSeries, { color: "#e6e6e6", lineWidth: 1.5, priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: true, title: "CVD" }, 2);
    ser.oi = chart.addSeries(LW.AreaSeries, { lineColor: C.gold, topColor: "rgba(245,196,81,.22)", bottomColor: "rgba(245,196,81,0)", lineWidth: 1.5, priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: true, title: "OI" }, 3);
    layoutPanes();
    chart.subscribeCrosshairMove((p) => {
      const i = p && p.time != null ? idxOf(p.time) : -1;
      S.hover = i >= 0 ? i : null;
      legend(); exPanel();
    });
    chart.subscribeClick((p) => {
      if (!S.anchorMode || !p || p.time == null) return;
      S.anchorT = p.time; S.anchorMode = false; renderControls(); draw();
      msg(_t("Якорный VWAP построен"), 1500);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => { recalcProfile(); });
    // шкалу цены можно двигать пальцем; если она ушла в ручной режим — показываем кнопку «Авто»
    const wrap = $("#pc-chart");
    const checkFit = () => setTimeout(() => { const f = $("#pc-fit"); if (f) f.hidden = ser.candle.priceScale().options().autoScale !== false; }, 60);
    ["touchend", "mouseup", "wheel"].forEach((ev) => wrap.addEventListener(ev, checkFit, { passive: true }));
    $("#pc-fit").addEventListener("click", () => { fitView(); $("#pc-fit").hidden = true; });
  }
  function idxOf(t) {
    let lo = 0, hi = S.cs.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (S.cs[m].t === t) return m; if (S.cs[m].t < t) lo = m + 1; else hi = m - 1; }
    return -1;
  }
  function layoutPanes() {
    if (!chart) return;
    const panes = chart.panes();
    const want = [1, 0.26, S.show.cvd ? 0.2 : 0.0001, S.show.oi ? 0.2 : 0.0001];
    panes.forEach((p, i) => { if (want[i] != null) p.setStretchFactor(want[i]); });
    if (ser.cvd) ser.cvd.applyOptions({ visible: S.show.cvd });
    if (ser.oi) ser.oi.applyOptions({ visible: S.show.oi });
  }
  let profTimer = null;
  function recalcProfile() {
    clearTimeout(profTimer);
    profTimer = setTimeout(() => {
      if (!chart || !overlay || !S.cs.length) return;
      const r = chart.timeScale().getVisibleLogicalRange();
      overlay.prof = r ? profile(S.cs, r.from, r.to, 44) : null;
      overlay.showVP = S.show.vp;
      overlay.update();
      legend();
    }, 60);
  }

  function draw(keepRange) {
    if (!chart) return;
    const cs = S.cs;
    const prec = precisionFor(cs.length ? cs[cs.length - 1].c : 1);
    const pf = { type: "price", precision: prec, minMove: Math.pow(10, -prec) };
    [ser.candle, ser.vwap, ser.u1, ser.d1, ser.u2, ser.d2, ser.av].forEach((s) => s.applyOptions({ priceFormat: pf }));
    S.ind = indicators(cs, S.sec, S.anchorT);
    const I = S.ind;
    ser.candle.setData(cs.map((k) => ({ time: k.t, open: k.o, high: k.h, low: k.l, close: k.c })));
    // линия сессионного VWAP рвётся на начале новой сессии (прозрачный сегмент)
    // цвет точки задаёт сегмент от неё к следующей — прячем отрезок, который «перепрыгивает» в новую сессию
    const seg = (key, mul) => I.sess.map((p, i) => ({ time: p.t, value: p.v + mul * p.sd, color: I.sess[i + 1] && I.sess[i + 1].reset ? "rgba(0,0,0,0)" : undefined }));
    ser.vwap.setData(S.show.vwap ? seg("v", 0) : []);
    ser.u1.setData(S.show.bands ? seg("u1", 1) : []); ser.d1.setData(S.show.bands ? seg("d1", -1) : []);
    ser.u2.setData(S.show.bands ? seg("u2", 2) : []); ser.d2.setData(S.show.bands ? seg("d2", -2) : []);
    ser.av.setData(I.av ? I.av.map((p) => ({ time: p.t, value: p.v })) : []);
    ser.vol.setData(cs.map((k) => ({ time: k.t, value: k.Q, color: k.delta >= 0 ? "rgba(61,220,132,.55)" : "rgba(255,90,82,.55)" })));
    ser.volSpot.setData(cs.map((k) => ({ time: k.t, value: k.spot })));
    ser.cvd.setData(I.cvd.map((p) => ({ time: p.t, value: p.v })));
    ser.oi.setData(oiSeries());
    const mk = I.spikes.map(({ i, x }) => ({ time: cs[i].t, position: cs[i].delta >= 0 ? "belowBar" : "aboveBar", shape: "circle", size: Math.min(1.6, 0.6 + x / 6), color: cs[i].delta >= 0 ? C.up : C.down }));
    if (S.anchorT != null) mk.push({ time: S.anchorT, position: "belowBar", shape: "arrowUp", color: C.gold, text: "⚓" });
    mk.sort((a, b) => a.time - b.time);
    markersApi.setMarkers(mk);
    overlay.cs = cs; overlay.showTicks = S.show.ticks; overlay.showVP = S.show.vp;
    drawSignal();
    drawAILevels();
    if (!keepRange) fitView();   // новая монета или таймфрейм: автомасштаб (после ручного сдвига шкала оставалась на старой цене)
    recalcProfile();
    legend(); exPanel(); stats();
  }
  function fitView() {
    [ser.candle, ser.vol, ser.cvd, ser.oi].forEach((x) => { try { x.priceScale().applyOptions({ autoScale: true }); } catch (e) { /* noop */ } });
    const n = S.cs.length;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - (S.sec >= 86400 ? 120 : 90)), to: n + 6 });
    const f = $("#pc-fit"); if (f) f.hidden = true;
  }
  function oiSeries() {
    if (!S.oi) return [];
    const { bm, ym } = S.oi;
    const both = bm.size && ym.size;
    const out = [];
    for (const k of S.cs) {
      const b = bm.get(k.t), y = ym.get(k.t);
      if (both ? b == null || y == null : b == null && y == null) continue;
      out.push({ time: k.t, value: ((b || 0) + (y || 0)) * k.c });
    }
    return out;
  }

  // ================================================================ сигнал McQ и уровни ИИ на графике
  function findSignal(sym) {
    const sig = window.McQ && window.McQ.sig && window.McQ.sig();
    return sig && (sig.open || []).find((t) => String(t.symbol).toUpperCase() === sym) || null;
  }
  function drawSignal() {
    S.sigLines.forEach((l) => ser.candle.removePriceLine(l)); S.sigLines = [];
    const t = S.signal;
    if (!t) return;
    const add = (price, title, color, style) => { if (price) S.sigLines.push(ser.candle.createPriceLine({ price: +price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title })); };
    add(t.entry, `McQ ${t.side === "LONG" ? "LONG" : "SHORT"}`, "#ffffff", 0);
    add(t.sl, "SL", C.down, 2);
    add(t.tp1, "TP1", C.up, 2);
    add(t.tp2, "TP2", C.up, 1);
  }
  const KIND_COLOR = { support: C.up, resistance: C.down, entry: "#ffffff", stop: C.down, target: C.up, liquidity: C.gold };
  function drawAILevels() {
    (S.aiLines || []).forEach((l) => { try { ser.candle.removePriceLine(l.line); } catch (e) { /* noop */ } });
    const levels = S.aiLevels || [];
    S.aiLines = levels.map((lv) => ({ line: ser.candle.createPriceLine({ price: lv.price, color: KIND_COLOR[lv.kind] || C.gold, lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: `✦ ${lv.label || ""}`.slice(0, 26) }) }));
  }
  function clearAI() { S.aiLevels = []; S.chat = []; if (chart) drawAILevels(); const b = $("#pc-ai-body"); if (b) b.innerHTML = ""; }

  // ================================================================ легенда, биржи, статистика
  function cur() { return S.cs.length ? S.cs[S.hover != null ? S.hover : S.cs.length - 1] : null; }
  function legend() {
    const k = cur(), el = $("#pc-legend");
    if (!k || !el) return;
    const I = S.ind, i = S.hover != null ? S.hover : S.cs.length - 1;
    const sv = I && I.sess[i];
    const chg = (k.c / k.o - 1) * 100;
    const dev = sv && sv.sd > 0 ? (k.c - sv.v) / sv.sd : null;
    const P = overlay && overlay.prof;
    el.innerHTML = `<div class="lg-row"><span class="lg-t">${esc(fmtTime(k.t, S.sec))}</span>
        <span>O <b>${fmtP(k.o)}</b></span><span>H <b>${fmtP(k.h)}</b></span><span>L <b>${fmtP(k.l)}</b></span><span>C <b class="${chg >= 0 ? "up" : "down"}">${fmtP(k.c)}</b></span></div>
      <div class="lg-row"><span class="gold">VWAP ${esc(_t("свечи"))} <b>${fmtP(k.vwap)}</b></span><span>Vol <b>${fmtUsd(k.Q)}</b></span>
        <span>Δ <b class="${k.delta >= 0 ? "up" : "down"}">${fmtUsd(k.delta)}</b></span><span>${esc(_t("спот"))} <b>${Math.round((k.spot / k.Q) * 100)}%</b></span></div>
      ${sv ? `<div class="lg-row dim"><span>VWAP ${esc(_t("сессии"))} <b>${fmtP(sv.v)}</b></span><span>${dev != null ? `${dev >= 0 ? "+" : ""}${dev.toFixed(2)}σ` : ""}</span>${P && S.show.vp ? `<span>POC <b class="gold">${fmtP(P.poc)}</b></span><span>VA <b>${fmtP(P.val)}–${fmtP(P.vah)}</b></span>` : ""}</div>` : ""}`;
  }
  function exPanel() {
    const k = cur(), el = $("#pc-ex");
    if (!k || !el) return;
    const rows = Object.entries(k.ex).sort((a, b) => b[1] - a[1]);
    el.innerHTML = `<div class="pc-ex-h"><span>${esc(_t("Объём по биржам"))} · ${esc(fmtTime(k.t, S.sec))}</span><span>${k.n} ${esc(_t("рынков"))} · ${fmtUsd(k.Q)}</span></div>
      <div class="pc-ex-bar">${rows.map(([e, q]) => `<i style="flex:${q}" title="${esc(e)}"></i>`).join("")}</div>
      <div class="pc-ex-list">${rows.map(([e, q]) => `<span><b>${esc(e)}</b> ${Math.round((q / k.Q) * 100)}%</span>`).join("")}</div>`;
  }
  function stats() {
    const el = $("#pc-stats");
    if (!el || !S.cs.length) return;
    const last = S.cs[S.cs.length - 1];
    $("#pc-price").textContent = fmtP(last.c);
    const m = S.mkt || {};
    const ch = $("#pc-chg");
    ch.textContent = m.chg24 != null ? `${fmtPct(m.chg24)} 24${_t("ч")}` : "";
    ch.className = m.chg24 >= 0 ? "up" : "down";
    const day = S.cs.filter((k) => k.t > last.t - 86400 + S.sec - 1);
    const vol24 = S.sec <= 3600 ? day.reduce((s, k) => s + k.Q, 0) : null;
    const spot24 = S.sec <= 3600 ? day.reduce((s, k) => s + k.spot, 0) : null;
    const oiBase = Object.values(m.oi || {}).reduce((s, v) => s + (v || 0), 0);
    const fr = Object.values(m.funding || {}).filter((v) => isFinite(v));
    const fAvg = fr.length ? fr.reduce((s, v) => s + v, 0) / fr.length : null;
    const cells = [];
    if (vol24 != null) cells.push([_t("Объём 24ч"), fmtUsd(vol24), `${_t("спот")} ${Math.round((spot24 / vol24) * 100)}%`]);
    if (oiBase) cells.push(["OI", fmtUsd(oiBase * last.c), Object.keys(m.oi).length + " " + _t("биржи")]);
    if (fAvg != null) cells.push([_t("Фандинг 8ч"), `<span class="${fAvg >= 0 ? "up" : "down"}">${(fAvg * 100).toFixed(4)}%</span>`, _t("среднее")]);
    const sv = S.ind && S.ind.sess[S.ind.sess.length - 1];
    if (sv && sv.sd) cells.push([_t("От VWAP"), `${((last.c - sv.v) / sv.sd).toFixed(2)}σ`, fmtPct((last.c / sv.v - 1) * 100)]);
    el.innerHTML = cells.map(([a, b, c]) => `<div><span>${esc(a)}</span><b>${b}</b><small>${esc(c)}</small></div>`).join("");
    const used = new Set(Object.keys(S.bySrc).map((id) => SRC[id].ex));
    $("#pc-src").innerHTML = `<span class="live-dot"></span>${used.size}/${EXCHANGES.length} ${esc(_t("бирж"))}`;
    $("#pc-src").title = [...used].join(", ");
  }

  // ================================================================ загрузка и обновление
  async function load() {
    const id = ++S.loadId;
    stopLive();
    msg(`<span class="pc-spin"></span>${esc(_t("Собираю данные с бирж…"))}`);
    const sym = S.sym, tf = S.tf, sec = S.sec;
    const [bySrc, mkt, oi] = await Promise.all([fetchAll(sym, tf, sec, LIMIT), fetchMarket(sym).catch(() => null), fetchOI(sym, tf).catch(() => null)]);
    if (id !== S.loadId) return;
    if (!Object.keys(bySrc).length) { S.cs = []; msg(esc(_t("Нет данных по этой монете на крупных биржах."))); if (chart) Object.values(ser).forEach((s) => s.setData && s.setData([])); return; }
    S.bySrc = bySrc; S.mkt = mkt; S.oi = oi;
    S.cs = aggregate(bySrc).slice(-LIMIT);
    msg("");
    S.hover = null;
    try { draw(); } catch (e) { msg(esc(`${_t("Ошибка графика")}: ${e.message || e}`)); return; }
    startLive();
  }
  async function refreshLast() {
    if (!S.open || document.hidden || !S.cs.length) return;
    const id = S.loadId, sym = S.sym, tf = S.tf, sec = S.sec;
    const fresh = await fetchAll(sym, tf, sec, 3);
    if (id !== S.loadId) return;
    for (const [sid, rows] of Object.entries(fresh)) {
      const arr = S.bySrc[sid] || (S.bySrc[sid] = []);
      for (const r of rows) {
        const j = arr.findIndex((x) => x.t === r.t);
        if (j >= 0) arr[j] = r; else if (!arr.length || r.t > arr[arr.length - 1].t) arr.push(r);
      }
      if (arr.length > LIMIT + 5) arr.splice(0, arr.length - LIMIT - 5);
    }
    const prevLen = S.cs.length;
    S.cs = aggregate(S.bySrc).slice(-LIMIT);
    if (S.cs.length !== prevLen || S.anchorT != null) draw(true);
    else {
      const k = S.cs[S.cs.length - 1];
      ser.candle.update({ time: k.t, open: k.o, high: k.h, low: k.l, close: k.c });
      ser.vol.update({ time: k.t, value: k.Q, color: k.delta >= 0 ? "rgba(61,220,132,.55)" : "rgba(255,90,82,.55)" });
      ser.volSpot.update({ time: k.t, value: k.spot });
      S.ind = indicators(S.cs, S.sec, S.anchorT);
      const p = S.ind.sess[S.ind.sess.length - 1];
      if (S.show.vwap) ser.vwap.update({ time: p.t, value: p.v });
      if (S.show.bands) { ser.u1.update({ time: p.t, value: p.v + p.sd }); ser.d1.update({ time: p.t, value: p.v - p.sd }); ser.u2.update({ time: p.t, value: p.v + 2 * p.sd }); ser.d2.update({ time: p.t, value: p.v - 2 * p.sd }); }
      ser.cvd.update({ time: k.t, value: S.ind.cvd[S.ind.cvd.length - 1].v });
      overlay.cs = S.cs; overlay.update();
      legend(); exPanel(); stats();
    }
  }
  function startLive() { stopLive(); S.timer = setInterval(refreshLast, S.sec <= 900 ? 8000 : 15000); }
  function stopLive() { if (S.timer) clearInterval(S.timer); S.timer = null; }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.open) refreshLast(); });

  // ================================================================ авто-разбор (без ИИ) — и контекст для ИИ
  function snapshot() {
    const cs = S.cs, n = cs.length;
    if (!n) return null;
    const last = cs[n - 1], I = S.ind, sv = I.sess[n - 1];
    const P = profile(cs, Math.max(0, n - 120), n - 1, 44);
    const back = Math.min(n - 1, S.sec <= 900 ? 24 : S.sec <= 3600 ? 12 : 6);
    const cvdNow = I.cvd[n - 1].v, cvdThen = I.cvd[n - 1 - back].v;
    const pxThen = cs[n - 1 - back].c;
    const oiArr = oiSeries();
    const oiNow = oiArr.length ? oiArr[oiArr.length - 1].value : null;
    const oiThenP = oiArr.length > back ? oiArr[oiArr.length - 1 - back].value : null;
    const m = S.mkt || {};
    const fr = Object.values(m.funding || {}).filter((v) => isFinite(v));
    const exTot = {};
    let tot = 0, spot = 0;
    cs.slice(-Math.min(n, 24)).forEach((k) => { tot += k.Q; spot += k.spot; Object.entries(k.ex).forEach(([e, q]) => { exTot[e] = (exTot[e] || 0) + q; }); });
    let hi = -Infinity, lo = Infinity;
    cs.slice(-60).forEach((k) => { hi = Math.max(hi, k.h); lo = Math.min(lo, k.l); });
    const r = (v) => (v == null ? null : +Number(v).toPrecision(6));
    return {
      symbol: S.sym, timeframe: S.tf, price: r(last.c), change_24h_pct: m.chg24 != null ? +m.chg24.toFixed(2) : null,
      session_vwap: r(sv.v), session_sigma: r(sv.sd), dev_sigma: sv.sd ? +((last.c - sv.v) / sv.sd).toFixed(2) : null,
      anchored_vwap: I.av ? r(I.av[I.av.length - 1].v) : null,
      volume_profile_120: P ? { poc: r(P.poc), vah: r(P.vah), val: r(P.val) } : null,
      range_60: { high: r(hi), low: r(lo) },
      cvd_change: Math.round(cvdNow - cvdThen), price_change_pct: +((last.c / pxThen - 1) * 100).toFixed(2), lookback_bars: back,
      oi_usd: oiNow ? Math.round(oiNow) : null, oi_change_pct: oiNow && oiThenP ? +((oiNow / oiThenP - 1) * 100).toFixed(2) : null,
      funding_8h_avg_pct: fr.length ? +((fr.reduce((s, v) => s + v, 0) / fr.length) * 100).toFixed(4) : null, funding_by_exchange: m.funding || {},
      spot_share_pct: tot ? Math.round((spot / tot) * 100) : null,
      exchange_share_pct: Object.fromEntries(Object.entries(exTot).sort((a, b) => b[1] - a[1]).map(([e, q]) => [e, Math.round((q / tot) * 100)])),
      volume_spikes_last20: I.spikes.filter((s) => s.i >= n - 20).map((s) => ({ bars_ago: n - 1 - s.i, x_avg: +s.x.toFixed(1), delta: cs[s.i].delta >= 0 ? "buy" : "sell", close: r(cs[s.i].c) })),
      candles: cs.slice(-40).map((k) => [k.t, r(k.o), r(k.h), r(k.l), r(k.c), r(k.vwap), Math.round(k.Q), Math.round(k.delta), Math.round((k.spot / k.Q) * 100)]),
      candles_format: "[unix, open, high, low, close, candle_vwap, volume_usd, est_delta_usd, spot_pct]",
      mcq_signal: S.signal ? { side: S.signal.side, entry: S.signal.entry, stop: S.signal.sl, tp1: S.signal.tp1, tp2: S.signal.tp2, status: S.signal.status } : null,
      exchanges: Object.keys(S.bySrc).map((id) => `${SRC[id].ex} ${SRC[id].kind}`),
    };
  }
  function autoRead(s) {
    if (!s) return "";
    const L = [];
    const dev = s.dev_sigma;
    if (dev != null) {
      if (dev >= 2) L.push(_t("Цена выше VWAP на 2σ+ — перегрев, покупать вдогонку рискованно."));
      else if (dev >= 1) L.push(_t("Цена выше VWAP на 1σ+ — покупатели контролируют сессию."));
      else if (dev <= -2) L.push(_t("Цена ниже VWAP на 2σ+ — перепроданность, продавать вдогонку рискованно."));
      else if (dev <= -1) L.push(_t("Цена ниже VWAP на 1σ+ — продавцы контролируют сессию."));
      else L.push(_t("Цена около VWAP — баланс, рынок выбирает направление."));
    }
    const pc = s.price_change_pct, cv = s.cvd_change;
    if (pc > 0.3 && cv < 0) L.push(_t("Медвежья дивергенция: цена растёт, а агрессивные продажи (CVD) преобладают."));
    else if (pc < -0.3 && cv > 0) L.push(_t("Бычья дивергенция: цена падает, а агрессивные покупки (CVD) преобладают — возможна абсорбция."));
    else if (cv > 0 && pc > 0) L.push(_t("Рост подтверждён агрессивными покупками."));
    else if (cv < 0 && pc < 0) L.push(_t("Падение подтверждено агрессивными продажами."));
    const oc = s.oi_change_pct;
    if (oc != null && Math.abs(oc) >= 0.3) {
      if (pc > 0 && oc > 0) L.push(_t("OI растёт вместе с ценой — открываются новые лонги."));
      else if (pc > 0 && oc < 0) L.push(_t("OI падает при росте — закрытие шортов (шорт-сквиз), импульс может быстро выдохнуться."));
      else if (pc < 0 && oc > 0) L.push(_t("OI растёт при падении — открываются новые шорты."));
      else if (pc < 0 && oc < 0) L.push(_t("OI падает при падении — ликвидации и закрытие лонгов."));
    }
    const f = s.funding_8h_avg_pct;
    if (f != null) {
      if (f > 0.03) L.push(_t("Фандинг высокий — толпа в лонгах, риск отката вниз."));
      else if (f < -0.01) L.push(_t("Фандинг отрицательный — толпа в шортах, возможен шорт-сквиз."));
    }
    if (s.volume_profile_120) {
      const P = s.volume_profile_120;
      if (s.price > P.vah) L.push(`${_t("Цена выше зоны стоимости")} (VAH ${fmtP(P.vah)}) — ${_t("удержание = продолжение, возврат внутрь = ложный пробой.")}`);
      else if (s.price < P.val) L.push(`${_t("Цена ниже зоны стоимости")} (VAL ${fmtP(P.val)}) — ${_t("удержание = продолжение, возврат внутрь = ложный пробой.")}`);
      else L.push(`${_t("Цена внутри зоны стоимости, магнит — POC")} ${fmtP(P.poc)}.`);
    }
    const sp = s.volume_spikes_last20.filter((x) => x.bars_ago <= 5);
    if (sp.length) L.push(`${_t("Аномальный объём")} ${sp[0].x_avg}× ${_t("за последние свечи")} (${sp[0].delta === "buy" ? _t("покупки") : _t("продажи")}).`);
    if (s.spot_share_pct != null) L.push(s.spot_share_pct >= 35 ? _t("Высокая доля спота — движение поддержано реальными деньгами.") : s.spot_share_pct <= 15 ? _t("Движение двигают фьючерсы (плечи) — выше риск резких выносов.") : "");
    return L.filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join("");
  }

  // ================================================================ ИИ-ассистент
  const QUICK = ["Что сейчас происходит?", "Ключевые уровни", "План сделки", "Где ликвидность и стопы?", "Кто сильнее: покупатели или продавцы?"];
  function openAI() {
    const box = $("#pc-ai");
    box.hidden = false;
    $("#pc").classList.add("ai-open");
    requestAnimationFrame(() => box.classList.add("show"));
    $("#pc-ai-sub").textContent = `${S.sym} · ${_t(TFS.find((x) => x[0] === S.tf)[2])}`;
    $("#pc-ai-quick").innerHTML = QUICK.map((q) => `<button>${esc(_t(q))}</button>`).join("");
    $("#pc-ai-quick").querySelectorAll("button").forEach((b, i) => b.addEventListener("click", () => ask(_t(QUICK[i]))));
    if (!S.chat.length) {
      const read = autoRead(snapshot());
      $("#pc-ai-body").innerHTML = `<div class="ai-msg bot"><div class="ai-auto-h">${esc(_t("Авто-разбор графика"))}</div><ul class="ai-auto">${read}</ul>
        <div class="ai-note">${esc(aiNote())}</div></div>`;
    }
  }
  function closeAI() { const box = $("#pc-ai"); box.classList.remove("show"); const pc = $("#pc"); if (pc) pc.classList.remove("ai-open"); setTimeout(() => { box.hidden = true; }, 250); }
  function aiNote() {
    const A = window.AUTH;
    if (!CFG.supabaseUrl || !A || !A.enabled) return _t("ИИ-ассистент подключится вместе со входом в аккаунт.");
    if (!A.user) return _t("Войди в аккаунт, чтобы задать вопрос ИИ.");
    return _t("Задай вопрос — ИИ видит агрегированные свечи, VWAP, профиль объёма, CVD, OI и фандинг.");
  }
  function md(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>"); }
  function addMsg(role, html) {
    const body = $("#pc-ai-body");
    const d = document.createElement("div");
    d.className = `ai-msg ${role}`;
    d.innerHTML = html;
    body.appendChild(d);
    body.scrollTop = body.scrollHeight;
    return d;
  }
  async function ask(q) {
    addMsg("me", esc(q));
    const A = window.AUTH;
    if (!CFG.supabaseUrl || !A || !A.enabled || !A.sb) { addMsg("bot", esc(aiNote())); return; }
    const sess = (await A.sb.auth.getSession()).data.session;
    if (!sess) { addMsg("bot", esc(_t("Войди в аккаунт, чтобы задать вопрос ИИ."))); return; }
    const wait = addMsg("bot", `<span class="pc-dots"><i></i><i></i><i></i></span>`);
    S.chat.push({ role: "user", content: q });
    try {
      const r = await fetch(`${CFG.supabaseUrl}/functions/v1/chart-ai`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: `Bearer ${sess.access_token}` },
        body: JSON.stringify({ question: q, ctx: snapshot(), lang: I18.lang, history: S.chat.slice(-6) }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 402 || d.error === "pro_required") { wait.remove(); paywall(); return; }
      if (r.status === 429 || d.error === "limit") throw new Error(`${_t("Лимит вопросов на сегодня исчерпан")} (${d.limit || ""}).`);
      if (!r.ok || !d.answer) throw new Error(d.error || `${r.status}`);
      S.chat.push({ role: "assistant", content: d.answer });
      const bias = { bullish: _t("бычий"), bearish: _t("медвежий"), neutral: _t("нейтральный") }[d.bias] || "";
      let h = bias ? `<div class="ai-bias ${esc(d.bias)}">${esc(bias)}${d.confidence ? ` · ${Math.round(d.confidence)}%` : ""}</div>` : "";
      h += `<div>${md(d.answer)}</div>`;
      if (d.plan && d.plan.entry) {
        h += `<div class="ai-plan"><b class="${d.plan.side === "long" ? "up" : "down"}">${d.plan.side === "long" ? "LONG" : "SHORT"}</b>
          <span>${esc(_t("Вход"))} <b>${fmtP(d.plan.entry)}</b></span><span>${esc(_t("Стоп"))} <b class="down">${fmtP(d.plan.stop)}</b></span>
          <span>${esc(_t("Цели"))} <b class="up">${(d.plan.targets || []).map(fmtP).join(" / ")}</b></span>
          ${d.plan.invalidation ? `<small>${esc(d.plan.invalidation)}</small>` : ""}</div>`;
      }
      const nLv = (d.levels || []).length + (d.plan && d.plan.entry ? 2 + (d.plan.targets || []).length : 0);
      if (nLv) h += `<button class="ai-lv">${esc(_t("Уровни на графике"))} · ${nLv} ✓ <small>${esc(_t("убрать"))}</small></button>`;
      h += `<div class="ai-foot">${esc(_t("Не финансовый совет."))}${d.used && d.limit ? ` · ${d.used}/${d.limit}` : ""}</div>`;
      wait.innerHTML = h;
      S.aiLevels = (d.levels || []).filter((l) => isFinite(l.price));
      if (d.plan && d.plan.entry) {
        S.aiLevels.push({ price: d.plan.entry, label: _t("Вход"), kind: "entry" }, { price: d.plan.stop, label: _t("Стоп"), kind: "stop" });
        (d.plan.targets || []).forEach((p, i) => S.aiLevels.push({ price: p, label: `${_t("Цель")} ${i + 1}`, kind: "target" }));
      }
      drawAILevels();
      const lv = wait.querySelector(".ai-lv");
      if (lv) lv.addEventListener("click", () => { S.aiLevels = []; drawAILevels(); lv.textContent = _t("Уровни убраны"); lv.disabled = true; });
    } catch (e) {
      wait.innerHTML = `<span class="down">${esc(e.message && e.message.length > 4 ? e.message : _t("ИИ не ответил. Попробуй ещё раз."))}</span>`;
      S.chat.pop();
    }
    $("#pc-ai-body").scrollTop = 1e9;
  }

  // ================================================================ подписка
  async function hasAccess() {
    if (PREMIUM !== "paid") return true;
    const A = window.AUTH;
    if (!A || !A.enabled) return false;
    if (A.loadPlan) await A.loadPlan();
    return A.plan === "pro";
  }
  function paywall() {
    const el = $("#pc-pay");
    const A = window.AUTH;
    el.innerHTML = `<div class="pay-card glass">
        <div class="pay-badge">McQ PRO</div>
        <h3>${esc(_t("Интеллектуальный чарт для профи"))}</h3>
        <ul>
          <li>${esc(_t("Свечи и объём с 9 крупнейших бирж: спот + фьючерсы"))}</li>
          <li>${esc(_t("VWAP в каждой свече, сессионный и якорный VWAP с σ-каналами"))}</li>
          <li>${esc(_t("Профиль объёма, CVD, открытый интерес, фандинг"))}</li>
          <li>${esc(_t("ИИ-ассистент: разбор графика, уровни и план сделки"))}</li>
        </ul>
        <button class="pay-cta" data-pay="join">${esc(_t("Хочу McQ Pro"))}</button>
        <button class="pay-back" data-pay="back">${esc(_t("Назад"))}</button>
        <small>${esc(_t("Подписка скоро. Оставь заявку — откроем доступ первым."))}</small>
      </div>`;
    el.hidden = false;
    el.querySelector('[data-pay="back"]').addEventListener("click", () => { el.hidden = true; if (!S.cs.length) close(); });
    el.querySelector('[data-pay="join"]').addEventListener("click", async (e) => {
      const b = e.currentTarget;
      try {
        if (A && A.sb && A.user) await A.sb.from("pro_waitlist").upsert({ user_id: A.user.id });
        b.textContent = _t("Заявка принята ✓"); b.disabled = true;
      } catch (err) { b.textContent = _t("Заявка принята ✓"); b.disabled = true; }
    });
  }

  // ================================================================ открыть / закрыть
  function onBack() { if (!$("#pc-ai").hidden) closeAI(); else close(); }
  async function open(opts) {
    opts = opts || {};
    const el = shell();
    if (opts.symbol) S.sym = String(opts.symbol).toUpperCase().replace(/USDT$/, "");
    S.signal = findSignal(S.sym);
    S.open = true;
    el.hidden = false;
    document.documentElement.classList.add("pc-open");
    requestAnimationFrame(() => el.classList.add("show"));
    if (tg) {
      try { tg.BackButton.show(); tg.BackButton.onClick(onBack); } catch (e) { /* noop */ }
      try { tg.HapticFeedback && tg.HapticFeedback.impactOccurred("medium"); } catch (e) { /* noop */ }
    }
    renderControls();
    if (!(await hasAccess())) { paywall(); return; }
    $("#pc-pay").hidden = true;
    try { await loadLW(); } catch (e) { msg(esc(_t("Не удалось загрузить график. Проверь соединение."))); return; }
    if (!chart) buildChart();
    clearAI();
    load();
  }
  function close() {
    const el = $("#pc");
    if (!el) return;
    S.open = false;
    stopLive();
    el.classList.remove("show");
    document.documentElement.classList.remove("pc-open");
    setTimeout(() => { el.hidden = true; }, 260);
    closeAI();
    if (tg) {
      try { tg.BackButton.offClick(onBack); tg.BackButton.hide(); } catch (e) { /* noop */ }
    }
  }

  window.ProChart = { open, close, premium: PREMIUM, _test: { aggregate, indicators, profile, autoRead, snapshot, S, chart: () => chart } };
})();
