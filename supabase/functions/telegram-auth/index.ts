// McQCryptoNews — вход через Telegram для Supabase Auth.
// Принимает либо initData мини-приложения Telegram, либо данные Telegram Login (сайт/PWA),
// проверяет подпись токеном бота и возвращает одноразовый token_hash; клиент обменивает его на сессию:
//   supabase.auth.verifyOtp({ token_hash, type: "magiclink" })
// Секреты функции: TELEGRAM_BOT_TOKEN (бот новостного приложения). SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY
// Supabase подставляет сам. Деплой: supabase functions deploy telegram-auth --no-verify-jwt
import { createClient } from "jsr:@supabase/supabase-js@2";

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const enc = new TextEncoder();
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const fresh = (authDate: unknown) => Date.now() / 1000 - Number(authDate) < 86400;

// Telegram Login Widget: secret = SHA256(bot_token)
async function checkWidget(d: Record<string, unknown>) {
  const { hash, ...rest } = d;
  const check = Object.keys(rest).filter((k) => rest[k] !== undefined && rest[k] !== null && rest[k] !== "")
    .sort().map((k) => `${k}=${rest[k]}`).join("\n");
  const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(BOT)));
  if (hex(await hmac(secret, check)) !== hash || !fresh(rest.auth_date)) return null;
  return { id: String(rest.id), first_name: rest.first_name, last_name: rest.last_name, username: rest.username,
    photo_url: rest.photo_url };
}

// Mini App initData: secret = HMAC_SHA256(key="WebAppData", bot_token)
async function checkInitData(initData: string) {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), BOT);
  if (!hash || hex(await hmac(secret, check)) !== hash || !fresh(p.get("auth_date"))) return null;
  const u = JSON.parse(p.get("user") || "null");
  return u ? { id: String(u.id), first_name: u.first_name, last_name: u.last_name, username: u.username,
    photo_url: u.photo_url, language_code: u.language_code } : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!BOT) return json({ error: "TELEGRAM_BOT_TOKEN не задан" }, 500);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const tg = typeof body.initData === "string" ? await checkInitData(body.initData)
    : body.widget && typeof body.widget === "object" ? await checkWidget(body.widget as Record<string, unknown>) : null;
  if (!tg) return json({ error: "подпись Telegram не прошла проверку" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `tg${tg.id}@telegram.mcqcryptonews.app`;  // служебный адрес, писем на него не шлём
  const meta = { provider: "telegram", tg_id: tg.id, name: [tg.first_name, tg.last_name].filter(Boolean).join(" "),
    username: tg.username ?? null, avatar_url: tg.photo_url ?? null };
  await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: meta }).catch(() => null);
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data?.properties?.hashed_token) return json({ error: error?.message ?? "generateLink" }, 500);
  await admin.auth.admin.updateUserById(data.user.id, { user_metadata: meta }).catch(() => null);
  return json({ token_hash: data.properties.hashed_token });
});
