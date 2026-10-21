// McQ Pro Chart — ИИ-ассистент. Получает вопрос пользователя и снимок графика (агрегированные свечи с VWAP,
// сессионный/якорный VWAP, профиль объёма, CVD, OI, фандинг, доли бирж, сигнал McQ), спрашивает LLM и
// возвращает разбор + уровни, которые клиент рисует на графике.
// Секреты функции: LLM_API_KEY (тот же ключ OpenRouter, что у бота). Необязательно: LLM_MODEL (через запятую),
// LLM_BASE_URL, PREMIUM_MODE (open | paid), AI_FREE_LIMIT (по умолч. 15/день), AI_PRO_LIMIT (по умолч. 100/день).
// SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.
// Деплой: supabase functions deploy chart-ai   (Verify JWT — включён: звать могут только вошедшие пользователи)
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const LANGS: Record<string, string> = { ru: "Russian", en: "English", es: "Spanish", fr: "French", ko: "Korean", zh: "Simplified Chinese" };
const KINDS = new Set(["support", "resistance", "entry", "stop", "target", "liquidity"]);

function system(lang: string) {
  return `You are McQ AI — a senior crypto derivatives trader and market-microstructure analyst inside the McQ Pro Chart app.
You receive a JSON snapshot aggregated across major exchanges (spot + perpetuals: Binance, Bybit, OKX, Bitget, Gate, Hyperliquid, Coinbase, Kraken):
candles with per-candle VWAP, USD volume, estimated taker delta (from Binance takers, extrapolated) and spot share; session VWAP with sigma;
anchored VWAP (if the user set one); volume profile of the last 120 bars (POC/VAH/VAL); CVD change; aggregated open interest and its change;
funding by exchange; exchange volume shares; volume spikes; and the McQ bot's open signal for this coin, if any.
Rules:
- Use ONLY the data provided. Never invent prices, news, events or indicators you were not given. If data is missing, say so briefly.
- Be concrete: cite numbers (levels, sigma, % changes, delta, OI). Think in scenarios with triggers and invalidation.
- Explain WHO is in control (aggressive buyers vs sellers, spot vs leverage) and WHERE liquidity/stops likely sit (range extremes, VAH/VAL, round numbers near price).
- If a McQ signal exists, comment whether the current flow supports or contradicts it.
- No certainty, no guarantees; it's analysis, not financial advice. Keep it tight: max ~170 words, short lines, may use **bold**, no headings, no tables.
- Answer in ${LANGS[lang] || "English"}.
Return STRICT JSON only:
{"answer": string,
 "bias": "bullish" | "bearish" | "neutral",
 "confidence": integer 0-100,
 "levels": [{"price": number, "label": string (max 22 chars, in the answer language), "kind": "support"|"resistance"|"entry"|"stop"|"target"|"liquidity"}]  // 0-6 items, only within ±15% of price
 "plan": null | {"side": "long"|"short", "entry": number, "stop": number, "targets": [number], "invalidation": string}}
Give a plan only if the user asks for a trade/plan or the setup is clear; otherwise null.`;
}

function journalSystem(lang: string) {
  return `You are McQ AI — a strict but supportive trading coach. You receive a JSON summary of the user's real closed positions
(from their exchange): totals, win rate, profit factor, avg win/loss, drawdown, fees, funding, streaks, holding times,
trades opened within 30 min after a loss, splits by side / symbol / weekday / close hour, and the last 40 trades with the user's own tags.
Write a review that helps them trade better:
1) **Verdict** in one line (is the edge real or not, with the key numbers).
2) **What works** — 2-3 concrete strengths backed by numbers.
3) **What costs money** — the 3 biggest leaks (e.g. losers held longer than winners, revenge trading, a bleeding symbol or side, fees, over-trading, bad hours), each with numbers.
4) **Rules for next week** — 3-5 specific, measurable rules (e.g. "max 3 losses per day then stop", "no trades on X", "cut losers at −1R").
Use ONLY the given data, never invent trades. If the sample is small (< 20 trades), say conclusions are preliminary. If "demo" is true, mention it's example data.
No guarantees, not financial advice. Max ~230 words, short lines, may use **bold**, no headings with #, no tables. Answer in ${LANGS[lang] || "English"}.
Return STRICT JSON only: {"answer": string}`;
}

