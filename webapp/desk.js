/* CANDEL — навигация в стиле сайта.
   • Компьютер: разделы — горизонтальным меню в шапке, рядом «Журнал» и «Pro Chart».
   • Телефон и PWA: сплошная нижняя панель (стили в ui.css).
   Клик по разделу закрывает открытый журнал или Pro Chart; открытое окно подсвечивается в меню. */
(function () {
  "use strict";
  const _t = (s) => (window.I18N ? window.I18N.t(s) : s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tb = document.getElementById("tabbar");
  if (!tb) return;
  document.documentElement.classList.add("ui26");

  const tools = document.createElement("div");
  tools.className = "nav-tools";
  tools.innerHTML = `<span class="nav-sep" aria-hidden="true"></span>
    <button class="nav-tool" type="button" data-open="jr-open">${esc(_t("Журнал"))}</button>
    <button class="nav-tool" type="button" data-open="pc-open">Pro Chart<i>PRO</i></button>`;
  tb.append(tools);
  tools.addEventListener("click", (e) => {
    const b = e.target.closest("[data-open]");
    if (!b) return;
    if (b.dataset.open === "jr-open") { if (window.Journal) window.Journal.open(); }
    else if (window.ProChart) window.ProChart.open();
    else { const el = document.getElementById(b.dataset.open); if (el) el.click(); }
  });

  // меню в шапке начинается сразу после логотипа (и значка PRO), чтобы ничего не перекрывать
  const brand = document.querySelector(".top .brand");
  // меню теперь слева (ui.css), отступ от логотипа больше не нужен
  const place = () => { tb.style.left = ""; };
  place();
  window.addEventListener("resize", place);
  if (window.ResizeObserver && brand) new ResizeObserver(place).observe(brand);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);

  // логотип ведёт на «Обзор»: закрывает журнал / Pro Chart и прокручивает наверх
  if (brand) {
    brand.setAttribute("role", "link"); brand.setAttribute("tabindex", "0"); brand.setAttribute("aria-label", _t("На главную"));
    brand.classList.add("brand-link");
    const home = () => {
      const ov = document.querySelector('.nav-btn[data-tab="overview"]');
      if (ov) ov.click();
      else { try { window.Journal && window.Journal.close(); window.ProChart && window.ProChart.close(); } catch (e) { /* noop */ } }
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    brand.addEventListener("click", home);
    brand.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); home(); } });
  }

  // заголовок раздела в верхней строке (компьютер): название раздела или открытого окна + время обновления данных
  const top = document.querySelector(".top");
  const tt = document.createElement("div");
  tt.className = "top-title";
  tt.innerHTML = `<b></b><small></small>`;
  if (top) top.prepend(tt);
  const upd = document.getElementById("updated-text");
  const setTitle = () => {
    const j = document.getElementById("jr"), p = document.getElementById("pc");
    const open = (el) => !!(el && !el.hidden && el.classList.contains("show"));
    const act = tb.querySelector(".nav-btn.active span");
    tt.querySelector("b").textContent = open(p) ? "Pro Chart" : open(j) ? _t("Журнал") : act ? act.textContent : "";
    tt.querySelector("small").textContent = upd ? upd.textContent : "";
  };
  new MutationObserver(setTitle).observe(tb, { subtree: true, attributes: true, attributeFilter: ["class"] });
  if (upd) new MutationObserver(setTitle).observe(upd, { childList: true, characterData: true, subtree: true });
  setTimeout(setTitle, 300);

  const shown = (id) => { const el = document.getElementById(id); return !!(el && !el.hidden && el.classList.contains("show")); };
  const sync = () => {
    const j = shown("jr"), p = shown("pc");
    tools.querySelector('[data-open="pc-open"]').classList.toggle("active", p);
    tools.querySelector('[data-open="jr-open"]').classList.toggle("active", j && !p);
    document.documentElement.classList.toggle("overlay-open", j || p);
    setTitle();
  };
  new MutationObserver(() => setTimeout(sync, 40)).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  tb.addEventListener("click", (e) => {
    if (!e.target.closest(".nav-btn")) return;
    try { if (shown("jr") && window.Journal) window.Journal.close(); } catch (er) { /* noop */ }
    try { if (shown("pc") && window.ProChart) window.ProChart.close(); } catch (er) { /* noop */ }
  }, true);
})();
