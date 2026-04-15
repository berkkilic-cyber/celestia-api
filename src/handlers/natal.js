// src/handlers/natal.js
import { computeNatal } from '../natal-core.js';
import { buildChartFacts } from '../lib/chart.js';
// import { callLlama } from '../lib/llama.js';
import { callOpenAI } from '../lib/openai.js';
import { pickLocale } from '../lib/locale.js';
import { natalAnalysisPrompt, natalChatSystemPrompt } from '../prompts.js';

const BIRTH_FIELDS = ['year', 'month', 'day', 'hour', 'minute', 'tzOffsetMinutes', 'latitude', 'longitude'];
// const CHAT_CFG = { model: 'llama-3.1-8b-instant', max_output_tokens: 1000, temperature: 0.8 };
// const ANALYSIS_CFG = { model: 'llama-3.1-8b-instant', max_output_tokens: 800, temperature: 0.7 };
const CHAT_CFG = { model: 'gpt-4o-mini', max_output_tokens: 1000, temperature: 0.8 };
const ANALYSIS_CFG = { model: 'gpt-4o-mini', max_output_tokens: 1200, temperature: 0.7 };

// ─── /natal ──────────────────────────────────────────────────────────────────

export async function handleNatal(request) {
	const body = await request.json();
	for (const k of BIRTH_FIELDS) {
		if (body[k] === undefined) return { error: `Missing: ${k}`, status: 400 };
	}
	return { data: computeNatal(body) };
}

// ─── /natal-analysis ─────────────────────────────────────────────────────────

export function buildAnalysisCacheKey(userId, locale) {
	return `natal-analysis:${userId}:${locale}`;
}

export function buildBirthSignature(body) {
	const lat = Number(body.latitude).toFixed(4);
	const lon = Number(body.longitude).toFixed(4);
	return `${body.year}-${body.month}-${body.day}-${body.hour}-${body.minute}-${body.tzOffsetMinutes}-${lat}-${lon}`;
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

	const KEYS = ['coreTheme', 'strengths', 'challenges', 'loveRelationships', 'careerPurpose', 'moneyAndFame'];
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

	const chart = computeNatal(body);
	const chartFacts = buildChartFacts(chart);
	if (!chartFacts) return { error: 'Failed to compute chart facts', status: 500 };

	const { system, user } = natalAnalysisPrompt({ chartFacts, locale });

	const out = await callOpenAI(env, ANALYSIS_CFG, system, user);

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


	return { data: analysis };
}

// ─── /natal-chat ─────────────────────────────────────────────────────────────

export async function handleNatalChat(request, env) {
	const body = await request.json();

	const message = body.message;
	if (!message?.trim()) return { error: 'Missing or empty message', status: 400 };
	if (message.length > 2000) return { error: 'Message too long (max 2000 characters)', status: 400 };
	if (!body.chart) return { error: 'Missing: chart', status: 400 };

	const chartFacts = buildChartFacts(body.chart);
	if (!chartFacts) return { error: 'Invalid chart object', status: 400 };

	const locale = pickLocale(body.lang);
	const systemPrompt = natalChatSystemPrompt({ chartFacts, locale });

	const out = await callOpenAI(env, CHAT_CFG, systemPrompt, message.trim());
	if (out?.error) return { error: out.error, details: out.raw, status: out.status || 500 };

	return { data: { reply: out.text } };
}