// вытаскиваем первый корректный JSON-объект из текста (модель может обернуть его в ```json … ``` или добавить слова)
// deno-lint-ignore no-explicit-any
function parseJSON(txt: string): any {
  const clean = txt.replace(/```(?:json)?/gi, "");
  const start = clean.indexOf("{");
  if (start < 0) return null;
  for (let end = clean.lastIndexOf("}"); end > start; end = clean.lastIndexOf("}", end - 1)) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch { /* пробуем короче */ }
  }
  return null;
}

async function llm(messages: unknown[]) {
  const key = Deno.env.get("LLM_API_KEY") ?? "";
  if (!key) throw new Error("LLM_API_KEY is not set");
  const base = (Deno.env.get("LLM_BASE_URL") || "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const models = (Deno.env.get("LLM_MODEL") || (base.includes("openrouter") ? "openai/gpt-4o-mini" : "gpt-4o-mini"))
    .split(",").map((s) => s.trim()).filter(Boolean);
  const errs: string[] = [];
  for (const model of models) {
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://mcqcryptonews.pages.dev/", "X-Title": "McQ Pro Chart" },
        // reasoning-модели (Claude 5.x, GPT-6 и т.п.) тратят часть max_tokens на «размышления» — даём запас и просим думать коротко
        body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 4000, reasoning: { effort: "low", exclude: true }, response_format: { type: "json_object" } }),
      });
      const d = await r.json();
      if (!r.ok) { errs.push(`${model}: ${r.status} ${JSON.stringify(d).slice(0, 160)}`); continue; }
      const msg = d.choices?.[0]?.message ?? {};
      // текст ответа может прийти строкой, массивом блоков или аргументами tool call — собираем всё
      let txt = "";
      if (typeof msg.content === "string") txt = msg.content;
      else if (Array.isArray(msg.content)) txt = msg.content.map((b: { text?: string }) => b?.text ?? "").join("");
      if (!txt.includes("{") && msg.tool_calls?.[0]?.function?.arguments) txt = String(msg.tool_calls[0].function.arguments);
      const parsed = parseJSON(txt);
      if (!parsed) {
        errs.push(`${model}: no json (finish=${d.choices?.[0]?.finish_reason ?? "?"}, text=${JSON.stringify(txt.slice(0, 80))})`);
        continue;
      }
      return parsed;
    } catch (e) { errs.push(`${model}: ${(e as Error).message}`); }
  }
  throw new Error(errs.join(" | ").slice(0, 400));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!, anon = Deno.env.get("SUPABASE_ANON_KEY")!, service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "auth" }, 401);
    const admin = createClient(url, service);

    // подписка и лимиты
    const { data: sub } = await admin.from("subscriptions").select("plan,until").eq("user_id", user.id).maybeSingle();
    const pro = !!sub && sub.plan === "pro" && (!sub.until || new Date(sub.until) > new Date());
    if ((Deno.env.get("PREMIUM_MODE") || "open") === "paid" && !pro) return json({ error: "pro_required" }, 402);
    const limit = Number(Deno.env.get(pro ? "AI_PRO_LIMIT" : "AI_FREE_LIMIT") || (pro ? 100 : 15));
    const { data: used, error: uerr } = await admin.rpc("bump_ai_usage", { p_user: user.id, p_limit: limit });
    if (!uerr && used === -1) return json({ error: "limit", limit }, 429);

    const body = await req.json().catch(() => ({}));
    const question = String(body.question || "").slice(0, 500).trim();
    const ctx = body.ctx;
    if (!question || !ctx || typeof ctx !== "object") return json({ error: "bad request" }, 400);
    const lang = LANGS[body.lang] ? body.lang : "en";
    const ctxStr = JSON.stringify(ctx).slice(0, 14000);

    // разбор торгового журнала (McQ Journal)
    if (body.kind === "journal") {
      const jout = await llm([
        { role: "system", content: journalSystem(lang) },
        { role: "user", content: `TRADING JOURNAL SUMMARY:\n${ctxStr}` },
      ]);
      return json({ answer: String(jout.answer || "").slice(0, 3500), pro, used: uerr ? null : used, limit });
    }

    const history = Array.isArray(body.history) ? body.history.slice(-6, -1) : [];
    const messages = [
      { role: "system", content: system(lang) },
      ...history.filter((m: { role?: string; content?: unknown }) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m: { role: string; content: string }) => ({ role: m.role, content: m.content.slice(0, 1200) })),
      { role: "user", content: `CHART SNAPSHOT:\n${ctxStr}\n\nQUESTION: ${question}` },
    ];
    const out = await llm(messages);

    // проверяем ответ модели
    const price = Number(ctx.price) || 0;
    const near = (p: unknown) => typeof p === "number" && isFinite(p) && p > 0 && (!price || Math.abs(p / price - 1) <= 0.15);
    const levels = (Array.isArray(out.levels) ? out.levels : [])
      .map((l: { price?: unknown; label?: unknown; kind?: unknown }) => ({ price: Number(l.price), label: String(l.label || "").slice(0, 22), kind: KINDS.has(String(l.kind)) ? String(l.kind) : "liquidity" }))
      .filter((l: { price: number }) => near(l.price)).slice(0, 6);
    let plan = null;
    const p = out.plan;
    if (p && (p.side === "long" || p.side === "short") && near(Number(p.entry)) && near(Number(p.stop))) {
      plan = { side: p.side, entry: Number(p.entry), stop: Number(p.stop), targets: (Array.isArray(p.targets) ? p.targets : []).map(Number).filter(near).slice(0, 3), invalidation: String(p.invalidation || "").slice(0, 200) };
    }
    return json({
      answer: String(out.answer || "").slice(0, 2500),
      bias: ["bullish", "bearish", "neutral"].includes(out.bias) ? out.bias : "neutral",
      confidence: Math.max(0, Math.min(100, Math.round(Number(out.confidence) || 0))),
      levels, plan, pro, used: uerr ? null : used, limit,
    });
  } catch (e) {
    return json({ error: (e as Error).message || "error" }, 500);
  }
});
