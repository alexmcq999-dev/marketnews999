/* McQCryptoNews — Telegram Mini App */
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
  // прелоадер: показываем минимум 1.2 с (чтобы логотип успел «вдохнуть»), максимум 7 с
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
    }, Math.max(0, 1200 - (Date.now() - T0)));
  }
  setTimeout(hidePreloader, 7000);
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
  const tvSymbol = (a) => TV[a] || `BINANCE:${String(a).toUpperCase()}USDT`;

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
        $("#ov-main").innerHTML = `<div class="glass card empty">${_t("Данные ещё не опубликованы.")}<br>${_t("Запусти workflow в GitHub Actions и открой приложение снова.")}</div><div class="section-title">${_t("Торговые сессии")}</div><div id="sessions"></div>`;
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
        renderSignals();
        if (state.tab === "charts") renderLiq();
        return;
      } catch (e) { /* пробуем следующий источник */ }
    }
    if (!state.sig) renderSignals();
  }

  function renderAll() {
    renderOverview();
    renderSignals();
    renderNews();
    renderCalendar();
    renderChartControls();
    if (state.tab === "charts") renderChart();
  }

  // ---------------------------------------------------------------- обзор
  // ---------------------------------------------------------------- пульс: BTC онлайн, страх/жадность, общий фон
  function renderPulse() {
    const d = state.data || {};
    const box = $("#ov-pulse");
    const m = (d.markets || []).find((x) => x.name === "BTC") || {};
    const live = state.live.BTC;
    const price = live ? live.price : m.price, ch = live ? live.chg : m.chg;
    const f = ((d.sentiment || {}).fng || {}).crypto;
    let h = `<div class="pulse-grid">
      <button class="tile glass pressable" data-asset="BTC" aria-label="${_t("Биткоин, открыть график")}">
        <div class="k">${_t("Биткоин")}</div>
        <div class="v">${price != null ? "$" + fmtNum(price, 0) : "—"}</div>
        <div class="s">${chg(ch) || "&nbsp;"} <span class="pro-only">${_t("за 24ч")}</span></div>
      </button>
      <div class="tile glass" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${f ? f.value : ""}">
        <div class="k">${_t("Настроение")}</div>
        <div class="v">${f ? f.value : "—"}<small style="font-size:14px;color:var(--text-3);font-weight:600"> /100</small></div>
        <div class="s">${f ? esc(_t(f.rating_ru)) : _t("нет данных")}</div>
        <div class="bar"><i style="width:${f ? Math.max(3, Math.min(100, f.value)) : 0}%"></i></div>
      </div>
    </div>
    <p class="explain simple-only">${_t("Настроение — индекс страха и жадности:")} <b>0–25</b> ${_t("паника,")} <b>75–100</b> ${_t("эйфория. На крайностях рынок часто разворачивается.")}</p>`;
    let mh = "";
    // текст «Что происходит» бот пишет по-русски; на других языках показываем только если есть перевод
    const mi = d.mood_i18n || {};
    const mood = I18.lang === "ru" ? d.mood : mi[I18.lang] || mi.en || "";
    if (mood) {
      mh += `<div class="mood glass" style="margin-top:12px"><div class="label"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15.5 8.5-2 5-5 2 2-5z" fill="currentColor"/></svg>${_t("Что происходит")}${d.news_updated ? " · " + fmtTime(d.news_updated, !isToday(d.news_updated)) : ""}</div><p>${esc(mood)}</p></div>`;
    }
    box.innerHTML = h;
    $("#ov-mood").innerHTML = mh;
    box.querySelectorAll(".tile[data-asset]").forEach((b) => b.addEventListener("click", () => { state.asset = b.dataset.asset; switchTab("charts"); }));
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
    const parts = [["BTC", btc, "#ffffff"], ["ETH", eth, "#9e9e9e"], [_t("Стейблы"), st, "#5c5c5c"], [_t("Остальные"), oth, "#2e2e2e"]];
    box.innerHTML = `<div class="pro-only">
      <div class="dom-split">${parts.map(([, v, c]) => `<i style="width:${v.toFixed(2)}%;background:${c}"></i>`).join("")}</div>
      <div class="dom-legend">${parts.map(([n, v, c]) => `<span style="--c:${c}">${n} ${v.toFixed(1)}%</span>`).join("")}</div>
      <p class="hint" style="margin:6px 0 0">${_t("Структура всего рынка (")}${Math.round(g.active_cryptocurrencies || 0).toLocaleString(LOCALE)} ${_t("монет, CoinGecko). TradingView считает доминацию по топ-125 монетам — поэтому цифра выше.")}</p>
    </div>`;
  }

  function renderOverview() {
    renderPulse();
    const d = state.data;
    const s = d.sentiment || {};
    let h = "";


    h += `<div class="section-title">${_t("Торговые сессии")}</div><div id="sessions"></div>`;

    if ((d.markets || []).length) {
      h += `<div class="section-title">${_t("Рынки")} <small class="simple-only">${_t("нажми — откроется график")}</small></div><div class="quotes">`;
      for (const m of d.markets) {
        h += `<button class="quote glass pressable ${trendClass(m.chg)}" data-asset="${esc(m.name)}" aria-label="${_t("Открыть график")} ${esc(m.name)}">
          <span class="glow"></span><span class="n">${esc(m.name)}</span><span class="p">${fmtNum(m.price, m.dec)}</span>${chg(m.chg)}</button>`;
      }
      h += `</div>`;
    }

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
      h += `<div class="section-title">${_t("Итоги событий")}</div><div class="glass list">`;
      h += done.map((e) => `<div class="ev past-res"><span class="time">${fmtTime(e.ts)}</span><span class="title">${FLAGS[e.country] || ""} ${esc(e.title)}${e.actual ? ` — <b>${esc(e.actual)}</b>${e.forecast ? ` <small>${_t("(прогноз")} ${esc(e.forecast)})</small>` : ""}` : ""}</span>${resultBlock(e)}</div>`).join("");
      h += `</div>`;
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

  // ---------------------------------------------------------------- сигналы
  function fmtPrice(v) {
    if (v == null || isNaN(v)) return "—";
    const a = Math.abs(v);
    const dec = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
    return Number(v).toLocaleString(LOCALE, { maximumFractionDigits: dec });
  }
  function rCls(v) { return v > 0.001 ? "up" : v < -0.001 ? "down" : ""; }
  function fmtR(v) { return v == null || isNaN(v) ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(2)}R`; }

  // ---------------------------------------------------------------- сигналы: две подачи — для новичка и для продвинутого
  const pct = (a, b) => (b / a - 1) * 100;
  const fmtPct = (v, dec = 1) => (v == null || isNaN(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dec)}%`);
  const sideWord = (t) => (t.side === "LONG" ? _t("Покупка") : _t("Продажа"));
  const EXIT_NB = { sl: _t("сработал стоп"), tp2: _t("цель 2"), be: _t("в ноль после цели"), trail: _t("прибыль зафиксирована"), timeout: _t("закрыта по времени") };

  // шкала «стоп → цель» с текущей ценой: понятна без слов
  function levelBar(t) {
    const span = t.tp1 - t.sl;
    if (!span || t.price == null) return "";
    const x = (p) => Math.max(0, Math.min(100, ((p - t.sl) / span) * 100));
    const pe = x(t.entry), pp = x(t.price);
    const good = (t.price - t.entry) * (t.side === "LONG" ? 1 : -1) >= 0;
    return `<div class="lbar" aria-hidden="true">
      <span class="lb-track">${t.status === "pending" ? "" : `<span class="lb-fill ${good ? "up" : "down"}" style="left:${Math.min(pe, pp)}%;width:${Math.abs(pp - pe)}%"></span>`}
        <span class="lb-entry" style="left:${pe}%"></span><span class="lb-now" style="left:${pp}%"></span></span>
      <span class="lb-labels"><span>${_t("стоп")}</span><span>${_t("цель")}</span></span>
    </div>`;
  }

  function nbCard(t, riskPct) {
    const move = t.price != null ? pct(t.entry, t.price) * (t.side === "LONG" ? 1 : -1) : null;
    const status = t.status === "pending" ? `<span class="nb-st wait">${_t("ждёт цену входа")}</span>`
      : t.status === "tp1" ? `<span class="nb-st up">${_t("цель взята ✓")}</span>`
      : move == null ? "" : `<span class="nb-st ${move >= 0 ? "up" : "down"}">${move >= 0 ? _t("в плюсе") : _t("в минусе")} ${fmtPct(Math.abs(move))}</span>`;
    const ex = 10, tpR = (state.sig.exit || {}).tp1_r || 1.5;
    return `<article class="sig-card nb glass pressable" data-sym="${esc(t.symbol)}" aria-label="${sideWord(t)} ${esc(t.symbol)}, ${_t("открыть график")}">
      <div class="nb-head"><span class="dir ${esc(t.side)}">${t.side === "LONG" ? "↑" : "↓"} ${sideWord(t)}</span><span class="nb-sym">${esc(t.symbol)}</span>${status}</div>
      ${levelBar(t)}
      <ol class="nb-steps">
        <li><i>1</i><span>${t.status === "pending" ? _t("Войти, когда цена дойдёт до") : _t("Вход")}</span><b>${fmtPrice(t.entry)}</b></li>
        <li><i>2</i><span>${_t("Защитный стоп")}</span><b class="down">${fmtPrice(t.sl)} <small>${fmtPct(pct(t.entry, t.sl))}</small></b></li>
        <li><i>3</i><span>${_t("Цель")}</span><b class="up">${fmtPrice(t.tp1)} <small>${fmtPct(pct(t.entry, t.tp1))}</small></b></li>
      </ol>
      <div class="nb-money">${_t("Пример: рискуешь")} <b>$${ex}</b> → ${_t("на цели")} <b class="up">+$${(ex * tpR).toFixed(0)}</b>, ${_t("на стопе")} <b class="down">−$${ex}</b></div>
    </article>`;
  }

  function proCard(t, riskPct) {
    const conf = Math.max(0, Math.min(100, t.conf || 0));
    const slp = Math.abs(pct(t.entry, t.sl));
    const size = slp ? (riskPct / slp) * 100 : null;
    return `<article class="sig-card pr glass pressable" data-sym="${esc(t.symbol)}" aria-label="${esc(t.side)} ${esc(t.symbol)}, ${_t("открыть график")}">
      <div class="sig-top">
        <span class="side ${esc(t.side)}">${esc(t.side)}</span>
        <span class="sig-sym">${esc(t.symbol)}</span><span class="pr-id">#${esc(t.id)}</span>
        ${t.kind === "breakout" ? `<span class="badge bo">${_t("пробой")}</span>` : ""}
        ${t.status === "pending" ? `<span class="badge pend">${_t("лимит")}</span>` : ""}
        ${t.status === "tp1" ? `<span class="badge tp">TP1 ✓ · ${_t("стоп б/у")}</span>` : ""}
        <span class="sig-r"><span class="r ${rCls(t.r_open)}">${fmtR(t.r_open)}</span><small>${ago(t.opened)}</small></span>
      </div>
      <div class="pr-grid">
        <div><span>${t.status === "pending" ? _t("Лимит") : _t("Вход")}</span><b>${fmtPrice(t.entry)}</b></div>
        <div><span>${_t("Стоп")}</span><b class="down">${fmtPrice(t.sl)}</b><em>${fmtPct(pct(t.entry, t.sl), 2)}</em></div>
        <div><span>TP1 · ${(state.sig.exit || {}).tp1_r || 1.5}R</span><b class="up">${fmtPrice(t.tp1)}</b><em>${fmtPct(pct(t.entry, t.tp1), 2)}</em></div>
        <div><span>${_t("Цена")}</span><b>${fmtPrice(t.price)}</b><em>${t.price != null ? fmtPct(pct(t.entry, t.price), 2) : ""}</em></div>
        <div><span>${_t("Позиция")}</span><b>${size ? size.toFixed(0) + "%" : "—"}</b><em>${_t("депо · риск")} ${riskPct}%</em></div>
        <div><span>${_t("Режим")}</span><b>${esc({ trend: _t("тренд"), range: _t("флэт"), neutral: _t("переходный") }[t.regime] || t.regime || "—")}</b><em>${fmtTime(t.opened, true)}</em></div>
      </div>
      <div class="conf"><span>${_t("Сила")}</span><span class="track"><span class="fill" style="width:${conf}%"></span></span><b>${Math.round(conf)}</b></div>
      ${(t.reasons || []).length ? `<div class="reasons">${t.reasons.map((x) => esc(_t(x))).join(" · ")}</div>` : ""}
      <div class="pr-exit">${_t("После TP1: 50% закрыть, стоп в б/у, остаток — трейлинг")} ${(state.sig.exit || {}).trail_atr || 3}×ATR</div>
    </article>`;
  }

  function renderSignals() {
    const box = $("#tab-signals");
    if (!box) return;
    const d = state.sig;
    if (!d) {
      box.innerHTML = `<div class="glass card empty">${_t("Загружаю сигналы…")}<br><small>${_t("Если долго пусто — бот ещё не опубликовал данные.")}</small></div>`;
      return;
    }
    const nb = state.mode === "simple";
    const riskPct = d.risk_pct || 0.5;
    const tf = d.timeframes || {};
    let h = "";
    if (d.test_mode) {
      h += `<div class="test-banner"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style="flex:none;margin-top:1px"><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><div><b>${_t("Тестовый режим")}</b>${_t("Сигналы публикуются для проверки стратегии на живом рынке. Не используй их для реальной торговли.")}</div></div>`;
    }
    if (nb) {
      h += `<div class="nb-intro glass"><div class="nb-intro-t">${_t("Как это работает")}</div>
        <div class="nb-how"><span><i>1</i>${_t("Бот сам ищет сделку по тренду")}</span><span><i>2</i>${_t("Даёт вход, стоп и цель")}</span><span><i>3</i>${_t("Сообщает, когда цель или стоп сработали")}</span></div>
        <p class="explain">${_t("Стоп ограничивает убыток, цель — первая фиксация прибыли. Больше одной сделки за раз — не больше")} ${riskPct}% ${_t("депозита риска на каждую.")}</p></div>`;
    } else {
      h += `<div class="sig-head glass"><div class="k">McQ Signals · ${_t("стратегия")}</div>
        <div class="t">${esc((tf.entry || "").toUpperCase())} ${_t("вход +")} ${esc((tf.confirm || "").toUpperCase())} ${_t("тренд + BTC фильтр")}</div>
        <div class="s">${d.coins || "—"} ${_t("монет ≥ $100M ·")} ${esc(d.provider || "")} · ${_t("выход: TP1")} ${(d.exit || {}).tp1_r || 1.5}R + ${_t("трейлинг")} ${(d.exit || {}).trail_atr || 3}×ATR · ${_t("обновлено")} ${ago(d.updated)}</div>
        ${d.blackout ? `<div class="blackout">⏸ ${_t("Пауза новых сигналов:")} ${esc(d.blackout.title)} ${_t("в")} ${fmtTime(d.blackout.ts)}</div>` : ""}
      </div>`;
    }
    if (nb && d.blackout) h += `<div class="glass card" style="margin-top:10px">⏸ ${_t("Сейчас важная новость (")}${esc(d.blackout.title)}) — ${_t("бот временно не даёт новых сделок.")}</div>`;

    // результаты
    const P = [["d7", _t("7 дней")], ["d30", _t("30 дней")], ["all", _t("Всё время")]];
    const idx = Math.max(0, P.findIndex(([k]) => k === state.sigPeriod));
    const st = (d.stats || {})[state.sigPeriod] || {};
    h += `<div class="section-title">${nb ? _t("Результаты") : _t("Статистика")}</div>`;
    h += `<div class="segmented glass stat-seg" id="sig-period" style="--n:3;--i:${idx}"><span class="thumb-glass" aria-hidden="true"></span>${P.map(([k, l]) => `<button class="${k === state.sigPeriod ? "active" : ""}" data-p="${k}" role="radio" aria-checked="${k === state.sigPeriod}">${l}</button>`).join("")}</div>`;
    if (!st.n) {
      h += `<div class="glass card empty" style="padding:18px">${_t("За этот период закрытых сигналов нет")}</div>`;
    } else if (nb) {
      const wins = Math.round((st.n * st.winrate) / 100), dep = st.total_r * riskPct;
      h += `<div class="nb-result glass">
        <div class="nb-big ${rCls(dep)}">${fmtPct(dep)}</div><div class="nb-big-l">${_t("к депозиту при риске")} ${riskPct}% ${_t("на сделку")}</div>
        <div class="nb-dots" aria-label="${wins} ${_t("из")} ${st.n} ${_t("сделок в плюсе")}">${Array.from({ length: Math.min(st.n, 40) }, (_, i) => `<i class="${i < Math.round(wins * Math.min(st.n, 40) / st.n) ? "w" : ""}"></i>`).join("")}</div>
        <div class="nb-big-l">${st.n} ${st.n % 10 === 1 && st.n % 100 !== 11 ? _t("сделка") : st.n % 10 >= 2 && st.n % 10 <= 4 && (st.n % 100 < 10 || st.n % 100 >= 20) ? _t("сделки") : _t("сделок")}, ${_t("в плюс —")} ${wins}</div>
      </div>`;
    } else {
      const be = st.by_exit || {};
      h += `<div class="stat-grid six">
        <div class="stat glass"><div class="v">${st.n}</div><div class="l">${_t("сделок")}</div></div>
        <div class="stat glass"><div class="v">${Math.round(st.winrate)}%</div><div class="l">winrate</div></div>
        <div class="stat glass"><div class="v ${rCls(st.total_r)}">${fmtR(st.total_r)}</div><div class="l">${_t("итого")}</div></div>
        <div class="stat glass"><div class="v ${rCls(st.avg_r)}">${fmtR(st.avg_r)}</div><div class="l">${_t("ср. на сделку")}</div></div>
        <div class="stat glass"><div class="v">${st.pf == null ? "∞" : Number(st.pf).toFixed(2)}</div><div class="l">profit factor</div></div>
        <div class="stat glass"><div class="v">${st.max_dd != null ? "−" + Number(st.max_dd).toFixed(1) + "R" : "—"}</div><div class="l">${_t("макс. просадка")}</div></div>
      </div>
      <div class="pr-exits">${Object.entries(be).map(([k, v]) => `<span>${esc(EXIT[k] || k)} <b>${v}</b></span>`).join("")}</div>`;
    }

    // открытые
    const open = d.open || [];
    h += `<div class="section-title">${nb ? _t("Сделки сейчас") : _t("Открытые")} <small>${open.length}</small></div>`;
    if (!open.length) h += `<div class="glass card empty" style="padding:18px">${nb ? _t("Сейчас подходящих сделок нет. Бот не торгует, когда нет понятного тренда — это нормально.") : _t("Открытых сигналов нет — бот ждёт сетап")}</div>`;
    for (const t of open) h += nb ? nbCard(t, riskPct) : proCard(t, riskPct);

    // на радаре (только в режиме пробоев)
    const radar = d.radar || [];
    if (!nb && (d.strategy === "breakout" || d.strategy === "both") && radar.length) {
      h += `<div class="section-title">${_t("На радаре")} <small>${_t("готовятся пробои")}</small></div><div class="glass list">` + radar.slice(0, 8).map((r) => `<div class="closed-row radar-row" data-sym="${esc(r.symbol)}">
          <span class="side ${esc(r.side)}">${esc(r.side)}</span>
          <span class="n">${esc(r.symbol)} · ${_t("уровень")} ${fmtPrice(r.level)}<small>${esc(loc(r.notes))}</small></span>
          <span class="r">${Math.round(r.score)}</span></div>`).join("") + `</div>`;
    }

    // закрытые
    const closed = (d.closed || []).slice(0, nb ? 8 : 20);
    if (closed.length) {
      h += `<div class="section-title">${nb ? _t("Последние сделки") : _t("Закрытые")} <small>${closed.length}</small></div><div class="glass list">`;
      h += closed.map((t) => nb
        ? `<div class="closed-row nb-row"><span class="dot ${rCls(t.r_gross)}"></span>
            <span class="n">${esc(t.symbol)} · ${sideWord(t)}<small>${EXIT_NB[t.exit_reason] || esc(t.exit_reason)}${t.closed ? " · " + fmtTime(t.closed, true) : ""}</small></span>
            <span class="r ${rCls(t.r_gross)}">${t.r_gross > 0 ? _t("прибыль") : t.r_gross < 0 ? _t("убыток") : _t("ноль")}</span></div>`
        : `<div class="closed-row"><span class="side ${esc(t.side)}">${esc(t.side)}</span>
            <span class="n">${esc(t.symbol)}${t.kind === "breakout" ? _t(" · пробой") : ""}<small>${EXIT[t.exit_reason] || esc(t.exit_reason)} · ${fmtTime(t.opened, true)} → ${t.closed ? fmtTime(t.closed, true) : ""}</small></span>
            <span class="r ${rCls(t.r_gross)}">${fmtR(t.r_gross)}</span></div>`).join("");
      h += `</div>`;
    }

    if (!nb) {
      // толпа на фьючерсах
      const crowd = (d.crowd || []).filter((c) => c.z != null);
      if (crowd.length) {
        const hot = crowd.filter((c) => Math.abs(c.z) >= 1.5);
        const show = (state.crowdAll ? crowd : (hot.length ? hot : crowd.slice(0, 6)));
        h += `<div class="section-title">${_t("Толпа на фьючерсах")} <small>Binance · ${esc(crowd[0].day || "")}</small></div><div class="glass list crowd">`;
        h += show.map((c) => {
          const z = Math.max(-3, Math.min(3, c.z));
          const left = z >= 0 ? 50 : 50 + (z / 3) * 50, width = Math.abs(z) / 3 * 50;
          const cls = c.z >= 1.5 ? "long" : c.z <= -1.5 ? "short" : "";
          return `<div class="crowd-row">
            <span class="cs">${esc(c.symbol)}<small>${esc(_t(c.label))}</small></span>
            <span class="zbar"><span class="mid"></span><span class="zfill ${cls}" style="left:${left}%;width:${width}%"></span></span>
            <span class="zv ${cls}">${c.z > 0 ? "+" : ""}${Number(c.z).toFixed(1)}</span>
            <span class="cm">L/S ${c.ls != null ? Number(c.ls).toFixed(2) : "—"}${c.top_z != null ? ` · ${_t("топ-трейдеры")} ${c.top_z > 0 ? "+" : ""}${Number(c.top_z).toFixed(1)}` : ""}${c.oi_chg != null ? ` · OI ${_t("3д")} ${c.oi_chg > 0 ? "+" : ""}${Number(c.oi_chg).toFixed(1)}%` : ""}</span>
          </div>`;
        }).join("");
        h += `</div><button class="chip glass crowd-toggle">${state.crowdAll ? _t("Показать только перекосы") : `${_t("Все монеты (")}${crowd.length})`}</button>
          <p class="hint">z — ${_t("перекос лонгов/шортов у розницы против её обычного уровня за 2 недели. Бот не входит туда, где толпа перегружена (|z| ≥ 2).")}</p>`;
      }
      // проверка стратегии
      const bt = d.backtest;
      if (bt && (bt.rows || []).length) {
        h += `<div class="section-title">${_t("Проверка на истории")} <small>${bt.days} ${_t("дн. ·")} ${bt.coins} ${_t("монет")}</small></div><div class="glass list">`;
        h += bt.rows.map((r) => `<div class="exp-row"><span>${r.ok ? "✅" : "▫️"}</span><span>${esc(r.name)}</span>
            <span class="f">${(r.folds || []).map((x) => fmtR(x)).join(" · ")}</span></div>`).join("");
        h += `</div><p class="hint">${_t("Средний R на сделку в каждом из 3 периодов, после комиссий. ✅ — в плюсе во всех.")}</p>`;
      }
      h += `<p class="hint">R — ${_t("результат в единицах риска: −1R = стоп, +1.5R = TP1. Нажми на сигнал — откроется график. Не финансовый совет.")}</p>`;
    } else {
      h += `<button class="chip glass go-pro">${_t("Больше данных — режим «Продвинутый» →")}</button><p class="hint">${_t("Нажми на сделку — откроется график. Это не финансовый совет.")}</p>`;
    }
    box.innerHTML = h;

    const ct = box.querySelector(".crowd-toggle");
    if (ct) ct.addEventListener("click", () => { state.crowdAll = !state.crowdAll; haptic(); renderSignals(); });
    const gp = box.querySelector(".go-pro");
    if (gp) gp.addEventListener("click", () => setMode("pro"));
    box.querySelectorAll("#sig-period button").forEach((b) => b.addEventListener("click", () => { state.sigPeriod = b.dataset.p; haptic(); renderSignals(); }));
    box.querySelectorAll(".sig-card[data-sym], .radar-row[data-sym]").forEach((c) => c.addEventListener("click", () => {
      // в режиме «Продвинутый» сделка открывается в McQ Pro Chart (с линиями входа, стопа и целей)
      if (state.mode === "pro" && window.ProChart && c.classList.contains("sig-card")) { window.ProChart.open({ symbol: c.dataset.sym }); return; }
      state.asset = c.dataset.sym; state.interval = "60"; switchTab("charts");
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
  function resultBlock(e) {
    const r = e.result;
    if (!r) return "";
    const chips = [];
    if (r.vs_forecast && VS[r.vs_forecast]) chips.push(`<span class="res-chip ${VS[r.vs_forecast][1]}">${VS[r.vs_forecast][0]}</span>`);
    if (r.tone && TONE[r.tone]) chips.push(`<span class="res-chip ${TONE[r.tone][1]}">${TONE[r.tone][0]}</span>`);
    if (loc(r.decision)) chips.push(`<span class="res-chip">${esc(loc(r.decision))}</span>`);
    const rx = (r.reaction || []).map(rxChip).join("");
    const src = (r.sources || [])[0];
    return `<div class="res">
      ${chips.length ? `<div class="res-chips">${chips.join("")}</div>` : ""}
      ${loc(r.summary) ? `<p class="res-sum">${esc(loc(r.summary))}</p>` : ""}
      ${rx ? `<div class="rx-row"><span class="rx-l">${r.reaction_full ? _t("Реакция за час") : _t("Реакция (идёт час)")}</span>${rx}</div>` : ""}
      ${loc(r.impact) ? `<p class="res-imp">${esc(loc(r.impact))}</p>` : (loc(r.reaction_label) ? `<p class="res-imp">${esc(loc(r.reaction_label))}</p>` : "")}
      ${src && src.url ? `<button class="res-src" data-url="${esc(src.url)}">${esc(src.source || _t("источник"))} ↗</button>` : ""}
    </div>`;
  }

  // ---------------------------------------------------------------- календарь
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
      h += `<div class="day-title"><b>${d.today ? _t("Сегодня") : esc(d.k)}</b><span>${high ? `${high} ${_t("важн.")}` : ""}</span></div><div class="glass list">`;
      for (const { e, i } of d.items) {
        const nums = [e.actual && `${_t("факт")} <b>${esc(e.actual)}</b>`, e.forecast && `${_t("прогноз")} ${esc(e.forecast)}`, e.previous && `${_t("пред.")} ${esc(e.previous)}`].filter(Boolean).join(" · ");
        h += `<div class="ev ${new Date(e.ts) < now ? "past" : ""} ${e.result ? "has-res" : ""} ${i === nextIdx ? "next" : ""}">
          <span class="time">${fmtTime(e.ts)}</span>
          <span class="title">${FLAGS[e.country] || ""} ${esc(e.title)}</span>
          <span class="imp ${e.impact === "High" ? "high" : ""}">${e.impact === "High" ? _t("высокая важность") : _t("средняя важность")}</span>
          ${nums ? `<span class="nums">${nums}</span>` : ""}
          ${resultBlock(e)}
        </div>`;
      }
      h += `</div>`;
    }
    h += `<p class="hint">${_t("Время московское. Календарь — ForexFactory. Итоги: факт берётся из свежих заголовков новостей и проверяется, реакция рынка — измеренное изменение цены за 60 минут после события.")}</p>`;
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
    const m = lm && lm.symbols ? lm.symbols[state.asset] : null;
    const avail = lm && lm.symbols ? Object.keys(lm.symbols) : [];
    let h = `<div class="section-title">${_t("Карта ликвидаций")} <small>${_t("оценка")}</small></div>`;
    if (!m) {
      h += `<div class="glass card empty" style="padding:18px">${avail.length ? `${_t("Для")} ${esc(state.asset)} ${_t("карты нет. Есть для:")} ${avail.map(esc).join(", ")}.` : _t("Карта появится после ближайшего скана бота McQ Signals.")}</div>`;
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
      <p class="hint">${_t("Модель McQ Signals: часовой открытый интерес Binance + типичные плечи 5–100x; уровни, которые цена уже прошла, убраны. Это оценка, а не реальные позиции. Позиции последних ~суток не видны (данные по")} ${esc(m.data_until || "—")}). ${_t("Крупные скопления часто работают как «магниты» для цены.")}</p>`;
    }
    h += `<button class="chip glass liq-cg">${_t("Тепловая карта на Coinglass ↗")}</button>`;
    box.innerHTML = h;
    box.querySelector(".liq-cg").addEventListener("click", () => openLink(COINGLASS));
  }

  // ---------------------------------------------------------------- графики
  function renderChartControls() {
    const order = CHART_ORDER.includes(state.asset) ? CHART_ORDER : [state.asset, ...CHART_ORDER];
    $("#chart-assets").innerHTML = order.map((a) => `<button class="chip glass ${a === state.asset ? "active" : ""}" data-a="${esc(a)}" role="tab" aria-selected="${a === state.asset}">${esc(a)}</button>`).join("");
    const seg = $("#chart-interval");
    const idx = Math.max(0, INTERVALS.findIndex(([v]) => v === state.interval));
    seg.style.setProperty("--n", INTERVALS.length);
    seg.style.setProperty("--i", idx);
    seg.innerHTML = `<span class="thumb-glass" aria-hidden="true"></span>` + INTERVALS.map(([v, l]) => `<button class="${v === state.interval ? "active" : ""}" data-i="${v}" role="radio" aria-checked="${v === state.interval}">${l}</button>`).join("");
    document.querySelectorAll("#chart-assets .chip").forEach((b) => b.addEventListener("click", () => { state.asset = b.dataset.a; haptic(); renderChartControls(); renderChart(); }));
    renderLiq();
    document.querySelectorAll("#chart-interval button").forEach((b) => b.addEventListener("click", () => { state.interval = b.dataset.i; haptic(); renderChartControls(); renderChart(); }));
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
      hide_side_toolbar: true,
      hide_top_toolbar: false,
      allow_symbol_change: false,
      withdateranges: false,
      save_image: false,
      studies: state.rsi ? ["RSI@tv-basicstudies"] : [],
      backgroundColor: "rgba(0,0,0,0)",
      gridColor: dark ? "rgba(255,255,255,0.06)" : "rgba(20,28,48,0.06)",
      toolbar_bg: "rgba(0,0,0,0)",
    });
  }

  // ---------------------------------------------------------------- навигация
  function switchTab(name) {
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

  document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

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

  const MODE_CAP = { simple: _t("Главное простыми словами: куда идёт рынок и готовые сделки"), pro: _t("Все инструменты: RSI, толпа, ликвидации, статистика стратегии") };
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
    renderSignals();
    if (state.tab === "charts") renderLiq();
    if (!quiet) toast(m === "pro"
      ? _t("<b>Продвинутый</b> · добавлены RSI, толпа на фьючерсах, карта ликвидаций, сила сигнала и статистика стратегии")
      : _t("<b>Новичок</b> · только главное, сделки пошагово и подсказки"));
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

  let pushState = "off";  // off | on | denied | unsupported
  function initPush() {
    if (inTG || !CFG.onesignal || !("Notification" in window)) { pushState = "unsupported"; return; }
    if (isIOS && !standalone) { pushState = "need-install"; return; }
    window.OneSignalDeferred = window.OneSignalDeferred || [];
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
      } catch (e) { pushState = "unsupported"; renderPromo(); }
    });
  }
  async function enablePush() {
    haptic();
    const OS = window.__os;
    if (!OS) return;
    try {
      await OS.Notifications.requestPermission();
      await OS.User.PushSubscription.optIn();
      OS.User.addTags({ lang: I18.lang, mode: state.mode });
    } catch (e) { /* пользователь отказал */ }
  }

  function renderPromo() {
    const box = $("#app-promo");
    if (!box) return;
    let h = "";
    if (inTG) {
      // в Telegram: предложить поставить приложение на телефон (с пушами)
      if (!LS.get("amq-promo-tg")) {
        h = `<div class="promo glass"><span class="promo-ic"><img src="icons/icon-192.png" alt=""></span>
          <div class="promo-t"><b>${_t("McQCryptoNews на телефоне")}</b><span>${_t("Отдельное приложение с пуш-уведомлениями о сигналах и важных событиях.")}</span></div>
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
        <div class="promo-t"><b>${_t("Уведомления")}</b><span>${_t("Новые сигналы, тейк/стоп, важные события и утренний план — сразу на телефон.")}</span></div>
        <button class="promo-btn" data-act="push">${_t("Включить")}</button><button class="promo-x" data-act="hide-push" aria-label="×">×</button></div>`;
    }
    box.innerHTML = h;
    box.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
      const a = b.dataset.act;
      if (a === "open") openLink(appUrl + "?install=1");
      else if (a === "install" && installEvt) { installEvt.prompt(); try { await installEvt.userChoice; } catch (e) { /* noop */ } installEvt = null; }
      else if (a === "push") await enablePush();
      else if (a.startsWith("hide-")) LS.set("amq-promo-" + a.slice(5), "1");
      renderPromo();
    }));
  }

  // переход по ссылке из пуша: …/#signals, #news, #calendar, #charts
  function routeHash() {
    const h = (location.hash || "").replace("#", "");
    if (["overview", "signals", "news", "charts", "calendar"].includes(h)) switchTab(h);
    if (h === "prochart" && window.ProChart) { switchTab("charts"); window.ProChart.open(); }
  }
  // McQ Pro Chart: кнопка во вкладке «Графики»
  const pcBtn = $("#pc-open");
  if (pcBtn) pcBtn.addEventListener("click", () => {
    const crypto = !["S&P 500", "Nasdaq", "Gold", "Brent", "DXY", "US10Y", "VIX", "BTC.D"].includes(state.asset);
    if (window.ProChart) window.ProChart.open({ symbol: crypto ? state.asset : "BTC" });
  });
  window.McQ = { sig: () => state.sig, mode: () => state.mode, setMode: (m) => setMode(m) };
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
