/* McQCryptoNews — знакомство с приложением для новых пользователей.
   Показывается один раз: после выбора режима (Новичок / Продвинутый) и входа. Подсвечивает элементы по очереди:
   режимы, вкладки, торговый журнал, Pro Chart, профиль и язык. В конце — предложение попробовать McQ Pro.
   Повторить можно из профиля («Как пользоваться»). */
(function () {
  "use strict";
  const _t = (s) => (window.I18N ? window.I18N.t(s) : s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const LS = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* noop */ } } };
  const KEY = "amq-tour-v1";
  const tab = (name) => { const b = document.querySelector(`.nav-btn[data-tab="${name}"]`); if (b && !b.classList.contains("active")) b.click(); };
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };

  const STEPS = [
    { center: true, icon: "👋", title: "Добро пожаловать в McQCryptoNews", text: "За минуту покажем, где что находится: рынок, сигналы, новости, графики и торговый журнал." },
    { el: "#mode", before: () => tab("overview"), title: "Новичок или Продвинутый", text: "Переключай, сколько данных показывать. «Новичок» — только главное и подсказки, «Продвинутый» — RSI, ликвидации, толпа на фьючерсах и статистика." },
    { el: '.nav-btn[data-tab="overview"]', before: () => tab("overview"), title: "Обзор", text: "Главный экран: биткоин, настроение рынка, доминация BTC и торговые сессии мира в реальном времени." },
    { el: '.nav-btn[data-tab="signals"]', before: () => tab("signals"), title: "Сигналы", text: "Сделки бота McQ: вход, стоп и цели, текущий результат и честная статистика стратегии." },
    { el: "#jr-open", before: () => tab("signals"), title: "Торговый журнал", text: "Подключи свою биржу read-only ключом — журнал сам соберёт сделки, покажет ошибки и календарь результатов. Ключи остаются на телефоне." },
    { el: '.nav-btn[data-tab="news"]', before: () => tab("news"), title: "Новости", text: "Главные события для крипты и рынков с пересказом и влиянием на цену. Обновляются дважды в день." },
    { el: "#pc-open", before: () => tab("charts"), title: "Pro Chart", text: "Свечи и объёмы сразу с 9 крупнейших бирж, VWAP в каждой свече и ИИ-ассистент, который разбирает график." },
    { el: '.nav-btn[data-tab="calendar"]', before: () => tab("calendar"), title: "Календарь", text: "Важные макро-события недели: ставки, инфляция, отчёты — и как на них реагировал рынок." },
    { el: "#profile-btn", before: () => tab("overview"), title: "Профиль", text: "Подписка McQ Pro, торговый журнал и настройки аккаунта — здесь." },
    { el: "#lang-btn", title: "Язык", text: "Приложение на шести языках: русский, английский, испанский, французский, корейский и китайский." },
    { center: true, icon: "🚀", final: true, title: "Всё готово!", text: "Начни с вкладки «Обзор». А чтобы открыть Pro Chart и ИИ-разборы — попробуй McQ Pro." },
  ];

  const S = { i: 0, el: null, steps: [], running: false };

  function build() {
    if (S.el) return S.el;
    const el = document.createElement("div");
    el.className = "tour";
    el.innerHTML = `<div class="tour-hole"></div><div class="tour-card glass" role="dialog" aria-live="polite"></div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => {
      const a = e.target.closest("[data-t]");
      if (!a) return;
      const k = a.dataset.t;
      if (k === "next") go(S.i + 1);
      else if (k === "back") go(S.i - 1);
      else if (k === "skip" || k === "done") finish();
      else if (k === "pro") { finish(); if (window.Pro && window.Pro.open) window.Pro.open(); }
    });
    window.addEventListener("resize", () => { if (S.running) place(); });
    S.el = el;
    return el;
  }

  function place() {
    const st = S.steps[S.i];
    const hole = S.el.querySelector(".tour-hole"), card = S.el.querySelector(".tour-card");
    const target = st.el ? document.querySelector(st.el) : null;
    const vw = innerWidth, vh = innerHeight, pad = 8;
    if (!target || st.center) {
      hole.style.cssText = `left:${vw / 2}px;top:${vh / 2}px;width:0;height:0;`;
      card.classList.add("center");
      card.style.cssText = "";
      return;
    }
    card.classList.remove("center");
    const r = target.getBoundingClientRect();
    const x = Math.max(4, r.left - pad), y = Math.max(4, r.top - pad);
    const w = Math.min(vw - x - 4, r.width + pad * 2), h = r.height + pad * 2;
    const radius = Math.min(22, h / 2);
    hole.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:${radius}px;`;
    // карточка — снизу или сверху от подсветки, где больше места
    const cw = Math.min(360, vw - 24);
    const below = vh - (y + h), above = y;
    let left = Math.min(Math.max(12, r.left + r.width / 2 - cw / 2), vw - cw - 12);
    card.style.width = `${cw}px`;
    card.style.left = `${left}px`;
    if (below > above) { card.style.top = `${y + h + 12}px`; card.style.bottom = "auto"; }
    else { card.style.bottom = `${vh - y + 12}px`; card.style.top = "auto"; }
  }

  async function go(i) {
    if (i < 0) return;
    if (i >= S.steps.length) return finish();
    S.i = i;
    const st = S.steps[i];
    if (st.before) { try { st.before(); } catch (e) { /* noop */ } }
    const target = st.el ? document.querySelector(st.el) : null;
    if (target) {
      const r = target.getBoundingClientRect();
      if (r.top < 70 || r.bottom > innerHeight - 90) { target.scrollIntoView({ block: "center", behavior: "instant" }); }
      await new Promise((res) => setTimeout(res, 260));
    }
    const card = S.el.querySelector(".tour-card");
    const n = S.steps.length;
    const proBtn = st.final && window.Pro && window.Pro.available && window.Pro.available() && !(window.AUTH && window.AUTH.plan === "pro");
    card.innerHTML = `${st.icon ? `<div class="tour-ic">${st.icon}</div>` : ""}
      <div class="tour-step">${i + 1} / ${n}</div>
      <b class="tour-h">${esc(_t(st.title))}</b>
      <p class="tour-p">${esc(_t(st.text))}</p>
      <div class="tour-dots">${S.steps.map((_, k) => `<i class="${k === i ? "on" : k < i ? "done" : ""}"></i>`).join("")}</div>
      <div class="tour-btns">
        ${st.final ? "" : `<button class="tour-skip" data-t="skip">${esc(_t("Пропустить"))}</button>`}
        ${i > 0 && !st.final ? `<button class="tour-back" data-t="back" aria-label="${esc(_t("Назад"))}">←</button>` : ""}
        ${st.final
          ? `${proBtn ? `<button class="tour-pro" data-t="pro">${esc(_t("Попробовать McQ Pro"))}</button>` : ""}<button class="tour-next${proBtn ? " alt" : ""}" data-t="done">${esc(_t("Начать"))}</button>`
          : `<button class="tour-next" data-t="next">${esc(i === 0 ? _t("Показать") : _t("Далее"))}</button>`}
      </div>`;
    place();
    try { const tg = window.Telegram && window.Telegram.WebApp; tg && tg.HapticFeedback && tg.HapticFeedback.selectionChanged(); } catch (e) { /* noop */ }
  }

  function start(force) {
    if (S.running) return;
    if (!force && LS.get(KEY)) return;
    // шаги только для элементов, которые сейчас есть на экране (например, профиля нет без входа)
    S.steps = STEPS.filter((s) => {
      if (s.center || !s.el) return true;
      const el = document.querySelector(s.el);
      if (!el) return false;
      if (s.el === "#profile-btn") return !el.hidden;
      return true;
    });
    const el = build();
    S.running = true;
    el.hidden = false;
    document.documentElement.classList.add("tour-open");
    requestAnimationFrame(() => el.classList.add("show"));
    go(0);
  }
  function finish() {
    LS.set(KEY, "1");
    S.running = false;
    document.documentElement.classList.remove("tour-open");
    if (!S.el) return;
    S.el.classList.remove("show");
    setTimeout(() => { S.el.hidden = true; }, 250);
    const b = document.querySelector('.nav-btn[data-tab="overview"]');
    if (b && !b.classList.contains("active")) b.click();
    window.scrollTo(0, 0);
  }

  // запуск: когда закрыты прелоадер, выбор режима и экран входа
  function blocked() {
    const busy = (sel) => { const el = document.querySelector(sel); return el && !el.hidden && visible(el); };
    return busy("#pre") || busy(".pre") || busy("#onb") || busy("#login") || busy(".pc.show") || busy(".jr.show") || busy("#pro.show");
  }
  if (!LS.get(KEY)) {
    let tries = 0, calm = 0;
    const timer = setInterval(() => {
      if (++tries > 600) return clearInterval(timer);      // 5 минут ожидания
      if (blocked()) { calm = 0; return; }
      if (++calm < 3) return;                              // экран спокоен ~1.5 с
      clearInterval(timer);
      start(false);
    }, 500);
  }

  window.Tour = { start: () => start(true) };
})();
