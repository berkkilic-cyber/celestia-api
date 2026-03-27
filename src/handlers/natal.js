// src/handlers/natal.js
import { computeNatal } from '../natal-core.js';
import { buildChartFacts } from '../lib/chart.js';
import { callLlama } from '../lib/llama.js';
import { pickLocale } from '../lib/locale.js';

const BIRTH_FIELDS = ['year', 'month', 'day', 'hour', 'minute', 'tzOffsetMinutes', 'latitude', 'longitude'];
const CHAT_CFG = { model: 'llama-3.1-8b-instant', max_output_tokens: 1000, temperature: 0.8 };
const ANALYSIS_CFG = { model: 'llama-3.1-8b-instant', max_output_tokens: 800, temperature: 0.7 };

// ─── /natal ──────────────────────────────────────────────────────────────────

export async function handleNatal(request) {
	const body = await request.json();
	for (const k of BIRTH_FIELDS) {
		if (body[k] === undefined) return { error: `Missing: ${k}`, status: 400 };
	}
	return { data: computeNatal(body) };
}

// ─── /natal-analysis ─────────────────────────────────────────────────────────

export function buildAnalysisCacheKey(body, locale) {
	const lat = Number(body.latitude).toFixed(4);
	const lon = Number(body.longitude).toFixed(4);
	return `natal-analysis:${body.year}-${body.month}-${body.day}-${body.hour}-${body.minute}-${body.tzOffsetMinutes}-${lat}-${lon}:${locale}`;
}

function parseAnalysisJSON(text) {
	console.log('[NATAL-ANALYSIS-DEBUG] Raw response length:', text?.length);
	console.log('[NATAL-ANALYSIS-DEBUG] First 500 chars:', text?.substring(0, 500));
	console.log('[NATAL-ANALYSIS-DEBUG] Last 200 chars:', text?.substring(Math.max(0, text.length - 200)));

	// Try to extract JSON from the response (handle text before/after JSON)
	let jsonStr = text.trim();
	
	// Remove code blocks if present
	jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
	
	// Try to find JSON object in the text (in case there's extra text)
	const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		jsonStr = jsonMatch[0];
		console.log('[NATAL-ANALYSIS-DEBUG] Extracted JSON from text');
	}

	console.log('[NATAL-ANALYSIS-DEBUG] Attempting to parse:', jsonStr.substring(0, 200) + '...');

	let parsed;
	try {
		parsed = JSON.parse(jsonStr);
	} catch (parseErr) {
		console.error('[NATAL-ANALYSIS-DEBUG] JSON parse failed:', parseErr.message);
		throw new Error(`Invalid JSON: ${parseErr.message}`);
	}

	console.log('[NATAL-ANALYSIS-DEBUG] Parsed successfully. Keys:', Object.keys(parsed));

	const KEYS = ['coreTheme', 'strengths', 'challenges', 'loveRelationships', 'careerPurpose', 'spiritualPath'];
	for (const k of KEYS) {
		const value = parsed[k];
		console.log(`[NATAL-ANALYSIS-DEBUG] Checking key "${k}": type=${typeof value}, length=${value?.length}, empty=${!value?.trim?.()}`);
		if (typeof value !== 'string' || !value.trim()) {
			console.error(`[NATAL-ANALYSIS-DEBUG] MISSING OR EMPTY KEY: ${k} (value: "${value}")`);
			throw new Error(`Missing or empty key: ${k}`);
		}
	}
	
	console.log('[NATAL-ANALYSIS-DEBUG] All keys validated successfully');
	return Object.fromEntries(KEYS.map((k) => [k, parsed[k]]));
}

