// McQ Journal — пересылка запросов к BingX (BingX не разрешает запросы из браузера).
// Запрос подписывается на устройстве пользователя; сюда приходят только URL с одноразовой подписью и публичный API key.
// Секретный ключ сюда НЕ передаётся и ничего не сохраняется. Разрешены только GET-запросы чтения к open-api.bingx.com.
// Деплой: supabase functions deploy exchange-relay   (Verify JWT — включён: пользоваться могут только вошедшие)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// только эндпоинты чтения
const ALLOWED = [
  "/openApi/swap/v2/user/balance",
  "/openApi/swap/v2/user/income",
  "/openApi/swap/v2/user/positions",
  "/openApi/swap/v1/trade/positionHistory",
  "/openApi/swap/v2/trade/allOrders",
  "/openApi/swap/v2/trade/allFillOrders",
  "/openApi/swap/v2/server/time",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const { url, apiKey } = await req.json();
    const u = new URL(String(url || ""));
    if (u.protocol !== "https:" || u.hostname !== "open-api.bingx.com" || !ALLOWED.includes(u.pathname)) return json({ error: "not allowed" }, 400);
    if (!/^[A-Za-z0-9]{16,128}$/.test(String(apiKey || ""))) return json({ error: "bad api key" }, 400);
    const r = await fetch(u.toString(), { headers: { "X-BX-APIKEY": String(apiKey) } });
    const text = await r.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = { code: -1, msg: text.slice(0, 200) }; }
    return json({ status: r.status, body });
  } catch (e) {
    return json({ error: (e as Error).message || "error" }, 500);
  }
});
