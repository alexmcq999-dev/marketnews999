/* Market Pulse — Telegram Mini App */
(function () {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp;
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
  };
  const CHART_ORDER = ["BTC", "ETH", "S&P 500", "Nasdaq", "Gold", "Brent", "DXY", "US10Y", "VIX"];
  const INTERVALS = [["15", "15м"], ["60", "1ч"], ["240", "4ч"], ["D", "1Д"], ["W", "1Н"]];
  const FLAGS = { USD: "🇺🇸", EUR: "🇪🇺", GBP: "🇬🇧", JPY: "🇯🇵", CNY: "🇨🇳", ALL: "🌐" };
  const BIAS = { bullish: "позитив", bearish: "негатив", mixed: "неоднозначно" };

  const state = { data: null, tab: "overview", newsFilter: "Все", asset: "BTC", interval: "240", rsi: true, chartKey: "" };

  // ---------------------------------------------------------------- утилиты
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtNum(v, dec) {
    return Number(v).toLocaleString("ru-RU", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function fmtTime(iso, withDate) {
    const d = new Date(iso);
    const opts = withDate ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" };
    return d.toLocaleString("ru-RU", { ...opts, timeZone: TZ });
  }
  function dayKey(iso) {
    return new Date(iso).toLocaleDateString("ru-RU", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
  }
  function isToday(iso) {
    const f = (d) => d.toLocaleDateString("ru-RU", { timeZone: TZ });
    return f(new Date(iso)) === f(new Date());
  }
  function ago(iso) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "только что";
    if (m < 60) return `${m} мин назад`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} ч назад` : fmtTime(iso, true);
  }
  function openLink(url) {
    if (tg && tg.openLink) tg.openLink(url); else window.open(url, "_blank", "noopener");
  }
  function haptic() { try { tg && tg.HapticFeedback && tg.HapticFeedback.selectionChanged(); } catch (e) { /* noop */ } }
  function chg(v) {
    if (v == null || isNaN(v)) return "";
    const cls = v > 0.05 ? "up" : v < -0.05 ? "down" : "flat";
    const word = cls === "up" ? "рост" : cls === "down" ? "падение" : "без изменений";
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
    return `<div class="gauge glass" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${x.value}" aria-label="${esc(title)}: ${x.value}, ${esc(x.rating_ru)}">
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
      <div class="r" style="color:${fngColor(x.value)}">${esc(x.rating_ru)}</div>
      <div class="d">вчера ${x.prev} · неделя ${x.week} (${delta > 0 ? "+" : ""}${delta})</div>
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
      $("#updated-text").textContent = `Обновлено ${ago(state.data.updated)} · ${fmtTime(state.data.updated, true)} МСК`;
      $(".live-dot").classList.toggle("stale", ageMin > 120);
      renderAll();
    } catch (e) {
      $("#updated-text").textContent = "Нет связи с сервером данных";
      $(".live-dot").classList.add("stale");
      if (!state.data) {
        $("#tab-overview").innerHTML = `<div class="glass card empty">Данные ещё не опубликованы.<br>Запусти workflow в GitHub Actions и открой приложение снова.</div><div class="section-title">Торговые сессии</div><div id="sessions"></div>`;
        renderSessions();
      }
    } finally {
      btn.classList.remove("spin");
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
  function renderOverview() {
    const d = state.data;
    const s = d.sentiment || {};
    let h = "";

    if (d.mood) {
      h += `<div class="mood glass"><div class="label"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15.5 8.5-2 5-5 2 2-5z" fill="currentColor"/></svg>Общий фон${d.news_updated ? " · " + fmtTime(d.news_updated, !isToday(d.news_updated)) : ""}</div><p>${esc(d.mood)}</p></div>`;
    }

    h += `<div class="section-title">Торговые сессии</div><div id="sessions"></div>`;

    if ((d.markets || []).length) {
      h += `<div class="section-title">Рынки</div><div class="quotes">`;
      for (const m of d.markets) {
        h += `<button class="quote glass pressable ${trendClass(m.chg)}" data-asset="${esc(m.name)}" aria-label="Открыть график ${esc(m.name)}">
          <span class="glow"></span><span class="n">${esc(m.name)}</span><span class="p">${fmtNum(m.price, m.dec)}</span>${chg(m.chg)}</button>`;
      }
      h += `</div>`;
    }

    const f = s.fng || {};
    if (f.stocks || f.crypto) {
      h += `<div class="section-title">Страх и жадность</div><div class="fng-grid">`;
      if (f.stocks) h += gauge("Акции · CNN", f.stocks);
      if (f.crypto) h += gauge("Крипта", f.crypto);
      h += `</div>`;
    }

    if ((s.rsi || []).length) {
      h += `<div class="section-title">RSI <small>14 дней</small></div><div class="glass rsi-list">`;
      for (const r of s.rsi) {
        h += `<div class="rsi-row" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${r.value}" aria-label="RSI ${esc(r.name)}: ${Math.round(r.value)}, ${esc(r.label)}">
          <span class="t">${esc(r.name)}</span>
          <div class="track"><span class="zone lo"></span><span class="zone hi"></span><span class="bead" style="left:${Math.max(0, Math.min(100, r.value))}%"></span></div>
          <span class="v">${Math.round(r.value)}</span>
          <span class="sub">${esc(r.label)}</span>
        </div>`;
      }
      h += `<div class="legend"><span><i style="background:var(--up)"></i>ниже 30 — перепроданность</span><span><i style="background:var(--down)"></i>выше 70 — перекупленность</span></div></div>`;
    }

    const next = (d.calendar || []).filter((e) => e.impact === "High" && new Date(e.ts) > Date.now()).slice(0, 3);
    if (next.length) {
      h += `<div class="section-title">Ближайшие события</div><div class="glass list">`;
      h += next.map((e) => `<div class="row"><span class="when">${fmtTime(e.ts)}${isToday(e.ts) ? "" : `<small>${new Date(e.ts).toLocaleDateString("ru-RU", { timeZone: TZ, day: "numeric", month: "short" })}</small>`}</span><span class="what">${FLAGS[e.country] || ""} ${esc(e.title)}</span></div>`).join("");
      h += `</div>`;
    }

    $("#tab-overview").innerHTML = h || `<div class="glass card empty">Нет данных</div>`;
    renderSessions();
    document.querySelectorAll(".quote[data-asset]").forEach((b) =>
      b.addEventListener("click", () => {
        const a = b.dataset.asset;
        if (TV[a]) { state.asset = a; switchTab("charts"); }
      }));
  }

  // ---------------------------------------------------------------- новости
  const ICON_IMPACT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>';
  const ICON_WATCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>';

  function renderNews() {
    const news = state.data.news || [];
    const box = $("#tab-news");
    if (!news.length) {
      box.innerHTML = `<div class="glass card empty">Новости появятся после ближайшего дайджеста в 08:00 или 16:00 МСК.</div>`;
      return;
    }
    const themes = ["Все", ...new Set(news.flatMap((n) => n.themes || []))];
    if (!themes.includes(state.newsFilter)) state.newsFilter = "Все";
    let h = `<div class="chips">${themes.map((t) => `<button class="chip glass ${t === state.newsFilter ? "active" : ""}" data-f="${esc(t)}">${esc(t)}</button>`).join("")}</div>`;
    if (state.data.news_updated) h += `<div class="issue">Выпуск ${fmtTime(state.data.news_updated, true)} МСК · ${news.length} ${news.length < 5 ? "события" : "событий"}</div>`;

    const list = news.filter((n) => state.newsFilter === "Все" || (n.themes || []).includes(state.newsFilter));
    for (const n of list) {
      h += `<article class="news-card glass">
        <div class="news-head">
          <span class="theme-pill">${esc(n.emoji)} ${esc((n.themes || [])[0] || "Рынки")}</span>
          <span class="news-time">${fmtTime(n.ts, !isToday(n.ts))}</span>
        </div>
        <h3>${esc(n.title)}</h3>
        ${n.title_en && n.title_en !== n.title ? `<div class="en">${esc(n.title_en)}</div>` : ""}
        ${n.summary ? `<p>${esc(n.summary)}</p>` : ""}
        ${n.why ? `<div class="insight impact"><b>${ICON_IMPACT}Влияние на рынки</b>${esc(n.why)}</div>` : ""}
        ${n.watch ? `<div class="insight watch"><b>${ICON_WATCH}Следить</b>${esc(n.watch)}</div>` : ""}
        ${(n.bias && BIAS[n.bias]) || n.assets ? `<div class="meta">
          ${n.bias && BIAS[n.bias] ? `<span class="bias ${n.bias}">${BIAS[n.bias]}</span>` : ""}
          ${n.assets ? `<span class="tag">${esc(n.assets)}</span>` : ""}
        </div>` : ""}
        <div class="trust">${esc(n.trust)}</div>
        <div class="links">${(n.links || []).map((l) => `<button data-url="${esc(l.url)}">${esc(l.outlet)} ↗</button>`).join("")}</div>
      </article>`;
    }
    box.innerHTML = h;
    box.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { state.newsFilter = c.dataset.f; haptic(); renderNews(); }));
    box.querySelectorAll(".links button").forEach((b) => b.addEventListener("click", () => openLink(b.dataset.url)));
  }

  // ---------------------------------------------------------------- календарь
  function renderCalendar() {
    const ev = state.data.calendar || [];
    const box = $("#tab-calendar");
    if (!ev.length) { box.innerHTML = `<div class="glass card empty">На этой неделе важных событий нет</div>`; return; }
    const now = Date.now();
    const nextIdx = ev.findIndex((e) => new Date(e.ts) > now);
    const days = [];
    ev.forEach((e, i) => {
      const k = dayKey(e.ts);
      if (!days.length || days[days.length - 1].k !== k) days.push({ k, today: isToday(e.ts), items: [] });
      days[days.length - 1].items.push({ e, i });
    });
    let h = "";
    for (const d of days) {
      const high = d.items.filter((x) => x.e.impact === "High").length;
      h += `<div class="day-title"><b>${d.today ? "Сегодня" : esc(d.k)}</b><span>${high ? `${high} важн.` : ""}</span></div><div class="glass list">`;
      for (const { e, i } of d.items) {
        const nums = [e.actual && `факт <b>${esc(e.actual)}</b>`, e.forecast && `прогноз ${esc(e.forecast)}`, e.previous && `пред. ${esc(e.previous)}`].filter(Boolean).join(" · ");
        h += `<div class="ev ${new Date(e.ts) < now ? "past" : ""} ${i === nextIdx ? "next" : ""}">
          <span class="time">${fmtTime(e.ts)}</span>
          <span class="title">${FLAGS[e.country] || ""} ${esc(e.title)}</span>
          <span class="imp ${e.impact === "High" ? "high" : ""}">${e.impact === "High" ? "высокая важность" : "средняя важность"}</span>
          ${nums ? `<span class="nums">${nums}</span>` : ""}
        </div>`;
      }
      h += `</div>`;
    }
    h += `<p class="hint">Время московское. Источник: ForexFactory.</p>`;
    box.innerHTML = h;
  }

  // ---------------------------------------------------------------- графики
  function renderChartControls() {
    $("#chart-assets").innerHTML = CHART_ORDER.map((a) => `<button class="chip glass ${a === state.asset ? "active" : ""}" data-a="${esc(a)}" role="tab" aria-selected="${a === state.asset}">${esc(a)}</button>`).join("");
    const seg = $("#chart-interval");
    const idx = Math.max(0, INTERVALS.findIndex(([v]) => v === state.interval));
    seg.style.setProperty("--n", INTERVALS.length);
    seg.style.setProperty("--i", idx);
    seg.innerHTML = `<span class="thumb-glass" aria-hidden="true"></span>` + INTERVALS.map(([v, l]) => `<button class="${v === state.interval ? "active" : ""}" data-i="${v}" role="radio" aria-checked="${v === state.interval}">${l}</button>`).join("");
    document.querySelectorAll("#chart-assets .chip").forEach((b) => b.addEventListener("click", () => { state.asset = b.dataset.a; haptic(); renderChartControls(); renderChart(); }));
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

  function isDark() {
    const t = document.documentElement.dataset.theme;
    if (t) return t === "dark";
    if (tg && tg.colorScheme) return tg.colorScheme === "dark";
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  async function renderChart() {
    const key = `${state.asset}|${state.interval}|${state.rsi}|${isDark()}`;
    if (key === state.chartKey) return;
    state.chartKey = key;
    const box = $("#tv-chart");
    box.innerHTML = `<div class="empty">Загрузка графика…</div>`;
    try { await loadTV(); } catch (e) {
      box.innerHTML = `<div class="empty">Не удалось загрузить TradingView. Проверь соединение.</div>`;
      state.chartKey = "";
      return;
    }
    box.innerHTML = "";
    const dark = isDark();
    /* global TradingView */
    new TradingView.widget({
      container_id: "tv-chart",
      autosize: true,
      symbol: TV[state.asset],
      interval: state.interval,
      timezone: TZ,
      theme: dark ? "dark" : "light",
      style: "1",
      locale: "ru",
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
  $("#refresh").addEventListener("click", () => { haptic(); load(true); });
  $("#chart-rsi").addEventListener("change", (e) => { state.rsi = e.target.checked; renderChart(); });

  function applyTheme() {
    if (tg && tg.colorScheme) document.documentElement.dataset.theme = tg.colorScheme;
    const base = getComputedStyle(document.documentElement).getPropertyValue("--base").trim() || "#05070d";
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
    requestAnimationFrame(() => { top.classList.toggle("scrolled", window.scrollY > 44); ticking = false; });
  }, { passive: true });

  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) { /* noop */ }
    tg.onEvent("themeChanged", () => { applyTheme(); state.chartKey = ""; if (state.tab === "charts") renderChart(); });
  }
  applyTheme();
  function renderSessions() {
    try { window.MarketSessions && window.MarketSessions.render(document.getElementById("sessions")); }
    catch (e) { const el = document.getElementById("sessions"); if (el) el.innerHTML = ""; }
  }

  load(false);
  setInterval(() => load(false), 5 * 60 * 1000);
  setInterval(() => { if (state.tab === "overview") renderSessions(); }, 30 * 1000);
})();
