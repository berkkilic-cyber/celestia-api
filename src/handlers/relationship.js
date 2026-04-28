// src/handlers/relationship.js
// import { callLlama } from '../lib/llama.js';
import { callOpenAI } from '../lib/openai.js';
import { buildChartFacts, formatSynastryAspects } from '../lib/chart.js';
import { pickLocale } from '../lib/locale.js';
import { relationshipScorePrompt, relationshipChatSystemPrompt } from '../prompts.js';

const VALID_RELATION_TYPES = ['romantic', 'family', 'friendship', 'business'];
// const CFG = { model: 'llama-3.1-8b-instant', max_output_tokens: 500, temperature: 0.7 };
// const CHAT_CFG = { model: 'llama-3.1-8b-instant', max_output_tokens: 1000, temperature: 0.8 };
const CFG = { model: 'gpt-4o-mini', max_output_tokens: 500, temperature: 0.7 };
const CHAT_CFG = { model: 'gpt-4o-mini', max_output_tokens: 1000, temperature: 0.8 };

function buildCacheKey(person1, person2, relationType) {
	const personStr = (p) => {
		const bd = p.birthData;
		return `${bd.year}-${bd.month}-${bd.day}-${bd.hour}-${bd.minute}-${bd.tzOffsetMinutes}-${Number(bd.latitude).toFixed(4)}-${Number(bd.longitude).toFixed(4)}`;
	};
	const sorted = [personStr(person1), personStr(person2)].sort();
	return `relationship-score:${relationType}:${sorted[0]}:${sorted[1]}`;
}

function parseResponse(text) {
	let cleaned = text
		.trim()
		.replace(/^```(?:json)?\s*\n?/i, '')
		.replace(/\n?```\s*$/i, '');
	const parsed = JSON.parse(cleaned);

	if (typeof parsed.overallScore !== 'number' || parsed.overallScore < 0 || parsed.overallScore > 100)
		throw new Error('overallScore must be a number 0-100');
	if (typeof parsed.generalText !== 'string' || !parsed.generalText.trim()) throw new Error('generalText must be a non-empty string');
	if (!Array.isArray(parsed.tags) || parsed.tags.length !== 3) throw new Error('tags must be an array of 3 objects');
	for (const tag of parsed.tags) {
		if (typeof tag.emoji !== 'string' || typeof tag.label !== 'string') throw new Error('Each tag must have emoji and label strings');
	}
	if (typeof parsed.suggestion !== 'string' || !parsed.suggestion.trim()) throw new Error('suggestion must be a non-empty string');
	if (typeof parsed.breakdown !== 'object' || parsed.breakdown === null) throw new Error('breakdown must be an object');
	const vals = Object.values(parsed.breakdown);
	if (vals.length !== 4 || !vals.every((v) => typeof v === 'number')) throw new Error('breakdown must have exactly 4 numeric values');

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
	const { relationType, person1, person2, compositeChart, synastryAspects, lang } = body;
	const locale = pickLocale(lang);

	if (!relationType || !VALID_RELATION_TYPES.includes(relationType))
		return { error: 'relationType must be one of: romantic, family, friendship, business', status: 400 };
	if (!person1?.name || !person1?.birthData || !person1?.chart)
		return { error: 'person1 must include name, birthData, and chart', status: 400 };
	if (!person2?.name || !person2?.birthData || !person2?.chart)
		return { error: 'person2 must include name, birthData, and chart', status: 400 };
	if (!compositeChart) return { error: 'Missing compositeChart', status: 400 };
	if (!Array.isArray(synastryAspects)) return { error: 'synastryAspects must be an array', status: 400 };

	// KV cache
	const cacheKey = buildCacheKey(person1, person2, relationType);
	try {
		const cached = await env.NATAL_ANALYSIS_KV.get(cacheKey, 'json');
		if (cached) return { data: cached };
	} catch (_) {}

	const { system, user } = relationshipScorePrompt({
		relationType,
		person1Name: person1.name,
		person1ChartFacts: buildChartFacts(person1.chart),
		person2Name: person2.name,
		person2ChartFacts: buildChartFacts(person2.chart),
		compositeChartFacts: buildChartFacts(compositeChart),
		synastryFacts: formatSynastryAspects(synastryAspects),
		locale,
	});

	let result;
	for (let attempt = 0; attempt < 2; attempt++) {
		const out = await callOpenAI(env, CFG, system, user);
		if (out?.error) return { error: out.error, details: out.raw, status: out.status || 500 };
		try {
			result = parseResponse(out.text);
			break;
		} catch (e) {
			if (attempt === 1) return { error: 'Failed to parse AI response', detail: e.message, status: 502 };
		}
	}

	// Cache permanently
	try {
		await env.NATAL_ANALYSIS_KV.put(cacheKey, JSON.stringify(result));
	} catch (_) {}

	return { data: result };
}

// ─── /relationship-chat ─────────────────────────────────────────────────────

export async function handleRelationshipChat(request, env) {
	const body = await request.json();

	const message = body.message;
	if (!message?.trim()) return { error: 'Missing or empty message', status: 400 };
	if (message.length > 2000) return { error: 'Message too long (max 2000 characters)', status: 400 };
	if (!body.compositeChart) return { error: 'Missing: compositeChart', status: 400 };

	const relationType = body.relationType;
	if (!relationType || !VALID_RELATION_TYPES.includes(relationType))
		return { error: 'relationType must be one of: romantic, family, friendship, business', status: 400 };

	const compositeChartFacts = buildChartFacts(body.compositeChart);
	if (!compositeChartFacts) return { error: 'Invalid compositeChart object', status: 400 };

	const synastryFacts = Array.isArray(body.synastryAspects) ? formatSynastryAspects(body.synastryAspects) : null;

	const locale = pickLocale(body.lang);
	const systemPrompt = relationshipChatSystemPrompt({ compositeChartFacts, synastryFacts, relationType, locale });

	const out = await callOpenAI(env, CHAT_CFG, systemPrompt, message.trim());
	if (out?.error) return { error: out.error, details: out.raw, status: out.status || 500 };

	return { data: { reply: out.text } };
}
