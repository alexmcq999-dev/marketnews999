// McQ Pro — оплата подписки.
//  • Внутри Telegram — Telegram Stars (ежемесячная подписка, продлевается сама). Правила Telegram: цифровые
//    товары в ботах и мини-приложениях — только за Stars, поэтому в мини-приложении другие способы не показываем.
//  • В браузере / PWA — USDT через Crypto Pay (@CryptoBot), разовый платёж на 30 дней.
// Одна функция обслуживает и приложение, и вебхуки:
//   POST {action:"config"}                     → цены и доступные способы
//   POST {action:"stars"}  + JWT пользователя  → ссылка на счёт в Stars (для Telegram.WebApp.openInvoice)
//   POST {action:"usdt"}   + JWT пользователя  → ссылка на счёт Crypto Pay
//   POST {action:"setup"}                      → направляет вебхук бота на эту функцию (можно звать повторно)
//   вебхук Telegram   — заголовок X-Telegram-Bot-Api-Secret-Token (секрет выводится из токена бота)
//   вебхук Crypto Pay — заголовок crypto-pay-api-signature (HMAC-SHA256 тела, ключ = SHA256(токена приложения))
// Секреты: TELEGRAM_BOT_TOKEN (уже есть — бот для входа), CRYPTOPAY_TOKEN (Crypto Bot → Crypto Pay → приложение).
// Необязательно: OWNER_CHAT_ID (куда пересылать вопросы пользователей боту), SUPPORT_CONTACT,
// PAY_BOT_TOKEN (другой бот для оплаты), PRO_PRICE_STARS (1500), PRO_PRICE_USDT (29.9),
// PRO_TRIAL_DAYS (3),
// CRYPTOPAY_TESTNET=1 (тестовая сеть @CryptoTestnetBot), APP_URL (ссылка на приложение).
// Деплой: supabase functions deploy billing --no-verify-jwt   (Verify JWT — ВЫКЛЮЧЕН: вебхуки приходят без JWT;
// пользователя функция проверяет сама).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const env = (k: string, d = "") => (Deno.env.get(k) || d).trim();
const BOT = () => env("PAY_BOT_TOKEN") || env("TELEGRAM_BOT_TOKEN");
const PRICE_STARS = () => Math.round(Number(env("PRO_PRICE_STARS", "1500"))) || 1500;
const PRICE_USDT = () => Number(env("PRO_PRICE_USDT", "29.9")) || 29.9;
const TRIAL_DAYS = () => Math.max(0, Math.round(Number(env("PRO_TRIAL_DAYS", "3"))));
const APP_URL = () => env("APP_URL", "https://mcqcryptonews.pages.dev/");
const CP_HOST = () => (env("CRYPTOPAY_TESTNET") === "1" ? "https://testnet-pay.crypt.bot" : "https://pay.crypt.bot");
const DAYS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const enc = new TextEncoder();

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(key: BufferSource, msg: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// секрет вебхука Telegram — без отдельной настройки: HMAC от токена бота
const tgSecret = async () => (await hmac(enc.encode(BOT()), "mcq-billing-webhook")).slice(0, 64);

async function tg(method: string, params: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${BOT()}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(`${method}: ${d.description || r.status}`);
  return d.result;
}
async function cryptoPay(method: string, params: Record<string, unknown>) {
  const r = await fetch(`${CP_HOST()}/api/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json", "Crypto-Pay-API-Token": env("CRYPTOPAY_TOKEN") },
    body: JSON.stringify(params),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(`${method}: ${JSON.stringify(d.error || r.status)}`);
  return d.result;
}

const admin = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const payloadUser = (p: unknown) => {
  const m = /^pro1:([0-9a-f-]{36})$/.exec(String(p || ""));
  return m && UUID.test(m[1]) ? m[1] : null;
};
const fmtDate = (s: string | null) => (s ? new Date(s).toISOString().slice(0, 10).split("-").reverse().join(".") : "∞");

// ---------------------------------------------------------------- вебхук Telegram
async function telegramUpdate(u: any) {
  const db = admin();
  if (u.pre_checkout_query) {
    const q = u.pre_checkout_query;
    const uid = payloadUser(q.invoice_payload);
    let ok = !!uid && q.currency === "XTR" && q.total_amount > 0;
    if (ok) {
      const { data } = await db.auth.admin.getUserById(uid!);
      ok = !!data?.user;
    }
    await tg("answerPreCheckoutQuery", ok ? { pre_checkout_query_id: q.id, ok: true }
      : { pre_checkout_query_id: q.id, ok: false, error_message: "Счёт устарел. Открой McQ Pro в приложении и попробуй снова." });
    return;
  }
  const m = u.message;
  if (!m) return;
  if (m.successful_payment) {
    const p = m.successful_payment;
    const uid = payloadUser(p.invoice_payload);
    if (!uid || p.currency !== "XTR") return;
    const { data: until, error } = await db.rpc("billing_record", {
      p_user: uid, p_provider: "stars", p_ext: p.telegram_payment_charge_id, p_amount: p.total_amount, p_asset: "XTR",
      p_days: DAYS, p_raw: { ...p, from: m.from?.id },
    });
    if (error) throw error;
    await tg("sendMessage", {
      chat_id: m.chat.id,
      text: `✅ McQ Pro ${p.is_recurring && !p.is_first_recurring ? "продлён" : "активирован"} до ${fmtDate(until)}.\n` +
        `Подписка продлевается автоматически. Управлять ею: Настройки Telegram → Мои звёзды.`,
      reply_markup: { inline_keyboard: [[{ text: "Открыть McQCryptoNews", web_app: { url: APP_URL() } }]] },
    }).catch(() => null);
    return;
  }
  if (m.refunded_payment) {
    await db.rpc("billing_refund", { p_provider: "stars", p_ext: m.refunded_payment.telegram_payment_charge_id });
    return;
  }
  const text = String(m.text || "").trim().split(/[\s@]/)[0];
  const owner = env("OWNER_CHAT_ID");
  if (text === "/paysupport") {
    await tg("sendMessage", { chat_id: m.chat.id, text: (owner
      ? "Вопрос по оплате McQ Pro? Напиши его одним сообщением сюда — оно придёт команде, ответим в личные сообщения."
      : "Вопрос по оплате McQ Pro? Напиши нам: " + (env("SUPPORT_CONTACT") || "в чат поддержки приложения") + ".") +
      "\nУсловия: " + APP_URL() + "privacy.html" }).catch(() => null);
  } else if (text === "/terms") {
    await tg("sendMessage", { chat_id: m.chat.id, text: "Условия и политика конфиденциальности: " + APP_URL() + "privacy.html" }).catch(() => null);
  } else if (text === "/start" && m.chat.type === "private") {
    await tg("sendMessage", {
      chat_id: m.chat.id, text: "McQCryptoNews — новости, сигналы, Pro Chart и торговый журнал.",
      reply_markup: { inline_keyboard: [[{ text: "Открыть приложение", web_app: { url: APP_URL() } }]] },
    }).catch(() => null);
  } else if (owner && m.chat.type === "private" && String(m.chat.id) !== owner && !text.startsWith("/")) {
    // любое другое личное сообщение боту — пересылаем владельцу (поддержка)
    await tg("forwardMessage", { chat_id: owner, from_chat_id: m.chat.id, message_id: m.message_id }).catch(() => null);
  }
}

// ---------------------------------------------------------------- вебхук Crypto Pay
async function cryptoPayUpdate(raw: string, sig: string) {
  const token = env("CRYPTOPAY_TOKEN");
  if (!token) return json({ error: "not configured" }, 503);
  const key = await crypto.subtle.digest("SHA-256", enc.encode(token));
  if (!safeEq(await hmac(key, raw), sig.toLowerCase())) return json({ error: "signature" }, 401);
  const u = JSON.parse(raw);
  if (u.update_type !== "invoice_paid") return json({ ok: true });
  const inv = u.payload || {};
  const uid = payloadUser(inv.payload);
  const paidUsd = inv.asset === "USDT" ? Number(inv.amount) : (inv.currency_type === "fiat" && inv.fiat === "USD" ? Number(inv.amount) : 0);
  if (!uid || inv.status !== "paid" || !(paidUsd >= PRICE_USDT() * 0.99)) return json({ ok: true, skipped: true });
  const { error } = await admin().rpc("billing_record", {
    p_user: uid, p_provider: "cryptopay", p_ext: String(inv.invoice_id), p_amount: Number(inv.paid_amount || inv.amount),
    p_asset: String(inv.paid_asset || inv.asset || "USDT"), p_days: DAYS,
    p_raw: { invoice_id: inv.invoice_id, hash: inv.hash, amount: inv.amount, asset: inv.asset, paid_asset: inv.paid_asset,
             paid_amount: inv.paid_amount, fee_amount: inv.fee_amount, paid_at: inv.paid_at },
  });
  if (error) return json({ error: error.message }, 500);   // 500 → Crypto Pay повторит позже
  return json({ ok: true });
}

// ---------------------------------------------------------------- запросы приложения
async function appRequest(req: Request, body: any) {
  const action = String(body.action || "");
  if (action === "config") {
    return json({ days: DAYS, trial_days: TRIAL_DAYS(), stars: BOT() ? { price: PRICE_STARS() } : null,
                  usdt: env("CRYPTOPAY_TOKEN") ? { price: PRICE_USDT(), asset: "USDT" } : null });
  }
  if (action === "setup") {
    const url = `${env("SUPABASE_URL")}/functions/v1/billing`;
    await tg("setWebhook", { url, secret_token: await tgSecret(), allowed_updates: ["message", "pre_checkout_query"], max_connections: 20 });
    await tg("setMyCommands", { commands: [
      { command: "start", description: "Открыть приложение" },
      { command: "paysupport", description: "Помощь с оплатой McQ Pro" },
      { command: "terms", description: "Условия" },
    ] }).catch(() => null);
    const info = await tg("getWebhookInfo", {});
    return json({ ok: true, webhook: info.url, pending: info.pending_update_count, last_error: info.last_error_message || null });
  }

  const userClient = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"),
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "auth" }, 401);
  const payload = `pro1:${user.id}`;
  // Telegram ID — из служебного email (его нельзя поменять из приложения, в отличие от user_metadata)
  const tgId = /^tg(\d+)@telegram\.mcqcryptonews\.app$/.exec(user.email || "")?.[1] || null;

  if (action === "status") {
    const db = admin();
    const [{ data: tr }, { data: pays }] = await Promise.all([
      db.from("trials").select("user_id").or(`user_id.eq.${user.id}${tgId ? `,tg_id.eq.${tgId}` : ""}`).limit(1),
      db.from("payments").select("id").eq("user_id", user.id).limit(1),
    ]);
    return json({ trial_available: TRIAL_DAYS() > 0 && !(tr && tr.length) && !(pays && pays.length), trial_days: TRIAL_DAYS() });
  }
  if (action === "trial") {
    if (!TRIAL_DAYS()) return json({ error: "trial_off" }, 400);
    const { data: until, error } = await admin().rpc("start_trial", { p_user: user.id, p_tg: tgId, p_days: TRIAL_DAYS() });
    if (error) {
      const code = /trial_used|already_pro/.exec(error.message)?.[0] || "trial_failed";
      return json({ error: code }, code === "trial_failed" ? 500 : 409);
    }
    return json({ until });
  }

  if (action === "stars") {
    if (!BOT()) return json({ error: "stars_off" }, 503);
    const url = await tg("createInvoiceLink", {
      title: "McQ Pro — 30 дней",
      description: "Pro Chart с объёмами и VWAP по 9 биржам, ИИ-ассистент по графику и ИИ-разбор торгового журнала. Продлевается каждые 30 дней.",
      payload, currency: "XTR", prices: [{ label: "McQ Pro", amount: PRICE_STARS() }],
      subscription_period: 2592000,
    });
    return json({ url });
  }
  if (action === "usdt") {
    if (!env("CRYPTOPAY_TOKEN")) return json({ error: "usdt_off" }, 503);
    const inv = await cryptoPay("createInvoice", {
      currency_type: "crypto", asset: "USDT", amount: PRICE_USDT().toFixed(2),
      description: "McQ Pro — 30 дней: Pro Chart, ИИ-ассистент, ИИ-разбор журнала",
      payload, expires_in: 3600, allow_comments: false, allow_anonymous: false,
      paid_btn_name: "callback", paid_btn_url: APP_URL(),
    });
    return json({ id: inv.invoice_id, url: inv.web_app_invoice_url || inv.bot_invoice_url || inv.pay_url,
                  tg_url: inv.bot_invoice_url || inv.pay_url, mini_app_url: inv.mini_app_invoice_url || null });
  }
  return json({ error: "action" }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const tgHeader = req.headers.get("x-telegram-bot-api-secret-token");
    if (tgHeader !== null) {
      if (!BOT() || !safeEq(tgHeader, await tgSecret())) return json({ error: "secret" }, 401);
      const u = await req.json().catch(() => ({}));
      try { await telegramUpdate(u); } catch (e) { console.error("tg update", (e as Error).message); return json({ error: "retry" }, 500); }
      return json({ ok: true });
    }
    const cpSig = req.headers.get("crypto-pay-api-signature");
    if (cpSig !== null) return await cryptoPayUpdate(await req.text(), cpSig);
    return await appRequest(req, await req.json().catch(() => ({})));
  } catch (e) {
    console.error("billing", (e as Error).message);
    return json({ error: (e as Error).message.slice(0, 300) }, 500);
  }
});
