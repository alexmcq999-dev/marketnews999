/* McQ Pro — экран подписки и оплата.
   • В Telegram (мини-приложение) — только Telegram Stars: ежемесячная подписка через Telegram.WebApp.openInvoice.
     Правила Telegram запрещают внутри мини-приложений другие способы оплаты цифровых товаров.
   • В браузере / PWA — USDT через Crypto Pay (разово, 30 дней) и, как запасной вариант, Stars в приложении Telegram.
   Оплату подтверждает сервер (функция billing → таблица subscriptions); здесь только ждём, пока подписка появится. */
(function () {
  "use strict";
  const CFG = window.APP_CONFIG || {};
  const tg = window.Telegram && window.Telegram.WebApp;
  const inTG = !!(tg && tg.initData);
  const _t = (s) => (window.I18N ? window.I18N.t(s) : s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fn = () => `${CFG.supabaseUrl}/functions/v1/billing`;
  const S = { conf: null, el: null, poll: null, busy: false };

  async function call(action, auth) {
    const A = window.AUTH;
    let token = CFG.supabaseKey;
    if (auth) {
      const sess = A && A.sb ? (await A.sb.auth.getSession()).data.session : null;
      if (!sess) throw new Error("auth");
      token = sess.access_token;
    }
    const r = await fetch(fn(), {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || `billing ${r.status}`);
    return d;
  }
  // доступен ли пробный период этому аккаунту (спрашиваем сервер, кэшируем на сеанс)
  async function trialStatus() {
    const A = window.AUTH;
    if (!A || !A.user) return { trial_available: false };
    if (S.status && S.status.uid === A.user.id) return S.status;
    try { S.status = Object.assign({ uid: A.user.id }, await call("status", true)); } catch (e) { S.status = { uid: A.user.id, trial_available: false }; }
    return S.status;
  }
  function config() {
    if (!S.conf) S.conf = call("config").catch(() => { S.conf = null; return { stars: null, usdt: null, days: 30 }; });
    return S.conf;
  }

  const fmtDate = (s) => new Date(s).toLocaleDateString(window.I18N && window.I18N.lang ? window.I18N.lang : undefined, { day: "numeric", month: "long", year: "numeric" });
  const haptic = (k) => { try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred(k); } catch (e) { /* noop */ } };

  function shell() {
    if (S.el) return S.el;
    const el = document.createElement("div");
    el.className = "pro";
    el.id = "pro";
    el.hidden = true;
    el.innerHTML = `<div class="pro-bg" data-pro="close"></div><div class="pro-sheet glass" role="dialog" aria-modal="true"><div class="pro-body"></div></div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => { if (e.target.closest('[data-pro="close"]')) close(); });
    S.el = el;
    return el;
  }

  const FEATURES = [
    ["chart", "Pro Chart", "Свечи, объём и VWAP в каждой свече по 9 крупнейшим биржам, профиль объёма, CVD, OI и фандинг"],
    ["ai", "ИИ-ассистент", "Разбор графика, уровни и план сделки прямо на чарте"],
    ["journal", "ИИ-разбор журнала", "Что работает, где утекают деньги и правила на неделю по твоим сделкам"],
  ];
  const ICONS = {
    chart: '<path d="M4 19V5M4 19h16M8 15l3-4 3 2 4-6"/>',
    ai: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/>',
    journal: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  };
  const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>`;

  async function render(state) {
    const el = shell();
    const body = el.querySelector(".pro-body");
    const A = window.AUTH || {};
    const c = await config();
    const pro = A.plan === "pro";
    const auto = pro && A.planSource === "stars";
    const onTrial = pro && A.planSource === "trial";
    const paid = pro && !onTrial;
    const st = A.user && !pro ? await trialStatus() : { trial_available: false };
    const trialDays = c.trial_days || st.trial_days || 3;
    const canTrial = !!st.trial_available && !!(c.stars || c.usdt);
    const usd = c.usdt ? c.usdt.price : 29.9;
    const head = `<button class="pro-x" data-pro="close" aria-label="${esc(_t("Закрыть"))}">✕</button>
      <div class="pro-tag">McQ PRO</div>
      <h3>${esc(state === "trial-done" ? _t("Пробный период активирован") : state === "done" ? _t("McQ Pro активирован") : _t("Инструменты для тех, кто торгует всерьёз"))}</h3>
      ${state === "done" || state === "trial-done" || paid ? "" : `<div class="pro-price"><b>$${usd}</b> / ${esc(_t("мес"))}${canTrial ? ` · <span>${esc(_t("первые {n} дня бесплатно").replace("{n}", trialDays))}</span>` : ""}</div>`}`;
    const feats = `<ul class="pro-feats">${FEATURES.map(([k, h, d]) => `<li><span class="pro-ic">${icon(k)}</span><span><b>${esc(_t(h))}</b><small>${esc(_t(d))}</small></span></li>`).join("")}</ul>`;
    let status = "";
    if (onTrial) status = `<div class="pro-status trial"><b>${esc(_t("Пробный период"))}</b> · ${esc(_t("до"))} ${esc(fmtDate(A.planUntil))}
      <small>${esc(_t("Оформи подписку, чтобы PRO не отключился. Оплаченные дни добавятся после пробного периода."))}</small></div>`;
    else if (pro) status = `<div class="pro-status"><b>${esc(_t("Подписка активна"))}</b>${A.planUntil ? ` · ${esc(_t("до"))} ${esc(fmtDate(A.planUntil))}` : ""}
      ${auto ? `<small>${esc(_t("Продлевается автоматически. Управлять: Настройки Telegram → Мои звёзды."))}</small>` : ""}</div>`;

    let actions = "";
    if (state === "wait") {
      actions = `<div class="pro-wait"><i class="pro-spin"></i><span>${esc(_t("Ждём подтверждение оплаты…"))}</span></div>
        <button class="pro-alt" data-pro="check">${esc(_t("Я оплатил — проверить"))}</button>`;
    } else if (state === "done" || state === "trial-done") {
      actions = `<button class="pro-cta" data-pro="close">${esc(_t("Отлично"))}</button>`;
    } else if (!A.enabled) {
      actions = `<p class="pro-note">${esc(_t("Подписка станет доступна после настройки входа."))}</p>`;
    } else if (!A.user) {
      actions = `<button class="pro-cta" data-pro="login">${esc(_t("Войти, чтобы оформить"))}</button>`;
    } else if (inTG) {
      if (auto) actions = "";
      else if (c.stars) actions = (canTrial ? trialBtn(trialDays) : "") + `<button class="${canTrial ? "pro-alt" : "pro-cta"}" data-pro="stars">${esc(paid ? _t("Продлить") : _t("Оформить"))} · ⭐ ${c.stars.price} / ${esc(_t("мес"))}</button>
        <p class="pro-note">${esc(_t("Оплата звёздами Telegram. Подписка продлевается каждые 30 дней, отменить можно в любой момент."))}</p>`;
      else actions = `<p class="pro-note">${esc(_t("Оплата скоро появится."))}</p>`;
    } else {
      const btns = [];
      if (canTrial) btns.push(trialBtn(trialDays));
      if (c.usdt) btns.push(`<button class="${canTrial ? "pro-alt" : "pro-cta"}" data-pro="usdt"><span class="pro-usdt">₮</span> ${esc(paid ? _t("Продлить") : _t("Оплатить"))} ${c.usdt.price} USDT · 30 ${esc(_t("дней"))}</button>`);
      if (c.stars && !auto) btns.push(`<button class="${c.usdt ? "pro-alt" : "pro-cta"}" data-pro="stars-web">⭐ ${c.stars.price} / ${esc(_t("мес"))} — ${esc(_t("в Telegram"))}</button>`);
      actions = btns.length ? btns.join("") + (c.usdt ? `<p class="pro-note">${esc(_t("USDT — через @CryptoBot: из кошелька Telegram или с биржи. Доступ откроется сразу после оплаты, в том числе в Telegram."))}</p>` : "")
        : (auto ? "" : `<p class="pro-note">${esc(_t("Оплата скоро появится."))}</p>`);
    }
    const terms = `<a class="pro-terms" href="privacy.html" target="_blank" rel="noopener">${esc(_t("Условия и конфиденциальность"))}</a>`;
    if (state === "trial-done") status = `<div class="pro-status trial"><b>${esc(_t("PRO открыт"))}</b> · ${esc(_t("до"))} ${esc(fmtDate(A.planUntil))}
      <small>${esc(_t("Без оплаты. Когда пробный период закончится, PRO просто выключится — ничего не спишется. Оформить подписку можно в профиле."))}</small></div>`;
    body.innerHTML = head + (state === "done" || state === "trial-done" ? "" : feats) + status + `<div class="pro-actions">${actions}</div>` + (state === "err" ? `<p class="pro-err">${esc(S.err || "")}</p>` : "") + terms;
    body.querySelectorAll("[data-pro]").forEach((b) => b.addEventListener("click", onAction));
  }

  function trialBtn(days) {
    return `<button class="pro-cta" data-pro="trial">${esc(_t("Попробовать {n} дня бесплатно").replace("{n}", days))}</button>
      <p class="pro-note">${esc(_t("Без привязки карты и оплаты. Потом — по подписке, если понравится."))}</p>`;
  }

  async function onAction(e) {
    const k = e.currentTarget.dataset.pro;
    if (k === "close") return;
    if (S.busy) return;
    if (k === "login") { close(); if (window.AUTH && window.AUTH.showLogin) window.AUTH.showLogin(); return; }
    if (k === "check") { await refresh(); return; }
    const b = e.currentTarget;
    S.busy = true;
    b.classList.add("busy");
    try {
      if (k === "trial") {
        try { await call("trial", true); } catch (err) {
          if (err.message === "trial_used" || err.message === "already_pro") { S.status = null; S.err = _t("Пробный период уже использован на этом аккаунте."); render("err"); return; }
          throw err;
        }
        S.status = null;
        if (window.AUTH && window.AUTH.refreshPlan) await window.AUTH.refreshPlan();
        haptic("success"); render("trial-done"); return;
      }
      if (k === "stars") {
        const { url } = await call("stars", true);
        tg.openInvoice(url, (status) => {
          if (status === "paid") { haptic("success"); render("wait"); waitPaid(); }
          else if (status === "failed") { S.err = _t("Оплата не прошла. Попробуй ещё раз."); render("err"); }
        });
      } else if (k === "stars-web") {
        const { url } = await call("stars", true);
        window.open(url, "_blank", "noopener");
        render("wait"); waitPaid();
      } else if (k === "usdt") {
        const w = window.open("about:blank", "_blank");     // открываем сразу — иначе Safari блокирует всплывающее окно
        const d = await call("usdt", true);
        if (w) w.location.href = d.url; else location.href = d.url;
        render("wait"); waitPaid();
      }
    } catch (err) {
      S.err = err.message === "auth" ? _t("Войди в аккаунт и попробуй снова.") : k === "trial" ? _t("Не удалось включить пробный период. Попробуй ещё раз.") : _t("Не удалось создать счёт. Попробуй ещё раз.");
      render("err");
    } finally { S.busy = false; b.classList.remove("busy"); }
  }

  async function refresh() {
    const A = window.AUTH;
    if (!A || !A.refreshPlan) return false;
    const before = A.planUntil;
    const p = await A.refreshPlan();
    if (p === "pro" && A.planUntil !== S.untilAtStart) { stopPoll(); haptic("success"); render("done"); return true; }
    return before !== A.planUntil;
  }
  function waitPaid() {
    stopPoll();
    let n = 0;
    S.poll = setInterval(async () => {
      n++;
      if (S.el.hidden || n > 90) return stopPoll();      // ~6 минут
      if (n % 2 === 0 || n < 10) await refresh();
    }, 4000);
  }
  function stopPoll() { if (S.poll) clearInterval(S.poll); S.poll = null; }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.poll) refresh(); });

  async function open() {
    const el = shell();
    const A = window.AUTH;
    if (A && A.loadPlan) await A.loadPlan();
    S.untilAtStart = A ? A.planUntil : null;
    await render();
    el.hidden = false;
    document.documentElement.classList.add("pro-open");
    requestAnimationFrame(() => el.classList.add("show"));
    if (tg) { try { tg.BackButton.show(); tg.BackButton.onClick(close); } catch (e) { /* noop */ } }
  }
  function close() {
    if (!S.el || S.el.hidden) return;
    stopPoll();
    S.el.classList.remove("show");
    document.documentElement.classList.remove("pro-open");
    setTimeout(() => { S.el.hidden = true; }, 250);
    if (tg) {
      try {
        tg.BackButton.offClick(close);
        // если под нами открыт Pro Chart или журнал — кнопка «Назад» нужна им
        if (!document.querySelector(".pc.show, .jr.show")) tg.BackButton.hide();
      } catch (e) { /* noop */ }
    }
  }

  window.Pro = { open, close, available: () => !!(CFG.supabaseUrl && CFG.supabaseKey), _test: { S, render } };
  if (location.hash === "#pro") setTimeout(open, 600);
})();
