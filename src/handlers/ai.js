// src/handlers/ai.js
import { callOpenAI } from "../lib/openai.js";
import { buildChartFacts } from "../lib/chart.js";
import { pickLocale, clampInt, requireBirthData } from "../lib/locale.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function actionConfig(action) {
  const base = { model: "gpt-4o-mini", max_output_tokens: 220, temperature: 0.85 };
  switch (action) {
    case "daily_cosmic_message":     return { ...base, max_output_tokens: 140, temperature: 0.9 };
    case "lucky_number_explanation": return { ...base, max_output_tokens: 170, temperature: 0.75 };
    case "natal_map_summary":        return { ...base, max_output_tokens: 220, temperature: 0.8 };
    default: return null;
  }
}

function buildPrompt(action, payload, locale) {
  const bd = payload?.birthData;
  const err = requireBirthData(bd);
  if (err) return { error: err };

  const hour   = clampInt(bd.hour   ?? 0, 0, 23, 0);
  const minute = clampInt(bd.minute ?? 0, 0, 59, 0);

  const commonRules = [
    `Language/locale: ${locale}`,
    "Tone: calm, premium, grounded.",
    "No emojis. No disclaimers.",
    "Don't repeat the user facts verbatim.",
  ].join("\n");

  const userFacts = [
    `Birth date: ${bd.day}-${bd.month}-${bd.year}`,
    `Birth time: ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    bd.latitude != null && bd.longitude != null
      ? `Location: lat ${bd.latitude}, lon ${bd.longitude}`
      : "Location: (not provided)",
  ].join("\n");

  if (action === "daily_cosmic_message") {
    return {
      system: `You are an expert writer creating calm, modern daily guidance for a premium lifestyle app.\n${commonRules}`,
      user: `Write the output in EXACTLY 2 LINES.

Line 1 (INSIGHT):
- 30–40 words
- Daily mindset / emotional focus
- Calm, warm, reflective tone
- ONE paragraph only

Line 2 (KOZMIK_TAVSIYE):
- ONE short, friendly sentence (8–14 words)
- Action must be simple and concrete
- NO explanation, NO justification

Rules:
- Plain text only
- No titles, no emojis, no astrology terms
- Exactly 2 lines, separated by ONE newline`,
    };
  }

  if (action === "lucky_number_explanation") {
    const luckyNumber = clampInt(payload?.luckyNumber ?? 7, 1, 9, 7);
    return {
      system: `You are a numerology expert for a premium app.\n${commonRules}`,
      user: `Explain the lucky number in a short, useful way.\n\nLucky number: ${luckyNumber}\nUser facts:\n${userFacts}\n\nOutput format:\n- 1 sentence meaning\n- 3 bullet points: Love / Work / Luck (one line each)\n- 1 short closing sentence\nKeep total under 90 words.`,
    };
  }

  if (action === "natal_map_summary") {
    const chartFacts = buildChartFacts(payload?.chart);
    if (!chartFacts) return { error: "Missing chart in payload.chart" };
    return {
      system: `You are an expert astrologer specializing in premium natal chart summaries.\n${commonRules}`,
      user: `Write a premium natal map summary using EXACTLY the structure below.

User facts:
${userFacts}

Chart facts:
${chartFacts}

OUTPUT FORMAT (MUST FOLLOW EXACTLY):

Core Theme:
(1 paragraph, 120-130 words)

Strength:
(1 paragraph, 120-130 words)

Watch-out:
(1 paragraph, 120-130 words)

RULES:
- Do NOT merge sections or rename headings
- Each heading followed by exactly ONE paragraph
- Total length: 140–190 words
- No bullet points, no emojis
- Output language: ${locale}`,
    };
  }

  return { error: "Unsupported action" };
}

export async function handleAI(request, env) {
  const body = await request.json();
  const { action, payload = {}, lang, userId } = body;
  const locale = pickLocale(lang);

  if (!action) return { error: "Missing action", status: 400 };

  const cfg = actionConfig(action);
  if (!cfg) return { error: "Unknown action", status: 400 };

  const prompt = buildPrompt(action, payload, locale);
  if (prompt?.error) return { error: prompt.error, status: 400 };

  // Edge cache per user/day/action/locale
  const day = new Date().toISOString().slice(0, 10);
  const cacheKeyUrl = new URL(request.url);
  cacheKeyUrl.pathname = "/__ai_cache__";
  cacheKeyUrl.searchParams.set("u", String(userId));
  cacheKeyUrl.searchParams.set("a", String(action));
  cacheKeyUrl.searchParams.set("l", String(locale));
  cacheKeyUrl.searchParams.set("d", day);
  const cacheKeyReq = new Request(cacheKeyUrl.toString(), { method: "GET" });
  const cache = caches.default;
  const cached = await cache.match(cacheKeyReq);
  if (cached) return { rawResponse: cached }; // bypass json() wrapper

  const out = await callOpenAI(env, cfg, prompt.system, prompt.user);
  if (out?.error) return { error: out.error, details: out.raw, status: out.status || 500 };

  const responseBody = { action, locale, result: out.text };
  const res = new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, "Cache-Control": "public, max-age=86400" },
  });
  await cache.put(cacheKeyReq, res.clone());
  return { rawResponse: res };
}
