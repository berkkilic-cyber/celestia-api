// src/index.js
import { computeNatal, computeComposite } from "./natal-core.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function text(msg, status = 200) {
  return new Response(msg, { status, headers: { ...CORS_HEADERS } });
}

function dayKeyUTC() {
  // daily cache key (UTC day). If you want user’s local day, tell me and we’ll switch.
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}
function signName(p) {
  return p?.sign ?? "Unknown";
}

function fmtPlanet(p) {
  if (!p) return null;
  const rx = p.retrograde ? " (R)" : "";
  const house = Number.isFinite(p.house) ? `H${p.house}` : "H?";
  const deg = Number.isFinite(p.deg) ? `${p.deg}°` : "";
  const min = Number.isFinite(p.min) ? `${String(p.min).padStart(2, "0")}` : "";
  const d = deg && min ? `${deg}${min}` : deg || "";
  return `${p.name}: ${signName(p)} ${house}${d ? ` @${d}` : ""}${rx}`;
}

function pickPlanet(chart, name) {
  return chart?.planets?.find((p) => p?.name === name) || null;
}

function buildChartFacts(chart) {
  if (!chart) return null;

  const asc = chart?.ascDetail
    ? `Ascendant: ${chart.ascDetail.sign} @${chart.ascDetail.deg}°${String(chart.ascDetail.min).padStart(2, "0")} (H1 starts near ${Math.round(chart.asc)}°)`
    : chart?.asc
      ? `Ascendant: ${Math.round(chart.asc)}°`
      : null;

  const mc = chart?.mcDetail
    ? `Midheaven (MC): ${chart.mcDetail.sign} @${chart.mcDetail.deg}°${String(chart.mcDetail.min).padStart(2, "0")}`
    : chart?.mc
      ? `Midheaven (MC): ${Math.round(chart.mc)}°`
      : null;

  const sun = fmtPlanet(pickPlanet(chart, "Sun"));
  const moon = fmtPlanet(pickPlanet(chart, "Moon"));
  const mercury = fmtPlanet(pickPlanet(chart, "Mercury"));
  const venus = fmtPlanet(pickPlanet(chart, "Venus"));
  const mars = fmtPlanet(pickPlanet(chart, "Mars"));
  const jupiter = fmtPlanet(pickPlanet(chart, "Jupiter"));
  const saturn = fmtPlanet(pickPlanet(chart, "Saturn"));
  const uranus = fmtPlanet(pickPlanet(chart, "Uranus"));
  const neptune = fmtPlanet(pickPlanet(chart, "Neptune"));
  const pluto = fmtPlanet(pickPlanet(chart, "Pluto"));
  const nn = fmtPlanet(pickPlanet(chart, "North Node"));
  const sn = fmtPlanet(pickPlanet(chart, "South Node"));

  // Houses are degree cusps (your API returns 12 values)
  const houses = Array.isArray(chart?.houses) && chart.houses.length === 12
    ? `House cusps (deg): ${chart.houses.map((h) => Math.round(h)).join(", ")}`
    : null;

  const lines = [
    asc,
    mc,
    sun,
    moon,
    mercury,
    venus,
    mars,
    jupiter,
    saturn,
    uranus,
    neptune,
    pluto,
    nn,
    sn,
    houses,
  ].filter(Boolean);

  return lines.join("\n");
}


