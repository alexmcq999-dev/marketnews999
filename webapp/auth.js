/* CANDEL — вход через Telegram или Google (Supabase Auth).
   • В мини-приложении Telegram — вход автоматический по initData, без формы.
   • В браузере и в приложении на телефоне (PWA) — экран входа: Telegram или Google.
   • Без настроек Supabase (APP_CONFIG.supabaseUrl / supabaseKey) вход выключен — приложение работает как раньше. */
(function () {
  "use strict";
  const CFG = window.APP_CONFIG || {};
  const tg = window.Telegram && window.Telegram.WebApp;
  const inTG = !!(tg && tg.initData);
  const t = (s) => (window.I18N ? window.I18N.t(s) : s);
  const $ = (s) => document.querySelector(s);
  const AUTH = (window.AUTH = { enabled: false, user: null, listeners: [], onUser(fn) { this.listeners.push(fn); if (this.user) fn(this.user); } });
  if (!CFG.supabaseUrl || !CFG.supabaseKey) return;
  AUTH.enabled = true;
  document.documentElement.classList.add("auth-on");

  const appUrl = location.origin + location.pathname.replace(/[^/]*$/, "");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function loadSdk() {
    return new Promise((res, rej) => {
      if (window.supabase && window.supabase.createClient) return res();
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  async function tgExchange(payload) {
    const r = await fetch(`${CFG.supabaseUrl}/functions/v1/telegram-auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: `Bearer ${CFG.supabaseKey}` },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.token_hash) throw new Error(d.error || `telegram-auth ${r.status}`);
    const { error } = await AUTH.sb.auth.verifyOtp({ token_hash: d.token_hash, type: "magiclink" });
    if (error) throw error;
  }

  // результат входа через Telegram на сайте: #tgAuthResult=<base64> или ?id=…&hash=…
  function telegramReturn() {
    const m = location.hash.match(/tgAuthResult=([^&]+)/);
    if (m) {
      try {
        const b = m[1].replace(/-/g, "+").replace(/_/g, "/");
        return JSON.parse(decodeURIComponent(escape(atob(b + "===".slice((b.length + 3) % 4)))));
      } catch (e) { return null; }
    }
    const q = new URLSearchParams(location.search);
    if (q.get("id") && q.get("hash") && q.get("auth_date")) {
      const o = {};
      ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"].forEach((k) => { if (q.get(k)) o[k] = q.get(k); });
      return o;
    }
    return null;
  }
  function cleanUrl() { history.replaceState(null, "", appUrl + (location.hash.startsWith("#tgAuthResult") ? "" : location.hash)); }

  // ---------------------------------------------------------------- экран входа
  function showLogin(err) {
    const box = $("#login");
    if (!box) return;
    box.hidden = false;
    box.querySelector(".login-err").textContent = err || "";
    document.documentElement.classList.add("wl-on");
    requestAnimationFrame(() => box.classList.add("show"));
    welcome();
    if (err) openAuth();
  }
  // ---------------- приветственный экран: живой брифинг из данных приложения, вход в окне
  let wlDone = false;
  const openAuth = () => { const d = $("#wl-auth"); if (!d) return; d.hidden = false; requestAnimationFrame(() => d.classList.add("show")); const b = d.querySelector(".login-btn"); if (b) b.focus(); };
  const closeAuth = () => { const d = $("#wl-auth"); if (!d || d.hidden) return; d.classList.remove("show"); setTimeout(() => { d.hidden = true; }, 200); };
  async function welcome() {
    if (wlDone) return;
    wlDone = true;
    const box = $("#login");
    box.addEventListener("click", (e) => {
      const a = e.target.closest("[data-wl]");
      if (!a) return;
      const k = a.dataset.wl;
      if (k === "auth") { e.preventDefault(); openAuth(); }
      else if (k === "close") closeAuth();
      else if (k === "top") { e.preventDefault(); box.scrollTo({ top: 0, behavior: "smooth" }); }
      else if (k === "go") { e.preventDefault(); const el = document.querySelector(a.getAttribute("href")); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); }
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAuth(); });
    const lang = window.I18N ? window.I18N.lang : "ru", loc = window.I18N && window.I18N.locale ? window.I18N.locale : "ru-RU";
    const esc2 = (x) => String(x == null ? "" : x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const num = (v, d) => Number(v).toLocaleString(loc, { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
    try {
      const d = await (await fetch(`data/app.json?t=${Date.now()}`, { cache: "no-store" })).json();
      const upd = d.updated ? new Date(d.updated).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }) : "";
      $("#wl-b-upd").textContent = upd ? `${t("обновлено")} ${upd} ${t("МСК")}` : "";
      const mood = lang === "ru" ? d.mood : ((d.mood_i18n || {})[lang] || (d.mood_i18n || {}).en || d.mood);
      $("#wl-b-title").textContent = String(mood || "").split(/(?<=[.!?])\s/)[0] || t("Рынок сегодня");
      const mk = (n) => (d.markets || []).find((x) => x.name === n);
      const btc = mk("BTC"), spx = mk("S&P 500"), fng = (((d.sentiment || {}).fng || {}).crypto || {});
      const cell = (l, v, c) => `<div><small>${esc2(l)}</small><b>${esc2(v)}</b>${c != null ? `<em class="${c >= 0 ? "up" : "down"}">${c >= 0 ? "+" : "−"}${Math.abs(c).toFixed(2)}%</em>` : ""}</div>`;
      $("#wl-b-stats").innerHTML = (btc ? cell("Bitcoin", num(btc.price), btc.chg) : "") + (fng.value != null ? cell(t("Страх и жадность"), String(fng.value)) : "") + (spx ? cell("S&P 500", num(spx.price), spx.chg) : "");
      const TONE = { hawkish: t("ястребино"), dovish: t("голубино"), neutral: t("нейтрально") };
      const ev = (d.calendar || []).filter((e) => e.result && e.impact === "High" && new Date(e.ts) < Date.now()).sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 2);
      $("#wl-b-ev").innerHTML = ev.map((e) => {
        const r = e.result, act = e.actual || r.actual;
        const left = act ? `${e.title} · ${act}${e.forecast ? ` / ${e.forecast}` : ""}` : `${e.title}${TONE[r.tone] ? ` · ${TONE[r.tone]}` : ""}`;
        const rx = (r.reaction || []).find((x) => x.asset === "BTC");
        const right = rx ? `BTC ${rx.value >= 0 ? "+" : "−"}${Math.abs(rx.value).toFixed(2)}% ${t("за час")}` : "";
        return `<div class="wl-b-row"><span>${esc2(left)}</span><span>${esc2(right)}</span></div>`;
      }).join("");
    } catch (er) { $("#wl-b-title").textContent = t("Рынок сегодня"); }
  }
  function hideLogin() {
    const box = $("#login");
    if (!box || box.hidden) return;
    document.documentElement.classList.remove("wl-on");
    box.classList.remove("show");
    setTimeout(() => { box.hidden = true; }, 400);
  }
  function bindLogin() {
    const box = $("#login");
    if (!box) return;
    // Google в WebView Telegram не пускает — там вход только через Telegram (и он автоматический)
    box.querySelector('[data-login="google"]').addEventListener("click", async () => {
      const { error } = await AUTH.sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: appUrl } });
      if (error) showLogin(error.message);
    });
    box.querySelector('[data-login="telegram"]').addEventListener("click", () => {
      if (!CFG.tgBotId) return showLogin(t("Вход через Telegram ещё не настроен."));
      location.href = `https://oauth.telegram.org/auth?bot_id=${encodeURIComponent(CFG.tgBotId)}&origin=${encodeURIComponent(location.origin)}`
        + `&request_access=write&return_to=${encodeURIComponent(appUrl)}`;
    });
  }

  // ---------------------------------------------------------------- профиль
  function userView(u) {
    const m = u.user_metadata || {};
    const provider = m.provider === "telegram" ? "Telegram" : (u.app_metadata && u.app_metadata.provider === "google" ? "Google" : (u.app_metadata || {}).provider || "");
    return { name: m.name || m.full_name || m.username || (u.email || "").split("@")[0], avatar: m.custom_avatar || m.avatar_url || m.picture || "", custom: !!m.custom_avatar, provider, username: m.username };
  }
  function renderProfile() {
    const btn = $("#profile-btn"), sheet = $("#profile");
    if (!btn || !sheet) return;
    const u = AUTH.user;
    btn.hidden = !u;
    document.documentElement.classList.toggle("has-user", !!u);
    if (!u) return;
    const v = userView(u);
    const ini = esc((v.name || "?").trim().slice(0, 1).toUpperCase());
    btn.innerHTML = v.avatar ? `<img src="${esc(v.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()"><i>${ini}</i>` : `<i>${ini}</i>`;
    const sales = !!(window.Pro && window.Pro.sales);
    sheet.innerHTML = `<div class="pf-head"><button class="pf-ava pf-ava-btn" data-pf="avatar" aria-label="${esc(t("Сменить фото"))}" title="${esc(t("Сменить фото"))}">${btn.innerHTML}<em aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/></svg></em></button>
        <span class="pf-who"><b>${esc(v.name)}</b><small>${v.username ? "@" + esc(v.username) + " · " : ""}${esc(t("Вход через"))} ${esc(v.provider)}</small></span></div>
      <div class="pf-photo"><button data-pf="avatar">${esc(t(v.custom ? "Сменить фото" : "Загрузить своё фото"))}</button>${v.custom ? `<button data-pf="avatar-del" class="muted">${esc(t("Убрать"))}</button>` : ""}</div>
      ${sales && AUTH.plan === "pro" ? `<div class="pf-plan${AUTH.planSource === "trial" ? "" : " gold"}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.5 3.5L12 5l4.5 6.5L21 8l-2 10H5z" fill="currentColor"/></svg>CANDEL PRO${AUTH.planSource === "trial" ? ` (${esc(t("пробный"))})` : ""}${AUTH.planUntil ? ` · ${esc(t("до"))} ${esc(new Date(AUTH.planUntil).toLocaleDateString(window.I18N && window.I18N.lang ? window.I18N.lang : undefined))}` : ""}</div>` : ""}
      ${sales ? `<button data-pf="pro" class="pf-pro">${esc(AUTH.plan === "pro" ? t("Моя подписка CANDEL Pro") : t("Оформить CANDEL Pro"))}</button>` : ""}
      <button data-pf="journal">${esc(t("Торговый журнал"))}</button>
      <button data-pf="tour">${esc(t("Как пользоваться"))}</button>
      <button data-pf="refresh">${esc(t("Обновить данные"))}</button>
      ${inTG ? "" : `<button data-pf="logout" class="danger">${esc(t("Выйти"))}</button>`}`;
    sheet.querySelectorAll("[data-pf]").forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.pf === "avatar") { pickAvatar(); return; }
      if (b.dataset.pf === "avatar-del") { removeAvatar(); return; }
      closeSheet();
      if (b.dataset.pf === "refresh") { const r = $("#refresh"); if (r) r.click(); }
      if (b.dataset.pf === "journal" && window.Journal) window.Journal.open();
      if (b.dataset.pf === "pro" && window.Pro) window.Pro.open();
      if (b.dataset.pf === "tour" && window.Tour) window.Tour.start();
      if (b.dataset.pf === "logout") { await AUTH.sb.auth.signOut(); }
    }));
  }
  // ---------------- своё фото профиля: обрезаем по центру до 256×256, сжимаем в JPEG и кладём в Supabase Storage (avatars/<id>/)
  const toast = (m) => { if (window.McQ && window.McQ.toast) window.McQ.toast(m); else console.log(m); };
  function pickAvatar() {
    let inp = document.getElementById("ava-input");
    if (!inp) {
      inp = document.createElement("input");
      inp.type = "file"; inp.accept = "image/*"; inp.id = "ava-input"; inp.hidden = true;
      document.body.appendChild(inp);
      inp.addEventListener("change", () => { const f = inp.files && inp.files[0]; inp.value = ""; if (f) uploadAvatar(f); });
    }
    inp.click();
  }
  function squareJpeg(file, size) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        if (!s) { URL.revokeObjectURL(url); rej(new Error("img")); return; }
        const c = document.createElement("canvas"); c.width = c.height = size;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#111"; ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? res(b) : rej(new Error("blob"))), "image/jpeg", 0.86);
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("img")); };
      img.src = url;
    });
  }
  async function uploadAvatar(file) {
    if (!AUTH.sb || !AUTH.user) return;
    if (!/^image\//.test(file.type || "image/")) { toast(t("Это не картинка")); return; }
    if (file.size > 15 * 1024 * 1024) { toast(t("Файл больше 15 МБ")); return; }
    const box = document.querySelector("#profile .pf-ava-btn");
    if (box) box.classList.add("busy");
    try {
      const blob = await squareJpeg(file, 256);
      const path = `${AUTH.user.id}/avatar.jpg`;
      const up = await AUTH.sb.storage.from("avatars").upload(path, blob, { upsert: true, contentType: "image/jpeg", cacheControl: "3600" });
      if (up.error) throw up.error;
      const pub = AUTH.sb.storage.from("avatars").getPublicUrl(path).data.publicUrl;
      const r = await AUTH.sb.auth.updateUser({ data: { custom_avatar: `${pub}?v=${Date.now()}` } });
      if (r.error) throw r.error;
      AUTH.user = r.data.user || AUTH.user;
      renderProfile(); saveProfile(AUTH.user);
      toast(t("Фото обновлено"));
    } catch (e) {
      console.warn("avatar", e);
      toast(t("Не удалось загрузить фото. Попробуй ещё раз."));
    } finally { if (box) box.classList.remove("busy"); }
  }
  async function removeAvatar() {
    if (!AUTH.sb || !AUTH.user) return;
    try {
      await AUTH.sb.storage.from("avatars").remove([`${AUTH.user.id}/avatar.jpg`]).catch(() => null);
      const r = await AUTH.sb.auth.updateUser({ data: { custom_avatar: null } });
      if (r.error) throw r.error;
      AUTH.user = r.data.user || AUTH.user;
      renderProfile(); saveProfile(AUTH.user);
    } catch (e) { toast(t("Не удалось убрать фото")); }
  }
  function closeSheet() { const s = $("#profile"); if (s) { s.classList.remove("show"); setTimeout(() => { s.hidden = true; }, 200); } }
  function bindProfile() {
    const btn = $("#profile-btn"), sheet = $("#profile");
    if (!btn || !sheet) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!sheet.hidden) return closeSheet();
      const r = btn.getBoundingClientRect();
      sheet.style.top = `${r.bottom + 8}px`;
      sheet.style.right = `${Math.max(12, innerWidth - r.right)}px`;
      sheet.hidden = false;
      requestAnimationFrame(() => sheet.classList.add("show"));
    });
    document.addEventListener("click", (e) => { if (!sheet.hidden && !sheet.contains(e.target)) closeSheet(); });
  }

  async function saveProfile(u) {
    const v = userView(u);
    const m = u.user_metadata || {};
    try {
      await AUTH.sb.from("profiles").upsert({
        id: u.id, provider: v.provider.toLowerCase(), tg_id: m.tg_id || null, name: v.name, username: v.username || null,
        avatar_url: v.avatar || null, lang: window.I18N ? window.I18N.lang : null,
        mode: document.documentElement.dataset.mode || null, last_seen: new Date().toISOString(),
      });
    } catch (e) { /* таблицы может не быть — вход всё равно работает */ }
    // откуда пришёл человек: первый источник пишем один раз, последний — обновляем (колонки из миграции 20261121_sources.sql)
    const CA = window.CandelAnalytics;
    if (CA) {
      try { const f = CA.first(); if (f) await AUTH.sb.from("profiles").update({ first_source: f }).eq("id", u.id).is("first_source", null); } catch (e) { /* noop */ }
      try { const l = CA.last(); if (l) await AUTH.sb.from("profiles").update({ last_source: l }).eq("id", u.id); } catch (e) { /* noop */ }
    }
  }
  AUTH.saveSettings = () => { if (AUTH.user) saveProfile(AUTH.user); };

  // золотой статус PRO — у оплаченной подписки (пробный период выглядит как обычный аккаунт)
  function planUi() {
    const paid = !!(window.Pro && window.Pro.sales) && AUTH.plan === "pro" && AUTH.planSource !== "trial";
    document.documentElement.classList.toggle("is-pro", paid);
    const b = document.querySelector(".pro-badge");
    if (b) b.title = paid ? "CANDEL PRO" : "";
  }

  // подписка CANDEL Pro: строка в таблице subscriptions (пишет только сервер/админ, клиент лишь читает свою)
  let planReq = null;
  AUTH.plan = "free";
  AUTH.loadPlan = () => {
    if (!AUTH.sb || !AUTH.user) return Promise.resolve("free");
    if (!planReq) {
      planReq = AUTH.sb.from("subscriptions").select("plan,until,source").eq("user_id", AUTH.user.id).maybeSingle()
        .then(({ data }) => {
          const ok = data && data.plan === "pro" && (!data.until || new Date(data.until) > new Date());
          AUTH.plan = ok ? "pro" : "free";
          AUTH.planUntil = ok ? data.until : null;
          AUTH.planSource = ok ? data.source || null : null;
          planUi();
          return AUTH.plan;
        })
        .catch(() => "free");
    }
    return planReq;
  };
  // перечитать подписку (после оплаты) и обновить профиль; событие mcq:plan — для экранов, которые ждут PRO
  AUTH.refreshPlan = () => {
    planReq = null;
    return AUTH.loadPlan().then((p) => {
      renderProfile();
      try { document.dispatchEvent(new CustomEvent("mcq:plan", { detail: p })); } catch (e) { /* noop */ }
      return p;
    });
  };
  AUTH.showLogin = () => showLogin();

  function setUser(u) {
    const changed = (AUTH.user && AUTH.user.id) !== (u && u.id);
    AUTH.user = u || null;
    if (changed) { planReq = null; AUTH.plan = "free"; AUTH.planSource = null; planUi(); }
    renderProfile();
    if (u) { hideLogin(); if (changed) { if (window.CandelAnalytics) { window.CandelAnalytics.user(u.id); window.CandelAnalytics.goal("login"); } saveProfile(u); AUTH.loadPlan().then(renderProfile); AUTH.listeners.forEach((fn) => { try { fn(u); } catch (e) { /* noop */ } }); } }
    else if (!inTG) showLogin();
  }

  // кнопку Google показываем, только если провайдер включён в Supabase (Authentication → Providers → Google)
  function checkProviders() {
    fetch(`${CFG.supabaseUrl}/auth/v1/settings`, { headers: { apikey: CFG.supabaseKey } })
      .then((r) => r.json())
      .then((s) => {
        const g = document.querySelector('#login [data-login="google"]');
        if (g && s && s.external && s.external.google === false) g.hidden = true;
      })
      .catch(() => { /* не удалось проверить — оставляем кнопку */ });
  }

  // ---------------------------------------------------------------- старт
  (async () => {
    bindLogin();
    checkProviders();
    bindProfile();
    try { await loadSdk(); } catch (e) { AUTH.enabled = false; document.documentElement.classList.remove("auth-on"); return; }
    AUTH.sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
      auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
    });
    AUTH.sb.auth.onAuthStateChange((_ev, s) => setUser(s ? s.user : null));
    let err = "";
    try {
      const ret = telegramReturn();
      if (ret) { cleanUrl(); await tgExchange({ widget: ret }); }
    } catch (e) { err = t("Не удалось войти через Telegram. Попробуй ещё раз."); }
    const { data } = await AUTH.sb.auth.getSession();
    let u = data && data.session ? data.session.user : null;
    if (inTG) {
      const tgId = String((tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) || "");
      if (!u || String((u.user_metadata || {}).tg_id || "") !== tgId) {
        try { await tgExchange({ initData: tg.initData }); } catch (e) { /* без входа мини-приложение всё равно работает */ }
        u = ((await AUTH.sb.auth.getSession()).data.session || {}).user || u;
      }
    }
    setUser(u);
    if (!u && err) showLogin(err);
  })();
})();
