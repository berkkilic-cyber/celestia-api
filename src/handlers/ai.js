// src/handlers/ai.js
import { callLlama } from '../lib/llama.js';
import { buildChartFacts } from '../lib/chart.js';
import { pickLocale, clampInt, requireBirthData } from '../lib/locale.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function actionConfig(action) {
	const base = { model: 'meta-llama/Llama-3.1-8b-instruct', max_output_tokens: 70, temperature: 0.85 };
	switch (action) {
		case 'daily_cosmic_message':
			return { ...base, max_output_tokens: 70, temperature: 0.9 };
		case 'lucky_number_explanation':
			return { ...base, max_output_tokens: 70, temperature: 0.75 };
		case 'natal_map_summary':
			return { ...base, max_output_tokens: 70, temperature: 0.8 };
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

	const commonRules = [
		`Language/locale: ${locale}`,
		'Tone: calm, premium, grounded.',
		'No emojis. No disclaimers.',
		"Don't repeat the user facts verbatim.",
	].join('\n');

	const userFacts = [
		`Birth date: ${bd.day}-${bd.month}-${bd.year}`,
		`Birth time: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
		bd.latitude != null && bd.longitude != null ? `Location: lat ${bd.latitude}, lon ${bd.longitude}` : 'Location: (not provided)',
	].join('\n');

	if (action === 'daily_cosmic_message') {
		return {
			system: `You are a warm, compassionate guide crafting daily cosmic wisdom for a premium lifestyle app.
Your voice is gentle, authentic, and deeply supportive.
Speak as a trusted friend offering perspective, not as an authority.
${commonRules}`,
			user: `Create an inspiring daily message in EXACTLY 2 LINES.

Line 1 (INSIGHT) - The Heart:
- 30–40 words of emotional & spiritual guidance
- Focus on what the user NEEDS to know about their day
- Warm, reflective, encouraging tone
- Feel like a gentle nudge toward growth
- One flowing paragraph

Line 2 (KOZMIK_TAVSIYE) - The Action:
- ONE short, actionable sentence (8–14 words)
- Practical, positive action to embody today
- Feel supportive and achievable
- No explanation—pure inspiration

Tone: Like a caring friend who understands them.
Format: Plain text only. Exactly 2 lines, separated by one newline.`,
		};
	}

	if (action === 'lucky_number_explanation') {
		const luckyNumber = clampInt(payload?.luckyNumber ?? 7, 1, 9, 7);
		return {
			system: `You are a warm numerology guide creating personalized, uplifting insights for a premium app.
Your explanations feel intimate and meaningful, never academic.
${commonRules}`,
			user: `Explain this lucky number as a personal gift for the user.\n\nLucky number: ${luckyNumber}\nUser context:\n${userFacts}\n\nStructure (keep total ~80 words):\n1. Opening: ONE sentence capturing the essence & energy of this number for them\n2. Life areas: Three distinct insights for:\n   - Love & Relationships (warmth, connection)\n   - Career & Purpose (direction, growth)\n   - Inner Luck & Intuition (spiritual resonance)\n   Each insight should feel personally relevant\n3. Closing: ONE inspiring sentence encouraging them to trust this number\n\nTone: Like sharing a secret gift. Warm, specific, actionable.`,
		};
	}

	if (action === 'natal_map_summary') {
		const chartFacts = buildChartFacts(payload?.chart);
		if (!chartFacts) return { error: 'Missing chart in payload.chart' };
		return {
			system: `You are a compassionate astrologer writing intimate natal chart summaries for self-discovery.
Your voice honors the person's journey while illuminating their potential.
Speak directly to them about their gifts and growing edges.
${commonRules}`,
			user: `Write a warm, personal natal map summary using the structure below.

User details:
${userFacts}

Chart data:
${chartFacts}

--- OUTPUT STRUCTURE (FOLLOW EXACTLY) ---

Core Theme:
(120-130 words capturing their soul's central narrative and life path)

Strengths:
(120-130 words celebrating their natural gifts, talents, and harmonious placements)

Growing Edge:
(120-130 words on their challenges and opportunities for growth, written with compassion)

--- GUIDELINES ---
Each section is ONE flowing paragraph.
Use their birth details naturally.
Tone: warm, personal, encouraging, grounded.
Language: ${locale}
No sections should feel like criticism. Frame challenges as invitations to evolve.
Total: 360-390 words across all sections.`,
		};
	}

	return { error: 'Unsupported action' };
}

export async function handleAI(request, env) {
	const body = await request.json();
	const { action, payload = {}, lang, userId } = body;
	const locale = pickLocale(lang);

	if (!action) return { error: 'Missing action', status: 400 };

	const cfg = actionConfig(action);
	if (!cfg) return { error: 'Unknown action', status: 400 };

	const prompt = buildPrompt(action, payload, locale);
	if (prompt?.error) return { error: prompt.error, status: 400 };

	// Edge cache per user/day/action/locale
	const day = new Date().toISOString().slice(0, 10);
	const cacheKeyUrl = new URL(request.url);
	cacheKeyUrl.pathname = '/__ai_cache__';
	cacheKeyUrl.searchParams.set('u', String(userId));
	cacheKeyUrl.searchParams.set('a', String(action));
	cacheKeyUrl.searchParams.set('l', String(locale));
	cacheKeyUrl.searchParams.set('d', day);
	const cacheKeyReq = new Request(cacheKeyUrl.toString(), { method: 'GET' });
	const cache = caches.default;
	const cached = await cache.match(cacheKeyReq);
	if (cached) return { rawResponse: cached }; // bypass json() wrapper

	const out = await callLlama(env, cfg, prompt.system, prompt.user);
	if (out?.error) return { error: out.error, details: out.raw, status: out.status || 500 };

	const responseBody = { action, locale, result: out.text };
	const res = new Response(JSON.stringify(responseBody), {
		status: 200,
		headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, 'Cache-Control': 'public, max-age=86400' },
	});
	await cache.put(cacheKeyReq, res.clone());
	return { rawResponse: res };
}
