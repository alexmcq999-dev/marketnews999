// McQ Journal — пересылка запросов к биржам, которые не разрешают запросы из браузера (BingX, Bitunix).
// Запрос подписывается на устройстве пользователя; сюда приходят только URL и заголовки с одноразовой подписью
// и публичным API key. Секретный ключ сюда НЕ передаётся и ничего не сохраняется. Разрешены только GET-запросы чтения.
// Деплой: supabase functions deploy exchange-relay   (Verify JWT — включён: пользоваться могут только вошедшие)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// только эндпоинты чтения, по биржам
const HOSTS: Record<string, { paths: string[]; headers: Record<string, RegExp> }> = {
  "open-api.bingx.com": {
    paths: [
      "/openApi/swap/v2/user/balance", "/openApi/swap/v2/user/income", "/openApi/swap/v2/user/positions",
      "/openApi/swap/v1/trade/positionHistory", "/openApi/swap/v2/trade/allOrders", "/openApi/swap/v2/trade/allFillOrders",
      "/openApi/swap/v2/server/time",
    ],
    headers: { "X-BX-APIKEY": /^[A-Za-z0-9]{16,128}$/ },
  },
  "fapi.bitunix.com": {
    paths: [
      "/api/v1/futures/account", "/api/v1/futures/position/get_history_positions",
      "/api/v1/futures/position/get_pending_positions", "/api/v1/futures/trade/get_history_trades",
    ],
    headers: { "api-key": /^[A-Za-z0-9]{16,128}$/, "nonce": /^[A-Za-z0-9]{8,64}$/, "timestamp": /^\d{10,16}$/, "sign": /^[a-f0-9]{64}$/ },
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const body = await req.json();
    const u = new URL(String(body.url || ""));
    const rule = HOSTS[u.hostname];
    if (u.protocol !== "https:" || !rule || !rule.paths.includes(u.pathname)) return json({ error: "not allowed" }, 400);
    // заголовки: BingX — старый формат {url, apiKey}; остальные — {url, headers}
    const given: Record<string, string> = body.headers && typeof body.headers === "object" ? body.headers
      : body.apiKey ? { "X-BX-APIKEY": String(body.apiKey) } : {};
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    for (const [name, re] of Object.entries(rule.headers)) {
      const v = String(given[name] ?? "");
      if (!re.test(v)) return json({ error: `bad header ${name}` }, 400);
      headers[name] = v;
    }
    const r = await fetch(u.toString(), { headers });
    const text = await r.text();
    let out: unknown = null;
    try { out = JSON.parse(text); } catch { out = { code: -1, msg: text.slice(0, 200) }; }
    return json({ status: r.status, body: out });
  } catch (e) {
    return json({ error: (e as Error).message || "error" }, 500);
  }
});
