/* McQCryptoNews — вход через Telegram или Google (Supabase Auth).
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
    requestAnimationFrame(() => box.classList.add("show"));
  }
  function hideLogin() {
    const box = $("#login");
    if (!box || box.hidden) return;
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
    return { name: m.name || m.full_name || m.username || (u.email || "").split("@")[0], avatar: m.avatar_url || m.picture || "", provider, username: m.username };
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
    sheet.innerHTML = `<div class="pf-head"><span class="pf-ava">${btn.innerHTML}</span>
        <span class="pf-who"><b>${esc(v.name)}</b><small>${v.username ? "@" + esc(v.username) + " · " : ""}${esc(t("Вход через"))} ${esc(v.provider)}</small></span></div>
      <button data-pf="refresh">${esc(t("Обновить данные"))}</button>
      ${inTG ? "" : `<button data-pf="logout" class="danger">${esc(t("Выйти"))}</button>`}`;
    sheet.querySelectorAll("[data-pf]").forEach((b) => b.addEventListener("click", async () => {
      closeSheet();
      if (b.dataset.pf === "refresh") { const r = $("#refresh"); if (r) r.click(); }
      if (b.dataset.pf === "logout") { await AUTH.sb.auth.signOut(); }
    }));
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
  }
  AUTH.saveSettings = () => { if (AUTH.user) saveProfile(AUTH.user); };

  function setUser(u) {
    const changed = (AUTH.user && AUTH.user.id) !== (u && u.id);
    AUTH.user = u || null;
    renderProfile();
    if (u) { hideLogin(); if (changed) { saveProfile(u); AUTH.listeners.forEach((fn) => { try { fn(u); } catch (e) { /* noop */ } }); } }
    else if (!inTG) showLogin();
  }

  // ---------------------------------------------------------------- старт
  (async () => {
    bindLogin();
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
