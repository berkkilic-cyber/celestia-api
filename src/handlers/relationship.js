// src/handlers/relationship.js
import { callLlama } from '../lib/llama.js';
import { buildChartFacts, formatSynastryAspects } from '../lib/chart.js';
import { pickLocale } from '../lib/locale.js';

const VALID_RELATION_TYPES = ['romantic', 'family', 'friendship', 'business'];
const CFG = { model: 'llama-3.1-8b-instant', max_output_tokens: 500, temperature: 0.7 };
const CHAT_CFG = { model: 'llama-3.1-8b-instant', max_output_tokens: 1000, temperature: 0.8 };

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
	const { relationType, person1, person2, compositeChart, synastryAspects } = body;

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

	const system =
		'You are a warm, compassionate astrologer reading the dynamics between two souls. You honor both their gifts and growth edges, seeing relationships as sacred mirrors for evolution.';
	const user = `Analyze the synastry aspects and composite chart for this relationship with warmth and truth.

Relationship type: ${relationType}

${person1.name}\'s chart: ${buildChartFacts(person1.chart)}

${person2.name}\'s chart: ${buildChartFacts(person2.chart)}

Composite chart (the relationship itself): ${buildChartFacts(compositeChart)}

Synastry aspects (how they ignite each other): ${formatSynastryAspects(synastryAspects)}

Create a beautiful, honest relationship reading as JSON with this structure:
{
  "overallScore": <number 0-100 representing the relationship's potential and harmony>,
  "generalText": "<30-40 words in Turkish capturing the essence of their dynamic and what makes it special>",
  "tags": [
    {"emoji": "<1 emoji>", "label": "<1-2 word Turkish label for a key relationship strength or theme>"},
    {"emoji": "<1 emoji>", "label": "<1-2 word Turkish label>"},
    {"emoji": "<1 emoji>", "label": "<1-2 word Turkish label>"}
  ],
  "suggestion": "<10-15 words of Turkish wisdom—what this pair should know or do to nurture their bond>",
  "breakdown": {
    "<area1>": <0-100>,
    "<area2>": <0-100>,
    "<area3>": <0-100>,
    "<area4>": <0-100>
  }
}

Scoring guidelines:
- Ground ALL scores in actual synastry aspects and composite chart placements
- Range: 55-100 (relationships have inherent value)
- overallScore = weighted average: first two categories × 0.3 each, last two × 0.2 each
- Share honest insights—strengths AND growth edges

Breakdown categories by relationship type:
- romantic:   Passion & Attraction, Communication, Trust & Vulnerability, Shared Energy
- family:     Loyalty & Bonds, Communication, Understanding, Shared Energy
- friendship: Fun & Connection, Communication, Trust, Shared Energy
- business:   Leadership & Vision, Communication, Trust & Reliability, Synergy

Write ALL text in beautiful, correct Turkish (ç, ş, ğ, ı, ö, ü, İ).
No markdown. Valid JSON only.`;

	let result;
	for (let attempt = 0; attempt < 2; attempt++) {
		const out = await callLlama(env, CFG, system, user);
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

function buildRelationshipChatPrompt(compositeChartFacts, synastryFacts, relationType, locale) {
	const langInstruction = {
		'tr-TR': 'Write entirely in Turkish with correct Turkish characters (ç, ş, ğ, ı, ö, ü, İ). Use warm, intimate Turkish language that honors the spiritual depth. Speak with the familiarity and care of someone who truly knows them.',
		'de-DE': 'Write entirely in German with precision and thoughtful clarity. German astrology values substantive insight—be specific and grounded. Use "du" to create warmth and directness.',
		'fr-FR': 'Write entirely in French with poetic elegance and personal warmth. French astrology values nuance and soul connection—incorporate this into your language. Use "tu" form for intimacy.',
		'en': 'Write entirely in English with conversational warmth and wisdom. Speak directly with "you," creating a tone of intimate mentorship.',
	}[locale] || 'Write entirely in English with conversational warmth and wisdom. Speak directly with "you," creating a tone of intimate mentorship.';

	return [
		'You are a warm, wise relationship astrologer guiding someone about their connection with another person.',
		'You read their composite chart and synastry aspects with deep insight and compassion.',
		'You see relationships as sacred mirrors for growth and evolution.',
		'',
		`Relationship type: ${relationType}`,
		'',
		'Composite chart (the relationship itself):',
		compositeChartFacts,
		'',
		synastryFacts ? `Synastry aspects:\n${synastryFacts}` : '',
		'',
		langInstruction,
		'',
		'Guidelines for your voice:',
		'- Deeply personal and compassionate, like a trusted relationship counselor',
		'- 80-150 words per reply—thoughtful, not rushed',
		'- Reference specific composite placements and synastry aspects naturally',
		'- Balance honesty with encouragement; frame challenges as growth opportunities for the pair',
		'- Focus on the dynamic between the two people, not individual charts',
		'- No generic advice. Every response should feel written for this specific pair',
		'- Never apologize for astrology or disclaim its value',
	].join('\n');
}

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
	const systemPrompt = buildRelationshipChatPrompt(compositeChartFacts, synastryFacts, relationType, locale);

	const out = await callLlama(env, CHAT_CFG, systemPrompt, message.trim());
	if (out?.error) return { error: out.error, details: out.raw, status: out.status || 500 };

	return { data: { reply: out.text } };
}
