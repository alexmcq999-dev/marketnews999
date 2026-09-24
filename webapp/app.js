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
    return `<span class="chg ${cls}" aria-label="${word} ${Math.abs(v).toFixed(2)}%"><span class="dot"></span>${v > 0 ? "+" : ""}${v.toFixed(2)}%</span>`;
  }

  // ---------------------------------------------------------------- данные
  async function load(showSpin) {
    const btn = $("#refresh");
    if (showSpin) btn.classList.add("spin");
    try {
      const r = await fetch(`data/app.json?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      state.data = await r.json();
      $("#updated").textContent = `Данные: ${ago(state.data.updated)} · ${fmtTime(state.data.updated, true)} МСК`;
      renderAll();
    } catch (e) {
      $("#updated").textContent = "Не удалось загрузить данные";
      if (!state.data) $("#tab-overview").innerHTML = `<div class="empty">Данные ещё не опубликованы.<br>Запусти workflow в GitHub Actions и открой приложение снова.</div>`;
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
      h += `<div class="card mood" style="margin-top:8px"><div class="ico">🧭</div><div><div class="label">Общий фон · ${d.news_updated ? fmtTime(d.news_updated, true) : ""}</div><p>${esc(d.mood)}</p></div></div>`;
    }

    if ((d.markets || []).length) {
      h += `<h2>Рынки</h2><div class="quotes">`;
      for (const m of d.markets) {
        h += `<button class="quote" data-asset="${esc(m.name)}" aria-label="Открыть график ${esc(m.name)}">
          <span class="n">${esc(m.name)}</span><span class="p">${fmtNum(m.price, m.dec)}</span>${chg(m.chg)}</button>`;
      }
      h += `</div>`;
    }

    const f = s.fng || {};
    if (f.stocks || f.crypto) {
      h += `<h2>Страх и жадность</h2><div class="card">`;
      for (const [key, title] of [["stocks", "Акции · CNN"], ["crypto", "Крипта · alternative.me"]]) {
        const x = f[key];
        if (!x) continue;
        const delta = x.value - x.week;
        h += `<div class="meter-row">
          <span class="t">${title}</span><span class="v">${x.value}</span>
          <div class="meter fng" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${x.value}" aria-label="${title}: ${x.value}, ${esc(x.rating_ru)}"><span class="mark" style="left:${x.value}%"></span></div>
          <div class="scale"><span>страх</span><span>нейтрально</span><span>жадность</span></div>
          <span class="sub"><b style="color:var(--text)">${esc(x.rating_ru)}</b> · вчера ${x.prev} · неделю назад ${x.week} (${delta > 0 ? "+" : ""}${delta})</span>
        </div>`;
      }
      h += `</div>`;
    }

    if ((s.rsi || []).length) {
      h += `<h2>RSI(14) · дневной</h2><div class="card rsi-list">`;
      for (const r of s.rsi) {
        h += `<div class="meter-row">
          <span class="t">${esc(r.name)}</span>
          <div class="meter rsi" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${r.value}" aria-label="RSI ${esc(r.name)}: ${Math.round(r.value)}, ${esc(r.label)}">
            <span class="zone lo"></span><span class="zone hi"></span><span class="mark" style="left:${Math.max(0, Math.min(100, r.value))}%"></span></div>
          <span class="v">${Math.round(r.value)}</span>
          <span class="sub">${esc(r.label)}</span>
        </div>`;
      }
      h += `<div class="legend"><span><i style="background:color-mix(in srgb,var(--up) 45%,transparent)"></i>&lt;30 перепроданность</span><span><i style="background:color-mix(in srgb,var(--down) 45%,transparent)"></i>&gt;70 перекупленность</span></div></div>`;
    }

    const next = (d.calendar || []).filter((e) => e.impact === "High" && new Date(e.ts) > Date.now()).slice(0, 3);
    if (next.length) {
      h += `<h2>Ближайшие события</h2><div class="card">`;
      h += next.map((e) => `<div style="display:flex;gap:10px;padding:4px 0"><b style="min-width:86px;font-variant-numeric:tabular-nums">${fmtTime(e.ts, !isToday(e.ts))}</b><span>${FLAGS[e.country] || ""} ${esc(e.title)}</span></div>`).join("");
      h += `</div>`;
    }

    $("#tab-overview").innerHTML = h || `<div class="empty">Нет данных</div>`;
    document.querySelectorAll(".quote[data-asset]").forEach((b) =>
      b.addEventListener("click", () => {
        const a = b.dataset.asset;
        if (TV[a]) { state.asset = a; switchTab("charts"); }
      }));
  }

  // ---------------------------------------------------------------- новости
  function renderNews() {
    const news = state.data.news || [];
    const box = $("#tab-news");
    if (!news.length) {
      box.innerHTML = `<div class="empty">Новости появятся после ближайшего дайджеста (08:00 и 16:00 МСК).</div>`;
      return;
    }
    const themes = ["Все", ...new Set(news.flatMap((n) => n.themes || []))];
    if (!themes.includes(state.newsFilter)) state.newsFilter = "Все";
    let h = `<div class="chips" style="margin-top:8px">${themes.map((t) => `<button class="chip ${t === state.newsFilter ? "active" : ""}" data-f="${esc(t)}">${esc(t)}</button>`).join("")}</div>`;
    if (state.data.news_updated) h += `<div class="updated" style="margin:-2px 4px 10px">Выпуск ${fmtTime(state.data.news_updated, true)} МСК</div>`;

    const list = news.filter((n) => state.newsFilter === "Все" || (n.themes || []).includes(state.newsFilter));
    for (const n of list) {
      h += `<article class="news-card">
        <h3>${esc(n.emoji)} ${esc(n.title)}</h3>
        ${n.title_en && n.title_en !== n.title ? `<div class="en">${esc(n.title_en)}</div>` : ""}
        ${n.summary ? `<p>${esc(n.summary)}</p>` : ""}
        ${n.why ? `<div class="block"><b>Влияние на рынки</b>${esc(n.why)}</div>` : ""}
        ${n.watch ? `<div class="block"><b>Следить</b>${esc(n.watch)}</div>` : ""}
        <div class="meta">
          ${n.bias && BIAS[n.bias] ? `<span class="bias ${n.bias}">${BIAS[n.bias]}</span>` : ""}
          ${n.assets ? `<span class="tag">${esc(n.assets)}</span>` : ""}
        </div>
        <div class="meta"><span class="trust">${esc(n.trust)} · ${fmtTime(n.ts, !isToday(n.ts))} МСК</span></div>
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
    if (!ev.length) { box.innerHTML = `<div class="empty">Нет событий на этой неделе</div>`; return; }
    const now = Date.now();
    const nextIdx = ev.findIndex((e) => new Date(e.ts) > now);
    let h = "", cur = "";
    ev.forEach((e, i) => {
      const k = dayKey(e.ts);
      if (k !== cur) { if (cur) h += `</div>`; cur = k; h += `<div class="day"><h2>${esc(k)}</h2>`; }
      const nums = [e.actual && `факт <b style="color:var(--text)">${esc(e.actual)}</b>`, e.forecast && `прогноз ${esc(e.forecast)}`, e.previous && `пред. ${esc(e.previous)}`].filter(Boolean).join(" · ");
      h += `<div class="ev ${new Date(e.ts) < now ? "past" : ""} ${i === nextIdx ? "next" : ""}">
        <span class="time">${fmtTime(e.ts)}</span>
        <span class="title">${FLAGS[e.country] || ""} ${esc(e.title)}</span>
        <span class="imp ${e.impact === "High" ? "high" : ""}">${e.impact === "High" ? "высокая важность" : "средняя важность"}</span>
        ${nums ? `<span class="nums">${nums}</span>` : ""}
      </div>`;
    });
    h += `</div><p class="hint">Время — МСК. Источник: ForexFactory.</p>`;
    box.innerHTML = h;
  }

  // ---------------------------------------------------------------- графики
  function renderChartControls() {
    $("#chart-assets").innerHTML = CHART_ORDER.map((a) => `<button class="chip ${a === state.asset ? "active" : ""}" data-a="${esc(a)}" role="tab">${esc(a)}</button>`).join("");
    $("#chart-interval").innerHTML = INTERVALS.map(([v, l]) => `<button class="${v === state.interval ? "active" : ""}" data-i="${v}" role="radio" aria-checked="${v === state.interval}">${l}</button>`).join("");
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
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--card").trim();
    /* global TradingView */
    new TradingView.widget({
      container_id: "tv-chart",
      autosize: true,
      symbol: TV[state.asset],
      interval: state.interval,
      timezone: TZ,
      theme: isDark() ? "dark" : "light",
      style: "1",
      locale: "ru",
      enable_publishing: false,
      hide_side_toolbar: true,
      hide_top_toolbar: false,
      allow_symbol_change: false,
      withdateranges: false,
      save_image: false,
      studies: state.rsi ? ["RSI@tv-basicstudies"] : [],
      backgroundColor: bg || undefined,
    });
  }

  // ---------------------------------------------------------------- навигация
  function switchTab(name) {
    state.tab = name;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
    document.querySelectorAll(".nav-btn").forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on);
    });
    window.scrollTo({ top: 0 });
    if (name === "charts") { renderChartControls(); renderChart(); }
    haptic();
  }

  document.querySelectorAll(".nav-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  $("#refresh").addEventListener("click", () => { haptic(); load(true); });
  $("#chart-rsi").addEventListener("change", (e) => { state.rsi = e.target.checked; renderChart(); });

  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor("secondary_bg_color"); tg.setBackgroundColor("secondary_bg_color"); } catch (e) { /* старые клиенты */ }
    tg.onEvent("themeChanged", () => { state.chartKey = ""; if (state.tab === "charts") renderChart(); });
  }
  load(false);
  setInterval(() => load(false), 5 * 60 * 1000);
})();
