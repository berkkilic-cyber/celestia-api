// src/handlers/relationship.js
import { callOpenAI } from "../lib/openai.js";
import { buildChartFacts, formatSynastryAspects } from "../lib/chart.js";

const VALID_RELATION_TYPES = ["romantic", "family", "friendship", "business"];
const CFG = { model: "gpt-4o-mini", max_output_tokens: 500, temperature: 0.7 };

function buildCacheKey(person1, person2, relationType) {
  const personStr = (p) => {
    const bd = p.birthData;
    return `${bd.year}-${bd.month}-${bd.day}-${bd.hour}-${bd.minute}-${bd.tzOffsetMinutes}-${Number(bd.latitude).toFixed(4)}-${Number(bd.longitude).toFixed(4)}`;
  };
  const sorted = [personStr(person1), personStr(person2)].sort();
  return `relationship-score:${relationType}:${sorted[0]}:${sorted[1]}`;
}

function parseResponse(text) {
  let cleaned = text.trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");
  const parsed = JSON.parse(cleaned);

  if (typeof parsed.overallScore !== "number" || parsed.overallScore < 0 || parsed.overallScore > 100)
    throw new Error("overallScore must be a number 0-100");
  if (typeof parsed.generalText !== "string" || !parsed.generalText.trim())
    throw new Error("generalText must be a non-empty string");
  if (!Array.isArray(parsed.tags) || parsed.tags.length !== 3)
    throw new Error("tags must be an array of 3 objects");
  for (const tag of parsed.tags) {
    if (typeof tag.emoji !== "string" || typeof tag.label !== "string")
      throw new Error("Each tag must have emoji and label strings");
  }
  if (typeof parsed.suggestion !== "string" || !parsed.suggestion.trim())
    throw new Error("suggestion must be a non-empty string");
  if (typeof parsed.breakdown !== "object" || parsed.breakdown === null)
    throw new Error("breakdown must be an object");
  const vals = Object.values(parsed.breakdown);
  if (vals.length !== 4 || !vals.every((v) => typeof v === "number"))
    throw new Error("breakdown must have exactly 4 numeric values");

  return {
    overallScore: parsed.overallScore,
    generalText: parsed.generalText,
    tags: parsed.tags.map((t) => ({ emoji: t.emoji, label: t.label })),
    suggestion: parsed.suggestion,
    breakdown: parsed.breakdown,
  };
}

export async function handleRelationshipScore(request, env) {
  const body = await request.json();
  const { relationType, person1, person2, compositeChart, synastryAspects } = body;

  if (!relationType || !VALID_RELATION_TYPES.includes(relationType))
    return { error: "relationType must be one of: romantic, family, friendship, business", status: 400 };
  if (!person1?.name || !person1?.birthData || !person1?.chart)
    return { error: "person1 must include name, birthData, and chart", status: 400 };
  if (!person2?.name || !person2?.birthData || !person2?.chart)
    return { error: "person2 must include name, birthData, and chart", status: 400 };
  if (!compositeChart)
    return { error: "Missing compositeChart", status: 400 };
  if (!Array.isArray(synastryAspects))
    return { error: "synastryAspects must be an array", status: 400 };

  // KV cache
  const cacheKey = buildCacheKey(person1, person2, relationType);
  try {
    const cached = await env.NATAL_ANALYSIS_KV.get(cacheKey, "json");
    if (cached) return { data: cached };
  } catch (_) {}

  const system = "You are an expert astrologer.";
  const user = `Analyze the provided synastry aspects and composite chart to generate a relationship compatibility reading.

Relation type: ${relationType}

Person 1 (${person1.name}): ${buildChartFacts(person1.chart)}

Person 2 (${person2.name}): ${buildChartFacts(person2.chart)}

Composite chart: ${buildChartFacts(compositeChart)}

Synastry aspects: ${formatSynastryAspects(synastryAspects)}

Return ONLY valid JSON with this exact structure, no markdown, no preamble:
{
  "overallScore": <number 0-100>,
  "generalText": "<30-40 token Turkish text summarizing harmony based on actual aspects>",
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
- romantic:   Tutku, İletişim, Güven, Enerji
- family:     Bağlılık, İletişim, Anlayış, Enerji
- friendship: Eğlence, İletişim, Güven, Enerji
- business:   Liderlik, İletişim, Güven, Vizyon

Scoring: base ALL scores on actual synastry aspects. Scores range 55-100.
overallScore = weighted average (first two categories 0.3 each, last two 0.2 each).
Write ALL text in correct Turkish (ç, ş, ğ, ı, ö, ü, İ).`;

  let result;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await callOpenAI(env, CFG, system, user);
    if (out?.error) return { error: out.error, details: out.raw, status: out.status || 500 };
    try { result = parseResponse(out.text); break; }
    catch (e) {
      if (attempt === 1) return { error: "Failed to parse AI response", detail: e.message, status: 502 };
    }
  }

  // Cache permanently
  try { await env.NATAL_ANALYSIS_KV.put(cacheKey, JSON.stringify(result)); } catch (_) {}

  return { data: result };
}
