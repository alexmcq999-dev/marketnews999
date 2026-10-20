/* McQ Journal — торговый журнал.
   • Пользователь подключает биржу read-only ключом (или адресом кошелька для Hyperliquid).
   • Ключи хранятся ТОЛЬКО на этом устройстве: IndexedDB, зашифрованы AES-GCM неизвлекаемым ключом браузера.
     Запросы к биржам подписываются прямо на устройстве (WebCrypto), секрет никуда не отправляется.
   • BingX не разрешает запросы из браузера — для неё запрос подписывается на устройстве и пересылается
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
  const EX_ORDER = ["binance", "bybit", "okx", "bingx", "hyperliquid"];

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
        pnl: gross - fee, openT, closeT: openT + (win ? dur : dur * 1.8), open: false, demo: true });
    }
    // несколько «отыгрышей»: быстрый вход после убытка, чаще всего неудачный
    out.filter((t, i) => t.gross < 0 && i % 3 === 0).forEach((l, j) => {
      const notional = 1500 + r() * 1500, px = l.exit, qty = notional / px, win = j % 4 === 0, dir = l.side === "long" ? 1 : -1;
      const exit = px * (1 + (win ? 0.008 : -0.012) * dir), gross = (exit - px) * qty * dir, fee = notional * 0.0009;
      out.push({ id: `demo:r${j}`, ex: l.ex, sym: l.sym, side: l.side, qty, entry: px, exit, notional, gross, fee, funding: 0, pnl: 0,
        openT: l.closeT + 8 * 60000, closeT: l.closeT + 50 * 60000, open: false, demo: true });
    });
    // все сделки — в прошлом
    const shift = Math.max(0, ...out.map((t) => t.closeT - now)) + 3600000;
    out.forEach((t) => { t.pnl = t.gross - t.fee + t.funding; t.openT -= shift; t.closeT -= shift; });
    return out;
  }

  // ================================================================ состояние
  const S = { open: false, conns: [], trades: [], notes: {}, period: 30, exFilter: "all", syncing: false, demo: false, status: {}, view: "main", expanded: null };
  try { const raw = localStorage.getItem("amq-jr-period"); const p = +raw; if (raw !== null && [7, 30, 90, 0].includes(p)) S.period = p; } catch (e) { /* noop */ }

  async function loadState() {
    try {
      S.conns = (await kvGet("conns")) || [];
      S.trades = (await kvGet("trades")) || [];
      S.notes = (await kvGet("notes")) || {};
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
    return el;
  }

  function onClick(e) {
    const a = e.target.closest("[data-j]");
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
  }

  function filtered() {
    const src = S.demo ? (S._demo || (S._demo = demoTrades())) : S.trades;
    const from = S.period ? Date.now() - S.period * DAY : 0;
    return src.filter((t) => (S.exFilter === "all" || t.ex === S.exFilter) && (t.open || (t.closeT || 0) >= from));
  }

  function render() {
    if (!S.open) return;
    const body = $("#jr-body");
    $("#jr-sync").hidden = !S.conns.length;
    $("#jr-sub").textContent = S.demo ? _t("демо-данные") : S.conns.length ? S.conns.map((c) => EX[c.ex].name).join(" · ") : "";
    if (S.dbError) { body.innerHTML = `<div class="jr-empty glass"><p>${esc(_t("Хранилище браузера недоступно (приватный режим?). Журналу нужно место для ключей и сделок на устройстве."))}</p></div>`; return; }
    if (!S.conns.length && !S.demo) { body.innerHTML = onboarding(); return; }
    const all = filtered(), s = stats(all);
    const exs = [...new Set((S.demo ? (S._demo || (S._demo = demoTrades())) : S.trades).map((t) => t.ex))];
    let h = "";
    if (S.demo) h += `<div class="jr-demo">${esc(_t("Это пример на выдуманных сделках."))} <button data-j="exit-demo">${esc(_t("Подключить свою биржу"))}</button></div>`;
    h += `<div class="jr-status" id="jr-status">${statusHtml()}</div>`;
    h += `<div class="jr-filters"><div class="jr-seg">${[[7, "7д"], [30, "30д"], [90, "90д"], [0, "Всё"]].map(([v, l]) => `<button class="${S.period === v ? "on" : ""}" data-j="period" data-v="${v}">${esc(_t(l))}</button>`).join("")}</div>`
      + (exs.length > 1 ? `<div class="jr-seg">${["all", ...exs].map((x) => `<button class="${S.exFilter === x ? "on" : ""}" data-j="exf" data-v="${x}">${esc(x === "all" ? _t("Все") : EX[x].name.replace(" Futures", ""))}</button>`).join("")}</div>` : "") + `</div>`;
    if (!s.n) {
      h += `<div class="jr-empty glass"><p>${esc(S.syncing ? _t("Загружаю сделки с биржи…") : _t("За этот период закрытых сделок нет."))}</p></div>`;
      body.innerHTML = h; return;
    }
    h += `<div class="jr-hero glass"><span>${esc(_t("Итог за период"))}</span><b class="${cls(s.net)}">${fmtUsd(s.net)}</b>
      <small>${s.n} ${esc(_t("сделок"))} · ${esc(_t("комиссии"))} ${fmtUsd(-s.fees, false)} · ${esc(_t("фандинг"))} ${fmtUsd(s.funding)}</small>${curveSvg(s)}</div>`;
    const kpi = [
      [_t("Win rate"), `${Math.round(s.winRate * 100)}%`, `${s.wins} / ${s.losses}`, _t("Доля прибыльных сделок")],
      [_t("Profit factor"), s.pf === Infinity ? "∞" : s.pf.toFixed(2), s.pf >= 1.5 ? _t("сильно") : s.pf >= 1 ? _t("в плюсе") : _t("в минусе"), _t("Сумма прибылей / сумма убытков. Больше 1 — торговля прибыльна")],
      [_t("Ср. прибыль"), fmtUsd(s.avgWin), `${_t("убыток")} ${fmtUsd(-s.avgLoss)}`, _t("Средний результат прибыльной и убыточной сделки")],
      [_t("Ожидание"), fmtUsd(s.expectancy), _t("на сделку"), _t("Сколько в среднем приносит одна сделка")],
      [_t("Макс. просадка"), fmtUsd(-s.maxDD), s.ddFrom ? `${fmtDate(s.ddFrom).split(",")[0]} → ${fmtDate(s.ddTo).split(",")[0]}` : "", _t("Самое глубокое падение кривой доходности от пика")],
      [_t("Серии"), `+${s.streakW} / −${s.streakL}`, _t("подряд"), _t("Самые длинные серии прибыльных и убыточных сделок")],
    ];
    h += `<div class="jr-kpis">${kpi.map(([a, b, c, d]) => `<div class="glass"><span>${esc(a)}</span><b>${esc(b)}</b><small>${esc(c)}</small><em class="simple-only">${esc(d)}</em></div>`).join("")}</div>`;
    const ins = insights(s);
    h += `<div class="section-title">${esc(_t("Выводы"))} <small>${esc(_t("по твоим сделкам"))}</small></div>
      <div class="jr-ins glass">${ins.length ? ins.map(([k, t]) => `<p class="${k}"><i></i>${esc(t)}</p>`).join("") : `<p class="info"><i></i>${esc(_t("Пока мало сделок для выводов — нужно хотя бы 10–20."))}</p>`}
        <button class="jr-ai" data-j="ai"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3l1.8 4.9L19 9.7l-4.3 3 1.4 5.3L12 15l-4.1 3 1.4-5.3L5 9.7l5.2-1.8z" fill="currentColor"/></svg>${esc(_t("ИИ-разбор торговли"))}<i class="pc-pro">PRO</i></button>
        <div class="jr-ai-out" id="jr-ai-out"></div></div>`;
    const sideMap = Object.fromEntries(s.bySide.map((g) => [g.k, g]));
    h += `<div class="jr-two">
      <div class="glass jr-box"><div class="jr-h">${esc(_t("Лонг / шорт"))}</div>${["long", "short"].map((k) => { const g = sideMap[k] || { n: 0, w: 0, pnl: 0 }; return `<div class="jr-row"><span class="side ${k === "long" ? "LONG" : "SHORT"}">${k === "long" ? "LONG" : "SHORT"}</span><span>${g.n} · ${g.n ? Math.round((g.w / g.n) * 100) : 0}%</span><b class="${cls(g.pnl)}">${fmtUsd(g.pnl)}</b></div>`; }).join("")}</div>
      <div class="glass jr-box"><div class="jr-h">${esc(_t("Монеты"))}</div>${s.bySym.slice(0, 3).concat(s.bySym.length > 3 ? s.bySym.slice(-2).filter((g) => g.pnl < 0) : []).map((g) => `<div class="jr-row"><span><b>${esc(g.k)}</b></span><span>${g.n} · ${Math.round((g.w / g.n) * 100)}%</span><b class="${cls(g.pnl)}">${fmtUsd(g.pnl)}</b></div>`).join("")}</div>
    </div>`;
    h += `<div class="glass jr-box"><div class="jr-h">${esc(_t("Дни недели"))}</div>${barsHtml(s.byDow, 7, (i) => [_t("Пн"), _t("Вт"), _t("Ср"), _t("Чт"), _t("Пт"), _t("Сб"), _t("Вс")][i])}</div>`;
    if (s.open.length) h += `<div class="section-title">${esc(_t("Открытые позиции"))} <small>${s.open.length}</small></div>`;
    h += `<div class="section-title">${esc(_t("Сделки"))} <small>${s.n}</small></div><div class="jr-trades" id="jr-trades"></div>`;
    h += `<p class="hint">${esc(_t("Ключи хранятся только на этом устройстве и не отправляются на наш сервер. Результаты — по данным биржи; позиции, открытые до начала истории, считаются по реализованному PnL."))}</p>`;
    body.innerHTML = h;
    S._list = s.closed.slice().reverse().concat(s.open);
    renderTrades();
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

  const TAGS = ["Пробой", "Отбой", "Тренд", "Сигнал McQ", "FOMO", "Отыгрыш", "По плану", "Ранний выход"];
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
        <button class="jr-tr-h" data-j="trade" data-v="${esc(t.id)}">
          <span class="side ${t.side === "long" ? "LONG" : "SHORT"}">${t.side === "long" ? "L" : "S"}</span>
          <span class="jr-tr-s"><b>${esc(t.sym)}</b><small>${esc(EX[t.ex] ? EX[t.ex].name.replace(" Futures", "") : t.ex)} · ${t.open ? esc(_t("открыта")) : fmtDate(t.closeT)}${(n.tags || []).length ? " · " + n.tags.map((x) => esc(_t(x))).join(", ") : ""}</small></span>
          <span class="jr-tr-p"><b class="${cls(t.pnl)}">${t.open ? "—" : fmtUsd(t.pnl)}</b><small>${pct != null && !t.open ? `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%` : ""}</small></span>
        </button>
        ${open ? `<div class="jr-tr-d">
          <div class="jr-grid"><span>${esc(_t("Вход"))}</span><b>${fmtP(t.entry)}</b><span>${esc(_t("Выход"))}</span><b>${fmtP(t.exit)}</b>
          <span>${esc(_t("Объём"))}</span><b>${fmtUsd(t.notional, false)}</b><span>${esc(_t("Время в сделке"))}</span><b>${t.openT && t.closeT ? fmtDur(t.closeT - t.openT) : "—"}</b>
          <span>${esc(_t("Комиссии"))}</span><b>${fmtUsd(-(t.fee || 0), false)}</b><span>${esc(_t("Фандинг"))}</span><b>${fmtUsd(t.funding || 0)}</b>
          ${t.lev ? `<span>${esc(_t("Плечо"))}</span><b>${t.lev}x</b>` : ""}${t.partial ? `<span></span><small>${esc(_t("вход до начала истории"))}</small>` : ""}</div>
          <div class="jr-tags">${TAGS.map((g) => `<button class="${(n.tags || []).includes(g) ? "on" : ""}" data-j="tag" data-v="${esc(t.id)}" data-tag="${esc(g)}">${esc(_t(g))}</button>`).join("")}</div>
          <textarea class="jr-note" data-note="${esc(t.id)}" placeholder="${esc(_t("Заметка: почему вошёл, что пошло не так…"))}">${esc(n.note || "")}</textarea>
        </div>` : ""}
      </div>`;
    }).join("") + (list.length > show.length ? `<button class="jr-more" data-j="more">${esc(_t("Показать все"))} (${list.length})</button>` : "");
    el.querySelectorAll(".jr-note").forEach((ta) => ta.addEventListener("change", async () => {
      const id = ta.dataset.note; S.notes[id] = Object.assign({}, S.notes[id], { note: ta.value.slice(0, 1000) });
      try { await kvSet("notes", S.notes); } catch (e) { /* noop */ }
    }));
  }
  async function toggleTag(id, tag) {
    const n = S.notes[id] = Object.assign({ tags: [] }, S.notes[id]);
    n.tags = n.tags.includes(tag) ? n.tags.filter((x) => x !== tag) : n.tags.concat(tag);
    try { await kvSet("notes", S.notes); } catch (e) { /* noop */ }
    renderTrades();
  }

  function onboarding() {
    return `<div class="jr-onb">
      <div class="jr-onb-ic"><svg viewBox="0 0 24 24" width="30" height="30"><path d="M5 4h11l3 3v13H5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 15l3-3 2 2 3-4" fill="none" stroke="#f5c451" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <h2>${esc(_t("Твой торговый журнал"))}</h2>
      <p>${esc(_t("Подключи биржу — журнал сам соберёт все закрытые позиции и покажет, где ты зарабатываешь, а где теряешь: win rate, profit factor, просадку, лучшие монеты и часы, ошибки вроде отыгрыша."))}</p>
      <div class="jr-exs">${EX_ORDER.map((k) => `<button class="glass" data-j="connect" data-v="${k}"><b>${esc(EX[k].name)}</b><small>${k === "hyperliquid" ? esc(_t("по адресу кошелька")) : esc(_t("read-only ключ"))}</small></button>`).join("")}</div>
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
          <small class="jr-note-s">${esc(_t("Ключ сохранится только на этом устройстве в зашифрованном виде."))}${ex === "bingx" ? " " + esc(_t("BingX не разрешает запросы из браузера, поэтому подписанный на устройстве запрос пересылается через наш сервер; секретный ключ при этом не передаётся.")) : ""}</small>
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
    if (CFG.premium === "paid" && A.loadPlan && (await A.loadPlan()) !== "pro") { out.innerHTML = `<p class="jr-muted">${esc(_t("ИИ-разбор торговли доступен в McQ Pro."))}</p>`; return; }
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
  function onBack() { if (!$("#jr-sheet").hidden) closeSheet(); else close(); }
  async function open() {
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
    S.open = false;
    el.classList.remove("show");
    document.documentElement.classList.remove("pc-open");
    setTimeout(() => { el.hidden = true; }, 250);
    if (tg) { try { tg.BackButton.offClick(onBack); tg.BackButton.hide(); } catch (e) { /* noop */ } }
  }

  window.Journal = { open, close, _test: { buildPositions, stats, insights, demoTrades, EX, S } };
})();
