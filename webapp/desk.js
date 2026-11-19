/* McQCryptoNews — навигация в стиле сайта.
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
    else { const el = document.getElementById(b.dataset.open); if (el) el.click(); }
  });

  // меню в шапке начинается сразу после логотипа (и значка PRO), чтобы ничего не перекрывать
  const brand = document.querySelector(".top .brand");
  const place = () => {
    if (!window.matchMedia("(min-width: 1024px)").matches || !brand) { tb.style.left = ""; return; }
    tb.style.left = `${Math.round(brand.getBoundingClientRect().right + 28)}px`;
  };
  place();
  window.addEventListener("resize", place);
  if (window.ResizeObserver && brand) new ResizeObserver(place).observe(brand);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);

  const shown = (id) => { const el = document.getElementById(id); return !!(el && !el.hidden && el.classList.contains("show")); };
  const sync = () => {
    const j = shown("jr"), p = shown("pc");
    tools.querySelector('[data-open="jr-open"]').classList.toggle("active", j);
    tools.querySelector('[data-open="pc-open"]').classList.toggle("active", p && !j);
    document.documentElement.classList.toggle("overlay-open", j || p);
  };
  new MutationObserver(() => setTimeout(sync, 40)).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  tb.addEventListener("click", (e) => {
    if (!e.target.closest(".nav-btn")) return;
    try { if (shown("jr") && window.Journal) window.Journal.close(); } catch (er) { /* noop */ }
    try { if (shown("pc") && window.ProChart) window.ProChart.close(); } catch (er) { /* noop */ }
  }, true);
})();
