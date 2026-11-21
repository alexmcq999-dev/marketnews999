/* CANDEL — аналитика.
   • Яндекс Метрика: номер счётчика приходит в APP_CONFIG.ym (переменная YM_COUNTER_ID в GitHub). Нет номера — ничего не грузим.
     Вебвизор выключен: на сайте есть поля для ключей бирж, их нельзя записывать.
   • Источник визита: UTM-метки из ссылки, сайт, с которого пришли, или start_param Telegram. Первый источник хранится
     на устройстве и при входе записывается в профиль (profiles.first_source), последний — в profiles.last_source.
   • Разделы приложения считаются как просмотры страниц (#overview, #news…), ключевые действия — как цели. */
(function () {
  "use strict";
  const CFG = window.APP_CONFIG || {};
  const get = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* noop */ } };
  const tg = window.Telegram && window.Telegram.WebApp;
  const inTG = !!(tg && tg.initData);

  // ---------------- источник визита
  const q = new URLSearchParams(location.search);
  const src = {};
  ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach((k) => { const v = q.get(k); if (v) src[k] = v.slice(0, 100); });
  const start = inTG && tg.initDataUnsafe && tg.initDataUnsafe.start_param ? String(tg.initDataUnsafe.start_param).slice(0, 64) : "";
  let ref = "";
  try { const r = document.referrer ? new URL(document.referrer) : null; if (r && r.host !== location.host) ref = r.host.replace(/^www\./, ""); } catch (e) { /* noop */ }
  if (!src.utm_source) {
    if (start) Object.assign(src, { utm_source: "telegram", utm_medium: "startapp", utm_campaign: start });
    else if (inTG) Object.assign(src, { utm_source: "telegram", utm_medium: "mini_app" });
    else if (ref) Object.assign(src, { utm_source: ref, utm_medium: "referral" });
  }
  const platform = inTG ? "telegram" : (window.matchMedia && matchMedia("(display-mode: standalone)").matches ? "pwa" : "web");
  const visit = Object.assign({ ref, landing: (location.pathname + location.hash).slice(0, 120), platform, at: new Date().toISOString() }, src);
  if (!get("cd-src-first")) put("cd-src-first", Object.keys(src).length ? visit : Object.assign({ utm_source: "direct" }, visit));
  if (Object.keys(src).length) put("cd-src-last", visit);

  // ---------------- Яндекс Метрика
  const id = Number(CFG.ym) || 0;
  const t0 = Date.now();
  let ready = false;
  if (id) {
    /* официальный код загрузки tag.js */
    (function (m, e, t, r, i, k, a) {
      m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
      m[i].l = 1 * new Date();
      for (let j = 0; j < document.scripts.length; j++) { if (document.scripts[j].src === r) return; }
      k = e.createElement(t); a = e.getElementsByTagName(t)[0]; k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
    })(window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");
    const params = { platform };
    if (start) params.start_param = start;
    window.ym(id, "init", { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: false, trackHash: false, params });
    ready = true;
  }

  let lastPath = location.hash || "#overview";
  window.CandelAnalytics = {
    enabled: ready,
    // просмотр раздела приложения (одностраничное приложение — разделы меняются без перезагрузки)
    hit(path, title) {
      if (!ready || !path || path === lastPath) return;
      lastPath = path;
      if (Date.now() - t0 < 1500) return; // первый показ уже засчитан при загрузке
      window.ym(id, "hit", location.origin + location.pathname + path, { title: title || document.title });
    },
    goal(name, extra) { if (ready) window.ym(id, "reachGoal", name, extra || {}); },
    user(uid) { if (ready && uid) window.ym(id, "setUserID", String(uid)); },
    first: () => get("cd-src-first"),
    last: () => get("cd-src-last"),
  };
})();