export async function handleNatalAnalysis(request, env) {
	const body = await request.json();
	for (const k of BIRTH_FIELDS) {
		if (body[k] === undefined) return { error: `Missing: ${k}`, status: 400 };
	}

	const locale = pickLocale(body.lang);
	const cacheKey = buildAnalysisCacheKey(body, locale);

	// KV cache hit
	try {
		const cached = await env.NATAL_ANALYSIS_KV.get(cacheKey, 'json');
		if (cached) return { data: cached };
	} catch (_) {}

	const chart = computeNatal(body);
	const chartFacts = buildChartFacts(chart);
	if (!chartFacts) return { error: 'Failed to compute chart facts', status: 500 };

	const langInstruction = {
		'tr-TR': 'Write entirely in Turkish with correct Turkish characters (ç, ş, ğ, ı, ö, ü, İ). Use a warm, intimate Turkish phrases that feel personal and grounded. Honor the depth of Turkish astrological tradition.',
		'de-DE': 'Write entirely in German with precise, grounded language. German astrology values clarity and thoughtfulness—be specific and substantive. Use "du" form to speak directly and warmly to the person.',
		'fr-FR': 'Write entirely in French with elegance and poetic warmth. French astrology values nuance and connection—weave in personal resonance. Speak directly with "tu" form, maintaining intimacy.',
		'en': 'Write entirely in English. Use warm, accessible language that feels conversational yet wise. Speak directly with "you," creating a tone of intimate guidance.',
	}[locale] || 'Write entirely in English. Use warm, accessible language that feels conversational yet wise. Speak directly with "you," creating a tone of intimate guidance.';

	const system = [
		'You are a warm astrologer writing personal natal chart analysis.',
		"Speak directly to the person. Your tone is intimate and encouraging.",
		langInstruction,
		'Respond ONLY with valid JSON—no extra text, no explanation, no markdown.',
	].join('\n');

	const user = [
		'RESPOND WITH ONLY VALID JSON. NO OTHER TEXT.',
		'',
		'{',
		'  "coreTheme": "Their central life purpose (50-60 words)",',
		'  "strengths": "Natural talents and gifts (50-60 words)",',
		'  "challenges": "Growth edges presented as evolution (50-60 words)",',
		'  "loveRelationships": "Love patterns and needs (50-60 words)",',
		'  "careerPurpose": "Vocational calling (50-60 words)",',
		'  "spiritualPath": "Spiritual potential (50-60 words)"',
		'}',
		'',
		'Chart data:',
		chartFacts,
		'',
		'Rules: Speak directly using "your". Ground in chart placements. Personal tone. Warm voice.',
	].join('\n');

	const out = await callLlama(env, ANALYSIS_CFG, system, user);
	
	console.log('[NATAL-ANALYSIS] API Response:', {
		error: out?.error,
		hasText: !!out?.text,
		textLength: out?.text?.length,
		first300: out?.text?.substring(0, 300),
		last100: out?.text?.substring(Math.max(0, out?.text?.length - 100)),
	});

	if (out?.error) {
		console.error('[NATAL-ANALYSIS] API Error:', out.error);
		return { error: out.error, details: out.raw, status: out.status || 500 };
	}

	let analysis;
	try {
		analysis = parseAnalysisJSON(out.text);
		console.log('[NATAL-ANALYSIS] ✓ Successfully parsed all keys');
	} catch (e) {
		console.error('[NATAL-ANALYSIS] ✗ Parse failed:', e.message);
		return { error: 'Failed to parse AI response', detail: e.message, fullOutput: out.text, status: 502 };
	}

	// Cache permanently (birth chart doesn't change)
	try {
		await env.NATAL_ANALYSIS_KV.put(cacheKey, JSON.stringify(analysis));
	} catch (_) {}

	return { data: analysis };
}

// ─── /natal-chat ─────────────────────────────────────────────────────────────

function buildChatSystemPrompt(chartFacts, locale) {
	const langInstruction = {
		'tr-TR': 'Write entirely in Turkish with correct Turkish characters (ç, ş, ğ, ı, ö, ü, İ). Use warm, intimate Turkish language that honors the spiritual depth. Speak with the familiarity and care of someone who truly knows them.',
		'de-DE': 'Write entirely in German with precision and thoughtful clarity. German astrology values substantive insight—be specific and grounded. Use "du" to create warmth and directness.',
		'fr-FR': 'Write entirely in French with poetic elegance and personal warmth. French astrology values nuance and soul connection—incorporate this into your language. Use "tu" form for intimacy.',
		'en': 'Write entirely in English with conversational warmth and wisdom. Speak directly with "you," creating a tone of intimate mentorship.',
	}[locale] || 'Write entirely in English with conversational warmth and wisdom. Speak directly with "you," creating a tone of intimate mentorship.';

	return [
		'You are a warm, wise astrologer in a deep conversation with someone you care about.',
		'You know their natal chart intimately and speak to their authentic self.',
		'Your role is to illuminate, encourage, and help them understand their path.',
		'',
		'Their natal chart:',
		chartFacts,
		'',
		langInstruction,
		'',
		'Guidelines for your voice:',
		'- Deeply personal and compassionate, like a trusted mentor',
		'- 80-150 words per reply—thoughtful, not rushed',
		'- Reference specific placements (sign, house, degree) naturally, not superficially',
		'- Balance insight with encouragement; frame challenges as growth opportunities',
		'- Use their language and meet them where they are emotionally',
		'- No generic advice. Every response should feel written for them alone',
		'- Never apologize for astrology or disclaim its value',
		'- Ask clarifying questions if needed to give them what they truly need',
	].join('\n');
}

export async function handleNatalChat(request, env) {
	const body = await request.json();

	const message = body.message;
	if (!message?.trim()) return { error: 'Missing or empty message', status: 400 };
	if (message.length > 2000) return { error: 'Message too long (max 2000 characters)', status: 400 };
	if (!body.chart) return { error: 'Missing: chart', status: 400 };

	const chartFacts = buildChartFacts(body.chart);
	if (!chartFacts) return { error: 'Invalid chart object', status: 400 };

	const locale = pickLocale(body.lang);
	const systemPrompt = buildChatSystemPrompt(chartFacts, locale);

	const out = await callLlama(env, CHAT_CFG, systemPrompt, message.trim());
	if (out?.error) return { error: out.error, details: out.raw, status: out.status || 500 };

	return { data: { reply: out.text } };
}
