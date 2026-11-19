/* McQ Journal — торговый журнал.
   • Пользователь подключает биржу read-only ключом (или адресом кошелька для Hyperliquid).
   • Ключи хранятся ТОЛЬКО на этом устройстве: IndexedDB, зашифрованы AES-GCM неизвлекаемым ключом браузера.
     Запросы к биржам подписываются прямо на устройстве (WebCrypto), секрет никуда не отправляется.
   • BingX и Bitunix не разрешают запросы из браузера — для них запрос подписывается на устройстве и пересылается
     через функцию Supabase exchange-relay (она видит только публичный API key и одноразовую подпись).
   • Сделки собираются в закрытые позиции, считается сводка: PnL, win rate, profit factor, просадка,
     разрезы по монетам/сторонам/часам, авто-выводы. ИИ-разбор торговли — функция chart-ai (kind: journal). */
(function () {
  "use strict";
  const I18 = window.I18N || { t: (s) => s, lang: "ru", locale: "ru-RU" };
  const _t = I18.t;
  const CFG = window.APP_CONFIG || {};
  const tg = window.Telegram && window.Telegram.WebApp;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DAY = 86400000;
  const enc = new TextEncoder();

  // ================================================================ хранилище (IndexedDB, секреты зашифрованы)
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open("mcq-journal", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function kvGet(k) { const d = await db(); return new Promise((res, rej) => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
  async function kvSet(k, v) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
  async function kvDel(k) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }

  async function vaultKey() {
    let k = await kvGet("__vault_key");
    if (!k) {
      k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await kvSet("__vault_key", k);
    }
    return k;
  }
  async function seal(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await vaultKey(), enc.encode(JSON.stringify(obj)));
    return { iv, data };
  }
  async function unseal(box) {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: box.iv }, await vaultKey(), box.data);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  // ================================================================ подписи
  async function hmac(secret, msg, out) {
    const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const s = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
    if (out === "b64") { let b = ""; s.forEach((x) => { b += String.fromCharCode(x); }); return btoa(b); }
    return [...s].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  const qs = (o) => Object.keys(o).filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== "").map((k) => `${k}=${encodeURIComponent(o[k])}`).join("&");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function getJSON(url, opt) {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(url, Object.assign({ signal: ctl.signal }, opt || {}));
      const txt = await r.text();
      let d = null; try { d = JSON.parse(txt); } catch (e) { d = { raw: txt }; }
      if (!r.ok) { const m = d && (d.msg || d.retMsg || d.message || d.error) || txt.slice(0, 120) || r.status; throw new Error(`${r.status}: ${m}`); }
      return d;
    } finally { clearTimeout(tm); }
  }
  // параллельно, но не больше n запросов одновременно
  async function pool(items, n, fn) {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
    return out;
  }
  function windows(from, to, step) { const w = []; for (let s = from; s < to; s += step) w.push([s, Math.min(to, s + step - 1)]); return w; }

  // ================================================================ сборка позиций из сделок (Binance, Hyperliquid)
  // fills: [{key, sym, side:"buy"|"sell", qty, px, fee, pnl, t, id, start (знаковая позиция до сделки, если биржа даёт)}]
  function buildPositions(fills, ex, fundingOf) {
    const out = [], st = new Map();
    fills.sort((a, b) => a.t - b.t || String(a.id).localeCompare(String(b.id)));
    const closeRec = (p, t, partialHistory) => {
      const dir = p.side === "long" ? 1 : -1;
      const entry = p.inQty ? p.inCost / p.inQty : null;
      const exit = p.outQty ? p.outCost / p.outQty : null;
      let gross = p.pnl;
      if (!p.hasPnl && entry && exit) gross = (exit - entry) * p.outQty * dir;
      const funding = fundingOf ? fundingOf(p.sym, p.openT || t - DAY, t) : 0;
      out.push({ id: `${ex}:${p.sym}:${p.firstId}`, ex, sym: p.sym, side: p.side, qty: p.outQty || p.maxQ, entry, exit,
        notional: (entry || exit || 0) * (p.outQty || p.maxQ), gross, fee: p.fee, funding, pnl: gross - p.fee + funding,
        openT: p.openT, closeT: t, open: false, partial: !!partialHistory });
    };
    for (const f of fills) {
      const k = f.key || f.sym;
      let p = st.get(k);
      const sgn = f.side === "buy" ? 1 : -1;
      let qty = f.qty;
      // позиция открыта до начала истории: «засеваем» её — по startPosition (Hyperliquid) или по закрывающей сделке с PnL (Binance)
      if (!p || Math.abs(p.q) < 1e-12) {
        let startQ = 0;
        if (f.start && Math.abs(f.start) > 1e-12) startQ = f.start;
        else if (f.closing && f.pnl && Math.abs(f.pnl) > 1e-9) startQ = -sgn * qty;
        if (startQ) {
          const dir = startQ > 0 ? 1 : -1, q0 = Math.abs(startQ);
          const entry = dir !== sgn && f.pnl ? f.px - f.pnl / (Math.min(qty, q0) * dir) : f.px;
          p = { sym: f.sym, side: dir > 0 ? "long" : "short", q: startQ, inQty: q0, inCost: entry * q0, outQty: 0, outCost: 0, pnl: 0, hasPnl: false, fee: 0, openT: null, firstId: f.id, maxQ: q0, partialHist: true };
          st.set(k, p);
        }
      }
      while (qty > 1e-12) {
        if (!p || Math.abs(p.q) < 1e-12) {
          p = { sym: f.sym, side: sgn > 0 ? "long" : "short", q: 0, inQty: 0, inCost: 0, outQty: 0, outCost: 0, pnl: 0, hasPnl: false, fee: 0, openT: f.t, firstId: f.id, maxQ: 0 };
          st.set(k, p);
        }
        const dir = p.side === "long" ? 1 : -1;
        if (sgn === dir) { // наращиваем
          p.inQty += qty; p.inCost += qty * f.px; p.q += sgn * qty; p.maxQ = Math.max(p.maxQ, Math.abs(p.q));
          p.fee += f.fee * (qty / f.qty);
          qty = 0;
        } else { // сокращаем / закрываем / переворачиваем
          const c = Math.min(qty, Math.abs(p.q));
          const share = c / f.qty;
          p.outQty += c; p.outCost += c * f.px; p.q += sgn * c;
          if (f.pnl != null) { p.pnl += f.pnl * share; p.hasPnl = true; }
          p.fee += f.fee * share;
          qty -= c;
          if (Math.abs(p.q) < 1e-9 * Math.max(1, p.maxQ)) { closeRec(p, f.t, p.partialHist); st.delete(k); p = null; }
        }
      }
    }
    // ещё открытые позиции
    for (const p of st.values()) {
      if (Math.abs(p.q) < 1e-12) continue;
      out.push({ id: `${ex}:${p.sym}:${p.firstId}:open`, ex, sym: p.sym, side: p.side, qty: Math.abs(p.q), entry: p.inQty ? p.inCost / p.inQty : null, exit: null,
        notional: (p.inQty ? p.inCost / p.inQty : 0) * Math.abs(p.q), gross: p.pnl, fee: p.fee, funding: 0, pnl: p.pnl - p.fee, openT: p.openT, closeT: null, open: true });
    }
    return out;
  }
  const baseSym = (s) => String(s).toUpperCase().replace(/[-_]?(USDT|USDC|USD|PERP|SWAP)$/g, "").replace(/-USDT-SWAP$/, "").replace(/^1000/, "");

  // ================================================================ биржи
  const EX = {};

  // ---------- Binance USDⓈ-M Futures
  EX.binance = {
    name: "Binance Futures", fields: ["key", "secret"],
    help: ["Binance → Профиль → Управление API → Создать API (System generated)", "Оставь включённым только «Enable Reading». Торговлю и вывод НЕ включай", "Скопируй API Key и Secret Key сюда"],
    async req(c, path, params) {
      const p = Object.assign({}, params, { timestamp: Date.now() + (c._off || 0), recvWindow: 15000 });
      const q = qs(p);
      const sig = await hmac(c.secret, q);
      return getJSON(`https://fapi.binance.com${path}?${q}&signature=${sig}`, { headers: { "X-MBX-APIKEY": c.key } });
    },
    async check(c) {
      try { const t = await getJSON("https://fapi.binance.com/fapi/v1/time"); c._off = t.serverTime - Date.now(); } catch (e) { /* noop */ }
      await this.req(c, "/fapi/v2/balance", {});
      // права ключа (спотовый API): вывод должен быть выключен
      try {
        const q = qs({ timestamp: Date.now() + (c._off || 0), recvWindow: 15000 });
        const r = await getJSON(`https://api.binance.com/sapi/v1/account/apiRestrictions?${q}&signature=${await hmac(c.secret, q)}`, { headers: { "X-MBX-APIKEY": c.key } });
        return { withdraw: !!r.enableWithdrawals, trade: !!(r.enableFutures || r.enableSpotAndMarginTrading || r.enableMargin) };
      } catch (e) { return {}; }
    },
    async equity(c) { const r = await this.req(c, "/fapi/v2/account", {}); return +r.totalMarginBalance || +r.totalWalletBalance || null; },
    async sync(c, from, to, progress) {
      try { const t = await getJSON("https://fapi.binance.com/fapi/v1/time"); c._off = t.serverTime - Date.now(); } catch (e) { /* noop */ }
      const income = [];
      for (const [a, b] of windows(from, to, 7 * DAY)) {
        let s = a;
        for (let guard = 0; guard < 20; guard++) {
          const r = await this.req(c, "/fapi/v1/income", { startTime: s, endTime: b, limit: 1000 });
          income.push(...r);
          if (r.length < 1000) break;
          s = r[r.length - 1].time + 1;
        }
      }
      const syms = [...new Set(income.filter((x) => x.incomeType === "REALIZED_PNL" || x.incomeType === "COMMISSION").map((x) => x.symbol).filter(Boolean))];
      const fund = income.filter((x) => x.incomeType === "FUNDING_FEE");
      const fills = [];
      let done = 0;
      await pool(syms, 3, async (sym) => {
        for (const [a, b] of windows(from, to, 7 * DAY)) {
          let s = a;
          for (let guard = 0; guard < 20; guard++) {
            const r = await this.req(c, "/fapi/v1/userTrades", { symbol: sym, startTime: s, endTime: b, limit: 1000 });
            for (const f of r) {
              fills.push({ key: `${f.symbol}:${f.positionSide}`, sym: baseSym(f.symbol), side: f.side === "BUY" ? "buy" : "sell", qty: +f.qty, px: +f.price,
                fee: f.commissionAsset === "USDT" || f.commissionAsset === "USDC" ? +f.commission : 0, pnl: +f.realizedPnl, t: f.time, id: f.id,
                closing: +f.realizedPnl !== 0 });
            }
            if (r.length < 1000) break;
            s = r[r.length - 1].time + 1;
          }
        }
        progress && progress(++done / syms.length);
      });
      const fundingOf = (sym, a, b) => fund.filter((x) => baseSym(x.symbol) === sym && x.time >= a && x.time <= b).reduce((s, x) => s + +x.income, 0);
      return buildPositions(fills, "binance", fundingOf);
    },
  };

  // ---------- Bybit (USDT-перпы): готовые закрытые позиции
  EX.bybit = {
    name: "Bybit", fields: ["key", "secret"],
    help: ["Bybit → Профиль → API → Создать новый ключ → «Системный»", "Права: «Только чтение» (Read-Only). Без IP-ограничения или с ним — как удобно", "Скопируй API Key и API Secret сюда"],
    async req(c, path, params) {
      const ts = String(Date.now() + (c._off || 0)), rw = "15000", q = qs(params);
      const sign = await hmac(c.secret, ts + c.key + rw + q);
      return getJSON(`https://api.bybit.com${path}?${q}`, { headers: { "X-BAPI-API-KEY": c.key, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": rw, "X-BAPI-SIGN": sign } })
        .then((d) => { if (d.retCode !== 0) throw new Error(d.retMsg || `retCode ${d.retCode}`); return d.result; });
    },
    async time(c) { try { const t = await getJSON("https://api.bybit.com/v5/market/time"); c._off = Math.round(+t.result.timeNano / 1e6) - Date.now(); } catch (e) { /* noop */ } },
    async check(c) {
      await this.time(c);
      const r = await this.req(c, "/v5/user/query-api", {});
      const perm = r.permissions || {};
      const any = (a) => Array.isArray(a) && a.length > 0;
      return { withdraw: any(perm.Wallet) && perm.Wallet.some((x) => /Withdraw/i.test(x)), trade: r.readOnly === 0 && (any(perm.ContractTrade) || any(perm.Spot) || any(perm.Derivatives)) };
    },
    async equity(c) {
      for (const accountType of ["UNIFIED", "CONTRACT"]) {
        try { const r = await this.req(c, "/v5/account/wallet-balance", { accountType }); const e = +((r.list || [])[0] || {}).totalEquity; if (e) return e; } catch (e) { /* другой тип аккаунта */ }
      }
      return null;
    },
    async sync(c, from, to, progress) {
      await this.time(c);
      const out = [], ws = windows(from, to, 7 * DAY);
      let done = 0;
      for (const [a, b] of ws) {
        let cursor = "";
        for (let guard = 0; guard < 30; guard++) {
          const r = await this.req(c, "/v5/position/closed-pnl", { category: "linear", startTime: a, endTime: b, limit: 100, cursor });
          for (const x of r.list || []) {
            const side = x.side === "Sell" ? "long" : "short"; // side — сторона закрывающего ордера
            const fee = (+x.openFee || 0) + (+x.closeFee || 0);
            out.push({ id: `bybit:${x.orderId}:${x.createdTime}`, ex: "bybit", sym: baseSym(x.symbol), side, qty: +x.closedSize, entry: +x.avgEntryPrice, exit: +x.avgExitPrice,
              notional: +x.cumEntryValue || +x.avgEntryPrice * +x.closedSize, gross: +x.closedPnl + fee, fee, funding: 0, pnl: +x.closedPnl,
              openT: null, closeT: +x.updatedTime || +x.createdTime, lev: +x.leverage || null, open: false });
          }
          cursor = r.nextPageCursor;
          if (!cursor || !(r.list || []).length) break;
        }
        progress && progress(++done / ws.length);
      }
      return out;
    },
  };

  // ---------- OKX (бессрочные свопы): история позиций
  EX.okx = {
    name: "OKX", fields: ["key", "secret", "passphrase"],
    help: ["OKX → Профиль → API → Создать API-ключ", "Разрешения: только «Чтение» (Read). Придумай Passphrase и запомни", "Скопируй API Key, Secret Key и Passphrase сюда"],
    async req(c, path, params) {
      const q = qs(params), rp = path + (q ? `?${q}` : "");
      const ts = new Date(Date.now() + (c._off || 0)).toISOString();
      const sign = await hmac(c.secret, ts + "GET" + rp, "b64");
      const d = await getJSON(`https://www.okx.com${rp}`, { headers: { "OK-ACCESS-KEY": c.key, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": c.passphrase } });
      if (d.code !== "0") throw new Error(d.msg || `code ${d.code}`);
      return d.data;
    },
    async time(c) { try { const t = await getJSON("https://www.okx.com/api/v5/public/time"); c._off = +t.data[0].ts - Date.now(); } catch (e) { /* noop */ } },
    async check(c) {
      await this.time(c);
      const r = await this.req(c, "/api/v5/account/config", {});
      const perm = String((r[0] || {}).perm || "");
      return { withdraw: /withdraw/.test(perm), trade: /trade/.test(perm) };
    },
    async equity(c) { const r = await this.req(c, "/api/v5/account/balance", {}); return +(r[0] || {}).totalEq || null; },
    async sync(c, from, to, progress) {
      await this.time(c);
      let ct = {};
      try { const ins = await getJSON("https://www.okx.com/api/v5/public/instruments?instType=SWAP"); ins.data.forEach((i) => { ct[i.instId] = +i.ctVal || 1; }); } catch (e) { /* noop */ }
      const out = [];
      let after = "";
      for (let guard = 0; guard < 40; guard++) {
        const r = await this.req(c, "/api/v5/account/positions-history", { instType: "SWAP", limit: 100, after });
        for (const x of r) {
          const t = +x.uTime;
          if (t < from) { after = null; break; }
          const qty = (+x.closeTotalPos || 0) * (ct[x.instId] || 1);
          const fee = -(+x.fee || 0), funding = +x.fundingFee || 0;
          out.push({ id: `okx:${x.posId}:${x.uTime}`, ex: "okx", sym: baseSym(x.instId.replace(/-SWAP$/, "")), side: x.direction === "short" ? "short" : "long", qty,
            entry: +x.openAvgPx, exit: +x.closeAvgPx, notional: +x.openAvgPx * qty, gross: +x.pnl, fee, funding, pnl: +x.realizedPnl,
            openT: +x.cTime, closeT: t, lev: +x.lever || null, open: false, liq: ["3", "4"].includes(String(x.type)) });
        }
        progress && progress(Math.min(0.95, (guard + 1) / 10));
        if (after === null || r.length < 100) break;
        after = r[r.length - 1].uTime;
      }
      return out.filter((x) => x.closeT >= from && x.closeT <= to);
    },
  };

  // ---------- BingX (через пересылку exchange-relay)
  EX.bingx = {
    name: "BingX", fields: ["key", "secret"],
    help: ["BingX → Аккаунт → API Management → Create API", "Разрешения: только «Read». Торговлю и вывод не включай", "Скопируй API Key и Secret Key сюда"],
    async req(c, path, params) {
      const p = Object.assign({}, params, { timestamp: Date.now() + (c._off || 0), recvWindow: 15000 });
      const keys = Object.keys(p).sort();
      const q = keys.filter((k) => p[k] !== undefined && p[k] !== "").map((k) => `${k}=${p[k]}`).join("&");
      const sig = await hmac(c.secret, q);
      const url = `https://open-api.bingx.com${path}?${q}&signature=${sig}`;
      if (!CFG.supabaseUrl || !window.AUTH || !window.AUTH.sb) throw new Error(_t("Для BingX нужен вход в аккаунт."));
      const sess = (await window.AUTH.sb.auth.getSession()).data.session;
      if (!sess) throw new Error(_t("Для BingX нужен вход в аккаунт."));
      const r = await getJSON(`${CFG.supabaseUrl}/functions/v1/exchange-relay`, {
        method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: `Bearer ${sess.access_token}` },
        body: JSON.stringify({ url, apiKey: c.key }),
      });
      const d = r.body;
      if (!d || d.code !== 0) throw new Error((d && d.msg) || `BingX ${r.status}`);
      return d.data;
    },
    async check(c) {
      await this.req(c, "/openApi/swap/v2/user/balance", {});
      return {};
    },
    async equity(c) { const r = await this.req(c, "/openApi/swap/v2/user/balance", {}); const b = (r && (r.balance || r)) || {}; return +(b.equity || b.balance) || null; },
    async sync(c, from, to, progress) {
      const inc = [];
      for (const [a, b] of windows(from, to, 7 * DAY)) {
        const r = await this.req(c, "/openApi/swap/v2/user/income", { incomeType: "REALIZED_PNL", startTime: a, endTime: b, limit: 1000 });
        inc.push(...(r || []));
      }
      const syms = [...new Set(inc.map((x) => x.symbol).filter(Boolean))];
      const out = [];
      let done = 0;
      for (const sym of syms) {
        for (let page = 1; page <= 10; page++) {
          const r = await this.req(c, "/openApi/swap/v1/trade/positionHistory", { symbol: sym, startTs: from, endTs: to, pageIndex: page, pageSize: 100 });
          const list = (r && (r.positionHistory || r)) || [];
          for (const x of list) {
            const fee = Math.abs(+x.positionCommission || 0), funding = +x.totalFunding || 0;
            out.push({ id: `bingx:${x.positionId}`, ex: "bingx", sym: baseSym(x.symbol), side: x.positionSide === "SHORT" ? "short" : "long", qty: +x.closePositionAmt || +x.positionAmt,
              entry: +x.avgPrice, exit: +x.avgClosePrice, notional: +x.avgPrice * (+x.closePositionAmt || +x.positionAmt), gross: +x.realisedProfit, fee, funding,
              pnl: x.netProfit != null ? +x.netProfit : +x.realisedProfit - fee + funding, openT: +x.openTime, closeT: +x.updateTime, lev: +x.leverage || null, open: false });
          }
          if (list.length < 100) break;
        }
        progress && progress(++done / syms.length);
      }
      return out;
    },
  };

  // ---------- Bitunix (через пересылку exchange-relay: Bitunix тоже не разрешает запросы из браузера)
  // подпись: sign = SHA256(SHA256(nonce + timestamp + apiKey + queryParams + body) + secret); queryParams — ключи по алфавиту, «ключзначение» подряд
  async function sha256hex(str) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(str)))].map((x) => x.toString(16).padStart(2, "0")).join(""); }
  async function relay(body, needLogin) {
    if (!CFG.supabaseUrl || !window.AUTH || !window.AUTH.sb) throw new Error(needLogin);
    const sess = (await window.AUTH.sb.auth.getSession()).data.session;
    if (!sess) throw new Error(needLogin);
    return getJSON(`${CFG.supabaseUrl}/functions/v1/exchange-relay`, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: `Bearer ${sess.access_token}` },
      body: JSON.stringify(body),
    });
  }
  EX.bitunix = {
    name: "Bitunix", fields: ["key", "secret"],
    help: ["Bitunix → Профиль → API Management → Create API", "Разрешения: только чтение (Read). Торговлю и вывод не включай", "Скопируй API Key и Secret Key сюда"],
    async req(c, path, params) {
      const p = {};
      Object.keys(params || {}).sort().forEach((k) => { if (params[k] !== undefined && params[k] !== null && params[k] !== "") p[k] = String(params[k]); });
      const sorted = Object.keys(p).map((k) => k + p[k]).join("");
      const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
      const timestamp = String(Date.now() + (c._off || 0));
      const sign = await sha256hex((await sha256hex(nonce + timestamp + c.key + sorted)) + c.secret);
      const q = Object.keys(p).map((k) => `${k}=${encodeURIComponent(p[k])}`).join("&");
      const url = `https://fapi.bitunix.com${path}${q ? "?" + q : ""}`;
      const r = await relay({ url, headers: { "api-key": c.key, nonce, timestamp, sign } }, _t("Для Bitunix нужен вход в аккаунт."));
      const d = r.body;
      if (!d || +d.code !== 0) throw new Error((d && (d.msg || d.message)) || `Bitunix ${r.status}`);
      return d.data;
    },
    async check(c) { await this.req(c, "/api/v1/futures/account", { marginCoin: "USDT" }); return {}; },
    async equity(c) {
      const a = await this.req(c, "/api/v1/futures/account", { marginCoin: "USDT" });
      const x = Array.isArray(a) ? a[0] || {} : a || {};
      const v = (+x.available || 0) + (+x.frozen || 0) + (+x.margin || 0) + (+x.crossUnrealizedPNL || 0) + (+x.isolationUnrealizedPNL || 0);
      return v || null;
    },
    async sync(c, from, to, progress) {
      const out = [];
      // фильтр биржи — по времени ОТКРЫТИЯ позиции, поэтому берём с запасом и отбираем закрытые в окне
      for (let skip = 0, page = 0; page < 60; page++, skip += 100) {
        const r = await this.req(c, "/api/v1/futures/position/get_history_positions", { startTime: from - 60 * DAY, endTime: to, skip, limit: 100 });
        const list = (r && (r.positionList || r.list)) || (Array.isArray(r) ? r : []);
        for (const x of list) {
          const qty = +x.maxQty || +x.qty || 0, fee = Math.abs(+x.fee || 0), funding = +x.funding || 0, gross = +x.realizedPNL || 0;
          out.push({ id: `bitunix:${x.positionId}`, ex: "bitunix", sym: baseSym(x.symbol), side: String(x.side).toUpperCase() === "SHORT" ? "short" : "long", qty,
            entry: +x.entryPrice, exit: +x.closePrice, notional: +x.entryPrice * qty, gross, fee, funding, pnl: gross - fee + funding,
            openT: +x.ctime, closeT: +x.mtime, lev: +x.leverage || null, open: false, liq: +x.liqQty > 0 });
        }
        progress && progress(Math.min(0.95, (page + 1) / 6));
        if (list.length < 100) break;
        await sleep(150);
      }
      return out.filter((x) => x.closeT >= from && x.closeT <= to);
    },
  };

  // ---------- Hyperliquid: только адрес кошелька, ключи не нужны
  EX.hyperliquid = {
    name: "Hyperliquid", fields: ["address"],
    help: ["Ключ не нужен: сделки Hyperliquid публичны", "Вставь адрес основного кошелька 0x…, с которого торгуешь. Адрес API-кошелька не подойдёт"],
    post(body) { return getJSON("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); },
    async check(c) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(c.address || "")) throw new Error(_t("Адрес должен быть вида 0x и 40 символов."));
      await this.post({ type: "clearinghouseState", user: c.address });
      return {};
    },
    async equity(c) { const r = await this.post({ type: "clearinghouseState", user: c.address }); return +((r || {}).marginSummary || {}).accountValue || null; },
    async sync(c, from, to, progress) {
      const fills = [];
      let s = from;
      for (let guard = 0; guard < 25; guard++) {
        const r = await this.post({ type: "userFillsByTime", user: c.address, startTime: s, endTime: to, aggregateByTime: true });
        for (const f of r) {
          if (/^@|\//.test(f.coin) || f.dir === "Spot Dust Conversion") continue; // спот пропускаем
          fills.push({ key: f.coin, sym: f.coin.replace(/^[a-z]+:/, ""), side: f.side === "B" ? "buy" : "sell", qty: +f.sz, px: +f.px, fee: +f.fee, pnl: +f.closedPnl,
            t: f.time, id: f.tid || f.hash, start: +f.startPosition, closing: /Close|>|Liquid|Settle/.test(f.dir || "") });
        }
        progress && progress(Math.min(0.9, (guard + 1) / 6));
        if (r.length < 2000) break;
        s = r[r.length - 1].time + 1;
      }
      // startPosition у HL — знаковый размер до сделки (покупка увеличивает)
      let funding = [];
      try { funding = await this.post({ type: "userFunding", user: c.address, startTime: from, endTime: to }); } catch (e) { /* noop */ }
      const fundingOf = (sym, a, b) => funding.filter((x) => x.delta && String(x.delta.coin).replace(/^[a-z]+:/, "") === sym && x.time >= a && x.time <= b).reduce((t, x) => t + +x.delta.usdc, 0);
      return buildPositions(fills, "hyperliquid", fundingOf);
    },
  };
  const EX_ORDER = ["binance", "bybit", "okx", "bingx", "bitunix", "hyperliquid"];

  // ================================================================ аналитика
  function stats(trades) {
    const closed = trades.filter((t) => !t.open && t.closeT).sort((a, b) => a.closeT - b.closeT);
    const wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl < 0);
    const sum = (a, f) => a.reduce((s, x) => s + (f ? f(x) : x), 0);
    const net = sum(closed, (t) => t.pnl), grossWin = sum(wins, (t) => t.pnl), grossLoss = -sum(losses, (t) => t.pnl);
    let eq = 0, peak = 0, maxDD = 0, ddFrom = null, ddTo = null, peakT = null;
    const curve = closed.map((t) => {
      eq += t.pnl;
      if (eq > peak) { peak = eq; peakT = t.closeT; }
      if (peak - eq > maxDD) { maxDD = peak - eq; ddFrom = peakT; ddTo = t.closeT; }
      return { t: t.closeT, v: eq };
    });
    let streakW = 0, streakL = 0, cw = 0, cl = 0;
    closed.forEach((t) => { if (t.pnl > 0) { cw++; cl = 0; } else if (t.pnl < 0) { cl++; cw = 0; } streakW = Math.max(streakW, cw); streakL = Math.max(streakL, cl); });
    const group = (keyFn) => {
      const m = new Map();
      closed.forEach((t) => { const k = keyFn(t); const g = m.get(k) || { k, n: 0, w: 0, pnl: 0 }; g.n++; if (t.pnl > 0) g.w++; g.pnl += t.pnl; m.set(k, g); });
      return [...m.values()];
    };
    const durs = closed.filter((t) => t.openT && t.closeT > t.openT).map((t) => ({ d: t.closeT - t.openT, win: t.pnl > 0 }));
    const avgDur = (arr) => (arr.length ? arr.reduce((s, x) => s + x.d, 0) / arr.length : null);
    // «отыгрыш»: сделки, открытые в течение 30 минут после убыточной
    let revenge = { n: 0, w: 0, pnl: 0 };
    const opened = closed.filter((t) => t.openT).sort((a, b) => a.openT - b.openT);
    closed.forEach((l) => {
      if (l.pnl >= 0) return;
      opened.forEach((t) => { if (t !== l && t.openT > l.closeT && t.openT - l.closeT < 30 * 60000) { revenge.n++; if (t.pnl > 0) revenge.w++; revenge.pnl += t.pnl; } });
    });
    const days = closed.length ? Math.max(1, (closed[closed.length - 1].closeT - closed[0].closeT) / DAY) : 1;
    return {
      closed, n: closed.length, open: trades.filter((t) => t.open), wins: wins.length, losses: losses.length,
      winRate: closed.length ? wins.length / closed.length : 0, net, grossWin, grossLoss,
      pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      avgWin: wins.length ? grossWin / wins.length : 0, avgLoss: losses.length ? grossLoss / losses.length : 0,
      expectancy: closed.length ? net / closed.length : 0,
      fees: sum(closed, (t) => t.fee || 0), funding: sum(closed, (t) => t.funding || 0),
      best: closed.reduce((b, t) => (!b || t.pnl > b.pnl ? t : b), null), worst: closed.reduce((b, t) => (!b || t.pnl < b.pnl ? t : b), null),
      maxDD, ddFrom, ddTo, curve, streakW, streakL, perDay: closed.length / days,
      bySym: group((t) => t.sym).sort((a, b) => b.pnl - a.pnl),
      bySide: group((t) => t.side),
      byHour: group((t) => new Date(t.closeT).getHours()),
      byDow: group((t) => (new Date(t.closeT).getDay() + 6) % 7),
      byEx: group((t) => t.ex),
      durWin: avgDur(durs.filter((x) => x.win)), durLoss: avgDur(durs.filter((x) => !x.win)),
      revenge, liqs: closed.filter((t) => t.liq).length,
    };
  }
  function insights(s) {
    const L = [];
    if (!s.n) return L;
    if (s.avgLoss > 0 && s.avgWin > 0) {
      const r = s.avgWin / s.avgLoss;
      if (r < 0.8) L.push(["bad", `${_t("Средний убыток больше средней прибыли в")} ${(1 / r).toFixed(1)}× — ${_t("режь убытки раньше или держи прибыль дольше.")}`]);
      else if (r > 1.5) L.push(["good", `${_t("Средняя прибыль больше среднего убытка в")} ${r.toFixed(1)}× — ${_t("хорошее соотношение, можно позволить win rate ниже 50%.")}`]);
    }
    const sd = Object.fromEntries(s.bySide.map((g) => [g.k, g]));
    if (sd.long && sd.short && sd.long.n >= 3 && sd.short.n >= 3) {
      const better = sd.long.pnl > sd.short.pnl ? "long" : "short", worse = better === "long" ? "short" : "long";
      if (sd[worse].pnl < 0 && sd[better].pnl > 0) L.push(["info", `${better === "long" ? _t("Лонги") : _t("Шорты")} ${_t("приносят")} ${fmtUsd(sd[better].pnl)}, ${worse === "long" ? _t("лонги") : _t("шорты")} — ${fmtUsd(sd[worse].pnl)}. ${_t("Возможно, стоит торговать только сильную сторону.")}`]);
    }
    const worstSym = s.bySym[s.bySym.length - 1];
    if (worstSym && worstSym.pnl < 0 && worstSym.n >= 3) L.push(["bad", `${_t("Худшая монета —")} ${worstSym.k}: ${fmtUsd(worstSym.pnl)} ${_t("за")} ${worstSym.n} ${_t("сделок. Проверь, работает ли твой подход на ней.")}`]);
    if (s.revenge.n >= 3) {
      const wr = s.revenge.w / s.revenge.n;
      L.push([wr < 0.45 || s.revenge.pnl < 0 ? "bad" : "info", `${_t("После убытка ты открывал новую сделку в течение 30 минут")} ${s.revenge.n} ${_t("раз")}: win rate ${Math.round(wr * 100)}%, ${fmtUsd(s.revenge.pnl)}. ${wr < 0.45 ? _t("Похоже на отыгрыш — сделай паузу после стопа.") : ""}`]);
    }
    const costs = s.fees - s.funding;
    if (s.grossWin > 0 && costs > 0 && costs / s.grossWin > 0.25) L.push(["bad", `${_t("Комиссии и фандинг съели")} ${Math.round((costs / s.grossWin) * 100)}% ${_t("прибыльных сделок. Меньше сделок или лимитные ордера снизят издержки.")}`]);
    if (s.perDay > 15) L.push(["bad", `${s.perDay.toFixed(0)} ${_t("сделок в день — признак овертрейдинга.")}`]);
    if (s.durWin && s.durLoss && s.durLoss > s.durWin * 1.5) L.push(["bad", `${_t("Убыточные сделки ты держишь дольше прибыльных")} (${fmtDur(s.durLoss)} ${_t("против")} ${fmtDur(s.durWin)}). ${_t("Классическая ошибка: прибыль режется, убыток пересиживается.")}`]);
    const hours = s.byHour.filter((g) => g.n >= 3).sort((a, b) => b.pnl - a.pnl);
    if (hours.length >= 3) L.push(["info", `${_t("Лучшее время закрытия:")} ${hours.slice(0, 2).map((h) => `${String(h.k).padStart(2, "0")}:00`).join(", ")}; ${_t("худшее:")} ${hours.slice(-1).map((h) => `${String(h.k).padStart(2, "0")}:00`).join("")}.`]);
    if (s.liqs) L.push(["bad", `${_t("Ликвидаций:")} ${s.liqs}. ${_t("Снизь плечо и ставь стоп до цены ликвидации.")}`]);
    if (s.streakL >= 4) L.push(["info", `${_t("Самая длинная серия убытков:")} ${s.streakL}. ${_t("Заранее реши, после скольких стопов подряд ты останавливаешься на день.")}`]);
    return L;
  }

  // ================================================================ форматирование
  function fmtUsd(v, sign = true) {
    if (v == null || !isFinite(v)) return "—";
    if (Math.abs(v) < 0.005) return "$0";
    const a = Math.abs(v), s = v < 0 ? "−" : sign && v > 0 ? "+" : "";
    return `${s}$${a >= 1e6 ? (a / 1e6).toFixed(2) + "M" : a >= 1e4 ? (a / 1e3).toFixed(1) + "K" : a.toLocaleString(I18.locale, { maximumFractionDigits: a >= 100 ? 0 : 2 })}`;
  }
  function fmtP(v) {
    if (v == null || !isFinite(v)) return "—";
    const a = Math.abs(v);
    return Number(v).toLocaleString(I18.locale, { maximumFractionDigits: a >= 1000 ? 1 : a >= 1 ? 3 : 6 });
  }
  function fmtDur(ms) {
    if (!ms) return "—";
    const m = ms / 60000;
    return m < 60 ? `${Math.round(m)} ${_t("мин")}` : m < 1440 ? `${(m / 60).toFixed(1)} ${_t("ч")}` : `${(m / 1440).toFixed(1)} ${_t("дн")}`;
  }
  const fmtDate = (t) => (t ? new Date(t).toLocaleString(I18.locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
  const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");

  // ================================================================ демо-данные
  function demoTrades() {
    let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const syms = [["BTC", 82000], ["ETH", 3050], ["SOL", 104], ["DOGE", 0.21], ["HYPE", 38]], out = [];
    const now = Date.now();
    for (let i = 0; i < 64; i++) {
      const [sym, px] = syms[Math.floor(r() * syms.length)];
      const side = r() < 0.6 ? "long" : "short", dir = side === "long" ? 1 : -1;
      const openT = now - (60 - i) * DAY * 0.9 - r() * 6 * 3600000;
      const dur = (r() < 0.5 ? 0.3 : 3) * 3600000 * (0.4 + r());
      const win = r() < (side === "long" ? 0.52 : 0.4);
      const move = (win ? 1 : -1) * (0.004 + r() * (win ? 0.025 : 0.018));
      const notional = 500 + r() * 2500, qty = notional / px;
      const exit = px * (1 + move * dir), gross = (exit - px) * qty * dir, fee = notional * 0.0009;
      out.push({ id: `demo:${i}`, ex: ["binance", "bybit", "okx"][i % 3], sym, side, qty, entry: px, exit, notional, gross, fee, funding: -notional * 0.0001 * (dur / 28800000),
        pnl: gross - fee, openT, closeT: openT + (win ? dur : dur * 1.8), open: false, demo: true,
        lev: [5, 10, 10, 20, 25, 50][Math.floor(r() * 6)], dtags: [["По плану"], ["Пробой"], ["Тренд", "По плану"], ["FOMO"], [], ["Отбой"], ["Пробой", "По плану"], []][Math.floor(r() * 8)] });
    }
    // несколько «отыгрышей»: быстрый вход после убытка, чаще всего неудачный
    out.filter((t, i) => t.gross < 0 && i % 3 === 0).forEach((l, j) => {
      const notional = 1500 + r() * 1500, px = l.exit, qty = notional / px, win = j % 4 === 0, dir = l.side === "long" ? 1 : -1;
      const exit = px * (1 + (win ? 0.008 : -0.012) * dir), gross = (exit - px) * qty * dir, fee = notional * 0.0009;
      out.push({ id: `demo:r${j}`, ex: l.ex, sym: l.sym, side: l.side, qty, entry: px, exit, notional, gross, fee, funding: 0, pnl: 0,
        openT: l.closeT + 8 * 60000, closeT: l.closeT + 50 * 60000, open: false, demo: true, lev: 50, dtags: ["Отыгрыш"] });
    });
    // все сделки — в прошлом
    const shift = Math.max(0, ...out.map((t) => t.closeT - now)) + 3600000;
    out.forEach((t) => { t.pnl = t.gross - t.fee + t.funding; t.openT -= shift; t.closeT -= shift; });
    return out;
  }

  // ================================================================ состояние
  const S = { open: false, conns: [], trades: [], notes: {}, exc: {}, period: 30, exFilter: "all", syncing: false, demo: false, status: {}, view: "main", expanded: null };
  try { if (localStorage.getItem("amq-jr-unit") === "pct") S.calUnit = "pct"; } catch (e) { /* noop */ }
  try { const raw = localStorage.getItem("amq-jr-period"); const p = +raw; if (raw !== null && [7, 30, 90, 0].includes(p)) S.period = p; } catch (e) { /* noop */ }

  async function loadState() {
    try {
      S.conns = (await kvGet("conns")) || [];
      S.trades = (await kvGet("trades")) || [];
      S.notes = (await kvGet("notes")) || {};
      S.exc = (await kvGet("exc")) || {};
    } catch (e) { S.dbError = true; }
  }
  async function saveConns() { await kvSet("conns", S.conns); }
  async function saveTrades() { await kvSet("trades", S.trades); }

  // ================================================================ синхронизация
  async function syncAll() {
    if (S.syncing || !S.conns.length) return;
    S.syncing = true; render();
    const to = Date.now(), from = to - 90 * DAY;
    for (const c of S.conns) {
      S.status[c.id] = { busy: true, p: 0 }; render();
      try {
        const secret = await unseal(await kvGet(`secret:${c.id}`));
        const conn = Object.assign({}, secret, { id: c.id });
        const list = await EX[c.ex].sync(conn, from, to, (p) => { S.status[c.id] = { busy: true, p }; renderStatus(); });
        list.forEach((t) => { t.conn = c.id; });
        S.trades = S.trades.filter((t) => t.conn !== c.id).concat(list);
        c.lastSync = Date.now(); c.count = list.length; c.error = null;
        try { if (EX[c.ex].equity) c.equity = await EX[c.ex].equity(conn); } catch (e) { /* баланс не обязателен */ }
        S.status[c.id] = { ok: true };
      } catch (e) {
        c.error = String(e.message || e).slice(0, 160);
        S.status[c.id] = { error: c.error };
      }
      await saveConns(); await saveTrades();
      render();
    }
    S.syncing = false; render();
  }

  async function addConnection(ex, form) {
    const c = { id: `${ex}-${Date.now().toString(36)}`, ex, label: EX[ex].name, added: Date.now() };
    const conn = {};
    EX[ex].fields.forEach((f) => { conn[f] = (form[f] || "").trim(); });
    if (EX[ex].fields.some((f) => !conn[f])) throw new Error(_t("Заполни все поля."));
    const perms = await EX[ex].check(Object.assign({}, conn));
    if (perms.withdraw) throw new Error(_t("У ключа включён вывод средств. Создай ключ только с правом чтения — так безопаснее."));
    c.warnTrade = !!perms.trade;
    if (ex === "hyperliquid") c.label = `Hyperliquid ${conn.address.slice(0, 6)}…${conn.address.slice(-4)}`;
    await kvSet(`secret:${c.id}`, await seal(conn));
    S.conns.push(c);
    await saveConns();
    return c;
  }
  async function removeConnection(id) {
    await kvDel(`secret:${id}`);
    S.conns = S.conns.filter((c) => c.id !== id);
    S.trades = S.trades.filter((t) => t.conn !== id);
    await saveConns(); await saveTrades();
  }

  // ================================================================ обзор: виджеты (в духе FOQUS)
  // Каждый виджет: заголовок · главная цифра с пояснением · маленький график · строка из 2–4 метрик.
  // Набор и порядок настраиваются («Виджеты»), сохраняются на устройстве.
  const WG_KEY = "amq-jr-wg";
  // разделы обзора: [id, название, пояснение]
  const GROUPS = [
    ["sum", "Итоги", "общий результат за период"],
    ["mkt", "Рынок", "что происходит сейчас"],
    ["qual", "Качество сделок", "как ты входишь и выходишь"],
    ["risk", "Риск и дисциплина", "сколько ставишь и как ведёшь себя после убытков"],
    ["time", "Время", "когда ты зарабатываешь и когда теряешь"],
    ["what", "Что ты торгуешь", "монеты, теги, сторона и плечо"],
    ["cost", "Издержки", "комиссии и фандинг"],
  ];
  const WIDGETS = [
    ["pnl", "Кривая прибыли", "sum"], ["month", "Карта месяца", "sum"], ["key", "Ключевые метрики", "sum"], ["insights", "Выводы и ИИ-разбор", "sum"],
    ["market", "Рынок сегодня", "mkt"],
    ["recent", "Последние сделки", "qual"], ["exit", "Качество выхода", "qual"], ["after", "Если бы держал ещё 30 минут", "qual"], ["move", "Средний ход цены", "qual"], ["dist", "Распределение результатов", "qual"],
    ["risk", "Риск на сделку", "risk"], ["streak", "Серии", "risk"], ["revenge", "Сделки после убытка", "risk"], ["perday", "Сделок в день", "risk"],
    ["daily", "Результат по дням", "time"], ["dow", "По дням недели", "time"], ["hour", "По часам", "time"], ["session", "По торговым сессиям", "time"], ["hold", "Время в сделке", "time"],
    ["sym", "Прибыль по монетам", "what"], ["tags", "Прибыль по тегам", "what"], ["side", "Лонг и шорт", "what"], ["lev", "Плечо и результат", "what"], ["exch", "По биржам", "what"],
    ["fees", "Комиссии", "cost"], ["funding", "Фандинг", "cost"],
  ];
  const WG_GROUP = Object.fromEntries(WIDGETS.map((w) => [w[0], w[2]]));
  const WG_NAME = Object.fromEntries(WIDGETS.map((w) => [w[0], w[1]]));
  function wgCfg() {
    let c = null;
    try { c = JSON.parse(localStorage.getItem(WG_KEY) || "null"); } catch (e) { /* noop */ }
    const ids = WIDGETS.map((w) => w[0]);
    const order = c && Array.isArray(c.order) ? c.order.filter((x) => ids.includes(x)) : [];
    ids.forEach((x) => { if (!order.includes(x)) order.push(x); });
    return { order, off: c && Array.isArray(c.off) ? c.off.filter((x) => ids.includes(x)) : [] };
  }
  function wgSave(c) { try { localStorage.setItem(WG_KEY, JSON.stringify(c)); } catch (e) { /* noop */ } }

  const tagsOf = (t) => (S.notes[t.id] && S.notes[t.id].tags) || t.dtags || [];

  // ---------------------------------------------------------------- период и размер каждой плашки
  // Период: общий (переключатель над обзором) или свой у плашки — «сегодня», «вчера», 7/30/90 дней, квартал, год,
  // всё время или произвольные даты. Размер: XS — четверть строки, S — половина, M — три четверти, L — вся строка.
  const WPER_KEY = "amq-jr-wper", WSIZE_KEY = "amq-jr-wsize";
  const lsObj = (k) => { try { return JSON.parse(localStorage.getItem(k) || "{}") || {}; } catch (e) { return {}; } };
  const lsPut = (k, o) => { try { localStorage.setItem(k, JSON.stringify(o)); } catch (e) { /* noop */ } };
  const PRESETS = [["today", "Сегодня"], ["yesterday", "Вчера"], ["7", "7 дней"], ["30", "30 дней"], ["90", "90 дней"], ["quarter", "Квартал"], ["year", "Год"], ["0", "Всё время"]];
  const NOPER = ["month", "market"];
  const SIZES = [[1, "XS", "Четверть строки"], [2, "S", "Половина строки"], [3, "M", "Три четверти строки"], [4, "L", "Вся строка"]];
  const DEF_SIZE = { pnl: 3, month: 1, recent: 4 };
  let CUR = null; // период плашки, которая сейчас рисуется
  const sod = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const fromYmd = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
  function perRange(spec) {
    spec = String(spec == null ? S.period : spec);
    const now = new Date();
    if (spec === "today") return [sod(now), Infinity];
    if (spec === "yesterday") { const t = sod(now); return [sod(t - 12 * 3600e3), t - 1]; }
    if (spec === "quarter") return [new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1).getTime(), Infinity];
    if (spec === "year") return [new Date(now.getFullYear(), 0, 1).getTime(), Infinity];
    if (spec.startsWith("c:")) { const [, a, b] = spec.split(":"); const f = fromYmd(a), t = fromYmd(b || a); return [Math.min(f, t), new Date(Math.max(f, t)).setHours(23, 59, 59, 999)]; }
    const n = +spec;
    return n > 0 ? [Date.now() - n * DAY, Infinity] : [0, Infinity];
  }
  const fmtD = (t, y) => new Date(t).toLocaleDateString(I18.locale, y ? { day: "numeric", month: "short", year: "2-digit" } : { day: "numeric", month: "short" });
  function perShort(spec) {
    spec = String(spec == null ? S.period : spec);
    if (spec.startsWith("c:")) { const [f, t] = perRange(spec); return sod(f) === sod(t) ? fmtD(f) : `${fmtD(f)} – ${fmtD(t)}`; }
    return _t(({ today: "Сегодня", yesterday: "Вчера", 7: "7д", 30: "30д", 90: "90д", quarter: "Квартал", year: "Год", 0: "Всё" })[spec] || "Всё");
  }
  function perSub(spec) {
    spec = String(spec == null ? S.period : spec);
    if (spec.startsWith("c:")) return perShort(spec);
    return _t(({ today: "за сегодня", yesterday: "за вчера", 7: "за 7 дней", 30: "за 30 дней", 90: "за 90 дней", quarter: "с начала квартала", year: "с начала года", 0: "за всё время" })[spec] || "за всё время");
  }
  const perLabel = () => perShort(CUR);
  const wSpec = (id) => lsObj(WPER_KEY)[id] || String(S.period);
  const wSize = (id, w2) => { const v = +lsObj(WSIZE_KEY)[id]; return v >= 1 && v <= 4 ? v : DEF_SIZE[id] || (w2 ? 3 : 2); };
  const pctS = (v, d = 1) => (v == null || !isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`);
  const pfS = (v) => (v === Infinity ? "∞" : v ? v.toFixed(2) : "0.00");
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const quant = (a, p) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), i = (b.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return b[lo] + (b[hi] - b[lo]) * (i - lo); };
  const median = (a) => quant(a, 0.5);
  const grp = (list, keyFn) => {
    const m = new Map();
    list.forEach((t) => { const k = keyFn(t); if (k == null) return; const g = m.get(k) || { k, n: 0, w: 0, pnl: 0, list: [] }; g.n++; if (t.pnl > 0) g.w++; g.pnl += t.pnl; g.list.push(t); m.set(k, g); });
    return m;
  };
  const wd = () => [_t("Пн"), _t("Вт"), _t("Ср"), _t("Чт"), _t("Пт"), _t("Сб"), _t("Вс")];
  const hh = (h) => `${String(h).padStart(2, "0")}:00`;
  // торговые сессии по времени входа (UTC)
  const SESS = [["Азия", 0, 7], ["Европа", 7, 13], ["Европа + США", 13, 16], ["США", 16, 21], ["Ночь", 21, 24]];
  const HOLD = [["<5м", 5 * 60e3], ["5–15м", 15 * 60e3], ["15м–1ч", 3600e3], ["1–4ч", 4 * 3600e3], ["4–24ч", 24 * 3600e3], [">1д", Infinity]];
  const LEV = [["×1–3", 3], ["×5", 5], ["×10", 10], ["×20", 20], ["×50", 50], ["×50+", Infinity]];
  const sessOf = (t) => { const h = new Date(t.openT || t.closeT).getUTCHours(); return SESS.findIndex(([, a, b]) => h >= a && h < b); };

  function ext(s) {
    const c = s.closed;
    const dmap = grp(c, (t) => dayKey(t.closeT));
    c.forEach((t) => { const g = dmap.get(dayKey(t.closeT)); g.fee = (g.fee || 0) + (t.fee || 0); });
    const days = [...dmap.values()].sort((a, b) => (a.k < b.k ? -1 : 1));
    const mv = c.filter((t) => t.entry && t.exit).map((t) => ({ t, p: ((t.exit - t.entry) / t.entry) * 100 * (t.side === "long" ? 1 : -1) }));
    const hold = c.filter((t) => t.openT && t.closeT > t.openT).map((t) => ({ t, d: t.closeT - t.openT }));
    return {
      days, mv, hold,
      bestDay: days.reduce((b, d) => (!b || d.pnl > b.pnl ? d : b), null),
      worstDay: days.reduce((b, d) => (!b || d.pnl < b.pnl ? d : b), null),
      byOpenHour: grp(c, (t) => new Date(t.openT || t.closeT).getHours()),
      bySess: grp(c, (t) => sessOf(t)),
      byHold: grp(hold.map((x) => x.t), (t) => HOLD.findIndex(([, lim]) => t.closeT - t.openT < lim)),
      byLev: grp(c.filter((t) => t.lev), (t) => LEV.findIndex(([, lim]) => t.lev <= lim)),
    };
  }

  // ---------------------------------------------------------------- разметка виджета
  const ICON_CAL = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  const ICON_INFO = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 11v5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="7.8" r="1.1" fill="currentColor"/></svg>`;
  function wg(id, body, o = {}) {
    const size = wSize(id, o.w2), own = !!lsObj(WPER_KEY)[id], info = window.JR_INFO && window.JR_INFO[id];
    const sz = `<div class="wg-sz" role="radiogroup" aria-label="${esc(_t("Размер плашки"))}">${SIZES.map(([n, l, tip]) => `<button class="${n === size ? "on" : ""}" data-j="wsize" data-v="${id}" data-d="${n}" title="${esc(_t(tip))}" aria-label="${esc(_t(tip))}">${l}</button>`).join("")}</div>`;
    const per = o.per === false ? "" : `<button class="wg-perb ${own ? "own" : ""}" data-j="wper" data-v="${id}" aria-haspopup="dialog" title="${esc(_t("Период плашки"))}">${ICON_CAL}<span>${esc(perLabel())}</span><i aria-hidden="true">▾</i></button>`;
    return `<section class="wg sz-${size}" data-w="${id}"><header class="wg-h"><b>${esc(_t(WG_NAME[id]))}</b>${info ? `<button class="wg-i" data-j="winfo" data-v="${id}" aria-label="${esc(_t("Как считается"))}">${ICON_INFO}</button>` : ""}<span class="wg-grow"></span>${sz}${per}${o.link ? `<button class="wg-link" data-j="${o.link[0]}" data-v="${esc(o.link[1])}">${esc(_t(o.link[2]))} ›</button>` : ""}</header>${body}</section>`;
  }
  const foot = (items, c) => `<div class="wg-foot ${c || ""}">${items.map(([v, l, k]) => `<div><b class="${k || ""}">${v}</b><span>${esc(_t(l))}</span></div>`).join("")}</div>`;
  const big = (cap, v, k, sub, md) => `${cap ? `<div class="wg-cap">${esc(cap)}</div>` : ""}<div class="wg-big ${md ? "md" : ""} ${k || ""}">${v}</div>${sub ? `<div class="wg-sub">${sub}</div>` : ""}`;
  const li = (l, v, k) => `<div class="wg-li"><span>${esc(_t(l))}</span><b class="${k || ""}">${v}</b></div>`;
  const emptyW = (t, sub) => `<div class="wg-empty"><div><b>${esc(_t(t))}</b>${sub ? `<br>${esc(_t(sub))}` : ""}</div></div>`;
  const DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
    <linearGradient id="svgUp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#00c58a" stop-opacity=".3"/><stop offset="1" stop-color="#00c58a" stop-opacity="0"/></linearGradient>
    <linearGradient id="svgDn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2735b" stop-opacity="0"/><stop offset="1" stop-color="#f2735b" stop-opacity=".3"/></linearGradient></defs></svg>`;

  function svgCurve(vals, H = 120) {
    const W = 600, pts = [0, ...vals], mn = Math.min(0, ...pts), mx = Math.max(0, ...pts), sp = mx - mn || 1;
    const x = (i) => (i / Math.max(1, pts.length - 1)) * W, y = (v) => 6 + (H - 12) * (1 - (v - mn) / sp);
    const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");
    const k = pts[pts.length - 1] >= 0 ? "up" : "down", z = y(0).toFixed(1);
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" aria-hidden="true"><line class="sv-zero" x1="0" x2="${W}" y1="${z}" y2="${z}" vector-effect="non-scaling-stroke"/><path class="sv-area ${k}" d="${d}L${W} ${z}L0 ${z}Z"/><path class="sv-line ${k}" d="${d}"/></svg>`;
  }
  // столбики: значения со знаком (цвет по знаку) или o.kinds — свой цвет для каждого; подписи — строкой под графиком
  function svgBars(vals, H = 86, o = {}) {
    const n = vals.length, W = n * 10, mx = Math.max(1e-9, ...vals.map((v) => Math.abs(v)));
    const neg = !o.kinds && vals.some((v) => v < 0), pos = vals.some((v) => v > 0);
    const z = neg && pos ? H / 2 : neg ? 1 : H - 1, sc = neg && pos ? H / 2 - 2 : H - 3, bw = o.bw || 6.6;
    let b = "";
    vals.forEach((v, i) => {
      const x = (i * 10 + (10 - bw) / 2).toFixed(2);
      if (!v) { b += `<rect class="sv-bar n" x="${x}" y="${(z - 1).toFixed(1)}" width="${bw}" height="2"/>`; return; }
      const h = Math.max(2, (Math.abs(v) / mx) * sc), k = o.kinds ? o.kinds[i] : o.mono ? "w" : v > 0 ? "up" : "down";
      b += `<rect class="sv-bar ${k}" x="${x}" y="${(v > 0 ? z - h : z).toFixed(1)}" width="${bw}" height="${h.toFixed(1)}"/>`;
    });
    const lab = o.labels ? `<div class="sv-xl" style="grid-template-columns:repeat(${n},minmax(0,1fr))">${o.labels.map((l) => `<span>${l}</span>`).join("")}</div>` : o.ends ? `<div class="sv-xe">${o.ends.map((l) => `<span>${l}</span>`).join("")}</div>` : "";
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" aria-hidden="true"><line class="sv-grid" x1="0" x2="${W}" y1="${z}" y2="${z}" vector-effect="non-scaling-stroke"/>${b}</svg>${lab}`;
  }
  const ring = (p) => { const r = 18, c = 2 * Math.PI * r; return `<svg class="wg-ring" viewBox="0 0 46 46" aria-hidden="true"><circle cx="23" cy="23" r="${r}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="5"/><circle cx="23" cy="23" r="${r}" fill="none" stroke="var(--up)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(c * Math.max(0, Math.min(1, p))).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 23 23)"/></svg>`; };
  const hbars = (rows) => { const mx = Math.max(1e-9, ...rows.map((r) => Math.abs(r.v))); return rows.map((r) => `<div class="wg-hbar"><span>${esc(r.k)}<small>${r.sub || ""}</small></span><b class="${cls(r.v)}">${fmtUsd(r.v)}</b><em><i class="${r.v >= 0 ? "up" : "down"}" style="width:${Math.max(2, (Math.abs(r.v) / mx) * 100).toFixed(0)}%"></i></em></div>`).join(""); };
  const wr = (g) => (g && g.n ? `${Math.round((g.w / g.n) * 100)}%` : "—");
  function fmtAgo(t) {
    const d = (t - Date.now()) / 1000, a = Math.abs(d);
    let rtf; try { rtf = new Intl.RelativeTimeFormat(I18.locale, { numeric: "auto", style: "short" }); } catch (e) { return fmtDate(t); }
    return a < 3600 ? rtf.format(Math.round(d / 60), "minute") : a < 86400 ? rtf.format(Math.round(d / 3600), "hour") : rtf.format(Math.round(d / 86400), "day");
  }

  // ---------------------------------------------------------------- виджеты
  const WG = {
    pnl(s, X) {
      const eq = equityBase(), gross = s.net + s.fees - s.funding;
      const left = big(`${_t("Итог")} · USD`, fmtUsd(s.net), cls(s.net), `${eq ? `${pctS((s.net / eq) * 100, 2)} ${esc(_t("к депозиту"))} · ` : ""}${s.n} ${esc(tradesWord(s.n))}`)
        + `<div class="wg-viz">${svgCurve(s.curve.map((p) => p.v), 130)}</div>`
        + foot([[`${Math.round(s.winRate * 100)}%`, "Win rate"], [fmtUsd(-s.maxDD), "Макс. просадка", s.maxDD ? "down" : ""], [pfS(s.pf), "Profit factor"], [fmtUsd(s.expectancy), "Средняя сделка", cls(s.expectancy)]]);
      const right = `<div class="wg-list">${li("Сделок", s.n)}${li("Прибыльные", fmtUsd(s.grossWin), "up")}${li("Убыточные", fmtUsd(-s.grossLoss), s.grossLoss ? "down" : "")}`
        + `${li("Лучший день", X.bestDay ? fmtUsd(X.bestDay.pnl) : "—", X.bestDay ? cls(X.bestDay.pnl) : "")}${li("Худший день", X.worstDay ? fmtUsd(X.worstDay.pnl) : "—", X.worstDay ? cls(X.worstDay.pnl) : "")}`
        + `${li("Лучшая сделка", s.best ? `${esc(s.best.sym)} ${fmtUsd(s.best.pnl)}` : "—", s.best ? cls(s.best.pnl) : "")}${li("Комиссии и фандинг", fmtUsd(s.funding - s.fees), cls(s.funding - s.fees))}${li("До комиссий", fmtUsd(gross), cls(gross))}</div>`;
      return wg("pnl", `<div class="wg-split"><div>${left}</div>${right}</div>`, { w2: true });
    },
    month() {
      const src = calSource(), m0 = calMonth(), y = m0.getFullYear(), mo = m0.getMonth();
      const pre = `${y}-${String(mo + 1).padStart(2, "0")}`;
      const g = grp(src.filter((t) => dayKey(t.closeT).startsWith(pre)), (t) => dayKey(t.closeT));
      const mx = Math.max(1e-9, ...[...g.values()].map((x) => Math.abs(x.pnl)));
      const days = new Date(y, mo + 1, 0).getDate(), lead = (new Date(y, mo, 1).getDay() + 6) % 7, todayK = dayKey(Date.now());
      let cells = wd().map((d) => `<span>${esc(d)}</span>`).join("");
      for (let i = 0; i < lead; i++) cells += `<i class="o"></i>`;
      for (let d = 1; d <= days; d++) {
        const k = `${pre}-${String(d).padStart(2, "0")}`, x = g.get(k);
        cells += `<i class="${x ? (x.pnl >= 0 ? "pos" : "neg") : ""} ${k === todayK ? "today" : ""}" ${x ? `style="--k:${Math.round(30 + 70 * Math.min(1, Math.abs(x.pnl) / mx))}%" title="${fmtUsd(x.pnl)}"` : ""}>${d}</i>`;
      }
      const tot = [...g.values()].reduce((a, x) => a + x.pnl, 0), up = [...g.values()].filter((x) => x.pnl > 0).length;
      const title = new Date(y, mo, 1).toLocaleDateString(I18.locale, { month: "long", year: "numeric" });
      return wg("month", `<div class="wg-cap" style="margin-bottom:8px">${esc(title.charAt(0).toUpperCase() + title.slice(1))}</div><div class="wg-cal">${cells}</div>`
        + foot([[fmtUsd(tot), "Итог месяца", cls(tot)], [`${up} ${esc(_t("из"))} ${g.size}`, "Дней в плюсе"], [String([...g.values()].reduce((a, x) => a + x.n, 0)), "Сделок"]], "c3"), { per: false, link: ["view", "calendar", "Календарь"] });
    },
    key(s) {
      const pr = s.avgLoss ? s.avgWin / s.avgLoss : null, mxw = Math.max(s.avgWin, s.avgLoss) || 1;
      return wg("key", `<div class="wg-2x2">
        <div>${big(_t("Чистый результат"), fmtUsd(s.net), cls(s.net), esc(perSub(CUR)))}</div>
        <div>${ring(s.winRate)}${big("Win rate", `${Math.round(s.winRate * 100)}%`, "", `${s.wins} ${esc(_t("из"))} ${s.n} ${esc(_t("в плюсе"))}`)}</div>
        <div>${big(_t("Прибыль / убыток"), pr == null ? "∞" : pr.toFixed(2), "", esc(_t("средняя прибыль к среднему убытку")))}<div class="wg-ratio"><i class="up" style="width:${((s.avgWin / mxw) * 100).toFixed(0)}%"></i><i class="down" style="width:${((s.avgLoss / mxw) * 100).toFixed(0)}%"></i></div></div>
        <div>${big(_t("Сделок"), String(s.n), "", `${s.perDay.toFixed(1)} ${esc(_t("в день"))}`)}</div></div>`);
    },
    insights(s) {
      const ins = insights(s);
      return wg("insights", `<div class="jr-ins">${ins.length ? ins.map(([k, t]) => `<p class="${k}"><i></i>${esc(t)}</p>`).join("") : `<p class="info"><i></i>${esc(_t("Пока мало сделок для выводов — нужно хотя бы 10–20."))}</p>`}
        <button class="jr-ai" data-j="ai"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3l1.8 4.9L19 9.7l-4.3 3 1.4 5.3L12 15l-4.1 3 1.4-5.3L5 9.7l5.2-1.8z" fill="currentColor"/></svg>${esc(_t("ИИ-разбор торговли"))}<i class="pc-pro">PRO</i></button>
        <div class="jr-ai-out" id="jr-ai-out"></div></div>`);
    },
    market() {
      const D = window.McQ && window.McQ.data ? window.McQ.data() : null;
      if (!D) return wg("market", emptyW("Данные рынка загружаются"), { per: false });
      const now = Date.now(), ru = I18.lang === "ru";
      const ev = (D.calendar || []).filter((e) => new Date(e.ts).getTime() > now - 2 * 3600e3).slice(0, 4);
      const next = (D.calendar || []).find((e) => new Date(e.ts).getTime() > now);
      const nw = (D.news || []).slice().sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 3);
      const BIAS = { bullish: ["Бычья", "up"], bearish: ["Медвежья", "down"], mixed: ["Смешанная", ""] };
      let h = "";
      if (next) {
        const m = Math.max(0, Math.round((new Date(next.ts).getTime() - now) / 60000));
        h += big(`${esc(next.country || "")} · ${esc(next.title)}`, m < 60 ? `${m} ${esc(_t("мин"))}` : `${Math.floor(m / 60)} ${esc(_t("ч"))} ${m % 60} ${esc(_t("мин"))}`, "", esc(_t("до следующего события")), true);
      }
      if (ev.length) h += `<div style="margin-top:8px">${ev.map((e) => `<div class="wg-ev ${new Date(e.ts).getTime() < now ? "past" : ""}"><time>${new Date(e.ts).toLocaleTimeString(I18.locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</time><span>${esc(e.country || "")} · ${esc(e.title)}</span><em class="${e.impact === "High" ? "hi" : ""}">${esc(_t(e.impact === "High" ? "важно" : "средне"))}</em></div>`).join("")}</div>`;
      if (nw.length) {
        h += `<div class="wg-sep"></div>`;
        h += nw.map((n) => { const tr = ru ? null : ((n.i18n || {})[I18.lang] || (n.i18n || {}).en); const title = ru ? n.title : (tr && tr.title) || n.title_en || n.title; const b = BIAS[n.bias]; return `<button class="wg-nw" data-j="tab" data-v="news">${esc(n.emoji || "")} ${esc(title)}<small>${b ? `<i class="${b[1]}">${esc(_t(b[0]))}</i> · ` : ""}${fmtAgo(new Date(n.ts).getTime())}</small></button>`; }).join("");
      }
      if (!h) h = emptyW("Сегодня важных событий нет");
      return wg("market", h, { per: false, link: ["tab", "calendar", "Календарь"] });
    },
    recent(s) {
      const list = s.closed.slice(-8).reverse();
      const rows = list.map((t) => { const pct = t.notional ? (t.pnl / t.notional) * 100 : null; return `<tr data-j="goto" data-v="${esc(t.id)}"><td><b>${esc(t.sym)}</b></td><td><span class="sd ${t.side === "long" ? "L" : "S"}">${t.side === "long" ? "LONG" : "SHORT"}</span></td><td>${fmtAgo(t.closeT)}</td><td class="hide-s">${t.openT ? fmtDur(t.closeT - t.openT) : "—"}</td><td class="hide-s">${t.lev ? `×${t.lev}` : "—"}</td><td class="r"><b class="${cls(t.pnl)}">${fmtUsd(t.pnl)}</b></td><td class="r hide-s ${cls(t.pnl)}">${pct == null ? "—" : pctS(pct, 2)}</td></tr>`; }).join("");
      return wg("recent", `<div style="overflow-x:auto"><table class="wg-tbl"><thead><tr><th>${esc(_t("Монета"))}</th><th>${esc(_t("Сторона"))}</th><th>${esc(_t("Закрыта"))}</th><th class="hide-s">${esc(_t("В сделке"))}</th><th class="hide-s">${esc(_t("Плечо"))}</th><th class="r">${esc(_t("Результат"))}</th><th class="r hide-s">${esc(_t("% объёма"))}</th></tr></thead><tbody>${rows}</tbody></table></div>`, { w2: true, per: false, link: ["view", "trades", "Все сделки"] });
    },
    risk(s) {
      const eq = equityBase();
      if (!eq) return wg("risk", emptyW("Нужен баланс счёта", "Баланс берётся с биржи при обновлении — для этого подключения он недоступен."));
      const lp = (s.avgLoss / eq) * 100, run = s.avgLoss > 0 ? Math.floor(eq / s.avgLoss) : null;
      const k = lp > 3 ? "down" : "", worst = s.worst ? (s.worst.pnl / eq) * 100 : null;
      return wg("risk", big(_t("Сколько в среднем забирает убыточная сделка"), s.avgLoss ? pctS(-lp, 2) : "0%", s.avgLoss ? "down" : "", run ? `${run} ${esc(_t("таких сделок до нуля"))} · ${esc(_t("от текущего депозита"))} ${fmtUsd(eq, false)}` : esc(_t("убыточных сделок нет")))
        + `<div class="wg-viz"><div class="wg-ratio"><i class="${k || "up"}" style="width:${Math.max(2, Math.min(100, lp * 10)).toFixed(0)}%"></i></div><div class="wg-sub" style="margin-top:6px">${esc(_t(lp <= 1 ? "Риск в норме: до 1% на сделку" : lp <= 3 ? "Риск повышенный: 1–3% на сделку" : "Риск высокий: больше 3% на сделку"))}</div></div>`
        + foot([[run ? String(run) : "∞", "Запас счёта, сделок"], [worst == null ? "—" : pctS(worst, 1), "Худшая сделка", worst < 0 ? "down" : ""], [pctS((-s.maxDD / eq) * 100, 1), "Макс. просадка", s.maxDD ? "down" : ""], [String(s.streakL), "Убытков подряд"]]));
    },
    move(s, X) {
      const p = X.mv.map((x) => x.p);
      if (!p.length) return wg("move", emptyW("Нет цен входа и выхода"));
      const avg = mean(p), w = mean(p.filter((x) => x > 0)), l = mean(p.filter((x) => x < 0));
      const H = 90, W = 600, mx = Math.max(Math.abs(w || 0), Math.abs(l || 0), 1e-9), y = (v) => H / 2 - (v / mx) * (H / 2 - 6);
      const viz = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" aria-hidden="true"><line class="sv-zero" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" vector-effect="non-scaling-stroke"/>${w != null ? `<path class="sv-line up" d="M0 ${H / 2} L${W} ${y(w).toFixed(1)}"/>` : ""}${l != null ? `<path class="sv-line down" d="M0 ${H / 2} L${W} ${y(l).toFixed(1)}"/>` : ""}</svg>`;
      return wg("move", big(_t("Средний ход цены за сделку"), pctS(avg, 2), cls(avg), esc(_t("от входа до выхода, в сторону сделки"))) + `<div class="wg-viz">${viz}</div>`
        + foot([[pctS(w, 2), "Прибыльная в среднем", "up"], [pctS(l, 2), "Убыточная в среднем", "down"], [w && l ? `${Math.abs(w / l).toFixed(1)}×` : "—", "Соотношение ходов"], [`${pctS(quant(p, 0.25), 2)} … ${pctS(quant(p, 0.75), 2)}`, "Средняя половина"]]));
    },
    dist(s) {
      const v = s.closed.map((t) => t.pnl);
      const mn = Math.min(...v), mx = Math.max(...v), N = 14, step = (mx - mn) / N || 1;
      const bins = Array(N).fill(0), mid = [];
      v.forEach((x) => { bins[Math.min(N - 1, Math.floor((x - mn) / step))]++; });
      for (let i = 0; i < N; i++) mid.push(mn + step * (i + 0.5));
      const top5 = s.closed.map((t) => t.pnl).filter((x) => x > 0).sort((a, b) => b - a).slice(0, 5).reduce((a, x) => a + x, 0);
      const lab = [fmtShort(mn), fmtShort(0).replace(/^[+−]/, ""), fmtShort(mx)];
      return wg("dist", big(_t("Средний результат сделки"), fmtUsd(s.expectancy), cls(s.expectancy), `${s.n} ${esc(tradesWord(s.n))}`)
        + `<div class="wg-viz">${svgBars(bins, 80, { kinds: mid.map((m) => (m >= 0 ? "up" : "down")), ends: lab })}</div>`
        + foot([[fmtUsd(s.avgWin), "Средняя прибыль", "up"], [fmtUsd(-s.avgLoss), "Средний убыток", s.avgLoss ? "down" : ""], [fmtUsd(median(v)), "Медиана", cls(median(v))], [s.grossWin ? `${Math.round((top5 / s.grossWin) * 100)}%` : "—", "Прибыли дают 5 лучших"]]));
    },
    daily(s, X) {
      const d = X.days.slice(-45), v = d.map((x) => x.pnl);
      const dl = (k) => new Date(k + "T12:00:00").toLocaleDateString(I18.locale, { day: "numeric", month: "short" });
      const lab = d.length ? [dl(d[0].k), d.length > 2 ? dl(d[Math.floor(d.length / 2)].k) : "", dl(d[d.length - 1].k)] : [];
      return wg("daily", big(_t("Средний торговый день"), fmtUsd(mean(v)), cls(mean(v)), `${X.days.length} ${esc(_t("торговых дней"))}`)
        + `<div class="wg-viz">${svgBars(v, 86, { ends: lab })}</div>`
        + foot([[X.bestDay ? fmtUsd(X.bestDay.pnl) : "—", "Лучший день", X.bestDay ? cls(X.bestDay.pnl) : ""], [X.worstDay ? fmtUsd(X.worstDay.pnl) : "—", "Худший день", X.worstDay ? cls(X.worstDay.pnl) : ""], [fmtUsd(median(v)), "Медианный день", cls(median(v))], [`${Math.round((v.filter((x) => x > 0).length / Math.max(1, v.length)) * 100)}%`, "Дней в плюсе"]]));
    },
    sym(s) {
      const up = s.bySym.filter((g) => g.pnl > 0), dn = s.bySym.filter((g) => g.pnl <= 0).reverse();
      const rows = (a) => (a.length ? hbars(a.slice(0, 5).map((g) => ({ k: g.k, v: g.pnl, sub: ` · ${g.n} · ${wr(g)}` }))) : `<div class="wg-sub">—</div>`);
      const pin = up.reduce((a, g) => a + g.pnl, 0), pout = dn.reduce((a, g) => a + g.pnl, 0);
      return wg("sym", `<div class="wg-two"><div><div class="wg-cap">${esc(_t("В плюсе"))} · ${up.length}</div>${rows(up)}</div><div><div class="wg-cap">${esc(_t("В минусе"))} · ${dn.length}</div>${rows(dn)}</div></div>`
        + foot([[fmtUsd(pin), "Принесли", "up"], [fmtUsd(pout), "Забрали", pout ? "down" : ""], [String(s.bySym.length), "Монет"], [(s.n / Math.max(1, s.bySym.length)).toFixed(1), "Сделок на монету"]]));
    },
    tags(s) {
      const m = new Map(), combo = new Map();
      s.closed.forEach((t) => {
        const tg = tagsOf(t);
        tg.forEach((x) => { const g = m.get(x) || { k: x, n: 0, w: 0, pnl: 0 }; g.n++; if (t.pnl > 0) g.w++; g.pnl += t.pnl; m.set(x, g); });
        if (tg.length >= 2) { const k = [...tg].sort().map((x) => _t(x)).join(" + "); const g = combo.get(k) || { k, n: 0, w: 0, pnl: 0 }; g.n++; if (t.pnl > 0) g.w++; g.pnl += t.pnl; combo.set(k, g); }
      });
      if (!m.size) return wg("tags", emptyW("На сделках этого периода нет тегов", "Отмечай причину входа на сделке — разбивка появится сразу."));
      const list = [...m.values()].sort((a, b) => b.pnl - a.pnl);
      const cb = [...combo.values()].sort((a, b) => b.pnl - a.pnl);
      return wg("tags", hbars(list.slice(0, 8).map((g) => ({ k: _t(g.k), v: g.pnl, sub: ` · ${g.n} · ${wr(g)}` })))
        + (cb.length ? `<div class="wg-sep"></div><div class="wg-cap" style="margin-bottom:2px">${esc(_t("Комбинации тегов"))}</div><div class="wg-list">${cb.slice(0, 3).map((g) => `<div class="wg-li"><span>${esc(g.k)} · ${g.n}</span><b class="${cls(g.pnl)}">${fmtUsd(g.pnl)}</b></div>`).join("")}</div>` : ""));
    },
    dow(s) {
      const m = Object.fromEntries(s.byDow.map((g) => [g.k, g])), names = wd();
      const v = names.map((_, i) => (m[i] ? m[i].pnl : 0));
      const act = s.byDow.slice().sort((a, b) => b.pnl - a.pnl), best = act[0], worst = act[act.length - 1];
      const wk = [0, 1, 2, 3, 4].reduce((a, i) => a + v[i], 0), we = v[5] + v[6];
      return wg("dow", big(best ? `${_t("Лучший день недели")} · ${names[best.k]}` : "", best ? fmtUsd(best.pnl) : "—", best ? cls(best.pnl) : "")
        + `<div class="wg-viz">${svgBars(v, 80, { labels: names.map((n, i) => `${esc(n)}·${m[i] ? m[i].n : 0}`) })}</div>`
        + foot([[worst ? `${esc(names[worst.k])} ${fmtShort(worst.pnl)}` : "—", "Худший день", worst ? cls(worst.pnl) : ""], [fmtUsd(s.expectancy), "Средняя сделка", cls(s.expectancy)], [fmtUsd(wk), "Пн–Пт", cls(wk)], [fmtUsd(we), "Выходные", cls(we)]]));
    },
    hour(s, X) {
      const v = Array.from({ length: 24 }, (_, h) => (X.byOpenHour.get(h) || { pnl: 0 }).pnl);
      const hs = [...X.byOpenHour.values()].sort((a, b) => b.pnl - a.pnl), best = hs[0], worst = hs[hs.length - 1];
      const lab = v.map((_, h) => (h % 6 === 0 ? String(h).padStart(2, "0") : ""));
      return wg("hour", big(_t("Лучший час входа"), best ? hh(best.k) : "—", "", best ? `<span class="${cls(best.pnl)}">${fmtUsd(best.pnl)}</span> · ${best.n} ${esc(tradesWord(best.n))}` : "")
        + `<div class="wg-viz">${svgBars(v, 80, { bw: 7, labels: lab })}</div>`
        + foot([[worst ? `${hh(worst.k)}` : "—", "Худший час", worst ? cls(worst.pnl) : ""], [`${X.byOpenHour.size} ${esc(_t("из"))} 24`, "Часов с торговлей"], [String(hs.filter((g) => g.pnl > 0).length), "Часов в плюсе", "up"], [String(hs.filter((g) => g.pnl < 0).length), "Часов в минусе", "down"]]));
    },
    session(s, X) {
      const g = SESS.map((_, i) => X.bySess.get(i) || { k: i, n: 0, w: 0, pnl: 0 });
      const act = g.filter((x) => x.n).sort((a, b) => b.pnl - a.pnl), best = act[0], worst = act[act.length - 1];
      return wg("session", big(best ? `${_t("Лучшая сессия")} · ${_t(SESS[best.k][0])}` : "", best ? fmtUsd(best.pnl) : "—", best ? cls(best.pnl) : "", esc(_t("по времени входа, UTC")))
        + `<div class="wg-viz">${svgBars(g.map((x) => x.pnl), 80, { bw: 5, labels: SESS.map(([n], i) => `${esc(_t(n))}·${g[i].n}`) })}</div>`
        + foot([[worst ? esc(_t(SESS[worst.k][0])) : "—", "Худшая сессия", worst ? cls(worst.pnl) : ""], [best ? String(best.n) : "0", "Сделок в лучшей"], [wr(best), "Win rate в лучшей"], [`${act.length} ${esc(_t("из"))} 5`, "Сессий с торговлей"]]));
    },
    hold(s, X) {
      if (!X.hold.length) return wg("hold", emptyW("Биржа не отдала время входа"));
      const d = X.hold.map((x) => x.d), g = HOLD.map((_, i) => X.byHold.get(i) || { k: i, n: 0, pnl: 0 });
      const avg = g.map((x) => (x.n ? x.pnl / x.n : 0)), act = g.filter((x) => x.n).sort((a, b) => b.pnl / b.n - a.pnl / a.n);
      return wg("hold", big(_t("Среднее время в сделке"), fmtDur(mean(d)), "", `${esc(_t("медиана"))} ${fmtDur(median(d))}`)
        + `<div class="wg-viz">${svgBars(avg, 80, { bw: 5.5, labels: HOLD.map(([n], i) => `${esc(_t(n))}·${g[i].n}`) })}</div>`
        + foot([[fmtDur(s.durWin), "Прибыльные держишь", "up"], [fmtDur(s.durLoss), "Убыточные держишь", "down"], [act[0] ? esc(_t(HOLD[act[0].k][0])) : "—", "Лучший интервал"], [act.length > 1 ? esc(_t(HOLD[act[act.length - 1].k][0])) : "—", "Худший интервал"]]));
    },
    side(s) {
      const col = (k) => { const list = s.closed.filter((t) => t.side === k), x = stats(list); const d = list.filter((t) => t.openT).map((t) => t.closeT - t.openT); return `<div><div class="wg-cap"><span class="sd ${k === "long" ? "L" : "S"}">${k === "long" ? "LONG" : "SHORT"}</span></div>${big("", fmtUsd(x.net), cls(x.net), "", true)}<div class="wg-list" style="margin-top:6px">${li("Сделок", x.n)}${li("Win rate", x.n ? `${Math.round(x.winRate * 100)}%` : "—")}${li("Profit factor", x.n ? pfS(x.pf) : "—")}${li("Средняя сделка", x.n ? fmtUsd(x.expectancy) : "—", cls(x.expectancy))}${li("В сделке", fmtDur(mean(d)))}</div></div>`; };
      return wg("side", `<div class="wg-two">${col("long")}${col("short")}</div>`);
    },
    lev(s, X) {
      if (!X.byLev.size) return wg("lev", emptyW("Биржа не отдаёт плечо по сделкам"));
      const g = LEV.map((_, i) => X.byLev.get(i) || { k: i, n: 0, pnl: 0 }), act = g.filter((x) => x.n).sort((a, b) => b.pnl / b.n - a.pnl / a.n);
      const withLev = s.closed.filter((t) => t.lev), lo = withLev.filter((t) => t.lev <= 10).length;
      return wg("lev", big(_t("Лучше всего работает"), act[0] ? esc(LEV[act[0].k][0]) : "—", "", act[0] ? `<span class="${cls(act[0].pnl)}">${fmtUsd(act[0].pnl / act[0].n)}</span> ${esc(_t("в среднем на сделку"))}` : "")
        + `<div class="wg-viz">${svgBars(g.map((x) => (x.n ? x.pnl / x.n : 0)), 80, { bw: 5.5, labels: LEV.map(([n], i) => `${n}·${g[i].n}`) })}</div>`
        + foot([[`×${mean(withLev.map((t) => t.lev)).toFixed(0)}`, "Среднее плечо"], [`${lo} ${esc(_t("из"))} ${withLev.length}`, "Сделок до ×10"], [String(withLev.length - lo), "Выше ×10"], [act.length > 1 ? esc(LEV[act[act.length - 1].k][0]) : "—", "Хуже всего"]]));
    },
    streak(s) {
      const c = s.closed; let cur = 0;
      for (let i = c.length - 1; i >= 0; i--) { const sg = Math.sign(c[i].pnl); if (!sg) break; if (!cur || Math.sign(cur) === sg) cur += sg; else break; }
      const after = (cond) => { let n = 0, w = 0; for (let i = 2; i < c.length; i++) if (cond(i)) { n++; if (c[i].pnl > 0) w++; } return n ? `${Math.round((w / n) * 100)}%` : "—"; };
      return wg("streak", big(_t("Текущая серия"), cur ? `${Math.abs(cur)} ${esc(_t(cur > 0 ? "в плюс" : "в минус"))}` : "—", cur > 0 ? "up" : cur < 0 ? "down" : "", esc(_t("сделок подряд")))
        + foot([[`+${s.streakW}`, "Макс. серия прибылей", "up"], [`−${s.streakL}`, "Макс. серия убытков", "down"], [after((i) => c[i - 1].pnl < 0 && c[i - 2].pnl < 0), "Win rate после 2 убытков"], [after((i) => c[i - 1].pnl > 0), "Win rate после прибыли"]]));
    },
    revenge(s) {
      const r = s.revenge;
      if (!r.n) return wg("revenge", emptyW("Нет сделок сразу после убытка", "Хорошо: ты не пытаешься быстро отыграться."));
      const w = r.w / r.n;
      return wg("revenge", big(_t("Сделки в течение 30 минут после убытка"), fmtUsd(r.pnl), cls(r.pnl), `${r.n} ${esc(tradesWord(r.n))} · ${esc(_t(w < s.winRate ? "хуже, чем обычно" : "не хуже, чем обычно"))}`)
        + foot([[`${Math.round(w * 100)}%`, "Win rate после убытка", w < s.winRate ? "down" : "up"], [`${Math.round(s.winRate * 100)}%`, "Win rate в целом"], [fmtUsd(r.pnl / r.n), "Средняя такая сделка", cls(r.pnl)]], "c3"));
    },
    perday(s, X) {
      const d = X.days.slice(-45), v = d.map((x) => x.n), md = median(v) || 0;
      const busy = X.days.filter((x) => x.n > md), calm = X.days.filter((x) => x.n <= md);
      const bp = busy.reduce((a, x) => a + x.pnl, 0), cp = calm.reduce((a, x) => a + x.pnl, 0);
      return wg("perday", big(_t("Сделок в торговый день"), (mean(X.days.map((x) => x.n)) || 0).toFixed(1), "", `${esc(_t("пик"))} ${Math.max(0, ...v)} · ${esc(_t("медиана"))} ${md}`)
        + `<div class="wg-viz">${svgBars(v, 70, { mono: true })}</div>`
        + foot([[fmtUsd(bp), "Дни с частой торговлей", cls(bp)], [fmtUsd(cp), "Спокойные дни", cls(cp)], [String(busy.length), "Частых дней"]], "c3"));
    },
    fees(s, X) {
      const v = X.days.slice(-45).map((x) => x.fee || 0), peak = X.days.reduce((b, x) => (!b || (x.fee || 0) > (b.fee || 0) ? x : b), null);
      return wg("fees", big(_t("Комиссии за период"), fmtUsd(-s.fees), s.fees ? "down" : "", `${fmtUsd(-s.fees / Math.max(1, s.n))} ${esc(_t("на сделку"))}`)
        + `<div class="wg-viz">${svgBars(v, 64, { mono: true })}</div>`
        + foot([[s.grossWin ? `${Math.round((s.fees / s.grossWin) * 100)}%` : "—", "От прибыльных сделок"], [s.net ? `${Math.round((s.fees / Math.abs(s.net)) * 100)}%` : "—", "От итога"], [peak && peak.fee ? fmtUsd(-peak.fee) : "—", "Самый дорогой день", "down"]], "c3"));
    },
    funding(s) {
      const f = s.closed.map((t) => t.funding || 0), paid = f.filter((x) => x < 0).reduce((a, x) => a + x, 0), got = f.filter((x) => x > 0).reduce((a, x) => a + x, 0);
      return wg("funding", big(_t("Фандинг, итог"), fmtUsd(s.funding), cls(s.funding), esc(_t("плюс — получил, минус — заплатил")))
        + foot([[fmtUsd(paid), "Заплатил", paid ? "down" : ""], [fmtUsd(got), "Получил", got ? "up" : ""], [s.net ? `${Math.round((Math.abs(s.funding) / Math.abs(s.net)) * 100)}%` : "—", "От итога"], [String(f.filter((x) => x).length), "Сделок с фандингом"]]));
    },
    exch(s) {
      if (s.byEx.length < 2) return null;
      return wg("exch", hbars(s.byEx.sort((a, b) => b.pnl - a.pnl).map((g) => ({ k: EX[g.k] ? EX[g.k].name.replace(" Futures", "") : g.k, v: g.pnl, sub: ` · ${g.n} · ${wr(g)}` }))));
    },
  };

  // ---------------------------------------------------------------- поповеры плашек: период и «как считается»
  const POP = { id: null, kind: null, month: new Date(), from: null, to: null, anchor: null };
  function popEl() {
    let p = $("#jr-pop");
    if (!p) {
      p = document.createElement("div"); p.id = "jr-pop"; p.className = "jr-pop"; p.hidden = true; p.setAttribute("role", "dialog");
      document.body.appendChild(p);
      p.addEventListener("click", onClick);
      p.addEventListener("mouseleave", (e) => { if (POP.kind === "info" && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".wg-i"))) closePop(); });
      document.addEventListener("click", (e) => { if (!p.hidden && e.target.isConnected && !e.target.closest("#jr-pop") && !e.target.closest("#jr")) closePop(); });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
      window.addEventListener("resize", closePop);
    }
    return p;
  }
  function closePop() { const p = $("#jr-pop"); if (p && !p.hidden) { p.hidden = true; p.innerHTML = ""; POP.id = null; POP.kind = null; } }
  function placePop(p, anchor) {
    const r = anchor.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight;
    p.style.visibility = "hidden"; p.hidden = false;
    const pw = p.offsetWidth, ph = p.offsetHeight;
    if (W < 600) { p.style.left = `${Math.max(8, (W - pw) / 2)}px`; p.style.top = `${Math.max(8, Math.min(H - ph - 8, r.bottom + 8))}px`; }
    else {
      let x = Math.min(W - pw - 12, Math.max(12, r.right - pw)), y = r.bottom + 8;
      if (POP.kind === "info") x = Math.min(W - pw - 12, Math.max(12, r.left - 12));
      if (y + ph > H - 12) y = Math.max(12, r.top - ph - 8);
      p.style.left = `${x}px`; p.style.top = `${y}px`;
    }
    p.style.visibility = "";
  }
  function openPer(anchor, id) {
    if (POP.id === id && POP.kind === "per") { closePop(); return; }
    const spec = wSpec(id);
    POP.id = id; POP.kind = "per"; POP.anchor = anchor;
    const [f, t] = perRange(spec);
    POP.from = spec.startsWith("c:") ? ymd(f) : null; POP.to = spec.startsWith("c:") ? ymd(t) : null;
    POP.month = new Date(new Date(POP.to ? fromYmd(POP.to) : Date.now()).getFullYear(), new Date(POP.to ? fromYmd(POP.to) : Date.now()).getMonth(), 1);
    drawPer();
  }
  function drawPer() {
    const p = popEl(), spec = wSpec(POP.id), own = !!lsObj(WPER_KEY)[POP.id];
    p.classList.remove("info");
    const [rf, rt] = perRange(spec);
    const fromS = POP.from ? fmtD(fromYmd(POP.from), true) : rf ? fmtD(rf, true) : "—";
    const toS = POP.to ? fmtD(fromYmd(POP.to), true) : POP.from ? "…" : fmtD(rt === Infinity ? Date.now() : rt, true);
    const m = POP.month, y = m.getFullYear(), mo = m.getMonth(), days = new Date(y, mo + 1, 0).getDate(), lead = (new Date(y, mo, 1).getDay() + 6) % 7;
    const a = POP.from ? fromYmd(POP.from) : rf, b = POP.to ? fromYmd(POP.to) : POP.from ? fromYmd(POP.from) : (rt === Infinity ? sod(Date.now()) : rt);
    const today = sod(Date.now());
    let cells = wd().map((d) => `<span class="jp-wd">${esc(d)}</span>`).join("");
    for (let i = 0; i < lead; i++) cells += `<span></span>`;
    for (let d = 1; d <= days; d++) {
      const t = new Date(y, mo, d).getTime(), k = ymd(t), inR = a && t >= sod(a) && t <= b, edge = inR && (t === sod(a) || t === sod(b));
      cells += `<button class="jp-d ${inR ? "in" : ""} ${edge ? "edge" : ""} ${t === today ? "today" : ""}" data-j="per-day" data-v="${k}" ${t > today ? "disabled" : ""}>${d}</button>`;
    }
    const title = m.toLocaleDateString(I18.locale, { month: "long", year: "numeric" });
    p.innerHTML = `<div class="jp-h"><b>${esc(_t("Период"))}</b><span>${esc(_t(WG_NAME[POP.id]))}</span><button class="jp-x" data-j="pop-close" aria-label="${esc(_t("Закрыть"))}">×</button></div>
      <div class="jp-pre">${PRESETS.map(([k, l]) => `<button class="${spec === k && own ? "on" : ""}" data-j="per-set" data-v="${k}">${esc(_t(l))}</button>`).join("")}</div>
      <div class="jp-rng"><span><small>${esc(_t("С"))}</small><b>${esc(fromS)}</b></span><i>→</i><span><small>${esc(_t("По"))}</small><b>${esc(toS)}</b></span></div>
      <div class="jp-cal"><div class="jp-m"><button data-j="per-mon" data-v="-1" aria-label="${esc(_t("Назад"))}">‹</button><b>${esc(title.charAt(0).toUpperCase() + title.slice(1))}</b><button data-j="per-mon" data-v="1" aria-label="${esc(_t("Вперёд"))}" ${y === new Date().getFullYear() && mo === new Date().getMonth() ? "disabled" : ""}>›</button></div><div class="jp-g">${cells}</div>
      <p class="jp-hint">${esc(_t(POP.from && !POP.to ? "Выбери конечную дату" : "Нажми на две даты, чтобы задать свой период"))}</p></div>
      <button class="jp-reset ${own ? "" : "on"}" data-j="per-reset">${esc(_t("Как у всего журнала"))} · ${esc(perShort(String(S.period)))}</button>`;
    placePop(p, POP.anchor);
  }
  function pickDay(k) {
    if (!POP.from || POP.to) { POP.from = k; POP.to = null; drawPer(); return; }
    let f = POP.from, t = k;
    if (fromYmd(t) < fromYmd(f)) [f, t] = [t, f];
    setPer(`c:${f}:${t}`);
  }
  function setPer(spec) {
    const o = lsObj(WPER_KEY);
    if (spec == null || spec === String(S.period) && !String(spec).startsWith("c:")) delete o[POP.id]; else o[POP.id] = spec;
    lsPut(WPER_KEY, o);
    closePop();
    render();
  }
  function openInfo(anchor, id, toggle) {
    if (toggle && POP.id === id && POP.kind === "info") { closePop(); return; }
    const I = window.JR_INFO && window.JR_INFO[id];
    if (!I) return;
    const tx = I18.lang === "ru" ? I.ru : I.en;
    const p = popEl();
    POP.id = id; POP.kind = "info"; POP.anchor = anchor;
    const sec = (ic, t, x, c) => `<div class="ji-s ${c || ""}"><span class="ji-k"><i aria-hidden="true">${ic}</i>${esc(_t(t))}</span><p>${esc(x)}</p></div>`;
    p.innerHTML = `<div class="ji">${sec("∑", "Как считается", tx[0])}${sec("◎", "Зачем это", tx[1])}${sec("✦", "Как помогает", tx[2])}${sec("→", "Пример", tx[3], "ex")}</div>`;
    p.classList.add("info");
    placePop(p, anchor);
  }

  function overviewHtml() {
    const cfg = wgCfg(), cache = {};
    const data = (spec) => cache[spec] || (cache[spec] = (() => { const s = stats(filtered(spec)); return { s, X: ext(s) }; })());
    let h = "";
    GROUPS.forEach(([g, title, sub]) => {
      const parts = cfg.order.filter((id) => WG_GROUP[id] === g && !cfg.off.includes(id)).map((id) => {
        CUR = NOPER.includes(id) ? String(S.period) : wSpec(id);
        try {
          const { s, X } = data(CUR);
          if (!s.n && !NOPER.includes(id) && id !== "exch") return wg(id, emptyW("За этот период сделок нет", "Выбери другой период в правом углу плашки."));
          return WG[id](s, X);
        } catch (e) { console.warn("widget", id, e); return ""; } finally { CUR = null; }
      }).filter(Boolean);
      if (parts.length) h += `<div class="wg-sec"><b>${esc(_t(title))}</b><small>${esc(_t(sub))}</small></div><div class="wg-grid">${parts.join("")}</div>`;
    });
    return h || `<div class="jr-empty glass"><p>${esc(_t("Все виджеты выключены — включи нужные в «Виджеты»."))}</p></div>`;
  }

  // ================================================================ свечи по сделке: MAE / MFE, качество выхода, график
  // Свечи — из публичного API Binance Futures (запасной вариант — Bybit), ключ не нужен.
  // MFE — самое выгодное движение цены за время сделки, MAE — самое невыгодное.
  const LWC_URL = "https://cdn.jsdelivr.net/npm/lightweight-charts@5.1.0/dist/lightweight-charts.standalone.production.js";
  let lwLoading = null;
  function loadLW() {
    if (window.LightweightCharts) return Promise.resolve();
    if (!lwLoading) lwLoading = new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = LWC_URL; sc.onload = res; sc.onerror = () => { lwLoading = null; rej(new Error("lwc")); }; document.head.appendChild(sc); });
    return lwLoading;
  }
  const IVS = [["1m", 60], ["5m", 300], ["15m", 900], ["1h", 3600], ["4h", 14400]];
  const BYB_IV = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240" };
  // интервал свечей: самый мелкий, при котором сделка с запасом по краям влезает в 1000 свечей
  function pickIv(t, want) {
    const hold = Math.max(60e3, (t.closeT || Date.now()) - (t.openT || t.closeT));
    if (want) { const f = IVS.find((x) => x[0] === want); if (f) return f; }
    return IVS.find(([, sec]) => (hold * 1.7) / (sec * 1000) + 60 <= 1000) || IVS[IVS.length - 1];
  }
  function tradeWindow(t, sec) {
    const o = t.openT || t.closeT - 3600e3, c = t.closeT || Date.now(), hold = c - o;
    const pad = Math.max(40 * sec * 1000, hold * 0.35);
    return [Math.floor((o - pad) / 1000 / sec) * sec * 1000, Math.min(Date.now(), c + Math.max(pad, 31 * 60e3))];
  }
  async function fetchKlines(t, iv, sec) {
    const [from, to] = tradeWindow(t, sec), n = Math.min(1000, Math.ceil((to - from) / (sec * 1000)) + 2);
    const syms = [`${t.sym}USDT`, `1000${t.sym}USDT`];
    let k = null;
    for (const s of syms) {
      try { const d = await getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=${iv}&startTime=${from}&endTime=${to}&limit=${n}`); if (Array.isArray(d) && d.length) { k = d.map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] })); break; } } catch (e) { /* следующий вариант */ }
    }
    if (!k) for (const s of syms) {
      try { const d = await getJSON(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${s}&interval=${BYB_IV[iv]}&start=${from}&end=${to}&limit=${n}`); const L = d && d.result && d.result.list; if (L && L.length) { k = L.map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] })).reverse(); break; } } catch (e) { /* нет данных */ }
    }
    if (!k || !t.entry) return k;
    // масштаб: на бирже мог торговаться 1000PEPE, а свечи — PEPE (или наоборот)
    const near = k.reduce((b, c) => (Math.abs(c.t - (t.openT || t.closeT)) < Math.abs(b.t - (t.openT || t.closeT)) ? c : b), k[0]);
    const r = t.entry / near.c, m = r > 300 ? 1000 : r < 1 / 300 ? 1 / 1000 : 1;
    return m === 1 ? k : k.map((c) => ({ t: c.t, o: c.o * m, h: c.h * m, l: c.l * m, c: c.c * m }));
  }
  // демо-сделки: правдоподобные свечи, проходящие через цены входа и выхода
  function demoKlines(t, sec) {
    let sd = [...String(t.id)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 2147483647, 7) || 7;
    const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647) - 0.5;
    const [from, to] = tradeWindow(t, sec), step = sec * 1000, o = t.openT, c = t.closeT;
    const vol = Math.max(Math.abs(t.exit - t.entry) * 0.35, t.entry * 0.0015);
    const pts = [];
    const nIn = Math.max(2, Math.round((c - o) / step));
    let w = 0; const walk = [];
    for (let i = 0; i <= nIn; i++) { walk.push(w); w += rnd() * vol * 0.6; }
    for (let x = from; x <= to; x += step) {
      let p;
      if (x <= o) p = t.entry + rnd() * vol * 0.4 + ((x - o) / step) * rnd() * vol * 0.05;
      else if (x >= c) p = t.exit + rnd() * vol * 0.5 + ((x - c) / step) * vol * 0.02 * Math.sin(sd);
      else { const i = Math.round((x - o) / step), f = i / nIn; p = t.entry + (t.exit - t.entry) * f + (walk[i] - f * walk[nIn]); }
      pts.push([x, p]);
    }
    return pts.map(([x, p], i) => { const pr = i ? pts[i - 1][1] : p; const hi = Math.max(p, pr) + Math.abs(rnd()) * vol * 0.25, lo = Math.min(p, pr) - Math.abs(rnd()) * vol * 0.25; return { t: x, o: pr, h: hi, l: lo, c: p }; });
  }
  function excursion(t, k, sec) {
    if (!k || !k.length || !t.entry || !t.exit || !t.openT || !t.closeT) return null;
    const dir = t.side === "long" ? 1 : -1, step = sec * 1000;
    const inK = k.filter((c) => c.t + step > t.openT && c.t <= t.closeT);
    if (!inK.length) return null;
    const hi = Math.max(t.entry, t.exit, ...inK.map((c) => c.h)), lo = Math.min(t.entry, t.exit, ...inK.map((c) => c.l));
    const fav = dir > 0 ? hi : lo, adv = dir > 0 ? lo : hi, q = t.qty || (t.notional && t.entry ? t.notional / t.entry : 0);
    const after = k.filter((c) => c.t >= t.closeT && c.t <= t.closeT + 30 * 60e3);
    const a30 = after.length && after[after.length - 1].t >= t.closeT + 20 * 60e3 ? after[after.length - 1].c : null;
    const move = (t.exit - t.entry) * q * dir, mfeU = (fav - t.entry) * q * dir;
    return {
      mfeP: ((fav - t.entry) / t.entry) * 100 * dir, maeP: ((adv - t.entry) / t.entry) * 100 * dir,
      mfeU, maeU: (adv - t.entry) * q * dir, move, took: mfeU > 0 ? move / mfeU : null,
      afterU: a30 != null ? (a30 - t.exit) * q * dir : null, iv: sec,
    };
  }
  // фоновый расчёт для последних сделок периода; результат кэшируется на устройстве
  async function ensureExc(list) {
    if (S._excBusy) return;
    const need = list.filter((t) => !t.open && t.entry && t.exit && t.openT && !(t.id in S.exc)).slice(-30);
    if (!need.length) return;
    S._excBusy = true;
    try {
      if (need[0].demo) need.forEach((t) => { const [, sec] = pickIv(t); S.exc[t.id] = excursion(t, demoKlines(t, sec), sec); });
      else {
        await pool(need, 3, async (t) => { const [iv, sec] = pickIv(t); try { S.exc[t.id] = excursion(t, await fetchKlines(t, iv, sec), sec); } catch (e) { S.exc[t.id] = null; } });
        try { await kvSet("exc", S.exc); } catch (e) { /* noop */ }
      }
    } finally { S._excBusy = false; }
    if (S.open && !["trades", "calendar", "trade"].includes(S.view)) { const b = $("#jr-body"), top = b ? b.scrollTop : 0; render(); if (b) b.scrollTop = top; }
  }

  Object.assign(WG, {
    exit(s) {
      const xs = s.closed.map((t) => S.exc[t.id]).filter((x) => x && x.mfeU > 0);
      if (!xs.length) return wg("exit", emptyW(Object.keys(S.exc).length ? "Пока не хватает данных" : "Считаю по свечам…", "MAE и MFE считаются по свечам Binance для последних 30 сделок."));
      const took = mean(xs.map((x) => Math.max(-1, Math.min(1, x.took)))), peak = mean(xs.map((x) => x.mfeU)), got = mean(xs.map((x) => x.move));
      const H = 90, W = 600, yP = 8, yE = H - 8 - (H - 16) * Math.max(0, took);
      const viz = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" aria-hidden="true"><line class="sv-zero" x1="0" x2="${W}" y1="${H - 8}" y2="${H - 8}" vector-effect="non-scaling-stroke"/><path class="sv-area up" d="M0 ${H - 8} C150 ${H - 8} 220 ${yP} 330 ${yP} S480 ${yE} ${W} ${yE} L${W} ${H - 8} Z"/><path class="sv-line up" d="M0 ${H - 8} C150 ${H - 8} 220 ${yP} 330 ${yP} S480 ${yE} ${W} ${yE}"/></svg><div class="sv-xe"><span>${esc(_t("Вход"))}</span><span>${esc(_t("Пик"))} · 100%</span><span>${esc(_t("Выход"))}</span></div>`;
      return wg("exit", big(_t("Какую часть хода ты забираешь"), `${Math.round(took * 100)}%`, took >= 0.5 ? "up" : took < 0.25 ? "down" : "", `${xs.length} ${esc(tradesWord(xs.length))} · ${esc(_t("от входа до лучшей цены в сделке"))}`)
        + `<div class="wg-viz">${viz}</div>`
        + foot([[fmtUsd(peak), "Пик в среднем", "up"], [fmtUsd(got), "Забрал в среднем", cls(got)], [fmtUsd(got - peak), "Оставил на столе", "down"], [pctS(mean(xs.map((x) => x.maeP)), 2), "Против тебя (MAE)", "down"]]));
    },
    after(s) {
      const xs = s.closed.map((t) => S.exc[t.id]).filter((x) => x && x.afterU != null);
      if (!xs.length) return wg("after", emptyW(Object.keys(S.exc).length ? "Пока не хватает данных" : "Считаю по свечам…", "Сравниваем цену выхода с ценой через 30 минут."));
      const sum = xs.reduce((a, x) => a + x.afterU, 0), early = xs.filter((x) => x.afterU > 0).length;
      const best = Math.max(...xs.map((x) => x.afterU)), worst = Math.min(...xs.map((x) => x.afterU));
      return wg("after", big(_t("Результат изменился бы на"), fmtUsd(sum), cls(sum), esc(_t(sum > 0 ? "ты выходишь рановато — цена шла дальше в твою сторону" : "выходы вовремя — дальше цена шла против тебя")))
        + foot([[`${early} ${esc(_t("из"))} ${xs.length}`, "Выход был ранним"], [fmtUsd(best), "Упущено максимум", best > 0 ? "up" : ""], [worst < 0 ? fmtUsd(-worst) : "$0", "Сэкономил выходом максимум", worst < 0 ? "up" : ""]], "c3"));
    },
  });

  // ---------------------------------------------------------------- страница сделки
  let tpChart = null;
  function tradePageHtml(t) {
    const dir = t.side === "long" ? 1 : -1, x = S.exc[t.id], q = t.qty || 0;
    const pct = t.notional ? (t.pnl / t.notional) * 100 : null, diffP = t.entry && t.exit ? ((t.exit - t.entry) / t.entry) * 100 * dir : null;
    const sess = t.openT ? _t(SESS[sessOf(t)][0]) : "—";
    const all = (S.demo ? (S._demo || []) : S.trades).filter((y) => y.id !== t.id && y.sym === t.sym && !y.open).sort((a, b) => b.closeT - a.closeT).slice(0, 5);
    const n = S.notes[t.id] || {};
    const ivNow = S.tpIv || "";
    let h = `<div class="tp-h"><button class="jr-tool" data-j="tp-back">‹ ${esc(_t("Назад"))}</button>
      <div class="tp-t"><b>${esc(t.sym)}</b><small>/USDT · ${esc(EX[t.ex] ? EX[t.ex].name.replace(" Futures", "") : t.ex)}</small><span class="sd ${t.side === "long" ? "L" : "S"}">${t.side === "long" ? "LONG" : "SHORT"}</span>${t.lev ? `<span class="tp-lev">×${t.lev}</span>` : ""}</div>
      <div class="tp-r"><b class="${cls(t.pnl)}">${t.open ? "—" : fmtUsd(t.pnl)}</b><small class="${cls(t.pnl)}">${pct == null || t.open ? "" : pctS(pct, 2)}</small></div></div>`;
    h += `<div class="wg-grid tp-grid">
      <section class="wg w2 tp-chart"><div class="tp-tf">${[["", "Авто"], ...IVS.map(([k]) => [k, k])].map(([k, l]) => `<button class="${ivNow === k ? "on" : ""}" data-j="tp-iv" data-v="${k}">${esc(_t(l))}</button>`).join("")}<span class="grow"></span><small id="tp-src"></small></div><div id="tp-chart" class="tp-cv"><span class="pc-spin"></span></div></section>
      <section class="wg"><header class="wg-h"><b>${esc(_t("Результат"))}</b></header><div class="wg-list">
        ${li("Реализовано", fmtUsd(t.gross), cls(t.gross))}${li("Комиссии", fmtUsd(-(t.fee || 0)), t.fee ? "down" : "")}${li("Фандинг", fmtUsd(t.funding || 0), cls(t.funding || 0))}${li("Итог", fmtUsd(t.pnl), cls(t.pnl))}
        ${li("Лучшая цена (MFE)", x ? `${pctS(x.mfeP, 2)} · ${fmtUsd(x.mfeU)}` : "…", "up")}${li("Против тебя (MAE)", x ? `${pctS(x.maeP, 2)} · ${fmtUsd(x.maeU)}` : "…", "down")}
        ${li("Забрал от хода", x && x.took != null ? `${Math.round(x.took * 100)}%` : "—")}${li("Через 30 мин после выхода", x && x.afterU != null ? fmtUsd(x.afterU) : "—", x && x.afterU != null ? cls(x.afterU) : "")}</div></section>
      <section class="wg"><header class="wg-h"><b>${esc(_t("Позиция"))}</b></header><div class="wg-list">
        ${li("Вход", fmtP(t.entry))}${li("Выход", fmtP(t.exit))}${li("Разница", diffP == null ? "—" : pctS(diffP, 3), cls(diffP))}${li("Количество", q ? `${fmtP(q)} ${esc(t.sym)}` : "—")}${li("Объём", fmtUsd(t.notional, false))}${li("Плечо", t.lev ? `×${t.lev}` : "—")}</div></section>
      <section class="wg"><header class="wg-h"><b>${esc(_t("Время"))}</b></header><div class="wg-list">
        ${li("Открыта", t.openT ? fmtDate(t.openT) : "—")}${li("Закрыта", t.open ? _t("открыта") : fmtDate(t.closeT))}${li("В сделке", t.openT && t.closeT ? fmtDur(t.closeT - t.openT) : "—")}${li("День", t.openT ? wd()[(new Date(t.openT).getDay() + 6) % 7] : "—")}${li("Сессия", esc(sess))}</div></section>
      <section class="wg"><header class="wg-h"><b>${esc(_t("Разбор сделки"))}</b></header>
        <div class="jr-tags">${TAGS.map((g) => `<button class="${tagsOf(t).includes(g) ? "on" : ""}" data-j="tag" data-v="${esc(t.id)}" data-tag="${esc(g)}">${esc(_t(g))}</button>`).join("")}</div>
        <textarea class="jr-note" data-note="${esc(t.id)}" placeholder="${esc(_t("Какой был план? Что сделал бы иначе? Что повторишь?"))}">${esc(n.note || "")}</textarea>
        <button class="jr-ai" data-j="ai-trade" data-v="${esc(t.id)}" style="margin-top:10px"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3l1.8 4.9L19 9.7l-4.3 3 1.4 5.3L12 15l-4.1 3 1.4-5.3L5 9.7l5.2-1.8z" fill="currentColor"/></svg>${esc(_t("ИИ-разбор этой сделки"))}<i class="pc-pro">PRO</i></button>
        <div class="jr-ai-out" id="jr-ai-out"></div></section>
      <section class="wg"><header class="wg-h"><b>${esc(_t("Другие сделки по"))} ${esc(t.sym)}</b></header>${all.length ? `<div class="wg-list">${all.map((y) => `<button class="wg-li tp-sim" data-j="open-trade" data-v="${esc(y.id)}"><span><span class="sd ${y.side === "long" ? "L" : "S"}">${y.side === "long" ? "L" : "S"}</span> ${fmtDate(y.closeT)}</span><b class="${cls(y.pnl)}">${fmtUsd(y.pnl)}</b></button>`).join("")}</div>` : emptyW("Других сделок по этой монете нет")}</section>
    </div>`;
    return h;
  }
  async function drawTradeChart(t) {
    const box = $("#tp-chart");
    if (!box) return;
    const [iv, sec] = pickIv(t, S.tpIv);
    let k;
    try {
      k = t.demo ? demoKlines(t, sec) : await fetchKlines(t, iv, sec);
      await loadLW();
    } catch (e) { k = k || null; }
    if (!$("#tp-chart") || S.tradeId !== t.id) return;
    if (!k || !k.length || !window.LightweightCharts) { box.innerHTML = `<div class="wg-empty"><div><b>${esc(_t("Свечи не загрузились"))}</b><br>${esc(_t("Биржа не отдала историю по этой монете."))}</div></div>`; return; }
    const src = $("#tp-src"); if (src) src.textContent = `${t.demo ? _t("демо") : "Binance"} · ${iv}`;
    if (!(t.id in S.exc) || (S.exc[t.id] && S.exc[t.id].iv > sec)) { S.exc[t.id] = excursion(t, k, sec); if (!t.demo) kvSet("exc", S.exc).catch(() => {}); }
    const LW = window.LightweightCharts, tz = -new Date().getTimezoneOffset() * 60;
    box.innerHTML = "";
    if (tpChart) { try { tpChart.remove(); } catch (e) { /* noop */ } }
    tpChart = LW.createChart(box, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: "rgba(250,250,250,.55)", fontSize: 11, fontFamily: "Inter, system-ui, sans-serif" },
      grid: { vertLines: { color: "rgba(255,255,255,.04)" }, horzLines: { color: "rgba(255,255,255,.04)" } },
      rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "rgba(255,255,255,.25)", labelBackgroundColor: "#1c1c1e" }, horzLine: { color: "rgba(255,255,255,.25)", labelBackgroundColor: "#1c1c1e" } },
      localization: { locale: I18.locale },
    });
    const ser = tpChart.addSeries(LW.CandlestickSeries, { upColor: "#e9e9ea", downColor: "#4a4a4f", wickUpColor: "#9a9a9f", wickDownColor: "#6a6a70", borderVisible: false, priceLineVisible: false, lastValueVisible: false });
    const T = (ms) => Math.floor(ms / 1000) + tz;
    ser.setData(k.map((c) => ({ time: T(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
    const snap = (ms) => T(Math.floor(ms / (sec * 1000)) * sec * 1000);
    const win = t.pnl >= 0, long = t.side === "long";
    const mk = [];
    if (t.openT) mk.push({ time: snap(t.openT), position: long ? "belowBar" : "aboveBar", color: "#00c58a", shape: long ? "arrowUp" : "arrowDown", text: _t("Вход") });
    if (t.closeT && !t.open) mk.push({ time: snap(t.closeT), position: long ? "aboveBar" : "belowBar", color: win ? "#00c58a" : "#f2735b", shape: long ? "arrowDown" : "arrowUp", text: _t("Выход") });
    LW.createSeriesMarkers(ser, mk.sort((a, b) => a.time - b.time));
    if (t.entry) ser.createPriceLine({ price: t.entry, color: "rgba(255,255,255,.55)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: _t("Вход") });
    if (t.exit && !t.open) ser.createPriceLine({ price: t.exit, color: win ? "#00c58a" : "#f2735b", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: _t("Выход") });
    tpChart.timeScale().fitContent();
    // обновим блок «Результат» — MAE/MFE теперь посчитаны
    const res = document.querySelector(".tp-grid .wg:nth-child(2) .wg-list");
    if (res && S.exc[t.id]) { const tmp = document.createElement("div"); tmp.innerHTML = tradePageHtml(t); const nr = tmp.querySelector(".tp-grid .wg:nth-child(2) .wg-list"); if (nr) res.innerHTML = nr.innerHTML; }
  }
  function openTrade(id) {
    const src = S.demo ? (S._demo || (S._demo = demoTrades())) : S.trades;
    const t = src.find((x) => x.id === id);
    if (!t) return;
    S.backView = S.view === "trade" ? S.backView : S.view;
    S.view = "trade"; S.tradeId = id;
    render();
    $("#jr-body").scrollTop = 0;
  }
  async function aiTrade(btn, id) {
    const out = $("#jr-ai-out"), A = window.AUTH;
    const src = S.demo ? (S._demo || []) : S.trades, t = src.find((x) => x.id === id);
    if (!t) return;
    if (!CFG.supabaseUrl || !A || !A.enabled || !A.sb) { out.innerHTML = `<p class="jr-muted">${esc(_t("ИИ-разбор подключится вместе со входом в аккаунт."))}</p>`; return; }
    const sess = (await A.sb.auth.getSession()).data.session;
    if (!sess) { out.innerHTML = `<p class="jr-muted">${esc(_t("Войди в аккаунт, чтобы получить ИИ-разбор."))}</p>`; return; }
    if (CFG.premium === "paid" && A.loadPlan && (await A.loadPlan()) !== "pro") { out.innerHTML = `<p class="jr-muted">${esc(_t("ИИ-разбор торговли доступен в McQ Pro."))}</p>`; if (window.Pro && window.Pro.available()) window.Pro.open(); return; }
    const x = S.exc[t.id] || {}, r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
    const s = stats(filtered());
    const ctx = {
      trade: { sym: t.sym, side: t.side, exchange: t.ex, entry: t.entry, exit: t.exit, qty: t.qty, notional: r2(t.notional), leverage: t.lev || null,
        pnl: r2(t.pnl), gross: r2(t.gross), fees: r2(t.fee), funding: r2(t.funding), opened: t.openT ? new Date(t.openT).toISOString() : null, closed: t.closeT ? new Date(t.closeT).toISOString() : null,
        hold_min: t.openT && t.closeT ? Math.round((t.closeT - t.openT) / 60000) : null, mfe_pct: r2(x.mfeP), mae_pct: r2(x.maeP), took_of_move_pct: x.took != null ? Math.round(x.took * 100) : null,
        price_30min_after_exit_usd: r2(x.afterU), tags: tagsOf(t), note: (S.notes[t.id] || {}).note || "" },
      context: { trades_in_period: s.n, win_rate_pct: Math.round(s.winRate * 100), avg_win: r2(s.avgWin), avg_loss: r2(s.avgLoss), avg_hold_win_min: s.durWin ? Math.round(s.durWin / 60000) : null, avg_hold_loss_min: s.durLoss ? Math.round(s.durLoss / 60000) : null },
      demo: !!t.demo,
    };
    btn.disabled = true;
    out.innerHTML = `<span class="pc-dots"><i></i><i></i><i></i></span>`;
    try {
      const r = await fetch(`${CFG.supabaseUrl}/functions/v1/chart-ai`, { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: `Bearer ${sess.access_token}` },
        body: JSON.stringify({ kind: "trade", question: "Review this trade", ctx, lang: I18.lang }) });
      const d = await r.json().catch(() => ({}));
      if (r.status === 402) throw new Error(_t("ИИ-разбор торговли доступен в McQ Pro."));
      if (r.status === 429) throw new Error(_t("Лимит вопросов на сегодня исчерпан"));
      if (!r.ok || !d.answer) throw new Error(d.error || `${r.status}`);
      out.innerHTML = `<div class="jr-ai-a">${esc(d.answer).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>")}</div><small class="jr-muted">${esc(_t("Не финансовый совет."))}</small>`;
    } catch (e) { out.innerHTML = `<p class="down">${esc(e.message || _t("ИИ не ответил. Попробуй ещё раз."))}</p>`; }
    btn.disabled = false;
  }

  // ---------------------------------------------------------------- список сделок с фильтрами
  function tradesViewHtml(s) {
    const F = S.tf || (S.tf = { side: "all", res: "all", sym: "all", tag: "all" });
    const base = s.open.concat(s.closed.slice().reverse());
    const syms = [...new Set(base.map((t) => t.sym))].sort(), tags = [...new Set(base.flatMap(tagsOf))];
    if (!syms.includes(F.sym)) F.sym = "all";
    if (!tags.includes(F.tag)) F.tag = "all";
    const list = base.filter((t) => (F.side === "all" || t.side === F.side) && (F.res === "all" || (F.res === "win" ? t.pnl > 0 : t.pnl < 0) && !t.open)
      && (F.sym === "all" || t.sym === F.sym) && (F.tag === "all" || tagsOf(t).includes(F.tag)));
    const sel = (k, opts) => `<select data-tf="${k}" aria-label="${esc(opts[0][1])}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${F[k] === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const x = stats(list);
    let h = `<div class="jr-flt">${sel("side", [["all", _t("Все стороны")], ["long", "Long"], ["short", "Short"]])}${sel("res", [["all", _t("Любой результат")], ["win", _t("В плюс")], ["loss", _t("В минус")]])}${sel("sym", [["all", _t("Все монеты")], ...syms.map((v) => [v, v])])}${tags.length ? sel("tag", [["all", _t("Все теги")], ...tags.map((v) => [v, _t(v)])]) : ""}</div>`;
    h += `<div class="jr-sum"><span>${esc(_t("Сделок"))} <b>${list.length}</b></span><span>${esc(_t("Итог"))} <b class="${cls(x.net)}">${fmtUsd(x.net)}</b></span><span>Win rate <b>${Math.round(x.winRate * 100)}%</b></span><span>PF <b>${pfS(x.pf)}</b></span></div>`;
    S._list = list;
    return h + `<div class="jr-trades" id="jr-trades"></div>`;
  }

  function widgetsSheet() {
    const sh = $("#jr-sheet"), keep = sh.querySelector(".wg-cfg"), top = keep ? keep.scrollTop : 0;
    const c = wgCfg(), n = c.order.length;
    sh.innerHTML = `<div class="jr-sheet-in glass">
      <div class="jr-sh-h"><b>${esc(_t("Виджеты"))}</b><button class="pc-x sm" data-j="sheet-close" aria-label="${esc(_t("Закрыть"))}"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button></div>
      <small class="jr-note-s">${esc(_t("Включай нужные и меняй порядок стрелками. Настройка хранится на этом устройстве."))}</small>
      <div class="wg-cfg">${GROUPS.map(([g, title]) => { const ids = c.order.filter((id) => WG_GROUP[id] === g); return `<div class="wg-cfg-g">${esc(_t(title))}</div>` + ids.map((id, i) => { const on = !c.off.includes(id); return `<div class="wg-cfg-r ${on ? "" : "off"}"><span>${esc(_t(WG_NAME[id]))}</span><button data-j="wg-mv" data-v="${id}" data-d="-1" ${i ? "" : "disabled"} aria-label="${esc(_t("Выше"))}">↑</button><button data-j="wg-mv" data-v="${id}" data-d="1" ${i < ids.length - 1 ? "" : "disabled"} aria-label="${esc(_t("Ниже"))}">↓</button><button class="tg ${on ? "on" : ""}" data-j="wg-tg" data-v="${id}" role="switch" aria-checked="${on}" aria-label="${esc(_t(WG_NAME[id]))}"></button></div>`; }).join(""); }).join("")}</div>
      <button class="jr-more" data-j="wg-reset" style="border-radius:12px;background:var(--surface-2)">${esc(_t("Вернуть как было"))}</button></div>`;
    sh.hidden = false;
    const box = sh.querySelector(".wg-cfg"); if (box) box.scrollTop = top;
    requestAnimationFrame(() => sh.classList.add("show"));
  }
  function wgAction(act, id, dir) {
    const c = wgCfg();
    if (act === "wg-tg") c.off = c.off.includes(id) ? c.off.filter((x) => x !== id) : c.off.concat(id);
    else if (act === "wg-mv") {
      // меняем местами с соседом из того же раздела
      const same = c.order.filter((x) => WG_GROUP[x] === WG_GROUP[id]), k = same.indexOf(id), other = same[k + dir];
      if (other) { const i = c.order.indexOf(id), j = c.order.indexOf(other); c.order[i] = other; c.order[j] = id; }
    }
    if (act === "wg-reset") { try { localStorage.removeItem(WG_KEY); } catch (e) { /* noop */ } } else wgSave(c);
    widgetsSheet(); render();
  }

  // ================================================================ разметка
  function shell() {
    let el = $("#jr");
    if (el) return el;
    el = document.createElement("div");
    el.id = "jr"; el.className = "jr"; el.hidden = true;
    el.innerHTML = `
      <div class="jr-top">
        <button class="pc-x" data-j="close" aria-label="${esc(_t("Закрыть"))}"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>
        <div class="jr-title"><b>${esc(_t("Торговый журнал"))}</b><small id="jr-sub"></small></div>
        <button class="pc-x" data-j="sync" aria-label="${esc(_t("Обновить"))}" id="jr-sync"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button class="pc-x" data-j="settings" aria-label="${esc(_t("Подключения"))}"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="16" cy="7" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="17" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>
      </div>
      <div class="jr-body" id="jr-body"></div>
      <div class="jr-sheet" id="jr-sheet" hidden></div>`;
    document.body.appendChild(el);
    el.addEventListener("click", onClick);
    // описание плашки — по наведению на ⓘ (на компьютере), по нажатию — везде
    const hover = () => window.matchMedia && window.matchMedia("(hover: hover)").matches;
    el.addEventListener("mouseover", (e) => { const b = e.target.closest(".wg-i"); if (b && hover() && !(POP.kind === "info" && POP.id === b.dataset.v)) openInfo(b, b.dataset.v, false); });
    el.addEventListener("mouseout", (e) => { const b = e.target.closest(".wg-i"); if (b && hover() && POP.kind === "info" && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("#jr-pop"))) setTimeout(() => { if (!document.querySelector("#jr-pop:hover")) closePop(); }, 120); });
    el.querySelector("#jr-body").addEventListener("scroll", closePop, { passive: true });
    el.addEventListener("change", async (e) => {
      const ta = e.target.closest(".jr-note");
      if (ta) { const id = ta.dataset.note; S.notes[id] = Object.assign({}, S.notes[id], { note: ta.value.slice(0, 1000) }); try { await kvSet("notes", S.notes); } catch (er) { /* noop */ } return; }
      const f = e.target.closest("[data-tf]"); if (!f) return; S.tf = Object.assign({}, S.tf, { [f.dataset.tf]: f.value }); S.showAll = false; S.expanded = null; render(); });
    return el;
  }

  function onClick(e) {
    const a = e.target.closest("[data-j]");
    if (!e.target.closest("#jr-pop") && !(a && /^(wper|winfo)$/.test(a.dataset.j))) closePop();
    if (!a) return;
    const act = a.dataset.j, v = a.dataset.v;
    if (act === "close") close();
    else if (act === "sync") { S.demo = false; syncAll(); }
    else if (act === "settings") openSheet("settings");
    else if (act === "connect") openSheet("connect", v);
    else if (act === "sheet-close") closeSheet();
    else if (act === "demo") { S.demo = true; render(); }
    else if (act === "exit-demo") { S.demo = false; render(); }
    else if (act === "period") { S.period = +v; try { localStorage.setItem("amq-jr-period", v); } catch (er) { /* noop */ } render(); }
    else if (act === "exf") { S.exFilter = v; render(); }
    else if (act === "trade") { S.expanded = S.expanded === v ? null : v; renderTrades(); }
    else if (act === "remove") { if (a.dataset.confirm === "1") { removeConnection(v).then(() => { openSheet("settings"); render(); }); } else { a.dataset.confirm = "1"; a.textContent = _t("Точно удалить? Нажми ещё раз"); } }
    else if (act === "ai") aiReview(a);
    else if (act === "tag") toggleTag(v, a.dataset.tag);
    else if (act === "more") { S.showAll = true; renderTrades(); }
    else if (act === "view") { S.view = v; S.expanded = null; S.showAll = false; render(); $("#jr-body").scrollTop = 0; }
    else if (act === "goto" || act === "open-trade") openTrade(v);
    else if (act === "tp-back") { S.view = S.backView || "trades"; S.tradeId = null; if (tpChart) { try { tpChart.remove(); } catch (er) { /* noop */ } tpChart = null; } render(); }
    else if (act === "tp-iv") { S.tpIv = v; render(); }
    else if (act === "ai-trade") aiTrade(a, v);
    else if (act === "widgets") widgetsSheet();
    else if (act === "wsize") { const o = lsObj(WSIZE_KEY); o[v] = +a.dataset.d; lsPut(WSIZE_KEY, o); render(); }
    else if (act === "wper") openPer(a, v);
    else if (act === "winfo") openInfo(a, v, true);
    else if (act === "per-set") setPer(v);
    else if (act === "per-day") pickDay(v);
    else if (act === "per-mon") { POP.month = new Date(POP.month.getFullYear(), POP.month.getMonth() + +v, 1); drawPer(); }
    else if (act === "per-reset") setPer(null);
    else if (act === "pop-close") closePop();
    else if (act === "wg-tg" || act === "wg-mv" || act === "wg-reset") wgAction(act, v, +a.dataset.d || 0);
    else if (act === "tab") { close(); setTimeout(() => { const b = document.querySelector(`.nav-btn[data-tab="${v}"]`); if (b) b.click(); }, 120); }
    else if (act === "cal-month") { const d = calMonth(); S.calMonth = new Date(d.getFullYear(), d.getMonth() + +v, 1); S.calDay = null; render(); }
    else if (act === "cal-unit") { S.calUnit = v; try { localStorage.setItem("amq-jr-unit", v); } catch (er) { /* noop */ } render(); }
    else if (act === "cal-day") { S.calDay = S.calDay === v ? null : v; S.expanded = null; render(); }
  }

  function filtered(spec) {
    const src = S.demo ? (S._demo || (S._demo = demoTrades())) : S.trades;
    const [from, to] = perRange(spec);
    return src.filter((t) => (S.exFilter === "all" || t.ex === S.exFilter) && (t.open ? to === Infinity : (t.closeT || 0) >= from && (t.closeT || 0) <= to));
  }

  const ICON_GRID = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="4" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="4" y="13" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
  function render() {
    if (!S.open) return;
    const body = $("#jr-body");
    $("#jr-sync").hidden = !S.conns.length;
    $("#jr-sub").textContent = S.demo ? _t("демо-данные") : S.conns.length ? S.conns.map((c) => EX[c.ex].name).join(" · ") : "";
    if (S.dbError) { body.innerHTML = `<div class="jr-empty glass"><p>${esc(_t("Хранилище браузера недоступно (приватный режим?). Журналу нужно место для ключей и сделок на устройстве."))}</p></div>`; return; }
    if (!S.conns.length && !S.demo) { body.innerHTML = onboarding(); return; }
    const all = filtered(), s = stats(all);
    const exs = [...new Set((S.demo ? (S._demo || (S._demo = demoTrades())) : S.trades).map((t) => t.ex))];
    if (S.view === "trade") {
      const src = S.demo ? (S._demo || (S._demo = demoTrades())) : S.trades, t = src.find((x) => x.id === S.tradeId);
      if (t) { body.innerHTML = `<div class="jr-wrap">${DEFS}${tradePageHtml(t)}</div>`; drawTradeChart(t); return; }
      S.view = S.backView || "trades";
    }
    const view = S.view === "calendar" || S.view === "trades" ? S.view : "overview";
    let h = `<div class="jr-wrap">${DEFS}`;
    if (S.demo) h += `<div class="jr-demo">${esc(_t("Это пример на выдуманных сделках."))} <button data-j="exit-demo">${esc(_t("Подключить свою биржу"))}</button></div>`;
    h += `<div class="jr-status" id="jr-status">${statusHtml()}</div>`;
    h += `<div class="jr-bar"><div class="jr-views">${[["overview", "Обзор"], ["trades", "Сделки"], ["calendar", "Календарь"]].map(([k, l]) => `<button class="${view === k ? "on" : ""}" data-j="view" data-v="${k}">${esc(_t(l))}</button>`).join("")}</div><span class="grow"></span>`
      + (view === "overview" ? `<button class="jr-tool" data-j="widgets">${ICON_GRID}${esc(_t("Виджеты"))}</button>` : "") + `</div><div class="jr-bar jr-bar2">`
      + (view === "calendar" ? "" : `<div class="jr-seg">${[[7, "7д"], [30, "30д"], [90, "90д"], [0, "Всё"]].map(([v, l]) => `<button class="${S.period === v ? "on" : ""}" data-j="period" data-v="${v}">${esc(_t(l))}</button>`).join("")}</div>`)
      + (exs.length > 1 ? `<div class="jr-seg">${["all", ...exs].map((x) => `<button class="${S.exFilter === x ? "on" : ""}" data-j="exf" data-v="${x}">${esc(x === "all" ? _t("Все") : EX[x].name.replace(" Futures", ""))}</button>`).join("")}</div>` : "")
      + `</div>`;
    if (view === "calendar") { h += calendarHtml() + `</div>`; body.innerHTML = h; renderTrades(); return; }
    const anyAtAll = view === "overview" && filtered("0").length;
    if (!s.n && !anyAtAll && (view === "overview" || !s.open.length)) {
      h += `<div class="jr-empty glass"><p>${esc(S.syncing ? _t("Загружаю сделки с биржи…") : _t("За этот период закрытых сделок нет."))}</p></div></div>`;
      body.innerHTML = h; return;
    }
    if (view === "trades") { h += tradesViewHtml(s) + `</div>`; body.innerHTML = h; renderTrades(); return; }
    h += overviewHtml();
    setTimeout(() => ensureExc(stats(filtered("0")).closed), 50);
    h += `<p class="hint">${esc(_t("Ключи хранятся только на этом устройстве и не отправляются на наш сервер. Результаты — по данным биржи; позиции, открытые до начала истории, считаются по реализованному PnL."))}</p></div>`;
    body.innerHTML = h;
  }

  function statusHtml() {
    return S.conns.map((c) => {
      const st = S.status[c.id] || {};
      const txt = st.busy ? `${_t("загрузка")} ${Math.round((st.p || 0) * 100)}%` : c.error ? `${_t("ошибка")}: ${c.error}` : c.lastSync ? `${_t("обновлено")} ${fmtDate(c.lastSync)}` : _t("не загружено");
      return `<span class="${c.error && !st.busy ? "err" : ""}">${esc(c.label)} · ${esc(txt)}</span>`;
    }).join("");
  }
  function renderStatus() { const el = $("#jr-status"); if (el) el.innerHTML = statusHtml(); }

  function curveSvg(s) {
    const pts = s.curve;
    if (pts.length < 2) return "";
    const W = 320, H = 80, vals = pts.map((p) => p.v), mn = Math.min(0, ...vals), mx = Math.max(0, ...vals), span = mx - mn || 1;
    const x = (i) => (i / (pts.length - 1)) * W, y = (v) => H - 4 - ((v - mn) / span) * (H - 8);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
    const up = pts[pts.length - 1].v >= 0;
    return `<svg class="jr-curve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="zero"/>
      <path d="${d} L${W} ${y(0).toFixed(1)} L0 ${y(0).toFixed(1)} Z" class="area ${up ? "up" : "down"}"/>
      <path d="${d}" class="line ${up ? "up" : "down"}"/>
      <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(pts[pts.length - 1].v).toFixed(1)}" r="3" class="dot ${up ? "up" : "down"}"/></svg>`;
  }
  function barsHtml(groups, n, label) {
    const m = Object.fromEntries(groups.map((g) => [g.k, g]));
    const mx = Math.max(1, ...groups.map((g) => Math.abs(g.pnl)));
    return `<div class="jr-bars">${Array.from({ length: n }, (_, i) => { const g = m[i] || { pnl: 0, n: 0 }; const hgt = Math.max(2, (Math.abs(g.pnl) / mx) * 48); return `<div><i class="${cls(g.pnl)}" style="height:${hgt}px" title="${fmtUsd(g.pnl)}"></i><span>${esc(label(i))}</span></div>`; }).join("")}</div>`;
  }

  // ---------------------------------------------------------------- календарь PnL по дням
  // «N сделок» с правильным окончанием
  function tradesWord(n) {
    const L = I18.lang;
    if (L === "ru") { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? "сделка" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "сделки" : "сделок"; }
    return ({ en: n === 1 ? "trade" : "trades", es: n === 1 ? "operación" : "operaciones", fr: n === 1 ? "trade" : "trades", ko: "건", zh: "笔" })[L] || "trades";
  }
  // база для процентов: текущий депозит подключённых бирж (или объём сделок, если баланса нет)
  function equityBase() {
    if (S.demo) return 5000;
    const cs = S.conns.filter((c) => S.exFilter === "all" || c.ex === S.exFilter);
    const e = cs.reduce((a, c) => a + (+c.equity || 0), 0);
    return e > 0 ? e : null;
  }
  const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  function calSource() {
    const src = S.demo ? (S._demo || (S._demo = demoTrades())) : S.trades;
    return src.filter((t) => !t.open && t.closeT && (S.exFilter === "all" || t.ex === S.exFilter));
  }
  function calMonth() {
    if (S.calMonth) return S.calMonth;
    const src = calSource();
    const last = src.reduce((m, t) => Math.max(m, t.closeT), 0) || Date.now();
    const d = new Date(last);
    return (S.calMonth = new Date(d.getFullYear(), d.getMonth(), 1));
  }
  function fmtCal(v, notional) {
    if (S.calUnit !== "pct") return fmtShort(v);
    const base = equityBase() || notional;
    if (!base) return "—";
    const p = (v / base) * 100, a = Math.abs(p);
    return `${p < 0 ? "−" : "+"}${a >= 10 ? a.toFixed(0) : a >= 1 ? a.toFixed(1) : a.toFixed(2)}%`;
  }
  function fmtShort(v) {
    const a = Math.abs(v), sg = v < 0 ? "−" : "+";
    return a >= 1e5 ? `${sg}$${(a / 1e3).toFixed(0)}K` : a >= 1e3 ? `${sg}$${(a / 1e3).toFixed(1)}K` : `${sg}$${a >= 100 ? a.toFixed(0) : a.toFixed(a >= 10 ? 0 : 1)}`;
  }
  function calendarHtml() {
    const src = calSource();
    const byDay = new Map();
    src.forEach((t) => { const k = dayKey(t.closeT); const g = byDay.get(k) || { pnl: 0, n: 0, w: 0, vol: 0, list: [] }; g.pnl += t.pnl; g.vol += t.notional || 0; g.n++; if (t.pnl > 0) g.w++; g.list.push(t); byDay.set(k, g); });
    const m0 = calMonth(), y = m0.getFullYear(), mo = m0.getMonth();
    const days = new Date(y, mo + 1, 0).getDate(), lead = (new Date(y, mo, 1).getDay() + 6) % 7;
    const inMonth = [...byDay.entries()].filter(([k]) => k.startsWith(`${y}-${String(mo + 1).padStart(2, "0")}`));
    const mx = Math.max(1, ...inMonth.map(([, g]) => Math.abs(g.pnl)));
    const mPnl = inMonth.reduce((a, [, g]) => a + g.pnl, 0), mTrades = inMonth.reduce((a, [, g]) => a + g.n, 0), mVol = inMonth.reduce((a, [, g]) => a + g.vol, 0);
    const green = inMonth.filter(([, g]) => g.pnl > 0).length, red = inMonth.filter(([, g]) => g.pnl < 0).length;
    const best = inMonth.reduce((b, e) => (!b || e[1].pnl > b[1].pnl ? e : b), null);
    const todayK = dayKey(Date.now());
    const title = new Date(y, mo, 1).toLocaleDateString(I18.locale, { month: "long", year: "numeric" });
    const allKeys = [...byDay.keys()].sort();
    const canPrev = allKeys.length && allKeys[0] < `${y}-${String(mo + 1).padStart(2, "0")}-01`;
    const canNext = new Date(y, mo + 1, 1) <= new Date();
    const wd = [_t("Пн"), _t("Вт"), _t("Ср"), _t("Чт"), _t("Пт"), _t("Сб"), _t("Вс")];
    let cells = wd.map((d) => `<span class="jr-cal-wd">${esc(d)}</span>`).join("") + `<span class="jr-cal-wd wk">${esc(_t("Нед"))}</span>`;
    const total = Math.ceil((lead + days) / 7) * 7;
    let wk = 0, wkN = 0, wkV = 0;
    for (let i = 0; i < total; i++) {
      const dn = i - lead + 1;
      if (dn < 1 || dn > days) cells += `<span class="jr-cal-c out"></span>`;
      else {
        const k = `${y}-${String(mo + 1).padStart(2, "0")}-${String(dn).padStart(2, "0")}`, g = byDay.get(k);
        // интенсивность цвета — по величине результата дня относительно лучшего/худшего дня месяца
        const a = g ? 0.22 + 0.78 * Math.min(1, Math.abs(g.pnl) / mx) : 0;
        if (g) { wk += g.pnl; wkN += g.n; wkV += g.vol; }
        const dots = g ? `<em class="jr-cnt"><span class="full">${g.n} ${esc(tradesWord(g.n))}</span><span class="short">${g.n} ${esc(_t("сд."))}</span></em>` : "";
        cells += `<button class="jr-cal-c ${g ? (g.pnl >= 0 ? "pos" : "neg") : "none"} ${k === todayK ? "today" : ""} ${S.calDay === k ? "sel" : ""}" style="${g ? `--k:${Math.round(a * 100)}%` : ""}" ${g ? `data-j="cal-day" data-v="${k}"` : "disabled"}>
          <i>${dn}</i>${g ? `<b>${fmtCal(g.pnl, g.vol)}</b>${dots}` : ""}</button>`;
      }
      if (i % 7 === 6) {
        cells += `<span class="jr-cal-c wk ${wkN ? (wk >= 0 ? "up" : "down") : ""}">${wkN ? `<b>${fmtCal(wk, wkV)}</b><small><span class="full">${wkN} ${esc(tradesWord(wkN))}</span><span class="short">${wkN} ${esc(_t("сд."))}</span></small>` : ""}</span>`;
        wk = 0; wkN = 0; wkV = 0;
      }
    }
    let h = `<div class="jr-cal-layout"><div class="jr-cal glass">
      <div class="jr-cal-h"><button class="pc-x sm" data-j="cal-month" data-v="-1" ${canPrev ? "" : "disabled"} aria-label="${esc(_t("Назад"))}">‹</button>
        <b>${esc(title.charAt(0).toUpperCase() + title.slice(1))}</b>
        <button class="pc-x sm" data-j="cal-month" data-v="1" ${canNext ? "" : "disabled"} aria-label="${esc(_t("Вперёд"))}">›</button></div>
      <div class="jr-unit" role="radiogroup" aria-label="${esc(_t("Единицы"))}"><button class="${S.calUnit !== "pct" ? "on" : ""}" data-j="cal-unit" data-v="usd">$</button><button class="${S.calUnit === "pct" ? "on" : ""}" data-j="cal-unit" data-v="pct">%</button>
        <small>${S.calUnit === "pct" ? esc(equityBase() ? `${_t("от депозита")} ${fmtUsd(equityBase(), false)}` : _t("от объёма сделок")) : ""}</small></div>
      <div class="jr-cal-sum"><div><span>${esc(_t("Итог"))}</span><b class="${cls(mPnl)}">${S.calUnit === "pct" ? fmtCal(mPnl, mVol) : fmtUsd(mPnl)}</b></div>
        <div><span>${esc(_t("Дни"))}</span><b><em class="up">${green}</em> / <em class="down">${red}</em></b></div>
        <div><span>${esc(_t("Сделок"))}</span><b>${mTrades}</b></div>
        <div><span>${esc(_t("Лучший"))}</span><b class="up">${best && best[1].pnl > 0 ? (S.calUnit === "pct" ? fmtCal(best[1].pnl, best[1].vol) : fmtUsd(best[1].pnl)) : "—"}</b></div></div>
      <div class="jr-cal-grid">${cells}</div>
    </div>`;
    h += `<div class="jr-cal-side">`;
    if (S.calDay && byDay.get(S.calDay)) {
      const g = byDay.get(S.calDay);
      const d = new Date(S.calDay + "T12:00:00");
      h += `<div class="section-title">${esc(d.toLocaleDateString(I18.locale, { weekday: "long", day: "numeric", month: "long" }))} <small class="${cls(g.pnl)}">${fmtUsd(g.pnl)} · ${g.n} · ${Math.round((g.w / g.n) * 100)}%</small></div>`;
      S._list = g.list.slice().sort((a, b) => b.closeT - a.closeT);
    } else {
      h += `<p class="hint">${esc(_t("Нажми на день, чтобы увидеть его сделки. В колонке «Нед» — итог недели."))}</p>`;
      S._list = [];
    }
    h += `<div class="jr-trades" id="jr-trades"></div></div></div>`;
    return h;
  }

  const TAGS = ["Пробой", "Отбой", "Тренд", "FOMO", "Отыгрыш", "По плану", "Ранний выход"];
  function renderTrades() {
    const el = $("#jr-trades");
    if (!el) return;
    const list = S._list || [];
    const show = S.showAll ? list : list.slice(0, 40);
    el.innerHTML = show.map((t) => {
      const n = S.notes[t.id] || {};
      const open = S.expanded === t.id;
      const pct = t.notional ? (t.pnl / t.notional) * 100 : null;
      return `<div class="jr-tr glass ${open ? "open" : ""}">
        <button class="jr-tr-h" data-j="open-trade" data-v="${esc(t.id)}">
          <span class="sd ${t.side === "long" ? "L" : "S"}">${t.side === "long" ? "LONG" : "SHORT"}</span>
          <span class="jr-tr-s"><b>${esc(t.sym)}</b><small>${esc(EX[t.ex] ? EX[t.ex].name.replace(" Futures", "") : t.ex)} · ${t.open ? esc(_t("открыта")) : fmtDate(t.closeT)}${tagsOf(t).length ? " · " + tagsOf(t).map((x) => esc(_t(x))).join(", ") : ""}</small></span>
          <span class="jr-tr-m"><span>${t.openT && t.closeT ? fmtDur(t.closeT - t.openT) : "—"}</span><span>${t.lev ? `×${t.lev}` : "—"}</span><span>${fmtUsd(t.notional, false)}</span></span>
          <span class="jr-tr-p"><b class="${cls(t.pnl)}">${t.open ? "—" : fmtUsd(t.pnl)}</b><small>${pct != null && !t.open ? `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%` : ""}</small></span>
        </button>
        ${open ? `<div class="jr-tr-d">
          <div class="jr-grid"><span>${esc(_t("Вход"))}</span><b>${fmtP(t.entry)}</b><span>${esc(_t("Выход"))}</span><b>${fmtP(t.exit)}</b>
          <span>${esc(_t("Объём"))}</span><b>${fmtUsd(t.notional, false)}</b><span>${esc(_t("Время в сделке"))}</span><b>${t.openT && t.closeT ? fmtDur(t.closeT - t.openT) : "—"}</b>
          <span>${esc(_t("Комиссии"))}</span><b>${fmtUsd(-(t.fee || 0), false)}</b><span>${esc(_t("Фандинг"))}</span><b>${fmtUsd(t.funding || 0)}</b>
          ${t.lev ? `<span>${esc(_t("Плечо"))}</span><b>${t.lev}x</b>` : ""}${t.partial ? `<span></span><small>${esc(_t("вход до начала истории"))}</small>` : ""}</div>
          <div class="jr-tags">${TAGS.map((g) => `<button class="${tagsOf(t).includes(g) ? "on" : ""}" data-j="tag" data-v="${esc(t.id)}" data-tag="${esc(g)}">${esc(_t(g))}</button>`).join("")}</div>
          <textarea class="jr-note" data-note="${esc(t.id)}" placeholder="${esc(_t("Заметка: почему вошёл, что пошло не так…"))}">${esc(n.note || "")}</textarea>
        </div>` : ""}
      </div>`;
    }).join("") + (list.length > show.length ? `<button class="jr-more" data-j="more">${esc(_t("Показать все"))} (${list.length})</button>` : "");

  }
  async function toggleTag(id, tag) {
    const tr = (S._list || []).concat(S.demo ? (S._demo || []) : S.trades).find((x) => x.id === id);
    const n = S.notes[id] = Object.assign({ tags: tr && tr.dtags ? tr.dtags.slice() : [] }, S.notes[id]);
    n.tags = n.tags.includes(tag) ? n.tags.filter((x) => x !== tag) : n.tags.concat(tag);
    try { await kvSet("notes", S.notes); } catch (e) { /* noop */ }
    if (S.view === "trade") { const box = document.querySelector(".tp-grid .jr-tags"); if (box) box.querySelectorAll("button").forEach((b) => b.classList.toggle("on", n.tags.includes(b.dataset.tag))); return; }
    renderTrades();
  }

  function onboarding() {
    return `<div class="jr-onb">
      <div class="jr-onb-ic"><svg viewBox="0 0 24 24" width="30" height="30"><path d="M5 4h11l3 3v13H5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 15l3-3 2 2 3-4" fill="none" stroke="#C8B08A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <h2>${esc(_t("Твой торговый журнал"))}</h2>
      <p>${esc(_t("Подключи биржу — журнал сам соберёт все закрытые позиции и покажет, где ты зарабатываешь, а где теряешь: win rate, profit factor, просадку, лучшие монеты и часы, ошибки вроде отыгрыша."))}</p>
      <div class="jr-exs">${EX_ORDER.map((k) => `<button class="glass" data-j="connect" data-v="${k}"><i class="jr-ex-ic" aria-hidden="true">${esc(({ binance: "BN", bybit: "BY", okx: "OKX", bingx: "BX", bitunix: "BU", hyperliquid: "HL" })[k] || EX[k].name.slice(0, 2).toUpperCase())}</i><span><b>${esc(EX[k].name)}</b><small>${k === "hyperliquid" ? esc(_t("по адресу кошелька")) : esc(_t("read-only ключ"))}</small></span><em aria-hidden="true">›</em></button>`).join("")}</div>
      <ul class="jr-safe">
        <li>${esc(_t("Ключи хранятся только на этом устройстве, зашифрованными. Мы их не видим."))}</li>
        <li>${esc(_t("Нужен ключ только с правом чтения: с ним нельзя торговать и выводить средства."))}</li>
        <li>${esc(_t("Ключ с правом вывода журнал не примет."))}</li>
      </ul>
      <button class="jr-demo-btn" data-j="demo">${esc(_t("Посмотреть на примере"))}</button>
    </div>`;
  }

  // ---------------------------------------------------------------- шторка: подключение / настройки
  function openSheet(kind, ex) {
    const sh = $("#jr-sheet");
    if (kind === "connect") {
      const E = EX[ex];
      const labels = { key: "API Key", secret: "Secret Key", passphrase: "Passphrase", address: _t("Адрес кошелька 0x…") };
      sh.innerHTML = `<div class="jr-sheet-in glass">
        <div class="jr-sh-h"><b>${esc(E.name)}</b><button class="pc-x sm" data-j="sheet-close" aria-label="${esc(_t("Закрыть"))}"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button></div>
        <ol class="jr-help">${E.help.map((x) => `<li>${esc(_t(x))}</li>`).join("")}</ol>
        <form id="jr-form" autocomplete="off">${E.fields.map((f) => `<label><span>${esc(labels[f])}</span><input id="jr-f-${f}" name="${f}" ${f === "address" || f === "key" ? 'type="text"' : 'type="password"'} autocomplete="off" autocapitalize="off" spellcheck="false" required></label>`).join("")}
          <p class="jr-err" id="jr-err"></p>
          <button type="submit" class="jr-go">${esc(_t("Подключить"))}</button>
          <small class="jr-note-s">${esc(_t("Ключ сохранится только на этом устройстве в зашифрованном виде."))}${ex === "bingx" ? " " + esc(_t("BingX не разрешает запросы из браузера, поэтому подписанный на устройстве запрос пересылается через наш сервер; секретный ключ при этом не передаётся.")) : ex === "bitunix" ? " " + esc(_t("Bitunix не разрешает запросы из браузера, поэтому подписанный на устройстве запрос пересылается через наш сервер; секретный ключ при этом не передаётся.")) : ""}</small>
        </form></div>`;
      sh.hidden = false;
      $("#jr-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = sh.querySelector(".jr-go"), err = $("#jr-err");
        btn.disabled = true; btn.textContent = _t("Проверяю ключ…"); err.textContent = "";
        const form = Object.fromEntries(new FormData(e.target).entries());
        try {
          const c = await addConnection(ex, form);
          closeSheet(); S.demo = false;
          if (c.warnTrade) toast(_t("У ключа включена торговля. Для журнала хватит права чтения — лучше пересоздай ключ."));
          render(); syncAll();
        } catch (er) {
          err.textContent = `${_t("Не получилось:")} ${er.message || er}`;
          btn.disabled = false; btn.textContent = _t("Подключить");
        }
      });
    } else {
      sh.innerHTML = `<div class="jr-sheet-in glass">
        <div class="jr-sh-h"><b>${esc(_t("Подключения"))}</b><button class="pc-x sm" data-j="sheet-close" aria-label="${esc(_t("Закрыть"))}"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button></div>
        ${S.conns.length ? S.conns.map((c) => `<div class="jr-conn"><span><b>${esc(c.label)}</b><small>${c.count != null ? `${c.count} ${esc(_t("позиций"))} · ` : ""}${c.lastSync ? fmtDate(c.lastSync) : esc(_t("не загружено"))}${c.warnTrade ? " · ⚠ " + esc(_t("ключ с правом торговли")) : ""}</small></span><button data-j="remove" data-v="${esc(c.id)}">${esc(_t("Удалить"))}</button></div>`).join("") : `<p class="jr-muted">${esc(_t("Пока нет подключений."))}</p>`}
        <div class="jr-h">${esc(_t("Добавить биржу"))}</div>
        <div class="jr-exs sm">${EX_ORDER.map((k) => `<button class="glass" data-j="connect" data-v="${k}"><b>${esc(EX[k].name)}</b></button>`).join("")}</div>
        <small class="jr-note-s">${esc(_t("Удаление стирает ключ и сделки с этого устройства. Сам ключ на бирже удали в настройках API биржи."))}</small>
      </div>`;
      sh.hidden = false;
    }
    requestAnimationFrame(() => sh.classList.add("show"));
  }
  function closeSheet() { const sh = $("#jr-sheet"); sh.classList.remove("show"); setTimeout(() => { sh.hidden = true; sh.innerHTML = ""; }, 220); }
  function toast(t) { const d = document.createElement("div"); d.className = "jr-toast"; d.textContent = t; $("#jr").appendChild(d); setTimeout(() => d.remove(), 5000); }

  // ---------------------------------------------------------------- ИИ-разбор (PRO)
  async function aiReview(btn) {
    const out = $("#jr-ai-out");
    const A = window.AUTH;
    if (!CFG.supabaseUrl || !A || !A.enabled || !A.sb) { out.innerHTML = `<p class="jr-muted">${esc(_t("ИИ-разбор подключится вместе со входом в аккаунт."))}</p>`; return; }
    const sess = (await A.sb.auth.getSession()).data.session;
    if (!sess) { out.innerHTML = `<p class="jr-muted">${esc(_t("Войди в аккаунт, чтобы получить ИИ-разбор."))}</p>`; return; }
    if (CFG.premium === "paid" && A.loadPlan && (await A.loadPlan()) !== "pro") { out.innerHTML = `<p class="jr-muted">${esc(_t("ИИ-разбор торговли доступен в McQ Pro."))}</p>${window.Pro && window.Pro.available() ? `<button class="jr-ai" id="jr-go-pro" style="margin-top:8px">${esc(_t("Оформить McQ Pro"))}</button>` : ""}`; const g = $("#jr-go-pro"); if (g) g.addEventListener("click", () => window.Pro.open()); return; }
    const s = stats(filtered());
    const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
    const ctx = {
      period_days: S.period || "all", trades: s.n, net_pnl: r2(s.net), win_rate_pct: Math.round(s.winRate * 100), profit_factor: s.pf === Infinity ? "inf" : r2(s.pf),
      avg_win: r2(s.avgWin), avg_loss: r2(s.avgLoss), expectancy: r2(s.expectancy), max_drawdown: r2(s.maxDD), fees: r2(s.fees), funding: r2(s.funding),
      win_streak: s.streakW, loss_streak: s.streakL, trades_per_day: r2(s.perDay), avg_hold_win_min: s.durWin ? Math.round(s.durWin / 60000) : null, avg_hold_loss_min: s.durLoss ? Math.round(s.durLoss / 60000) : null,
      after_loss_30min: s.revenge, liquidations: s.liqs,
      by_side: s.bySide.map((g) => ({ side: g.k, n: g.n, win_pct: Math.round((g.w / g.n) * 100), pnl: r2(g.pnl) })),
      by_symbol: s.bySym.slice(0, 12).map((g) => ({ sym: g.k, n: g.n, win_pct: Math.round((g.w / g.n) * 100), pnl: r2(g.pnl) })),
      by_weekday_mon0: s.byDow.map((g) => ({ d: g.k, n: g.n, pnl: r2(g.pnl) })), by_close_hour_local: s.byHour.map((g) => ({ h: g.k, n: g.n, pnl: r2(g.pnl) })),
      last_trades: s.closed.slice(-40).map((t) => ({ sym: t.sym, side: t.side, pnl: r2(t.pnl), pct: t.notional ? r2((t.pnl / t.notional) * 100) : null, hold_min: t.openT ? Math.round((t.closeT - t.openT) / 60000) : null, lev: t.lev || null, tags: (S.notes[t.id] || {}).tags || [] })),
      demo: S.demo,
    };
    btn.disabled = true;
    out.innerHTML = `<span class="pc-dots"><i></i><i></i><i></i></span>`;
    try {
      const r = await fetch(`${CFG.supabaseUrl}/functions/v1/chart-ai`, {
        method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey, Authorization: `Bearer ${sess.access_token}` },
        body: JSON.stringify({ kind: "journal", question: "Review my trading journal", ctx, lang: I18.lang }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 402) throw new Error(_t("ИИ-разбор торговли доступен в McQ Pro."));
      if (r.status === 429) throw new Error(_t("Лимит вопросов на сегодня исчерпан"));
      if (!r.ok || !d.answer) throw new Error(d.error || `${r.status}`);
      out.innerHTML = `<div class="jr-ai-a">${esc(d.answer).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>")}</div><small class="jr-muted">${esc(_t("Не финансовый совет."))}</small>`;
    } catch (e) {
      out.innerHTML = `<p class="down">${esc(e.message || _t("ИИ не ответил. Попробуй ещё раз."))}</p>`;
    }
    btn.disabled = false;
  }

  // ---------------------------------------------------------------- открыть / закрыть
  function onBack() { if (document.documentElement.classList.contains("pro-open")) return; if (!$("#jr-sheet").hidden) closeSheet(); else if (S.view === "trade") { S.view = S.backView || "trades"; render(); } else close(); }
  async function open() {
    try { const pc = document.getElementById("pc"); if (pc && !pc.hidden && window.ProChart) window.ProChart.close(); } catch (e) { /* noop */ }
    const el = shell();
    S.open = true;
    el.hidden = false;
    document.documentElement.classList.add("pc-open");
    requestAnimationFrame(() => el.classList.add("show"));
    if (tg) { try { tg.BackButton.show(); tg.BackButton.onClick(onBack); } catch (e) { /* noop */ } }
    $("#jr-body").innerHTML = `<div class="jr-empty"><span class="pc-spin"></span></div>`;
    await loadState();
    render();
    // данные старше 15 минут — обновляем в фоне
    if (S.conns.length && S.conns.some((c) => !c.lastSync || Date.now() - c.lastSync > 15 * 60000)) syncAll();
  }
  function close() {
    const el = $("#jr");
    if (!el) return;
    closePop();
    S.open = false;
    el.classList.remove("show");
    document.documentElement.classList.remove("pc-open");
    setTimeout(() => { el.hidden = true; }, 250);
    if (tg) { try { tg.BackButton.offClick(onBack); tg.BackButton.hide(); } catch (e) { /* noop */ } }
  }

  window.Journal = { open, close, _test: { buildPositions, stats, insights, demoTrades, EX, S } };
})();
