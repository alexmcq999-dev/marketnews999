/* Торговые сессии мировых рынков — считаются прямо в браузере по часам устройства.
   Переходы на летнее/зимнее время учитываются автоматически через часовые пояса бирж. */
(function () {
  "use strict";

  const MSK = "Europe/Moscow";

  // Праздники NYSE (полностью закрыта) и сокращённые дни (закрытие в 13:00 по Нью-Йорку)
  const NYSE_HOLIDAYS = new Set([
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03",
    "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05",
    "2027-09-06", "2027-11-25", "2027-12-24",
  ]);
  const NYSE_EARLY = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);

  // region: цвет строки; main — основная сессия (с обеденными перерывами), ext — доп. сессии
  const MARKETS = [
    { id: "tse", flag: "🇯🇵", name: "Токио", ex: "TSE", tz: "Asia/Tokyo", region: "asia",
      main: [["09:00", "11:30"], ["12:30", "15:30"]] },
    { id: "hkex", flag: "🇭🇰", name: "Гонконг", ex: "HKEX", tz: "Asia/Hong_Kong", region: "asia",
      main: [["09:30", "12:00"], ["13:00", "16:00"]] },
    { id: "sse", flag: "🇨🇳", name: "Шанхай", ex: "SSE", tz: "Asia/Shanghai", region: "asia",
      main: [["09:30", "11:30"], ["13:00", "15:00"]] },
    { id: "moex", flag: "🇷🇺", name: "Мосбиржа", ex: "MOEX", tz: "Europe/Moscow", region: "ru",
      main: [["10:00", "18:50"]], ext: [["06:50", "09:50", "утренняя сессия"], ["19:05", "23:50", "вечерняя сессия"]] },
    { id: "xetra", flag: "🇩🇪", name: "Франкфурт", ex: "Xetra", tz: "Europe/Berlin", region: "eu",
      main: [["09:00", "17:30"]] },
    { id: "lse", flag: "🇬🇧", name: "Лондон", ex: "LSE", tz: "Europe/London", region: "eu",
      main: [["08:00", "16:30"]] },
    { id: "nyse", flag: "🇺🇸", name: "Нью-Йорк", ex: "NYSE · Nasdaq", tz: "America/New_York", region: "us",
      main: [["09:30", "16:00"]], ext: [["04:00", "09:30", "премаркет"], ["16:00", "20:00", "постмаркет"]],
      holidays: NYSE_HOLIDAYS, early: NYSE_EARLY, earlyClose: "13:00" },
  ];
  const REGION_NAME = { asia: "Азия", ru: "Россия", eu: "Европа", us: "США" };

  // ---------------------------------------------------------------- время и пояса
  const dtfCache = {};
  function parts(ms, tz) {
    const f = dtfCache[tz] || (dtfCache[tz] = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    }));
    const o = {};
    for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
    return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, wd: o.weekday };
  }
  function offset(ms, tz) {
    const p = parts(ms, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  }
  // локальное время биржи -> UTC миллисекунды
  function zoned(y, m, d, hhmm, tz) {
    const [hh, mm] = hhmm.split(":").map(Number);
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    let t = guess - offset(guess, tz);
    t = guess - offset(t, tz);
    return t;
  }
  function ymd(y, m, d) { return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }

  // все интервалы рынка на отрезке дней вокруг «сегодня» по местному времени биржи
  function intervals(mk, now, from = -2, to = 8) {
    const t = parts(now, mk.tz);
    const out = [];
    for (let k = from; k <= to; k++) {
      const base = new Date(Date.UTC(t.y, t.m - 1, t.d + k));
      const y = base.getUTCFullYear(), m = base.getUTCMonth() + 1, d = base.getUTCDate(), wd = base.getUTCDay();
      if (wd === 0 || wd === 6) continue;
      const key = ymd(y, m, d);
      if (mk.holidays && mk.holidays.has(key)) continue;
      const early = mk.early && mk.early.has(key);
      for (const [a, b] of mk.main) {
        const end = early && b > mk.earlyClose ? mk.earlyClose : b;
        if (a >= end) continue;
        out.push({ kind: "main", start: zoned(y, m, d, a, mk.tz), end: zoned(y, m, d, end, mk.tz) });
      }
      for (const [a, b, label] of mk.ext || []) {
        if (early && a >= mk.earlyClose) continue;
        out.push({ kind: "ext", label, start: zoned(y, m, d, a, mk.tz), end: zoned(y, m, d, b, mk.tz) });
      }
    }
    return out.sort((x, y) => x.start - y.start);
  }

  function status(mk, now) {
    const iv = intervals(mk, now);
    const cur = iv.find((s) => s.start <= now && now < s.end && s.kind === "main")
      || iv.find((s) => s.start <= now && now < s.end);
    const nextMain = iv.find((s) => s.kind === "main" && s.start > now);
    if (cur && cur.kind === "main") {
      // конец непрерывной основной сессии (без учёта перерыва) — ближайший end
      return { state: "open", until: cur.end, iv };
    }
    if (cur) return { state: "ext", label: cur.label, until: cur.end, next: nextMain && nextMain.start, iv };
    const lastMain = [...iv].reverse().find((s) => s.kind === "main" && s.end <= now);
    const isBreak = lastMain && nextMain && nextMain.start - lastMain.end < 3 * 3600e3 && parts(lastMain.end, mk.tz).d === parts(nextMain.start, mk.tz).d;
    return { state: isBreak ? "break" : "closed", next: nextMain && nextMain.start, iv };
  }

  // ---------------------------------------------------------------- форматирование
  function dur(ms) {
    const m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return `${m} мин`;
    const h = Math.floor(m / 60), r = m % 60;
    if (h < 24) return r ? `${h} ч ${r} мин` : `${h} ч`;
    const d = Math.floor(h / 24), hh = h % 24;
    return hh ? `${d} д ${hh} ч` : `${d} д`;
  }
  function hm(ms) {
    return new Date(ms).toLocaleTimeString("ru-RU", { timeZone: MSK, hour: "2-digit", minute: "2-digit" });
  }
  function dayLabel(t, now) {
    const a = parts(t, MSK), b = parts(now, MSK);
    if (a.y === b.y && a.m === b.m && a.d === b.d) return "в ";
    const tomorrow = parts(now + 864e5, MSK);
    if (a.y === tomorrow.y && a.m === tomorrow.m && a.d === tomorrow.d) return "завтра ";
    return new Date(t).toLocaleDateString("ru-RU", { timeZone: MSK, weekday: "short" }) + " ";
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------------------------------------------------------------- сводка «что сейчас»
  function summary(st, now) {
    const open = (id) => st[id].state === "open";
    const eu = open("lse") || open("xetra");
    const us = open("nyse");
    const asia = open("tse") || open("hkex") || open("sse");
    const wd = parts(now, MSK).wd;
    const weekend = (wd === "Sat" || wd === "Sun") && !us && !eu && !asia;
    if (weekend) return { title: "Выходные", text: "Фондовые биржи закрыты. Торгуется только крипта, поэтому движения бывают резкими при низкой ликвидности.", tone: "quiet" };
    if (eu && us) return { title: "Европа + США", text: "Пересечение сессий Лондона и Нью-Йорка — самая высокая ликвидность и волатильность дня. Выходят ключевые данные США.", tone: "peak" };
    if (us) return { title: "Сессия США", text: "Основной объём торгов в акциях и крипте. После закрытия Европы ликвидность постепенно снижается.", tone: "high" };
    if (eu && asia) return { title: "Азия → Европа", text: "Европа открылась, Азия завершает день. Объёмы растут, часто задаётся направление на день.", tone: "high" };
    if (eu) return { title: "Европейская сессия", text: "Ликвидность выше средней. Перед открытием США рынок часто ждёт американскую статистику.", tone: "high" };
    if (asia) return { title: "Азиатская сессия", text: "Спокойнее по объёмам. Двигают новости из Китая и Японии, в крипте — азиатские биржи.", tone: "mid" };
    if (st.nyse.state === "ext") return { title: `США: ${st.nyse.label}`, text: "Основная сессия закрыта, торги идут в расширенные часы с низкой ликвидностью. Реакция на отчёты компаний.", tone: "mid" };
    return { title: "Между сессиями", text: "Основные биржи закрыты. Торгуются фьючерсы и крипта, ликвидность минимальная.", tone: "quiet" };
  }

  function nextEvent(st, now) {
    let best = null;
    for (const mk of MARKETS) {
      const s = st[mk.id];
      if (s.state === "open") {
        if (!best || s.until < best.t) best = { t: s.until, text: `закрытие: ${mk.name}` };
      } else if (s.next) {
        if (!best || s.next < best.t) best = { t: s.next, text: `открытие: ${mk.name}` };
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- отрисовка
  function render(el) {
    if (!el) return;
    const now = Date.now();
    const st = {};
    for (const mk of MARKETS) st[mk.id] = status(mk, now);
    const sum = summary(st, now);
    const nx = nextEvent(st, now);

    // окно шкалы: сегодняшние сутки по Москве
    const p = parts(now, MSK);
    const day0 = zoned(p.y, p.m, p.d, "00:00", MSK), day1 = day0 + 864e5;
    const pct = (t) => ((Math.min(Math.max(t, day0), day1) - day0) / 864e5) * 100;
    const nowPct = pct(now);

    let rows = "";
    for (const mk of MARKETS) {
      const s = st[mk.id];
      const segs = s.iv.filter((x) => x.end > day0 && x.start < day1).map((x) => {
        const live = x.start <= now && now < x.end;
        return `<span class="seg ${x.kind} ${mk.region} ${live ? "live" : ""}" style="left:${pct(x.start).toFixed(2)}%;width:${(pct(x.end) - pct(x.start)).toFixed(2)}%"></span>`;
      }).join("");
      let stTxt, stCls;
      if (s.state === "open") { stCls = "open"; stTxt = `открыта · до ${hm(s.until)}`; }
      else if (s.state === "ext") { stCls = "ext"; stTxt = `${s.label} · до ${hm(s.until)}`; }
      else if (s.state === "break") { stCls = "break"; stTxt = `перерыв · с ${hm(s.next)}`; }
      else { stCls = "closed"; stTxt = s.next ? `откр. ${dayLabel(s.next, now)}${hm(s.next)}` : "закрыта"; }
      rows += `<div class="s-row">
        <div class="s-name"><b>${mk.flag} ${esc(mk.name)}</b><span class="s-st ${stCls}">${esc(stTxt)}</span></div>
        <div class="s-track" aria-hidden="true">${segs}</div>
      </div>`;
    }
    rows += `<div class="s-row">
      <div class="s-name"><b>₿ Крипта</b><span class="s-st open">24/7</span></div>
      <div class="s-track" aria-hidden="true"><span class="seg main crypto live" style="left:0;width:100%"></span></div>
    </div>`;

    const ticks = [0, 6, 12, 18, 24].map((h) => `<span style="left:${(h / 24) * 100}%">${String(h).padStart(2, "0")}</span>`).join("");

    el.innerHTML = `
      <div class="sess-now glass tone-${sum.tone}">
        <div class="sess-kicker"><span class="pulse"></span>Сейчас активно · ${hm(now)} МСК</div>
        <div class="sess-title">${esc(sum.title)}</div>
        <p>${esc(sum.text)}</p>
        ${nx ? `<div class="sess-next">Далее ${esc(nx.text)} · ${hm(nx.t)} · через ${dur(nx.t - now)}</div>` : ""}
      </div>
      <div class="glass sess-card">
        <div class="s-grid" style="--nowf:${(nowPct / 100).toFixed(4)}">
          ${rows}
          <div class="s-axis"><div class="s-ticks">${ticks}</div></div>
          <div class="s-nowline" aria-hidden="true"><span>${hm(now)}</span></div>
        </div>
        <div class="s-legend">
          <span><i class="lg asia"></i>Азия</span><span><i class="lg ru"></i>Россия</span><span><i class="lg eu"></i>Европа</span><span><i class="lg us"></i>США</span><span><i class="lg ext"></i>доп. сессии</span>
        </div>
      </div>
      <p class="hint">Шкала — сутки по московскому времени. Летнее и зимнее время учитываются автоматически, праздники — только для NYSE. У Мосбиржи бывают торги выходного дня, здесь они не показаны.</p>`;
  }

  window.MarketSessions = { render, MARKETS, status, summary };
})();
