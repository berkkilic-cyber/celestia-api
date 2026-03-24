// src/handlers/natal.js
import { computeNatal } from '../natal-core.js';
import { buildChartFacts } from '../lib/chart.js';
import { callLlama, callLlamaChat } from '../lib/llama.js';
import { pickLocale } from '../lib/locale.js';

const BIRTH_FIELDS = ['year', 'month', 'day', 'hour', 'minute', 'tzOffsetMinutes', 'latitude', 'longitude'];
const CHAT_SESSION_TTL = 86400; // 24 hours
const CHAT_CFG = { model: 'meta-llama/Llama-3.1-8b-instruct', max_output_tokens: 1000, temperature: 0.8 };
const ANALYSIS_CFG = { model: 'meta-llama/Llama-3.1-8b-instruct', max_output_tokens: 1200, temperature: 0.8 };

// ─── /natal ──────────────────────────────────────────────────────────────────

export async function handleNatal(request) {
	const body = await request.json();
	for (const k of BIRTH_FIELDS) {
		if (body[k] === undefined) return { error: `Missing: ${k}`, status: 400 };
	}
	return { data: computeNatal(body) };
}

// ─── /natal-analysis ─────────────────────────────────────────────────────────

function buildAnalysisCacheKey(body, locale) {
	const lat = Number(body.latitude).toFixed(4);
	const lon = Number(body.longitude).toFixed(4);
	return `natal-analysis:${body.year}-${body.month}-${body.day}-${body.hour}-${body.minute}-${body.tzOffsetMinutes}-${lat}-${lon}:${locale}`;
}

function parseAnalysisJSON(text) {
	let cleaned = text
		.trim()
		.replace(/^```(?:json)?\s*\n?/i, '')
		.replace(/\n?```\s*$/i, '');
	const parsed = JSON.parse(cleaned);
	const KEYS = ['coreTheme', 'strengths', 'challenges', 'loveRelationships', 'careerPurpose', 'spiritualPath'];
	for (const k of KEYS) {
		if (typeof parsed[k] !== 'string' || !parsed[k].trim()) throw new Error(`Missing or empty key: ${k}`);
	}
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

	const system = [
		'You are an expert astrologer writing deeply personal natal chart analyses.',
		"Your words feel like a warm hand on someone's shoulder—illuminating, not judging.",
		'Help them see themselves through the lens of their chart with loving clarity.',
		`Language/locale: ${locale}`,
		'Tone: intimate, wise, encouraging. No disclaimers or apologies for astrology.',
	].join('\n');

	const user = [
		'Chart facts:',
		chartFacts,
		'',
		'Write a detailed, personal natal analysis as valid JSON with EXACTLY these 6 keys (each ~80 words):',
		'- "coreTheme": their soul\'s central narrative, life purpose, and core gifts',
		'- "strengths": natural talents, harmonious placements, what comes easily to them',
		'- "challenges": growth edges, tensions, and how to work with them wisely',
		'- "loveRelationships": how they love, vulnerability patterns, what they seek in partnership',
		'- "careerPurpose": their vocational calling, work strengths, path to fulfillment',
		'- "spiritualPath": their spiritual gifts, inner growth potential, connection to something greater',
		'',
		'Guidelines:',
		'- Speak directly to them ("your Venus...", "your North Node...")',
		'- Ground everything in actual chart placements',
		'- Frame challenges as evolution, not problems',
		'- Be specific and personal—this is THEIR story',
		'- Return ONLY valid JSON. No markdown.',
	].join('\n');

	const out = await callLlama(env, ANALYSIS_CFG, system, user);
	if (out?.error) return { error: out.error, details: out.raw, status: out.status || 500 };

	let analysis;
	try {
		analysis = parseAnalysisJSON(out.text);
	} catch (e) {
		return { error: 'Failed to parse AI response', detail: e.message, status: 502 };
	}

	// Cache permanently (birth chart doesn't change)
	try {
		await env.NATAL_ANALYSIS_KV.put(cacheKey, JSON.stringify(analysis));
	} catch (_) {}

	return { data: analysis };
}

// ─── /natal-chat ─────────────────────────────────────────────────────────────

function buildChatSystemPrompt(chartFacts, locale) {
	return [
		'You are a warm, wise astrologer in a deep conversation with someone you care about.',
		'You know their natal chart intimately and speak to their authentic self.',
		'Your role is to illuminate, encourage, and help them understand their path.',
		'',
		'Their natal chart:',
		chartFacts,
		'',
		`Language/locale: ${locale}`,
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

	// ── Continue existing session ──────────────────────────────────────────────
	if (body.sessionId) {
		const message = body.message;
		if (!message?.trim()) return { error: 'Missing or empty message', status: 400 };
		if (message.length > 2000) return { error: 'Message too long (max 2000 characters)', status: 400 };

		const kvKey = `chat:${body.sessionId}`;
		let session;
		try {
			session = await env.NATAL_ANALYSIS_KV.get(kvKey, 'json');
		} catch (_) {}
		if (!session) return { error: 'Session not found or expired', status: 404 };

		const out = await callLlamaChat(env, CHAT_CFG, [session.messages[0], { role: 'user', content: message.trim() }]);
		if (out?.error) return { error: out.error, details: out.raw, status: out.status || 500 };

		session.turnCount = (session.turnCount || 0) + 1;
		try {
			await env.NATAL_ANALYSIS_KV.put(kvKey, JSON.stringify(session), { expirationTtl: CHAT_SESSION_TTL });
		} catch (_) {}

		return { data: { sessionId: body.sessionId, reply: out.text, turnCount: session.turnCount } };
	}

	// ── New session ────────────────────────────────────────────────────────────
	for (const k of BIRTH_FIELDS) {
		if (body[k] === undefined) return { error: `Missing: ${k}`, status: 400 };
	}

	const chart = computeNatal(body);
	const chartFacts = buildChartFacts(chart);
	if (!chartFacts) return { error: 'Failed to compute chart facts', status: 500 };

	const locale = pickLocale(body.lang);
	const systemPrompt = buildChatSystemPrompt(chartFacts, locale);
	const sessionId = crypto.randomUUID();
	const messages = [{ role: 'system', content: systemPrompt }];

	let reply,
		turnCount = 0;

	if (body.message?.trim()) {
		if (body.message.length > 2000) return { error: 'Message too long (max 2000 characters)', status: 400 };
		const out = await callLlamaChat(env, CHAT_CFG, [messages[0], { role: 'user', content: body.message.trim() }]);
		if (out?.error) return { error: out.error, details: out.raw, status: out.status || 500 };
		reply = out.text;
		turnCount = 1;
	}

	const session = { locale, createdAt: new Date().toISOString(), turnCount, messages };
	try {
		await env.NATAL_ANALYSIS_KV.put(`chat:${sessionId}`, JSON.stringify(session), { expirationTtl: CHAT_SESSION_TTL });
	} catch (_) {}

	const result = { sessionId, turnCount };
	if (reply !== undefined) result.reply = reply;
	return { data: result };
}