function pickLocale(lang) {
  if (!lang) return "en-US";
  const s = String(lang).toLowerCase();
  if (s.startsWith("tr")) return "tr-TR";
  if (s.startsWith("de")) return "de-DE";
  if (s.startsWith("fr")) return "fr-FR";
  return "en-US";
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function requireBirthData(bd) {
  if (!bd) return "Missing birthData";
  const { year, month, day } = bd;
  if (!year || !month || !day) return "birthData must include year, month, day";
  return null;
}

function actionConfig(action) {
  const base = { model: "gpt-4o-mini", max_output_tokens: 220, temperature: 0.85 };
  switch (action) {
    case "daily_cosmic_message":
      return { ...base, max_output_tokens: 140, temperature: 0.9 };
    case "lucky_number_explanation":
      return { ...base, max_output_tokens: 170, temperature: 0.75 };
    case "natal_map_summary":
      return { ...base, max_output_tokens: 220, temperature: 0.8 };
    default:
      return null;
  }
}

function buildPrompt(action, payload, locale) {
  const bd = payload?.birthData;
  const err = requireBirthData(bd);
  if (err) return { error: err };

  const hour = clampInt(bd.hour ?? 0, 0, 23, 0);
  const minute = clampInt(bd.minute ?? 0, 0, 59, 0);

  const chart = payload?.chart;

  const commonRules = [
    `Language/locale: ${locale}`,
    `Tone: calm, premium, grounded.`,
    `No emojis. No disclaimers.`,
    `Don’t repeat the user facts verbatim.`,
  ].join("\n");

  const userFacts = [
    `Birth date: ${bd.day}-${bd.month}-${bd.year}`,
    `Birth time: ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    bd.latitude != null && bd.longitude != null
      ? `Location: lat ${bd.latitude}, lon ${bd.longitude}`
      : `Location: (not provided)`,
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
      - Examples of tone:
        “Bugün açık renkler giymeyi dene.”
        “Bir dakika durup derin nefes al.”
        “Telefonu bırakıp kısa bir yürüyüş yap.”
      - NO explanation
      - NO justification
      - Just the suggestion
      
      Rules:
      - Plain text only
      - No titles
      - No emojis
      - No astrology terms (no planets, signs, houses)
      - Exactly 2 lines, separated by ONE newline
      `
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
    const chart = payload?.chart;
    const chartFacts = buildChartFacts(chart);
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
  - Do NOT merge sections
  - Do NOT rename headings
  - Each heading must be followed by exactly ONE paragraph
  - Total length: 140–190 words
  - Use modern, grounded language
  - Reference real placements (sign + house)
  - Mention at least ONE retrograde influence if present
  - No bullet points
  - No emojis
  - Output language: ${locale}`
    };
  }
  


  return { error: "Unsupported action" };
}

async function callOpenAIChat(env, cfg, messages) {
  if (!env.OPENAI_API_KEY) {
    return { error: "Missing OPENAI_API_KEY secret on Worker", status: 500 };
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      input: messages,
      temperature: cfg.temperature,
      max_output_tokens: cfg.max_output_tokens,
    }),
  });

  const raw = await res.json();
  if (!res.ok) {
    return { error: raw?.error?.message || "OpenAI error", status: res.status, raw };
  }

  const chunks = raw?.output?.flatMap((o) => o?.content || []).filter(Boolean) || [];
  const textOut = chunks
    .map((c) => (c?.type === "output_text" ? c?.text : ""))
    .filter(Boolean)
    .join("")
    .trim();

  return { text: textOut, raw };
}

async function callOpenAI(env, cfg, system, user) {
  if (!env.OPENAI_API_KEY) {
    return { error: "Missing OPENAI_API_KEY secret on Worker", status: 500 };
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: cfg.temperature,
      max_output_tokens: cfg.max_output_tokens,
    }),
  });

  const raw = await res.json();
  if (!res.ok) {
    return { error: raw?.error?.message || "OpenAI error", status: res.status, raw };
  }

  const chunks = raw?.output?.flatMap((o) => o?.content || []).filter(Boolean) || [];
  const textOut = chunks
    .map((c) => (c?.type === "output_text" ? c?.text : ""))
    .filter(Boolean)
    .join("")
    .trim();

  return { text: textOut, raw };
}

async function handleNatal(request) {
  if (request.method !== "POST") {
    return text("Send JSON birth data with POST to this endpoint", 405);
  }

  const body = await request.json();

  // keep your existing validation (unchanged)
  const needed = ["year", "month", "day", "hour", "minute", "tzOffsetMinutes", "latitude", "longitude"];
  for (const k of needed) {
    if (body[k] === undefined) {
      return json({ error: `Missing: ${k}` }, 400);
    }
  }

  const chart = computeNatal(body);
  return json(chart);
}

async function handleComposite(request) {
  if (request.method !== "POST") {
    return text("Send JSON with person1 and person2 via POST", 405);
  }

  const body = await request.json();
  const needed = ["year", "month", "day", "hour", "minute", "tzOffsetMinutes", "latitude", "longitude"];

  for (const key of ["person1", "person2"]) {
    if (!body[key]) return json({ error: `Missing: ${key}` }, 400);
    for (const k of needed) {
      if (body[key][k] === undefined) {
        return json({ error: `Missing: ${key}.${k}` }, 400);
      }
    }
  }

  const chart = computeComposite(body.person1, body.person2);
  return json(chart);
}

async function handleAI(request, env) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const body = await request.json();
  const action = body?.action;
  const payload = body?.payload ?? {};
  const locale = pickLocale(body?.lang);

  const userId = body?.userId;
  if (!userId) return json({ error: "Missing userId" }, 400);

  if (!action) return json({ error: "Missing action" }, 400);

  const cfg = actionConfig(action);
  if (!cfg) return json({ error: "Unknown action", action }, 400);

  const prompt = buildPrompt(action, payload, locale);
  if (prompt?.error) return json({ error: prompt.error }, 400);

  // ------------------ CACHE (per user/day/action/lang) ------------------
  const day = dayKeyUTC();

  // keep it stable; do NOT include payload (privacy + avoid too many keys)
  const cacheKeyUrl = new URL(request.url);
  cacheKeyUrl.pathname = "/__ai_cache__";
  cacheKeyUrl.searchParams.set("u", String(userId));
  cacheKeyUrl.searchParams.set("a", String(action));
  cacheKeyUrl.searchParams.set("l", String(locale));
  cacheKeyUrl.searchParams.set("d", day);

  const cacheKeyReq = new Request(cacheKeyUrl.toString(), { method: "GET" });

  const cache = caches.default;
  const cached = await cache.match(cacheKeyReq);
  if (cached) {
    // return cached JSON as-is
    return cached;
  }

  // ------------------ OPENAI CALL (only once if cache miss) ------------------
  const out = await callOpenAI(env, cfg, prompt.system, prompt.user);
  if (out?.error) return json({ error: out.error, details: out.raw }, out.status || 500);

  const responseBody = { action, locale, result: out.text };

  // Build response we will return + cache
  const res = new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,

      // cache for 1 day at edge (Cloudflare cache API respects this)
      "Cache-Control": "public, max-age=86400",
    },
  });

  // Put into cache (must clone because response body can be read once)
  await cache.put(cacheKeyReq, res.clone());

  return res;
}


function buildChatSystemPrompt(chartFacts, locale) {
  return [
    "You are an expert astrologer having a personal conversation with the user.",
    "You have deep knowledge of their natal chart and speak directly to them.",
    "",
    "Their natal chart:",
    chartFacts,
    "",
    `Language/locale: ${locale}`,
    "",
    "Rules:",
    "- Warm, insightful, personal tone",
    "- 80-150 words per reply",
    "- Reference specific placements (sign, house, degree) from the chart above",
    "- No emojis",
    "- No disclaimers about astrology not being real",
    "- Answer the user's question directly and personally",
  ].join("\n");
}

const CHAT_SESSION_TTL = 86400;
const CHAT_CFG = { model: "gpt-4o-mini", max_output_tokens: 1000, temperature: 0.8 };

async function handleNatalChat(request, env) {
  if (request.method !== "POST") {
    return text("Send JSON with POST to this endpoint", 405);
  }

  const body = await request.json();

  // Flow B — Continue existing session
  if (body.sessionId) {
    const message = body.message;
    if (!message || typeof message !== "string" || !message.trim()) {
      return json({ error: "Missing or empty message" }, 400);
    }
    if (message.length > 2000) {
      return json({ error: "Message too long (max 2000 characters)" }, 400);
    }

    if (!env.NATAL_ANALYSIS_KV) {
      return json({ error: "KV storage not available" }, 500);
    }

    const kvKey = `chat:${body.sessionId}`;
    let session;
    try {
      session = await env.NATAL_ANALYSIS_KV.get(kvKey, "json");
    } catch (_) {
      session = null;
    }
    if (!session) {
      return json({ error: "Session not found or expired" }, 404);
    }

    // Stateless: only send system prompt + current user message
    const callMessages = [
      session.messages[0],
      { role: "user", content: message.trim() },
    ];

    const out = await callOpenAIChat(env, CHAT_CFG, callMessages);
    if (out?.error) {
      return json({ error: out.error, details: out.raw }, out.status || 500);
    }

    // Track turn count but don't accumulate history
    session.turnCount = (session.turnCount || 0) + 1;

    // Save to KV (resets TTL)
    try {
      await env.NATAL_ANALYSIS_KV.put(kvKey, JSON.stringify(session), {
        expirationTtl: CHAT_SESSION_TTL,
      });
    } catch (_) { /* ignore KV write errors */ }

    return json({
      sessionId: body.sessionId,
      reply: out.text,
      turnCount: session.turnCount,
    });
  }

  // Flow A — New session
  const needed = ["year", "month", "day", "hour", "minute", "tzOffsetMinutes", "latitude", "longitude"];
  for (const k of needed) {
    if (body[k] === undefined) {
      return json({ error: `Missing: ${k}` }, 400);
    }
  }

  const chart = computeNatal(body);
  const chartFacts = buildChartFacts(chart);
  if (!chartFacts) {
    return json({ error: "Failed to compute chart facts" }, 500);
  }

  const locale = pickLocale(body.lang);
  const systemPrompt = buildChatSystemPrompt(chartFacts, locale);
  const sessionId = crypto.randomUUID();
  const messages = [{ role: "system", content: systemPrompt }];

  let reply = undefined;
  let turnCount = 0;

  // If message provided, call OpenAI for first reply
  if (body.message && typeof body.message === "string" && body.message.trim()) {
    if (body.message.length > 2000) {
      return json({ error: "Message too long (max 2000 characters)" }, 400);
    }
    const callMessages = [
      messages[0],
      { role: "user", content: body.message.trim() },
    ];
    const out = await callOpenAIChat(env, CHAT_CFG, callMessages);
    if (out?.error) {
      return json({ error: out.error, details: out.raw }, out.status || 500);
    }
    reply = out.text;
    turnCount = 1;
  }

  // Store session in KV (only system prompt, no history)
  const session = {
    locale,
    createdAt: new Date().toISOString(),
    turnCount,
    messages,
  };

  if (env.NATAL_ANALYSIS_KV) {
    try {
      await env.NATAL_ANALYSIS_KV.put(`chat:${sessionId}`, JSON.stringify(session), {
        expirationTtl: CHAT_SESSION_TTL,
      });
    } catch (_) { /* ignore KV write errors */ }
  }

  const result = { sessionId, turnCount };
  if (reply !== undefined) result.reply = reply;
  return json(result);
}

function formatSynastryAspects(aspects) {
  if (!Array.isArray(aspects) || aspects.length === 0) return "(none)";
  return aspects
    .map((a) => `${a.planet1} ${a.aspect} ${a.planet2} (orb ${a.orb}°)`)
    .join("\n");
}

function buildRelationshipCacheKey(person1, person2, relationType) {
  const personStr = (p) => {
    const bd = p.birthData;
    return `${bd.year}-${bd.month}-${bd.day}-${bd.hour}-${bd.minute}-${bd.tzOffsetMinutes}-${Number(bd.latitude).toFixed(4)}-${Number(bd.longitude).toFixed(4)}`;
  };
  const s1 = personStr(person1);
  const s2 = personStr(person2);
  const sorted = [s1, s2].sort();
  return `relationship-score:${relationType}:${sorted[0]}:${sorted[1]}`;
}

function parseRelationshipJSON(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const parsed = JSON.parse(cleaned);

  if (typeof parsed.overallScore !== "number" || parsed.overallScore < 0 || parsed.overallScore > 100) {
    throw new Error("overallScore must be a number 0-100");
  }
  if (typeof parsed.generalText !== "string" || !parsed.generalText.trim()) {
    throw new Error("generalText must be a non-empty string");
  }
  if (!Array.isArray(parsed.tags) || parsed.tags.length !== 3) {
    throw new Error("tags must be an array of 3 objects");
  }
  for (const tag of parsed.tags) {
    if (typeof tag.emoji !== "string" || typeof tag.label !== "string") {
      throw new Error("Each tag must have emoji and label strings");
    }
  }
  if (typeof parsed.suggestion !== "string" || !parsed.suggestion.trim()) {
    throw new Error("suggestion must be a non-empty string");
  }
  if (typeof parsed.breakdown !== "object" || parsed.breakdown === null) {
    throw new Error("breakdown must be an object");
  }
  const breakdownValues = Object.values(parsed.breakdown);
  if (breakdownValues.length !== 4 || !breakdownValues.every((v) => typeof v === "number")) {
    throw new Error("breakdown must have exactly 4 numeric values");
  }

  return {
    overallScore: parsed.overallScore,
    generalText: parsed.generalText,
    tags: parsed.tags.map((t) => ({ emoji: t.emoji, label: t.label })),
    suggestion: parsed.suggestion,
    breakdown: parsed.breakdown,
  };
}

const VALID_RELATION_TYPES = ["romantic", "family", "friendship", "business"];

const VALID_SPREAD_TYPES = ["yes_no", "three_card", "love", "career", "celtic_cross"];

const SPREAD_CARD_COUNTS = {
  yes_no: 1,
  three_card: 3,
  love: 5,
  career: 5,
  celtic_cross: 10,
};

const SPREAD_POSITIONS = {
  yes_no: ["Kart"],
  three_card: ["Geçmiş", "Şimdi", "Gelecek"],
  love: ["Durum", "Zorluk", "Tavsiye", "Sonuç", "Anahtar Enerji"],
  career: ["Durum", "Zorluk", "Tavsiye", "Sonuç", "Anahtar Enerji"],
  celtic_cross: ["Şimdi", "Zorluk", "Geçmiş", "Gelecek", "Yukarı", "Aşağı", "Tavsiye", "Dış Etki", "Umutlar/Korkular", "Sonuç"],
};

const TAROT_CFG = { model: "gpt-4o-mini", max_output_tokens: 1500, temperature: 0.85 };

async function handleRelationshipScore(request, env) {
  if (request.method !== "POST") {
    return text("Send JSON with POST to this endpoint", 405);
  }

  const body = await request.json();

  const { relationType, person1, person2, compositeChart, synastryAspects } = body;

  if (!relationType || !VALID_RELATION_TYPES.includes(relationType)) {
    return json({ error: "relationType must be one of: romantic, family, friendship, business" }, 400);
  }
  if (!person1?.name || !person1?.birthData || !person1?.chart) {
    return json({ error: "person1 must include name, birthData, and chart" }, 400);
  }
  if (!person2?.name || !person2?.birthData || !person2?.chart) {
    return json({ error: "person2 must include name, birthData, and chart" }, 400);
  }
  if (!compositeChart) {
    return json({ error: "Missing compositeChart" }, 400);
  }
  if (!Array.isArray(synastryAspects)) {
    return json({ error: "synastryAspects must be an array" }, 400);
  }

  // Check KV cache
  const cacheKey = buildRelationshipCacheKey(person1, person2, relationType);
  if (env.NATAL_ANALYSIS_KV) {
    try {
      const cached = await env.NATAL_ANALYSIS_KV.get(cacheKey, "json");
      if (cached) return json(cached);
    } catch (_) { /* ignore KV errors */ }
  }

  const person1Summary = buildChartFacts(person1.chart);
  const person2Summary = buildChartFacts(person2.chart);
  const compositeSummary = buildChartFacts(compositeChart);
  const synastryText = formatSynastryAspects(synastryAspects);

  const system = "You are an expert astrologer.";

  const user = `Analyze the provided synastry aspects and composite chart to generate a relationship compatibility reading.

Relation type: ${relationType}

Person 1 (${person1.name}): ${person1Summary}

Person 2 (${person2.name}): ${person2Summary}

Composite chart: ${compositeSummary}

Synastry aspects: ${synastryText}

Return ONLY valid JSON with this exact structure, no markdown, no preamble:

{
  "overallScore": <number 0-100>,
  "generalText": "<30-40 token Turkish text summarizing the harmony between these two people based on their actual aspects>",
  "tags": [
    {"emoji": "<1 emoji>", "label": "<1-2 word Turkish label>"},
    {"emoji": "<1 emoji>", "label": "<1-2 word Turkish label>"},
    {"emoji": "<1 emoji>", "label": "<1-2 word Turkish label>"}
  ],
  "suggestion": "<10-15 token Turkish actionable suggestion for this pair>",
  "breakdown": {
    "<cat1>": <number 0-100>,
    "<cat2>": <number 0-100>,
    "<cat3>": <number 0-100>,
    "<cat4>": <number 0-100>
  }
}

Breakdown categories by relation type:
- romantic: Tutku, İletişim, Güven, Enerji
- family: Bağlılık, İletişim, Anlayış, Enerji
- friendship: Eğlence, İletişim, Güven, Enerji
- business: Liderlik, İletişim, Güven, Vizyon

Scoring rules:
- Base ALL scores on the actual synastry aspects and composite placements provided — do not invent or assume aspects
- Harmonious aspects (trines, sextiles, benefic conjunctions) increase relevant category scores
- Challenging aspects (squares, oppositions, malefic conjunctions) decrease relevant category scores
- Venus/Mars aspects heavily influence Tutku (romantic) or Eğlence (friendship)
- Mercury aspects heavily influence İletişim
- Saturn aspects heavily influence Güven/Bağlılık
- Sun/Moon/Jupiter aspects influence Enerji/Vizyon
- overallScore = weighted average of breakdown (weight first two categories at 0.3 each, last two at 0.2 each)
- Tags should reflect the 2-3 strongest themes from the actual aspects
- Scores should range 55-100, lean optimistic — perfect harmony is possible

Language & tone rules:
- Write ALL Turkish text with correct Turkish characters (ç, ş, ğ, ı, ö, ü, İ). Never use c for ç, s for ş, g for ğ, i for ı, etc.
- Adapt tone to relation type:
  - romantic: warm, passionate, intimate (e.g. "aranızdaki çekim", "tutkulu bir bağ")
  - family: nurturing, respectful, grounded (e.g. "aile bağlarınız", "köklü bir anlayış")
  - friendship: fun, lighthearted, supportive (e.g. "keyifli bir uyum", "birlikte güçlüsünüz")
  - business: professional, strategic, confident (e.g. "iş birliği potansiyeliniz", "güçlü bir vizyon")`;

  const cfg = { model: "gpt-4o-mini", max_output_tokens: 500, temperature: 0.7 };

  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await callOpenAI(env, cfg, system, user);
    if (out?.error) return json({ error: out.error, details: out.raw }, out.status || 500);

    try {
      result = parseRelationshipJSON(out.text);
      break;
    } catch (e) {
      if (attempt === 1) {
        return json({ error: "Failed to parse AI response", detail: e.message, raw: out.text }, 502);
      }
      // retry once
    }
  }

  // Cache in KV (permanent, no TTL)
  if (env.NATAL_ANALYSIS_KV) {
    try {
      await env.NATAL_ANALYSIS_KV.put(cacheKey, JSON.stringify(result));
    } catch (_) { /* ignore KV write errors */ }
  }

  return json(result);
}

function buildNatalAnalysisKey(body) {
  const lat = Number(body.latitude).toFixed(4);
  const lon = Number(body.longitude).toFixed(4);
  const locale = pickLocale(body.lang);
  return `natal-analysis:${body.year}-${body.month}-${body.day}-${body.hour}-${body.minute}-${body.tzOffsetMinutes}-${lat}-${lon}:${locale}`;
}

function parseAnalysisJSON(text) {
  let cleaned = text.trim();
  // Strip markdown code fences if present
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const parsed = JSON.parse(cleaned);
  const KEYS = ["coreTheme", "strengths", "challenges", "loveRelationships", "careerPurpose", "spiritualPath"];
  for (const k of KEYS) {
    if (typeof parsed[k] !== "string" || !parsed[k].trim()) {
      throw new Error(`Missing or empty key: ${k}`);
    }
  }
  const result = {};
  for (const k of KEYS) result[k] = parsed[k];
  return result;
}

async function handleNatalAnalysis(request, env) {
  if (request.method !== "POST") {
    return text("Send JSON birth data with POST to this endpoint", 405);
  }

  const body = await request.json();

  const needed = ["year", "month", "day", "hour", "minute", "tzOffsetMinutes", "latitude", "longitude"];
  for (const k of needed) {
    if (body[k] === undefined) {
      return json({ error: `Missing: ${k}` }, 400);
    }
  }

  const locale = pickLocale(body.lang);
  const cacheKey = buildNatalAnalysisKey(body);

  // Check KV cache
  if (env.NATAL_ANALYSIS_KV) {
    try {
      const cached = await env.NATAL_ANALYSIS_KV.get(cacheKey, "json");
      if (cached) return json(cached);
    } catch (_) { /* ignore KV errors, fall through */ }
  }

  const chart = computeNatal(body);
  const chartFacts = buildChartFacts(chart);
  if (!chartFacts) return json({ error: "Failed to compute chart facts" }, 500);

  const system = [
    "You are an expert astrologer writing detailed, personal natal chart analyses for a premium astrology app.",
    "Speak directly to the user (e.g. 'your Venus in Libra means...').",
    `Language/locale: ${locale}`,
    "Tone: warm, insightful, grounded. No emojis. No disclaimers.",
  ].join("\n");

  const user = [
    "Chart facts:",
    chartFacts,
    "",
    "Write a detailed natal analysis as valid JSON with EXACTLY these 6 keys, each ~80 words:",
    '- "coreTheme": central narrative / soul\'s purpose',
    '- "strengths": natural talents from harmonious placements',
    '- "challenges": tensions, squares, oppositions',
    '- "loveRelationships": Venus, Mars, 7th house, Moon dynamics',
    '- "careerPurpose": MC, Saturn, 10th house, Sun dynamics',
    '- "spiritualPath": Neptune, 12th house, North Node insights',
    "",
    "Return ONLY valid JSON. No markdown. No extra keys.",
  ].join("\n");

  const cfg = { model: "gpt-4o-mini", max_output_tokens: 1200, temperature: 0.8 };
  const out = await callOpenAI(env, cfg, system, user);
  if (out?.error) return json({ error: out.error, details: out.raw }, out.status || 500);

  let analysis;
  try {
    analysis = parseAnalysisJSON(out.text);
  } catch (e) {
    return json({ error: "Failed to parse AI response", detail: e.message, raw: out.text }, 502);
  }

  // Store in KV (fire-and-forget, don't block response)
  if (env.NATAL_ANALYSIS_KV) {
    try {
      await env.NATAL_ANALYSIS_KV.put(cacheKey, JSON.stringify(analysis));
    } catch (_) { /* ignore KV write errors */ }
  }

  return json(analysis);
}

function formatTarotCards(cards, spreadType) {
  const positions = SPREAD_POSITIONS[spreadType];
  return cards
    .map((c, i) => {
      const rev = c.reversed ? " (Reversed)" : "";
      return `Position ${i + 1} (${positions[i]}): ${c.name}${rev}`;
    })
    .join("\n");
}

function parseTarotJSON(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const parsed = JSON.parse(cleaned);

  if (typeof parsed.reading !== "string" || !parsed.reading.trim()) {
    throw new Error("reading must be a non-empty string");
  }
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    throw new Error("summary must be a non-empty string");
  }
  if (!Array.isArray(parsed.cards)) {
    throw new Error("cards must be an array");
  }
  for (const card of parsed.cards) {
    if (typeof card.name !== "string" || !card.name.trim()) {
      throw new Error("Each card must have a non-empty name");
    }
    if (typeof card.reversed !== "boolean") {
      throw new Error("Each card must have a boolean reversed field");
    }
    if (typeof card.positionLabel !== "string" || !card.positionLabel.trim()) {
      throw new Error("Each card must have a non-empty positionLabel");
    }
    if (typeof card.interpretation !== "string" || !card.interpretation.trim()) {
      throw new Error("Each card must have a non-empty interpretation");
    }
  }

  return {
    reading: parsed.reading,
    summary: parsed.summary,
    cards: parsed.cards.map((c) => ({
      name: c.name,
      reversed: c.reversed,
      positionLabel: c.positionLabel,
      interpretation: c.interpretation,
    })),
  };
}

async function handleTarot(request, env) {
  if (request.method !== "POST") {
    return text("Send JSON with POST to this endpoint", 405);
  }

  const body = await request.json();
  const { spreadType, cards, question } = body;

  if (!spreadType || !VALID_SPREAD_TYPES.includes(spreadType)) {
    return json({ error: `spreadType must be one of: ${VALID_SPREAD_TYPES.join(", ")}` }, 400);
  }

  const expectedCount = SPREAD_CARD_COUNTS[spreadType];
  if (!Array.isArray(cards) || cards.length !== expectedCount) {
    return json({ error: `${spreadType} spread requires exactly ${expectedCount} card(s)` }, 400);
  }

  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (!c || typeof c.name !== "string" || !c.name.trim()) {
      return json({ error: `cards[${i}] must have a non-empty name` }, 400);
    }
    if (typeof c.reversed !== "boolean") {
      return json({ error: `cards[${i}].reversed must be a boolean` }, 400);
    }
  }

  const locale = pickLocale(body.lang);
  const formattedCards = formatTarotCards(cards, spreadType);

  const toneMap = {
    yes_no: "direct and clear",
    three_card: "narrative and flowing",
    love: "warm and romantic",
    career: "professional and strategic",
    celtic_cross: "deep and comprehensive",
  };
  const tone = toneMap[spreadType];

  const langInstruction = locale === "en-US"
    ? "Write entirely in English."
    : locale === "tr-TR"
      ? "Write entirely in Turkish with correct Turkish characters (ç, ş, ğ, ı, ö, ü, İ)."
      : locale === "de-DE"
        ? "Write entirely in German."
        : locale === "fr-FR"
          ? "Write entirely in French."
          : "Write entirely in English.";

  const system = [
    "You are an expert tarot reader providing insightful, personal readings.",
    langInstruction,
    "Tone: calm, premium, grounded. No emojis. No disclaimers.",
  ].join("\n");

  const questionLine = question && typeof question === "string" && question.trim()
    ? `\nThe querent's question: "${question.trim()}"\nAddress this question directly in your reading.`
    : "";

  const user = [
    `Spread type: ${spreadType}`,
    `Tone: ${tone}`,
    "",
    "Cards drawn:",
    formattedCards,
    questionLine,
    "",
    "Return ONLY valid JSON with this exact structure, no markdown, no preamble:",
    "",
    "{",
    '  "reading": "<250-300 word reading split into 2-3 short paragraphs separated by \\n\\n>",',
    '  "summary": "<1-2 sentence summary of the overall message>",',
    '  "cards": [',
    "    {",
    '      "name": "<card name>",',
    '      "reversed": <true/false>,',
    '      "positionLabel": "<position label>",',
    '      "interpretation": "<2-3 sentence interpretation for this position>"',
    "    }",
    "  ]",
    "}",
    "",
    `The cards array must have exactly ${expectedCount} element(s), matching the positions: ${SPREAD_POSITIONS[spreadType].join(", ")}.`,
    "Each card's positionLabel must match the position labels above exactly.",
  ].join("\n");

  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await callOpenAI(env, TAROT_CFG, system, user);
    if (out?.error) return json({ error: out.error, details: out.raw }, out.status || 500);

    try {
      result = parseTarotJSON(out.text);
      break;
    } catch (e) {
      if (attempt === 1) {
        return json({ error: "Failed to parse AI response", detail: e.message, raw: out.text }, 502);
      }
    }
  }

  return json(result);
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/" || url.pathname === "/natal") {
        return await handleNatal(request);
      }

      if (url.pathname === "/composite") {
        return await handleComposite(request);
      }

      if (url.pathname === "/ai") {
        return await handleAI(request, env);
      }

      if (url.pathname === "/natal-analysis") {
        return await handleNatalAnalysis(request, env);
      }

      if (url.pathname === "/natal-chat") {
        return await handleNatalChat(request, env);
      }

      if (url.pathname === "/relationship-score") {
        return await handleRelationshipScore(request, env);
      }

      if (url.pathname === "/tarot") {
        return await handleTarot(request, env);
      }

      return json({ error: "Not found", path: url.pathname }, 404);
    } catch (err) {
      console.error("API error:", err);
      return json(
        { error: "Internal error", message: err?.message, stack: err?.stack },
        500
      );
    }
  },
};