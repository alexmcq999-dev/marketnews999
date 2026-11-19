/* CANDEL — Telegram Mini App */
(function () {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp;
  // вне Telegram (приложение на телефоне, браузер) отступы от чёлки/Dynamic Island берём у системы
  if (!(tg && tg.initData)) document.documentElement.classList.add("no-tg");
  const I18 = window.I18N || { t: (s) => s, lang: "ru", locale: "ru-RU", tv: "ru", langs: {}, setLang() {}, translateDom() {} };
  const _t = I18.t, LOCALE = I18.locale;
  const CYR = /[А-Яа-яЁё]/;
  // текст от бота: на русском — как есть; на других языках — перевод из словаря, а если его нет — скрываем
  const loc = (s) => (I18.lang === "ru" || !s || !CYR.test(s) ? s || "" : (_t(s) !== s ? _t(s) : ""));
  const locList = (s) => (s || "").split(",").map((x) => loc(x.trim())).filter(Boolean).join(", ");
  I18.translateDom(document.body);
  // прелоадер: показываем минимум 1.5 с (чтобы логотип успел «вдохнуть»), максимум 7 с
  const T0 = Date.now();
  let preHidden = false;
  function hidePreloader() {
    if (preHidden) return;
    preHidden = true;
    setTimeout(() => {
      const p = document.getElementById("preloader");
      if (!p) return;
      p.classList.add("done");
      // после затухания прячем прелоадер совсем (display: none): его бесконечные анимации иначе продолжают грузить видеочип
      setTimeout(() => { if (p.classList.contains("done")) p.hidden = true; }, 800);
    }, Math.max(0, 1500 - (Date.now() - T0)));
  }
  setTimeout(hidePreloader, 7000);
  window.__appStarted = true;   // для диагностики запуска в index.html
  const TZ = "Europe/Moscow";
  const $ = (sel) => document.querySelector(sel);

  // Символы TradingView (CFD/индексы, доступные во встраиваемом виджете)
  const TV = {
    "S&P 500": "FOREXCOM:SPXUSD",
    "Nasdaq": "FOREXCOM:NSXUSD",
    "BTC": "BITSTAMP:BTCUSD",
    "ETH": "BITSTAMP:ETHUSD",
    "Gold": "TVC:GOLD",
    "Brent": "TVC:UKOIL",
    "DXY": "TVC:DXY",
    "US10Y": "TVC:US10Y",
    "VIX": "TVC:VIX",
    "BTC.D": "CRYPTOCAP:BTC.D",
  };
  const CHART_ORDER = ["BTC", "BTC.D", "ETH", "S&P 500", "Nasdaq", "Gold", "Brent", "DXY", "US10Y", "VIX"];
  const INTERVALS = [["15", _t("15м")], ["60", _t("1ч")], ["240", _t("4ч")], ["D", _t("1Д")], ["W", _t("1Н")]];
  const FLAGS = { USD: "🇺🇸", EUR: "🇪🇺", GBP: "🇬🇧", JPY: "🇯🇵", CNY: "🇨🇳", ALL: "🌐" };
  const BIAS = { bullish: _t("позитив"), bearish: _t("негатив"), mixed: _t("неоднозначно") };

  const state = { data: null, sig: null, sigPeriod: "d30", tab: "overview", newsFilter: _t("Все"), asset: "BTC", interval: "240", rsi: true, chartKey: "",
    mode: "simple", live: {}, global: null, newsView: "news", xGroup: "all" };
  // режим «Просто / Профи» запоминаем на устройстве
  let modeChosen = false;
  try { const m = localStorage.getItem("amq-mode"); if (m === "pro" || m === "simple") { state.mode = m; modeChosen = true; } } catch (e) { /* приватный режим */ }

  // Сигналы McQ Signals: свежие данные прямо из репозитория бота, запасной вариант — копия в data/
  const SIGNALS_URLS = [
    "https://raw.githubusercontent.com/alexmcq999-dev/McQSignals/main/state/app_signals.json",
    "data/signals.json",
  ];
  const EXIT = { sl: _t("стоп"), tp2: "TP2", be: _t("б/у после TP1"), trail: _t("трейлинг"), timeout: _t("по времени") };
  // свой актив: «SOL» → крипта на Binance, «NASDAQ:AAPL» / «FX:EURUSD» — как есть (биржа:тикер TradingView)
  const tvSymbol = (a) => { const x = String(a).toUpperCase(); return TV[a] || (x.includes(":") ? x : x.endsWith("USDT") ? `BINANCE:${x}` : `BINANCE:${x}USDT`); };
  const LS_CUSTOM = "amq-chart-custom";
  const customAssets = () => { try { const v = JSON.parse(localStorage.getItem(LS_CUSTOM) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 12) : []; } catch (e) { return []; } };
  const saveCustom = (list) => { try { localStorage.setItem(LS_CUSTOM, JSON.stringify(list.slice(0, 12))); } catch (e) { /* noop */ } };

  // ---------------------------------------------------------------- утилиты
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtNum(v, dec) {
    return Number(v).toLocaleString(LOCALE, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function fmtTime(iso, withDate) {
    const d = new Date(iso);
    const opts = withDate ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" };
    return d.toLocaleString(LOCALE, { ...opts, timeZone: TZ });
  }
  function dayKey(iso) {
    return new Date(iso).toLocaleDateString(LOCALE, { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
  }
  function isToday(iso) {
    const f = (d) => d.toLocaleDateString(LOCALE, { timeZone: TZ });
    return f(new Date(iso)) === f(new Date());
  }
  function ago(iso) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return _t("только что");
    if (m < 60) return `${m} ${_t("мин назад")}`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} ${_t("ч назад")}` : fmtTime(iso, true);
  }
  function openLink(url) {
    if (tg && tg.openLink) tg.openLink(url); else window.open(url, "_blank", "noopener");
  }
  function haptic() { try { tg && tg.HapticFeedback && tg.HapticFeedback.selectionChanged(); } catch (e) { /* noop */ } }
  function chg(v) {
    if (v == null || isNaN(v)) return "";
    const cls = v > 0.05 ? "up" : v < -0.05 ? "down" : "flat";
    const word = cls === "up" ? _t("рост") : cls === "down" ? _t("падение") : _t("без изменений");
    const icon = cls === "up" ? '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.5 9 8H1z" fill="currentColor"/></svg>'
      : cls === "down" ? '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 8.5 1 2h8z" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="4" width="8" height="2" rx="1" fill="currentColor"/></svg>';
    return `<span class="chg ${cls}" aria-label="${word} ${Math.abs(v).toFixed(2)}%">${icon}${v > 0 ? "+" : ""}${v.toFixed(2)}%</span>`;
  }
  function trendClass(v) { return v == null ? "" : v > 0.05 ? "up" : v < -0.05 ? "down" : ""; }
  function fngColor(v) {
    return v < 25 ? "var(--down)" : v < 45 ? "var(--orange)" : v <= 55 ? "var(--text-2)" : v < 75 ? "color-mix(in srgb, var(--up) 70%, var(--warn))" : "var(--up)";
  }
  function gauge(title, x) {
    const r = 48, cx = 60, cy = 58, len = Math.PI * r, v = Math.max(0, Math.min(100, x.value));
    const th = Math.PI * (1 - v / 100), kx = cx + r * Math.cos(th), ky = cy - r * Math.sin(th);
    const id = "g" + title.replace(/\W/g, "");
    const delta = x.value - x.week;
    return `<div class="gauge glass" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${x.value}" aria-label="${esc(title)}: ${x.value}, ${esc(_t(x.rating_ru))}">
      <div class="t">${esc(title)}</div>
      <svg class="arc" viewBox="0 0 120 70" aria-hidden="true">
        <defs><linearGradient id="${id}" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stop-color="var(--down)"/><stop offset=".3" stop-color="var(--orange)"/>
          <stop offset=".5" stop-color="var(--neutral)"/><stop offset=".72" stop-color="#a4d65e"/><stop offset="1" stop-color="var(--up)"/></linearGradient></defs>
        <path d="M12 58 A48 48 0 0 1 108 58" fill="none" stroke="url(#${id})" stroke-width="9" stroke-linecap="round" opacity=".25"/>
        <path d="M12 58 A48 48 0 0 1 108 58" fill="none" stroke="url(#${id})" stroke-width="9" stroke-linecap="round" stroke-dasharray="${(len * v / 100).toFixed(1)} ${len.toFixed(1)}"/>
        <circle cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="7.5" fill="#fff" stroke="rgba(0,0,0,.15)" stroke-width=".6"/>
        <circle cx="${(kx - 1.8).toFixed(1)}" cy="${(ky - 2).toFixed(1)}" r="2.6" fill="rgba(255,255,255,.9)"/>
      </svg>
      <div class="v">${x.value}</div>
      <div class="r" style="color:${fngColor(x.value)}">${esc(_t(x.rating_ru))}</div>
      <div class="d">${_t("вчера")} ${x.prev} · ${_t("неделя")} ${x.week} (${delta > 0 ? "+" : ""}${delta})</div>
    </div>`;
  }

  // ---------------------------------------------------------------- данные
  async function load(showSpin) {
    const btn = $("#refresh");
    if (showSpin) btn.classList.add("spin");
    try {
      const r = await fetch(`data/app.json?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      state.data = await r.json();
      const ageMin = (Date.now() - new Date(state.data.updated).getTime()) / 60000;
      $("#updated-text").textContent = `${_t("Обновлено")} ${ago(state.data.updated)}`;
      $("#updated").title = `${fmtTime(state.data.updated, true)} ${_t("МСК")}`;
      $(".live-dot").classList.toggle("stale", ageMin > 120);
      renderAll();
    } catch (e) {
      $("#updated-text").textContent = _t("Нет связи с сервером данных");
      $(".live-dot").classList.add("stale");
      if (!state.data) {
        $("#ov-main").innerHTML = `<div class="glass card empty">${_t("Данные ещё не опубликованы.")}<br>${_t("Запусти workflow в GitHub Actions и открой приложение снова.")}</div><div id="sessions" class="sess-wrap"></div>`;
        renderSessions();
      }
    } finally {
      btn.classList.remove("spin");
      hidePreloader();
    }
  }

  async function loadSignals() {
    for (const u of SIGNALS_URLS) {
      try {
        const r = await fetch(`${u}?t=${Date.now()}`, { cache: "no-store" });
        if (!r.ok) continue;
        state.sig = await r.json();
        if (state.tab === "charts") renderLiq();
        return;
      } catch (e) { /* пробуем следующий источник */ }
    }
  }

  function renderAll() {
    renderOverview();
    renderNews();
    renderCalendar();
    renderChartControls();
    if (state.tab === "charts") renderChart();
  }

  // ---------------------------------------------------------------- обзор
  // ---------------------------------------------------------------- пульс: BTC онлайн, страх/жадность, общий фон
  // ---------------------------------------------------------------- рынок сейчас: строка BTC · страх · доминация · индексы
  const FNG_COND = (v) => (v == null ? null : v <= 25 ? ["Страх на рынке", "down"] : v <= 45 ? ["Осторожность", "down"] : v < 55 ? ["Нейтрально", ""] : v < 75 ? ["Аппетит к риску", "up"] : ["Эйфория", "up"]);
  const SIMPLE = {
    down: "инвесторы осторожничают. В такие дни цена часто резко ходит в обе стороны — уменьши размер сделок и не входи «на эмоциях».",
    "": "рынок без явного настроения. Лучше дождаться понятного движения и торговать по плану.",
    up: "покупатели активны. Не догоняй рост — на эйфории рынок часто разворачивается.",
  };
  function renderPulse() {
    const d = state.data || {};
    const box = $("#ov-pulse");
    const m = (d.markets || []).find((x) => x.name === "BTC") || {};
    const live = state.live.BTC;
    const price = live ? live.price : m.price, ch = live ? live.chg : m.chg;
    const f = ((d.sentiment || {}).fng || {}).crypto;
    const g = state.global, p = (g && g.market_cap_percentage) || null;
    const dom = p ? p.btc : null;
    const fv = f ? Math.max(0, Math.min(100, f.value)) : null;
    const fc = f ? (f.value <= 45 ? "down" : f.value >= 55 ? "up" : "") : "";
    const mk = (d.markets || []).filter((x) => x.name !== "BTC").slice(0, 4);
    let domBar = "";
    if (p) {
      const st = (p.usdt || 0) + (p.usdc || 0), oth = Math.max(0, 100 - p.btc - (p.eth || 0) - st);
      domBar = `<span class="comp" aria-hidden="true"><i style="width:${p.btc.toFixed(1)}%"></i><i style="width:${(p.eth || 0).toFixed(1)}%"></i><i style="width:${st.toFixed(1)}%"></i><i style="width:${oth.toFixed(1)}%"></i></span>`;
    }
    box.innerHTML = `<section class="strip" aria-label="${_t("Рынок сейчас")}">
      <button class="st st-btc" data-asset="BTC" aria-label="${_t("Биткоин, открыть график")}">
        <span class="st-k"><b>Bitcoin</b>BTC · USD</span>
        <span class="st-price"><b>${price != null ? fmtNum(price, price >= 1000 ? 1 : 2) : "—"}</b>${chg(ch)}</span>
        <span class="st-sub">${_t("изменение за 24ч")}</span>
      </button>
      <div class="st" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${f ? f.value : ""}" aria-label="${_t("Страх и жадность")}">
        <span class="st-k">${_t("Страх и жадность · крипта")}</span>
        <span class="st-v"><b>${f ? f.value : "—"}</b><em class="${fc}">${f ? esc(_t(f.rating_ru)) : _t("нет данных")}</em></span>
        <span class="fg-scale" aria-hidden="true">${fv != null ? `<i style="left:${fv}%"></i>` : ""}</span>
        <span class="st-sub">${f ? `${_t("вчера")} ${f.prev} · ${_t("неделю назад")} ${f.week}` : ""}</span>
      </div>
      <button class="st" data-asset="BTC.D" aria-label="${_t("Доминация BTC, открыть график")}">
        <span class="st-k">${_t("Доминация BTC")}</span>
        <span class="st-v"><b>${dom != null ? dom.toFixed(1).replace(".", I18.lang === "en" || I18.lang === "ko" || I18.lang === "zh" ? "." : ",") + "%" : "—"}</b></span>
        ${domBar || `<span class="comp" aria-hidden="true"></span>`}
        <span class="st-sub">${_t("доля в капитализации · CoinGecko")}</span>
      </button>
      <div class="st st-mk">${mk.map((q) => `<button class="mk" data-asset="${esc(q.name)}" aria-label="${_t("Открыть график")} ${esc(q.name)}"><span>${esc(q.name)}</span><b>${fmtNum(q.price, q.dec)}</b>${chg(q.chg)}</button>`).join("")}</div>
    </section>
    <p class="explain simple-only">${_t("Настроение — индекс страха и жадности:")} <b>0–25</b> ${_t("паника,")} <b>75–100</b> ${_t("эйфория. На крайностях рынок часто разворачивается.")}</p>`;
    box.querySelectorAll("[data-asset]").forEach((b) => b.addEventListener("click", () => { state.asset = b.dataset.asset; switchTab("charts"); }));
    renderBrief();
  }

  // ---------------------------------------------------------------- брифинг: что происходит + главные новости
  function renderBrief() {
    const d = state.data || {};
    const mi = d.mood_i18n || {};
    // текст «Что происходит» бот пишет по-русски; на других языках показываем только если есть перевод
    const mood = I18.lang === "ru" ? d.mood : mi[I18.lang] || mi.en || "";
    const f = ((d.sentiment || {}).fng || {}).crypto;
    const cond = FNG_COND(f ? f.value : null);
    const ru = I18.lang === "ru";
    const BIAS = { bullish: [_t("Бычья"), "up"], bearish: [_t("Медвежья"), "down"], mixed: [_t("Смешанная"), ""] };
    const news = (d.news || []).slice().sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 4);
    if (!mood && !news.length) { $("#ov-mood").innerHTML = ""; return; }
    let head = mood, rest = "";
    const mm = mood && mood.match(/^(.{20,180}?[.!?])\s+([\s\S]+)$/);
    if (mm) { head = mm[1]; rest = mm[2]; }
    const rows = news.map((n) => {
      const tr = ru ? null : ((n.i18n || {})[I18.lang] || (n.i18n || {}).en || null);
      const title = ru ? n.title : (tr && tr.title) || n.title_en || n.title;
      const b = BIAS[n.bias];
      const src = (n.links || []).map((l) => l.outlet).filter(Boolean).slice(0, 2).join(", ");
      const when = isToday(n.ts) ? fmtTime(n.ts) : new Date(n.ts).toLocaleDateString(LOCALE, { timeZone: TZ, day: "numeric", month: "short" });
      return `<button class="br-row" data-go="news"><span class="br-t">${when}</span><span class="br-h">${esc(title)}${src ? `<small>${esc(src)}</small>` : ""}</span>${b ? `<span class="br-b ${b[1]}">${esc(b[0])}</span>` : "<span></span>"}</button>`;
    }).join("");
    $("#ov-mood").innerHTML = `<article class="brief" aria-label="${_t("Что происходит на рынке")}">
      <div class="br-meta"><span class="br-k">${_t("Брифинг")}</span>${d.news_updated ? `<span>${fmtTime(d.news_updated, !isToday(d.news_updated))} ${_t("МСК")}</span>` : ""}${cond ? `<span class="br-cond ${cond[1]}">${_t(cond[0])}</span>` : ""}</div>
      ${head ? `<h2 class="br-title">${esc(head)}</h2>` : ""}
      ${rest ? `<p class="br-text">${esc(rest)}</p>` : ""}
      ${cond ? `<div class="br-simple simple-only"><b>${_t("Простыми словами:")}</b> ${_t(SIMPLE[cond[1]])}</div>` : ""}
      ${rows ? `<div class="br-list">${rows}</div>` : ""}
    </article>`;
    $("#ov-mood").querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.go)));
  }

  // BTC онлайн (Binance, без ключей) — обновляем каждые 20 секунд
  async function loadLive() {
    for (const u of ["https://data-api.binance.vision/api/v3/ticker/24hr?symbol=BTCUSDT", "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT"]) {
      try {
        const r = await fetch(u, { cache: "no-store" });
        if (!r.ok) continue;
        const j = await r.json();
        state.live.BTC = { price: Number(j.lastPrice), chg: Number(j.priceChangePercent) };
        if (state.data) renderPulse();
        return;
      } catch (e) { /* следующий источник */ }
    }
  }

  // ---------------------------------------------------------------- доминация BTC
  // Основное значение — виджет TradingView CRYPTOCAP:BTC.D (тот же ряд, что и на графике, обновляется сам).
  function mountDominance() {
    const box = $("#dom-widget");
    if (!box || box.dataset.ready) return;
    box.dataset.ready = "1";
    box.innerHTML = `<div class="tradingview-widget-container" style="height:100%"><div class="tradingview-widget-container__widget" style="height:100%"></div></div>`;
    const s = document.createElement("script");
    s.src = "https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js";
    s.async = true;
    s.text = JSON.stringify({
      symbol: "CRYPTOCAP:BTC.D", width: "100%", height: "100%", locale: I18.tv, dateRange: "1D",
      colorTheme: "dark", isTransparent: true, autosize: true, largeChartUrl: "", chartOnly: false, noTimeScale: true,
      trendLineColor: "rgba(255, 255, 255, 1)", underLineColor: "rgba(255, 255, 255, 0.16)", underLineBottomColor: "rgba(255, 255, 255, 0)",
    });
    box.querySelector(".tradingview-widget-container").appendChild(s);
    // если TradingView не загрузился (блокировка/сеть) — показываем долю BTC по CoinGecko
    setTimeout(() => {
      if (box.querySelector("iframe")) return;
      box.dataset.fallback = "1";
      renderDomFallback();
    }, 8000);
    $("#dom-card .dom-head").addEventListener("click", () => { state.asset = "BTC.D"; switchTab("charts"); });
  }
  // Профи: структура рынка по CoinGecko (все монеты — поэтому доля BTC здесь ниже, чем в индексе TradingView)
  async function loadGlobal() {
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/global", { cache: "no-store" });
      if (!r.ok) return;
      const g = (await r.json()).data || {};
      state.global = g;
      renderDomExtra();
    } catch (e) { /* без структуры — не критично */ }
  }
  function renderDomFallback() {
    const box = $("#dom-widget"), g = state.global;
    if (!box || !box.dataset.fallback) return;
    const v = g && g.market_cap_percentage ? g.market_cap_percentage.btc : null;
    box.innerHTML = `<div class="dom-fb"><div class="v">${v != null ? v.toFixed(1) + "%" : "—"}</div><div class="s">${_t("по всем монетам (CoinGecko) · график TradingView недоступен")}</div></div>`;
  }
  function renderDomExtra() {
    renderDomFallback();
    const g = state.global, box = $("#dom-extra");
    if (!g || !box) return;
    const p = g.market_cap_percentage || {};
    const btc = p.btc || 0, eth = p.eth || 0, st = (p.usdt || 0) + (p.usdc || 0), oth = Math.max(0, 100 - btc - eth - st);
    const parts = [["BTC", btc, "#F2F0EC"], ["ETH", eth, "#8E9196"], [_t("Стейблкоины"), st, "#5E6167"], [_t("Остальные"), oth, "#34363B"]];
    if (state.data) renderPulse();
    box.innerHTML = `<div>
      <div class="dom-split">${parts.map(([, v, c]) => `<i style="width:${v.toFixed(2)}%;background:${c}"></i>`).join("")}</div>
      <div class="dom-legend">${parts.map(([n, v, c]) => `<span style="--c:${c}">${n}<b>${v.toFixed(1)}%</b></span>`).join("")}</div>
      <p class="hint pro-only" style="margin:6px 0 0">${_t("Структура всего рынка (")}${Math.round(g.active_cryptocurrencies || 0).toLocaleString(LOCALE)} ${_t("монет, CoinGecko). TradingView считает доминацию по топ-125 монетам — поэтому цифра выше.")}</p>
    </div>`;
  }

  function renderOverview() {
    renderPulse();
    const d = state.data;
    const s = d.sentiment || {};
    let h = "";


    h += `<div id="sessions" class="sess-wrap"></div>`;

    const f = s.fng || {};
    if (f.stocks || f.crypto) {
      h += `<div class="pro-only"><div class="section-title">${_t("Страх и жадность")}</div><div class="fng-grid">`;
      if (f.stocks) h += gauge(_t("Акции · CNN"), f.stocks);
      if (f.crypto) h += gauge(_t("Крипта"), f.crypto);
      h += `</div></div>`;
    }

    if ((s.rsi || []).length) {
      h += `<div class="pro-only"><div class="section-title">RSI <small>14 ${_t("дней")}</small></div><div class="glass rsi-list">`;
      for (const r of s.rsi) {
        h += `<div class="rsi-row" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${r.value}" aria-label="RSI ${esc(r.name)}: ${Math.round(r.value)}, ${esc(_t(r.label))}">
          <span class="t">${esc(r.name)}</span>
          <div class="track"><span class="zone lo"></span><span class="zone hi"></span><span class="bead" style="left:${Math.max(0, Math.min(100, r.value))}%"></span></div>
          <span class="v">${Math.round(r.value)}</span>
          <span class="sub">${esc(_t(r.label))}</span>
        </div>`;
      }
      h += `<div class="legend"><span><i style="background:var(--up)"></i>${_t("ниже 30 — перепроданность")}</span><span><i style="background:var(--down)"></i>${_t("выше 70 — перекупленность")}</span></div></div></div>`;
    }

    const next = (d.calendar || []).filter((e) => e.impact === "High" && new Date(e.ts) > Date.now()).slice(0, 3);
    if (next.length) {
      h += `<div class="section-title">${_t("Ближайшие события")}</div><div class="glass list">`;
      h += next.map((e) => `<div class="row"><span class="when">${fmtTime(e.ts)}${isToday(e.ts) ? "" : `<small>${new Date(e.ts).toLocaleDateString(LOCALE, { timeZone: TZ, day: "numeric", month: "short" })}</small>`}</span><span class="what">${FLAGS[e.country] || ""} ${esc(e.title)}</span></div>`).join("");
      h += `</div>`;
    }

    const done = (d.calendar || []).filter((e) => e.result && e.impact === "High" && new Date(e.ts) < Date.now())
      .sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 3);
    if (done.length) {
      h += `<div class="section-title">${_t("Итоги событий")}</div><div class="ce-day ov-res">${done.map((e) => calRow(e, false)).join("")}</div>`;
    }

    $("#ov-main").innerHTML = h || `<div class="glass card empty">${_t("Нет данных")}</div>`;
    document.querySelectorAll("#tab-overview .res-src").forEach((b) => b.addEventListener("click", () => openLink(b.dataset.url)));
    renderSessions();
    document.querySelectorAll("#ov-main .quote[data-asset]").forEach((b) =>
      b.addEventListener("click", () => {
        const a = b.dataset.asset;
        if (TV[a]) { state.asset = a; switchTab("charts"); }
      }));
  }

  // ---------------------------------------------------------------- новости
  const ICON_IMPACT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>';
  const ICON_WATCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';

  // ---------------------------------------------------------------- новости: три ленты
  const NEWS_VIEWS = [["news", "Новости"], ["x", "Крипто X"], ["dex", "Perp DEX"]];
  function newsSwitch() {
    const idx = Math.max(0, NEWS_VIEWS.findIndex(([k]) => k === state.newsView));
    return `<div class="segmented glass news-seg" id="news-view" style="--n:3;--i:${idx}"><span class="thumb-glass" aria-hidden="true"></span>${
      NEWS_VIEWS.map(([k, l]) => `<button class="${k === state.newsView ? "active" : ""}" data-v="${k}" role="radio" aria-checked="${k === state.newsView}">${_t(l)}</button>`).join("")}</div>`;
  }
  function bindNewsSwitch(box) {
    box.querySelectorAll("#news-view button").forEach((b) => b.addEventListener("click", () => {
      state.newsView = b.dataset.v; haptic(); renderNews(); window.scrollTo({ top: 0, behavior: "smooth" });
    }));
  }
  function renderNews() {
    if (state.newsView === "x") return renderXFeed();
    if (state.newsView === "dex") return renderDex();
    const news = state.data.news || [];
    const box = $("#tab-news");
    if (!news.length) {
      box.innerHTML = newsSwitch() + `<div class="glass card empty">${_t("Новости появятся после ближайшего дайджеста в 08:00 или 16:00 МСК.")}</div>`;
      bindNewsSwitch(box);
      return;
    }
    const themes = [_t("Все"), ...new Set(news.flatMap((n) => n.themes || []))];
    if (!themes.includes(state.newsFilter)) state.newsFilter = _t("Все");
    let h = newsSwitch() + `<div class="chips">${themes.map((t) => `<button class="chip glass ${t === state.newsFilter ? "active" : ""}" data-f="${esc(t)}">${esc(_t(t))}</button>`).join("")}</div>`;
    if (state.data.news_updated) h += `<div class="issue">${_t("Выпуск")} ${fmtTime(state.data.news_updated, true)} ${_t("МСК ·")} ${news.length} ${news.length < 5 ? _t("события") : _t("событий")}</div>`;

    const ru = I18.lang === "ru";
    const nb = state.mode === "simple";
    const list = news.filter((n) => state.newsFilter === _t("Все") || (n.themes || []).includes(state.newsFilter));
    for (const n of list) {
      // перевод разбора от бота: выбранный язык → английский; без перевода — только заголовок и источники
      const tr = ru ? null : ((n.i18n || {})[I18.lang] || (n.i18n || {}).en || null);
      const pick = (k) => (ru ? n[k] : tr ? tr[k] : "") || "";
      const title = ru ? n.title : (tr && tr.title) || n.title_en || n.title;
      const assets = ru ? n.assets : (tr && tr.assets) || locList(n.assets);
      const why = pick("why"), summary = pick("summary"), watch = pick("watch");
      const whyBox = why ? `<div class="insight impact ${nb ? "nb-why" : ""}"><b>${ICON_IMPACT}${nb ? _t("Что это значит для рынка") : _t("Влияние на рынки")}</b>${esc(why)}</div>` : "";
      h += `<article class="news-card glass">
        <div class="news-head">
          <span class="theme-pill">${esc(n.emoji)} ${esc(_t((n.themes || [])[0] || "Рынки"))}</span>
          <span class="news-time">${fmtTime(n.ts, !isToday(n.ts))}</span>
        </div>
        <h3>${esc(title)}</h3>
        ${ru && n.title_en && n.title_en !== n.title ? `<div class="en pro-only">${esc(n.title_en)}</div>` : ""}
        ${nb ? whyBox : ""}
        ${summary ? `<p ${nb ? 'style="margin-top:12px"' : ""}>${esc(summary)}</p>` : ""}
        ${nb ? "" : whyBox}
        ${watch ? `<div class="insight watch"><b>${ICON_WATCH}${_t("Следить")}</b>${esc(watch)}</div>` : ""}
        ${(n.bias && BIAS[n.bias]) || assets ? `<div class="meta">
          ${n.bias && BIAS[n.bias] ? `<span class="bias ${n.bias}">${BIAS[n.bias]}</span>` : ""}
          ${assets ? `<span class="tag">${esc(assets)}</span>` : ""}
        </div>` : ""}
        <div class="trust pro-only">${esc(loc(n.trust))}</div>
        <div class="links">${(n.links || []).map((l) => `<button data-url="${esc(l.url)}">${esc(l.outlet)} ↗</button>`).join("")}</div>
      </article>`;
    }
    box.innerHTML = h;
    box.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { state.newsFilter = c.dataset.f; haptic(); renderNews(); }));
    box.querySelectorAll(".links button").forEach((b) => b.addEventListener("click", () => openLink(b.dataset.url)));
    bindNewsSwitch(box);
  }

  // ---------------------------------------------------------------- Крипто X и Perp DEX
  const SENT = { bullish: ["позитив", "bullish"], bearish: ["негатив", "bearish"], neutral: ["нейтрально", "mixed"] };
  const GROUP = { leaders: "Лидеры мнений", protocols: "Проекты", dex: "Perp DEX" };
  const fmtK = (v) => (v == null ? "" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : String(v));
  const fmtBig = (v) => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : `$${Math.round(v / 1e3)}K`);
  function trPost(p, k) {
    if (I18.lang === "ru") return p[k] || "";
    const t = (p.i18n || {})[I18.lang] || (p.i18n || {}).en;
    return (t && t[k]) || "";
  }
  function trSummary(sec) {
    if (!sec) return "";
    if (I18.lang === "ru") return sec.summary || "";
    const m = sec.summary_i18n || {};
    return m[I18.lang] || m.en || "";
  }
  function postCard(p) {
    const nb = state.mode === "simple";
    const sum = trPost(p, "summary"), why = trPost(p, "why");
    const sent = SENT[p.sentiment] || SENT.neutral;
    const score = Math.max(0, Math.min(10, p.score || 0));
    const ini = esc((p.name || p.handle || "?").trim().slice(0, 1).toUpperCase());
    return `<article class="xpost glass" data-url="${esc(p.url)}">
      <div class="xp-head">
        <span class="xp-ava">${p.avatar ? `<img src="${esc(p.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<i>${ini}</i></span>
        <span class="xp-who"><b>${esc(p.name || p.handle)}${p.verified ? ' <svg class="xp-ok" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 2.4 2.1 3.2-.3.9 3 2.7 1.8-1 3 1 3-2.7 1.8-.9 3-3.2-.3L12 22l-2.4-2.1-3.2.3-.9-3L2.8 15.4l1-3-1-3L5.5 7.6l.9-3 3.2.3z" fill="currentColor"/><path d="m8 12.3 2.6 2.6L16 9.5" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/></svg>' : ""}</b>
          <small>@${esc(p.handle)} · ${ago(p.ts)}</small></span>
        <span class="bias ${sent[1]}">${_t(sent[0])}</span>
      </div>
      ${sum ? `<p class="xp-sum">${esc(sum)}</p>` : ""}
      ${why ? `<div class="insight impact ${nb ? "nb-why" : ""}"><b>${ICON_IMPACT}${nb ? _t("Что это значит для рынка") : _t("Влияние на рынки")}</b>${esc(why)}</div>` : ""}
      ${nb ? `<details class="xp-orig"><summary>${_t("Оригинал поста")}</summary><p>${esc(p.text)}</p></details>`
           : `<blockquote class="xp-text">${esc(p.text)}</blockquote>`}
      <div class="xp-foot">
        <span class="xp-score" title="${_t("Влияние")}">${_t("Влияние")} <i style="--w:${score * 10}%"></i><b>${score}/10</b></span>
        <span class="xp-metrics pro-only">♥ ${fmtK(p.likes)} · ↻ ${fmtK(p.rts)}${p.views ? ` · 👁 ${fmtK(p.views)}` : ""}</span>
        <button class="xp-open">${_t("Открыть в X")} ↗</button>
      </div>
      ${p.assets ? `<div class="xp-assets">${esc(p.assets)}</div>` : ""}
    </article>`;
  }
  function bindPosts(box) {
    box.querySelectorAll(".xpost .xp-open").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openLink(b.closest(".xpost").dataset.url); }));
    box.querySelectorAll(".dex-news [data-url]").forEach((b) => b.addEventListener("click", () => openLink(b.dataset.url)));
  }
  function emptyX(sec) {
    return `<div class="glass card empty">${(!sec || !sec.provider) && !((sec && sec.posts) || []).length
      ? _t("Лента постов из X появится после подключения источника данных.")
      : _t("За последние сутки значимых постов нет — бот показывает только то, что может повлиять на рынок.")}</div>`;
  }

  function renderXFeed() {
    const box = $("#tab-news");
    const sec = state.data.cryptox || null;
    const posts = (sec && sec.posts) || [];
    const groups = ["all", "leaders", "protocols"];
    if (!groups.includes(state.xGroup)) state.xGroup = "all";
    let h = newsSwitch();
    h += `<div class="x-intro glass"><div class="k">${_t("О чём говорят в X")}</div>
      <p>${esc(trSummary(sec)) || _t("Посты крупнейших людей и проектов крипторынка: только то, что может повлиять на цены или показывает настроение.")}</p>
      ${sec && sec.updated ? `<small>${_t("обновлено")} ${ago(sec.updated)}</small>` : ""}</div>`;
    h += `<div class="chips">${groups.map((g) => `<button class="chip glass ${g === state.xGroup ? "active" : ""}" data-g="${g}">${g === "all" ? _t("Все") : _t(GROUP[g])}</button>`).join("")}</div>`;
    const list = posts.filter((p) => state.xGroup === "all" || p.group === state.xGroup);
    h += list.length ? list.map(postCard).join("") : emptyX(sec);
    h += `<p class="hint">${_t("Отбор: посты с заметной реакцией, ИИ оставляет только влияющие на рынок или показывающие настроение. Не финансовый совет.")}</p>`;
    box.innerHTML = h;
    bindNewsSwitch(box);
    bindPosts(box);
    box.querySelectorAll(".chip[data-g]").forEach((c) => c.addEventListener("click", () => { state.xGroup = c.dataset.g; haptic(); renderXFeed(); }));
  }

  function renderDex() {
    const box = $("#tab-news");
    const d = state.data.dex || {};
    const nb = state.mode === "simple";
    let h = newsSwitch();
    h += `<div class="x-intro glass"><div class="k">${_t("Рынок perp DEX")}</div>
      <p>${esc(trSummary(d)) || _t("Децентрализованные биржи бессрочных фьючерсов: объёмы, новости и посты Hyperliquid, dYdX, GMX, Aster, Lighter и других.")}</p>
      ${nb ? `<p class="explain">${_t("Perp DEX — биржи, где торгуют фьючерсами с плечом прямо из своего кошелька, без регистрации на централизованной бирже. Рост их объёмов — признак активности трейдеров.")}</p>` : ""}</div>`;
    const v = d.volumes;
    if (v && (v.top || []).length) {
      const max = Math.max(...v.top.map((r) => r.vol24h));
      h += `<div class="section-title">${_t("Объём торгов за 24ч")} <small>${esc(v.source || "DefiLlama")}</small></div>
        <div class="dex-vol glass"><div class="dv-total"><b>${fmtBig(v.total24h)}</b>${v.change_1d != null ? chg(Number(v.change_1d)) : ""}<span>${_t("все perp DEX")}</span></div>
        ${v.top.slice(0, nb ? 5 : 10).map((r, i) => `<div class="dv-row"><span class="dv-n">${i + 1}. ${esc(r.name)}</span>
          <span class="dv-bar"><i style="width:${(r.vol24h / max) * 100}%"></i></span>
          <span class="dv-v">${fmtBig(r.vol24h)}${r.share != null ? `<small>${r.share.toFixed(1)}%</small>` : ""}</span>
          ${!nb && r.change_1d != null ? `<span class="dv-c">${chg(Number(r.change_1d))}</span>` : ""}</div>`).join("")}</div>`;
    }
    const posts = d.posts || [];
    h += `<div class="section-title">${_t("Посты бирж и команд")}</div>`;
    h += posts.length ? posts.map(postCard).join("") : emptyX(state.data.cryptox);
    const news = d.news || [];
    if (news.length) {
      h += `<div class="section-title">${_t("Новости рынка perp DEX")}</div><div class="glass list dex-news">` +
        news.map((n) => `<button class="dn-row" data-url="${esc(n.link)}"><span>${esc(n.title)}</span><small>${esc(n.outlet || "")}${n.outlet ? " · " : ""}${ago(n.ts)}</small></button>`).join("") + `</div>`;
    }
    h += `<p class="hint">${_t("Объёмы — DefiLlama, обновляются каждый час. Не финансовый совет.")}</p>`;
    box.innerHTML = h;
    bindNewsSwitch(box);
    bindPosts(box);
  }

  // ---------------------------------------------------------------- итоги событий
  // «выше/ниже прогноза» — описание, не оценка (высокая инфляция выше прогноза — плохо для риска), поэтому цвет нейтральный
  const VS = { above: [_t("выше прогноза ↑"), "vs"], below: [_t("ниже прогноза ↓"), "vs"], inline: [_t("в рамках прогноза"), "vs"] };
  const TONE = { hawkish: [_t("ястребино"), "hawk"], dovish: [_t("голубино"), "dove"], neutral: [_t("нейтрально"), "flat"] };
  function rxChip(x) {
    const v = Number(x.value);
    const cls = Math.abs(v) < (x.unit === "bp" ? 1 : 0.05) ? "flat" : v > 0 ? "up" : "down";
    const val = x.unit === "bp" ? `${v > 0 ? "+" : ""}${v.toFixed(0)} ${_t("б.п.")}` : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
    return `<span class="rx ${cls}">${esc(x.asset)} ${val}</span>`;
  }
  // служебные фразы ИИ («не найден», «не зафиксирована») пользователю не показываем
  const JUNK = /не найден|не зафиксирован|нет данных|not found/i;
  const clean = (s) => { const t = loc(s); return t && !JUNK.test(t) ? t : ""; };
  const headTitle = (t) => String(t || "").replace(/\s+-\s+[^-]+$/, "");
  function resultBlock(e) {
    const r = e.result;
    if (!r) return "";
    const chips = [];
    if (loc(r.decision)) chips.push(`<span class="res-chip dec">${esc(loc(r.decision))}</span>`);
    if (r.vs_forecast && VS[r.vs_forecast]) chips.push(`<span class="res-chip ${VS[r.vs_forecast][1]}">${VS[r.vs_forecast][0]}</span>`);
    if (r.tone && TONE[r.tone]) chips.push(`<span class="res-chip ${TONE[r.tone][1]}">${TONE[r.tone][0]}</span>`);
    const rx = (r.reaction || []).map(rxChip).join("");
    const sum = clean(r.summary), imp = clean(r.impact) || clean(r.reaction_label);
    const srcs = (r.sources || []).filter((x) => x && x.url);
    // для выступлений и протоколов без итога показываем главные заголовки — это и есть содержание
    const heads = !sum && srcs.length ? srcs.slice(0, 2).map((x) => `<li>${esc(headTitle(x.title))} <em>${esc(x.source || "")}</em></li>`).join("") : "";
    if (!chips.length && !sum && !heads && !rx && !imp) return "";
    return `<div class="ce-res">
      ${chips.length ? `<div class="res-chips">${chips.join("")}</div>` : ""}
      ${sum ? `<p class="ce-sum">${esc(sum)}</p>` : ""}
      ${heads ? `<ul class="ce-heads">${heads}</ul>` : ""}
      ${rx ? `<div class="ce-rx"><span>${r.reaction_full ? _t("Реакция за час") : _t("Реакция (идёт час)")}</span>${rx}</div>` : ""}
      ${imp ? `<p class="ce-imptxt">${esc(imp)}</p>` : ""}
      ${srcs.length ? `<div class="ce-src">${srcs.slice(0, 3).map((x) => `<button class="res-src" data-url="${esc(x.url)}">${esc(x.source || _t("источник"))} ↗</button>`).join("")}${r.actual_src === "tradingview" ? `<span>${_t("факт — официальные данные")}</span>` : ""}</div>` : ""}
    </div>`;
  }

  // ---------------------------------------------------------------- календарь
  function numCell(label, val, cls) {
    return `<span class="ce-n ${cls || ""}"><small>${label}</small><b>${val ? esc(val) : "—"}</b></span>`;
  }
  function calRow(e, isNext) {
    const now = Date.now();
    const past = new Date(e.ts) < now;
    const r = e.result || {};
    const act = e.actual || r.actual || "";
    const hasNums = act || e.forecast || e.previous;
    const vs = r.vs_forecast === "above" ? "↑" : r.vs_forecast === "below" ? "↓" : "";
    return `<div class="ce ${past ? "past" : ""} ${act || e.result ? "done" : ""} ${isNext ? "next" : ""}">
      <span class="ce-t">${fmtTime(e.ts)}</span>
      <div class="ce-main">
        <div class="ce-title"><i class="ce-imp ${e.impact === "High" ? "high" : ""}" title="${e.impact === "High" ? _t("высокая важность") : _t("средняя важность")}"></i><span>${FLAGS[e.country] || ""} ${esc(e.title)}</span>${isNext ? `<em class="ce-next">${_t("далее")}</em>` : ""}</div>
      </div>
      ${hasNums ? `<div class="ce-nums">${numCell(_t("Факт"), act ? act + (vs ? " " + vs : "") : "", act ? "act" : "")}${numCell(_t("Прогноз"), e.forecast)}${numCell(_t("Было"), e.previous)}</div>` : `<div class="ce-nums"></div>`}
      ${e.result ? `<div class="ce-body">${resultBlock(e)}</div>` : ""}
    </div>`;
  }
  function renderCalendar() {
    const all = state.data.calendar || [];
    const ev = state.mode === "simple" ? all.filter((e) => e.impact === "High") : all;
    const box = $("#tab-calendar");
    if (!ev.length) { box.innerHTML = `<div class="glass card empty">${_t("На этой неделе важных событий нет")}</div>`; return; }
    const now = Date.now();
    const nextIdx = ev.findIndex((e) => new Date(e.ts) > now);
    const days = [];
    ev.forEach((e, i) => {
      const k = dayKey(e.ts);
      if (!days.length || days[days.length - 1].k !== k) days.push({ k, today: isToday(e.ts), items: [] });
      days[days.length - 1].items.push({ e, i });
    });
    let h = state.mode === "simple" ? `<p class="explain" style="margin:6px 4px 0">${_t("Показаны только самые важные события недели — в эти моменты рынок может резко двигаться. Все события — в режиме «Продвинутый».")}</p>` : "";
    for (const d of days) {
      const high = d.items.filter((x) => x.e.impact === "High").length;
      h += `<div class="day-title"><b>${d.today ? _t("Сегодня") : esc(d.k)}</b><span>${high ? `${high} ${_t("важн.")}` : ""}</span></div><div class="ce-day">`;
      for (const { e, i } of d.items) h += calRow(e, i === nextIdx);
      h += `</div>`;
    }
    h += `<p class="hint">${_t("Время московское. Календарь — ForexFactory, факт — официальные данные (календарь TradingView). Реакция рынка — измеренное изменение цены за 60 минут после события.")}</p>`;
    box.innerHTML = h;
    box.querySelectorAll(".res-src").forEach((b) => b.addEventListener("click", () => openLink(b.dataset.url)));
  }

  // ---------------------------------------------------------------- карта ликвидаций (оценка McQ Signals)
  const COINGLASS = "https://www.coinglass.com/pro/futures/LiquidationHeatMap";
  function fmtUsd(v) {
    return v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${Math.round(v / 1e6)}M` : `$${Math.round(v / 1e3)}K`;
  }
  function lpx(v) {
    const a = Math.abs(v);
    return Number(v).toLocaleString(LOCALE, { maximumFractionDigits: a >= 1000 ? 0 : a >= 10 ? 2 : a >= 1 ? 3 : 5 });
  }
  function renderLiq() {
    const box = $("#liq-box");
    if (!box) return;
    const lm = state.sig && state.sig.liqmap;
    if (!lm) { box.innerHTML = ""; return; }   // данных карты ликвидаций нет — блок не показываем
    const m = lm && lm.symbols ? lm.symbols[state.asset] : null;
    const avail = lm && lm.symbols ? Object.keys(lm.symbols) : [];
    let h = `<div class="section-title">${_t("Карта ликвидаций")} <small>${_t("оценка")}</small></div>`;
    if (!m) {
      h += `<div class="glass card empty" style="padding:18px">${avail.length ? `${_t("Для")} ${esc(state.asset)} ${_t("карты нет. Есть для:")} ${avail.map(esc).join(", ")}.` : _t("Карта появится после ближайшего обновления данных CANDEL.")}</div>`;
    } else {
      const n = m.bins.length, max = Math.max(1, ...m.long_usd, ...m.short_usd);
      let rows = "";
      let marked = false;
      for (let i = n - 1; i >= 0; i--) {
        const p = m.bins[i], above = p > m.price;
        if (!marked && !above) {
          rows += `<div class="liq-now"><span>${lpx(m.price)}</span></div>`;
          marked = true;
        }
        const v = above ? m.short_usd[i] : m.long_usd[i];
        const w = Math.max(v > 0 ? 1.5 : 0, (v / max) * 100);
        rows += `<div class="liq-row"><span class="lq-p">${i % 4 === 0 ? lpx(p) : ""}</span><span class="lq-b"><span class="lf ${above ? "sh" : "lo"}" style="width:${w}%"></span></span><span class="lq-v">${v / max > 0.25 ? fmtUsd(v) : ""}</span></div>`;
      }
      const cl = (arr) => arr.map((c) => `<span class="res-chip">${lpx(c.price)} · ${c.dist_pct > 0 ? "+" : ""}${c.dist_pct}% · ${fmtUsd(c.usd)}</span>`).join("");
      h += `<div class="glass liq">
        <div class="liq-legend"><span><i class="sh"></i>${_t("шорты — ликвидация при росте")}</span><span><i class="lo"></i>${_t("лонги — при падении")}</span></div>
        <div class="liq-ladder">${rows}</div>
        <div class="liq-sum"><b>${_t("Магниты выше")}</b><div class="res-chips">${cl(m.clusters_above) || "—"}</div>
          <b>${_t("Магниты ниже")}</b><div class="res-chips">${cl(m.clusters_below) || "—"}</div>
          <div class="liq-tot">${_t("В пределах ±5%: шорты")} ${fmtUsd(m.within5_short)} · ${_t("лонги")} ${fmtUsd(m.within5_long)}</div></div>
      </div>
      <p class="hint">${_t("Модель CANDEL: часовой открытый интерес Binance + типичные плечи 5–100x; уровни, которые цена уже прошла, убраны. Это оценка, а не реальные позиции. Позиции последних ~суток не видны (данные по")} ${esc(m.data_until || "—")}). ${_t("Крупные скопления часто работают как «магниты» для цены.")}</p>`;
    }
    h += `<button class="chip glass liq-cg">${_t("Тепловая карта на Coinglass ↗")}</button>`;
    box.innerHTML = h;
    box.querySelector(".liq-cg").addEventListener("click", () => openLink(COINGLASS));
  }

  // ---------------------------------------------------------------- графики
  function renderChartControls() {
    const custom = customAssets();
    const base = [...CHART_ORDER, ...custom.filter((c) => !CHART_ORDER.includes(c))];
    const order = base.includes(state.asset) ? base : [...base, state.asset];
    $("#chart-assets").innerHTML = order.map((a) => `<button class="chip glass ${a === state.asset ? "active" : ""}" data-a="${esc(a)}" role="tab" aria-selected="${a === state.asset}">${esc(a)}</button>`
      + (custom.includes(a) && a === state.asset ? `<button class="chip glass chip-x" data-rm="${esc(a)}" aria-label="${esc(_t("Убрать актив"))} ${esc(a)}">×</button>` : "")).join("")
      + `<button class="chip glass chip-add" id="chart-add" aria-label="${esc(_t("Добавить актив"))}">+ ${esc(_t("Актив"))}</button>`;
    { const add = $("#chart-add"); if (add) add.addEventListener("click", () => addAssetInput(add)); }
    document.querySelectorAll("#chart-assets [data-rm]").forEach((b) => b.addEventListener("click", () => {
      saveCustom(customAssets().filter((x) => x !== b.dataset.rm)); state.asset = "BTC"; haptic(); renderChartControls(); renderChart();
    }));
    const seg = $("#chart-interval");
    const idx = Math.max(0, INTERVALS.findIndex(([v]) => v === state.interval));
    seg.style.setProperty("--n", INTERVALS.length);
    seg.style.setProperty("--i", idx);
    seg.innerHTML = `<span class="thumb-glass" aria-hidden="true"></span>` + INTERVALS.map(([v, l]) => `<button class="${v === state.interval ? "active" : ""}" data-i="${v}" role="radio" aria-checked="${v === state.interval}">${l}</button>`).join("");
    document.querySelectorAll("#chart-assets .chip[data-a]").forEach((b) => b.addEventListener("click", () => { state.asset = b.dataset.a; haptic(); renderChartControls(); renderChart(); }));
    renderLiq();
    document.querySelectorAll("#chart-interval button").forEach((b) => b.addEventListener("click", () => { state.interval = b.dataset.i; haptic(); renderChartControls(); renderChart(); }));
  }

  // свой актив: поле прямо в ряду чипов (window.prompt в Telegram работает не везде)
  function addAssetInput(btn) {
    const wrap = document.createElement("span");
    wrap.className = "chip-in";
    wrap.innerHTML = `<input maxlength="24" autocapitalize="characters" autocomplete="off" spellcheck="false" enterkeyhint="go" placeholder="SOL · NASDAQ:AAPL" aria-label="${esc(_t("Тикер актива"))}"><small>${esc(_t("Крипта — тикер (SOL). Акции, валюты и прочее — биржа:тикер (NASDAQ:AAPL, FX:EURUSD)."))}</small>`;
    btn.replaceWith(wrap);
    const inp = wrap.querySelector("input");
    inp.focus();
    let done = false;
    const go = () => {
      if (done) return; done = true;
      const v = inp.value.trim().toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9:._!-]/g, "");
      if (v) {
        const list = customAssets().filter((x) => x !== v);
        if (!CHART_ORDER.includes(v)) { list.push(v); saveCustom(list.slice(-12)); }
        state.asset = v;
        renderChartControls(); renderChart();
      } else renderChartControls();
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } if (e.key === "Escape") { inp.value = ""; go(); } });
    inp.addEventListener("blur", go);
  }

  let tvLoading = null;
  function loadTV() {
    if (window.TradingView) return Promise.resolve();
    if (!tvLoading) {
      tvLoading = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "https://s3.tradingview.com/tv.js";
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    return tvLoading;
  }

  function isDark() { return true; }  // фирменный стиль — всегда тёмный

  async function renderChart() {
    const key = `${state.asset}|${state.interval}|${state.rsi}|${isDark()}`;
    if (key === state.chartKey) return;
    state.chartKey = key;
    const box = $("#tv-chart");
    box.innerHTML = `<div class="empty">${_t("Загрузка графика…")}</div>`;
    try { await loadTV(); } catch (e) {
      box.innerHTML = `<div class="empty">${_t("Не удалось загрузить TradingView. Проверь соединение.")}</div>`;
      state.chartKey = "";
      return;
    }
    box.innerHTML = "";
    const dark = isDark();
    /* global TradingView */
    new TradingView.widget({
      container_id: "tv-chart",
      autosize: true,
      symbol: tvSymbol(state.asset),
      interval: state.interval,
      timezone: TZ,
      theme: dark ? "dark" : "light",
      style: "1",
      locale: I18.tv,
      enable_publishing: false,
      hide_side_toolbar: false,           // базовые инструменты рисования TradingView слева
      hide_legend: true,                  // без плашки с названием актива поверх графика
      hide_top_toolbar: false,
      allow_symbol_change: true,          // поиск любого инструмента прямо в графике
      withdateranges: false,
      save_image: false,
      studies: state.rsi ? ["RSI@tv-basicstudies"] : [],
      backgroundColor: "#0D0F13",
      gridColor: "rgba(255,255,255,0.05)",
    });
  }

  // график на весь экран: системный полноэкранный режим, где он есть; иначе — на всё окно приложения
  function chartFS(force) {
    const box = $("#chart-box");
    if (!box) return;
    const on = force != null ? force : !box.classList.contains("fs");
    box.classList.toggle("fs", on);
    document.documentElement.classList.toggle("chart-fs", on);
    const btn = $("#chart-fs");
    if (btn) { btn.setAttribute("aria-label", on ? _t("Свернуть") : _t("На весь экран")); btn.innerHTML = on
      ? '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
    try {
      const req = box.requestFullscreen || box.webkitRequestFullscreen, fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (on && !fsEl && req && !inTGApp()) { const r = req.call(box); if (r && r.catch) r.catch(() => { /* остаётся режим на всё окно */ }); }
      else if (!on && fsEl) { const ex = document.exitFullscreen || document.webkitExitFullscreen; const r = ex && ex.call(document); if (r && r.catch) r.catch(() => { /* noop */ }); }
    } catch (e) { /* noop */ }
    haptic();
  }
  function inTGApp() { return !!(tg && tg.initData); }
  ["fullscreenchange", "webkitfullscreenchange"].forEach((ev) => document.addEventListener(ev, () => {
    const box = $("#chart-box");
    if (box && box.classList.contains("fs") && !(document.fullscreenElement || document.webkitFullscreenElement)) chartFS(false);
  }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.documentElement.classList.contains("chart-fs")) chartFS(false); });
  { const b = $("#chart-fs"); if (b) b.addEventListener("click", () => chartFS()); }

  // ---------------------------------------------------------------- навигация
  function switchTab(name) {
    if (document.documentElement.classList.contains("chart-fs")) chartFS(false);
    state.tab = name;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
    const btns = [...document.querySelectorAll(".nav-btn")];
    btns.forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on);
    });
    $("#tabbar").style.setProperty("--i", Math.max(0, btns.findIndex((b) => b.dataset.tab === name)));
    window.scrollTo(0, 0);
    if (name === "charts") { renderChartControls(); renderChart(); }
    haptic();
  }

  document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.tab) switchTab(b.dataset.tab);
    else if (b.dataset.open === "journal" && window.Journal) { haptic(); window.Journal.open(); }
  }));

  // ---------------------------------------------------------------- язык
  const langBtn = $("#lang-btn"), langMenu = $("#lang-menu");
  $("#lang-code").textContent = (I18.langs[I18.lang] || {}).short || "RU";
  langMenu.innerHTML = Object.entries(I18.langs).map(([k, v]) =>
    `<button role="option" aria-selected="${k === I18.lang}" class="${k === I18.lang ? "on" : ""}" data-l="${k}"><span>${v.name}</span><b>${v.short}</b></button>`).join("");
  function closeLang() { langMenu.classList.remove("show"); langBtn.setAttribute("aria-expanded", "false"); setTimeout(() => { if (!langMenu.classList.contains("show")) langMenu.hidden = true; }, 250); }
  langBtn.addEventListener("click", (e) => {
    e.stopPropagation(); haptic();
    if (langMenu.classList.contains("show")) return closeLang();
    const r = langBtn.getBoundingClientRect();
    langMenu.style.top = `${r.bottom + 8}px`;
    langMenu.style.right = `${Math.max(12, window.innerWidth - r.right)}px`;
    langMenu.hidden = false;
    requestAnimationFrame(() => langMenu.classList.add("show"));
    langBtn.setAttribute("aria-expanded", "true");
  });
  langMenu.querySelectorAll("[data-l]").forEach((b) => b.addEventListener("click", () => {
    haptic();
    if (b.dataset.l === I18.lang) return closeLang();
    // красиво: перезагрузка через прелоадер (если его нет — просто перезагружаемся)
    const pre = document.getElementById("preloader");
    if (pre) { pre.hidden = false; requestAnimationFrame(() => pre.classList.remove("done")); }
    setTimeout(() => I18.setLang(b.dataset.l), 250);
  }));
  document.addEventListener("click", (e) => { if (!langMenu.hidden && !langMenu.contains(e.target)) closeLang(); });

  const MODE_CAP = { simple: _t("Главное простыми словами: куда идёт рынок и почему"), pro: _t("Все инструменты: RSI, страх и жадность, карта ликвидаций") };
  function applyMode() {
    document.documentElement.dataset.mode = state.mode;
    const seg = $("#mode");
    seg.style.setProperty("--i", state.mode === "pro" ? 1 : 0);
    seg.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.m === state.mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on);
    });
    $("#mode-cap").textContent = MODE_CAP[state.mode];
  }
  let toastT = null;
  function toast(html) {
    const el = $("#toast");
    el.innerHTML = html;
    el.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => el.classList.remove("show"), 3200);
  }
  function setMode(m, quiet) {
    try { localStorage.setItem("amq-mode", m); } catch (e) { /* noop */ }
    if (window.AUTH && window.AUTH.saveSettings) window.AUTH.saveSettings();
    if (state.mode === m && quiet) { applyMode(); return; }
    state.mode = m;
    applyMode();
    haptic();
    if (state.data) { renderOverview(); renderNews(); renderCalendar(); }
    if (state.tab === "charts") renderLiq();
    if (!quiet) toast(m === "pro"
      ? _t("<b>Продвинутый</b> · добавлены RSI, страх и жадность и карта ликвидаций")
      : _t("<b>Новичок</b> · только главное и подсказки"));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  $("#mode").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { if (state.mode !== b.dataset.m) setMode(b.dataset.m); }));
  applyMode();
  // первый вход: спрашиваем опыт
  if (!modeChosen) {
    const onb = $("#onb");
    onb.hidden = false;
    requestAnimationFrame(() => onb.classList.add("show"));
    onb.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => {
      onb.classList.remove("show");
      setTimeout(() => { onb.hidden = true; }, 350);
      setMode(b.dataset.m, true);
    }));
  }
  $("#refresh").addEventListener("click", () => { haptic(); load(true); loadSignals(); });
  $("#chart-rsi").addEventListener("change", (e) => { state.rsi = e.target.checked; renderChart(); });

  function applyTheme() {
    document.documentElement.dataset.theme = "dark";
    const base = "#000000";
    document.querySelector('meta[name="theme-color"]').setAttribute("content", base);
    if (tg) {
      try { tg.setHeaderColor(base); tg.setBackgroundColor(base); tg.setBottomBarColor && tg.setBottomBarColor(base); } catch (e) { /* старые клиенты */ }
    }
  }

  const top = $("#top");
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { top.classList.toggle("scrolled", window.scrollY > 150); ticking = false; });
  }, { passive: true });

  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) { /* noop */ }
    tg.onEvent("themeChanged", applyTheme);
  }
  applyTheme();
  function renderSessions() {
    try { window.MarketSessions && window.MarketSessions.render(document.getElementById("sessions")); }
    catch (e) { const el = document.getElementById("sessions"); if (el) el.innerHTML = ""; }
  }

  // ---------------------------------------------------------------- приложение на телефон (PWA) и пуши
  const CFG = window.APP_CONFIG || {};
  const inTG = !!(tg && tg.initData);
  const standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const appDir = location.pathname.replace(/[^/]*$/, "");          // /marketnews999/
  const appUrl = location.origin + appDir;
  let installEvt = null;
  const LS = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* noop */ } } };

  if (!inTG && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js", { scope: appDir }).catch(() => { /* без офлайна */ });
  }
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; renderPromo(); });
  window.addEventListener("appinstalled", () => { installEvt = null; LS.set("amq-installed", "1"); renderPromo(); });

  let pushState = "loading";  // loading | off | on | denied | unsupported | need-install
  function initPush() {
    if (inTG || !CFG.onesignal || !("Notification" in window)) { pushState = "unsupported"; return; }
    if (isIOS && !standalone) { pushState = "need-install"; return; }
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    // если SDK не загрузился за 12 с — всё равно даём кнопку: разрешение спросим напрямую у браузера
    setTimeout(() => { if (pushState === "loading") { pushState = Notification.permission === "granted" ? "on" : Notification.permission === "denied" ? "denied" : "off"; renderPromo(); } }, 12000);
    const sc = document.createElement("script");
    sc.src = "https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js";
    sc.defer = true;
    document.head.appendChild(sc);
    window.OneSignalDeferred.push(async (OneSignal) => {
      try {
        await OneSignal.init({ appId: CFG.onesignal, serviceWorkerPath: appDir.slice(1) + "sw.js",
          serviceWorkerParam: { scope: appDir }, notifyButton: { enable: false }, autoResubscribe: true });
        try { OneSignal.User.setLanguage(I18.lang); } catch (e) { /* старый SDK */ }
        const sync = () => {
          const on = OneSignal.User.PushSubscription.optedIn;
          pushState = on ? "on" : (Notification.permission === "denied" ? "denied" : "off");
          renderPromo();
        };
        OneSignal.User.PushSubscription.addEventListener("change", sync);
        sync();
        window.__os = OneSignal;
        // персональные пуши: связываем подписку с аккаунтом
        if (window.AUTH && window.AUTH.enabled) window.AUTH.onUser((u) => { try { OneSignal.login(u.id); } catch (e) { /* noop */ } });
      } catch (e) { console.warn("OneSignal init", e); pushState = "unsupported"; renderPromo(); }
    });
  }
  async function enablePush(btn) {
    haptic();
    if (Notification.permission === "denied") {
      toast(isIOS ? _t("Уведомления запрещены. Включи их: Настройки iPhone → Уведомления → CANDEL.") : _t("Уведомления запрещены в браузере. Разреши их в настройках сайта (значок замка в адресной строке)."));
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    const OS = window.__os;
    try {
      if (OS) {
        // запрос разрешения — сразу по нажатию (iOS принимает его только так)
        await OS.Notifications.requestPermission();
        await OS.User.PushSubscription.optIn();
        try { OS.User.addTags({ lang: I18.lang, mode: state.mode }); } catch (e) { /* noop */ }
      } else {
        // SDK ещё не готов — спрашиваем браузер напрямую, подписку OneSignal оформит при загрузке (autoResubscribe)
        const p = await Notification.requestPermission();
        if (p === "granted") pushState = "on";
      }
    } catch (e) { /* пользователь отказал */ }
    const perm = Notification.permission;
    if (perm === "granted") { pushState = "on"; toast(_t("Уведомления включены ✓")); }
    else if (perm === "denied") { pushState = "denied"; }
    renderPromo();
  }

  function renderPromo() {
    const box = $("#app-promo");
    if (!box) return;
    let h = "";
    if (inTG) {
      // в Telegram: предложить поставить приложение на телефон (с пушами)
      if (!LS.get("amq-promo-tg")) {
        h = `<div class="promo glass"><span class="promo-ic"><img src="icons/icon-192.png" alt=""></span>
          <div class="promo-t"><b>${_t("CANDEL на телефоне")}</b><span>${_t("Отдельное приложение с пуш-уведомлениями о важных событиях.")}</span></div>
          <button class="promo-btn" data-act="open">${_t("Установить")}</button><button class="promo-x" data-act="hide-tg" aria-label="×">×</button></div>`;
      }
    } else if (!standalone && !LS.get("amq-promo-install")) {
      const how = isIOS ? _t("Нажми «Поделиться» внизу Safari → «На экран «Домой»».") : _t("Добавь на главный экран — откроется как обычное приложение.");
      h = `<div class="promo glass"><span class="promo-ic"><img src="icons/icon-192.png" alt=""></span>
        <div class="promo-t"><b>${_t("Установи приложение")}</b><span>${how}</span></div>
        ${installEvt ? `<button class="promo-btn" data-act="install">${_t("Установить")}</button>` : ""}
        <button class="promo-x" data-act="hide-install" aria-label="×">×</button></div>`;
    }
    if (!inTG && (pushState === "off") && !LS.get("amq-promo-push")) {
      h += `<div class="promo glass"><span class="promo-ic bell"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></span>
        <div class="promo-t"><b>${_t("Уведомления")}</b><span>${_t("Важные события и утренний план — сразу на телефон.")}</span></div>
        <button class="promo-btn" data-act="push">${_t("Включить")}</button><button class="promo-x" data-act="hide-push" aria-label="×">×</button></div>`;
    }
    box.innerHTML = h;
    box.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
      const a = b.dataset.act;
      if (a === "open") { installSheet(); return; }
      else if (a === "install" && installEvt) { installEvt.prompt(); try { await installEvt.userChoice; } catch (e) { /* noop */ } installEvt = null; }
      else if (a === "push") await enablePush(b);
      else if (a.startsWith("hide-")) LS.set("amq-promo-" + a.slice(5), "1");
      renderPromo();
    }));
  }

  // Установка из Telegram. Встроенный браузер Telegram не умеет «На экран Домой», поэтому показываем шаги:
  // открыть ссылку в Safari / Chrome (или скопировать её) и добавить приложение на главный экран.
  function installSheet() {
    const url = (CFG.appUrl || appUrl).replace(/\/?$/, "/") + "?install=1";
    const ios = isIOS || (tg && tg.platform === "ios");
    let el = $("#inst");
    if (!el) { el = document.createElement("div"); el.id = "inst"; el.className = "inst"; document.body.appendChild(el); }
    const steps = ios
      ? [_t("Скопируй ссылку или нажми «Открыть»."), _t("Открой её в Safari (в браузере Telegram установка недоступна)."), _t("В Safari нажми «Поделиться» → «На экран «Домой»».")]
      : [_t("Нажми «Открыть» — ссылка откроется в браузере."), _t("В Chrome нажми ⋮ → «Установить приложение» (или «Добавить на главный экран»).")];
    el.innerHTML = `<div class="inst-bg" data-i="close"></div><div class="inst-card glass" role="dialog" aria-modal="true">
        <button class="inst-x" data-i="close" aria-label="×">×</button>
        <b class="inst-h">${_t("Установи CANDEL на телефон")}</b>
        <ol>${steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
        <div class="inst-url">${esc(url.replace(/^https:\/\//, ""))}</div>
        <button class="inst-btn" data-i="copy">${_t("Скопировать ссылку")}</button>
        <button class="inst-btn alt" data-i="open">${_t("Открыть")}</button>
        <small class="inst-dbg">${esc(`tg ${tg ? tg.version : "-"} · ${tg ? tg.platform : "-"}`)}</small>
      </div>`;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("show"));
    const dbg = el.querySelector(".inst-dbg");
    const close = () => { el.classList.remove("show"); setTimeout(() => { el.hidden = true; }, 200); };
    el.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", async () => {
      const k = b.dataset.i;
      if (k === "close") return close();
      if (k === "copy") {
        let ok = false;
        try { await navigator.clipboard.writeText(url); ok = true; } catch (e) {
          try { const ta = document.createElement("textarea"); ta.value = url; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;opacity:0";
            document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, url.length); ok = document.execCommand("copy"); ta.remove(); } catch (e2) { /* noop */ }
        }
        b.textContent = ok ? _t("Ссылка скопирована ✓") : _t("Не получилось — выдели адрес выше и скопируй");
        if (!ok) { const u = el.querySelector(".inst-url"); const r = document.createRange(); r.selectNodeContents(u); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
        try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred(ok ? "success" : "warning"); } catch (e) { /* noop */ }
      }
      if (k === "open") {
        try {
          if (tg && tg.openLink) tg.openLink(url, ios ? undefined : { try_browser: "chrome" });
          else window.open(url, "_blank", "noopener");
          dbg.textContent += " · open ok";
        } catch (e) { dbg.textContent += " · " + (e && e.message ? e.message : e); }
      }
    }));
  }

  // переход по ссылке из пуша: …/#signals, #news, #calendar, #charts
  function routeHash() {
    const h = (location.hash || "").replace("#", "");
    if (["overview", "news", "charts", "calendar"].includes(h)) switchTab(h);
    if (h === "prochart" && window.ProChart) { switchTab("charts"); window.ProChart.open(); }
    if ((h === "journal" || h === "signals") && window.Journal) window.Journal.open();
  }
  // Pro Chart: кнопка во вкладке «Графики»
  const pcBtn = $("#pc-open");
  if (pcBtn) pcBtn.addEventListener("click", () => {
    const crypto = !["S&P 500", "Nasdaq", "Gold", "Brent", "DXY", "US10Y", "VIX", "BTC.D"].includes(state.asset) && !String(state.asset).includes(":");
    if (window.ProChart) window.ProChart.open({ symbol: crypto ? state.asset : "BTC" });
  });
  window.McQ = { sig: () => null, mode: () => state.mode, setMode: (m) => setMode(m), data: () => state.data, toast: (m) => toast(esc(m)) };
  window.addEventListener("hashchange", routeHash);

  mountDominance();
  initPush();
  renderPromo();
  routeHash();
  load(false);
  loadSignals();
  loadLive();
  loadGlobal();
  setInterval(loadLive, 20 * 1000);
  setInterval(loadGlobal, 60 * 1000);
  setInterval(() => load(false), 5 * 60 * 1000);
  setInterval(() => loadSignals(), 2 * 60 * 1000);
  setInterval(() => { if (state.tab === "overview") renderSessions(); }, 30 * 1000);
})();
