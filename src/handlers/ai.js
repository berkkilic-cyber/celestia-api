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
	const base = { model: 'llama-3.1-8b-instant', max_output_tokens: 70, temperature: 0.85 };
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

	const langInstruction = {
		'tr-TR': 'Write entirely in Turkish with correct Turkish characters (ç, ş, ğ, ı, ö, ü, İ). Use warm, poetic language that feels intimate and personal. Turkish spirituality values heart-centered wisdom—let your words resonate deeply. Use relevant emojis to enhance the cosmic feeling.',
		'de-DE': 'Write entirely in German with clear, grounded language that feels thoughtful and wise. German audiences appreciate precision combined with warmth—be both specific and caring. Use relevant emojis to add visual beauty without overwhelming.',
		'fr-FR': 'Write entirely in French with elegance and poetic nuance. French readers value sophistication and soul connection—weave in subtle depth and beauty. Use tasteful emojis that enhance the message\'s emotional resonance.',
		'en': 'Write entirely in English with warmth, clarity, and inspiration. Create messages that feel like they\'re from a trusted cosmic guide. Use relevant emojis to add visual beauty and enhance the spiritual atmosphere.',
	}[locale] || 'Write entirely in English with warmth, clarity, and inspiration. Create messages that feel like they\'re from a trusted cosmic guide. Use relevant emojis to add visual beauty and enhance the spiritual atmosphere.';

	const commonRules = [
		langInstruction,
		'Tone: calm, premium, grounded.',
		'No disclaimers. Speak with quiet confidence.',
		"Don't repeat the user facts verbatim.",
	].join('\n');

	const userFacts = [
		`Birth date: ${bd.day}-${bd.month}-${bd.year}`,
		`Birth time: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
		bd.latitude != null && bd.longitude != null ? `Location: lat ${bd.latitude}, lon ${bd.longitude}` : 'Location: (not provided)',
	].join('\n');

	if (action === 'daily_cosmic_message') {
		return {
			system: `You are a warm, compassionate cosmic guide crafting daily wisdom for a premium lifestyle app.
Your voice is gentle, authentic, and deeply supportive—like a guiding star.
Speak as a trusted friend offering perspective and hope, not as an authority.
${commonRules}`,
			user: `Create an inspiring daily cosmic message in EXACTLY 2 LINES. ✨

Line 1 (INSIGHT) - The Heart:
- 30–40 words of emotional & spiritual guidance
- Focus on what they NEED to know about their day
- Warm, reflective, encouraging tone
- Feel like a gentle cosmic nudge toward growth
- One flowing paragraph

Line 2 (KOZMIK_TAVSIYE) - The Action:
- ONE short, actionable sentence (8–14 words)
- Practical, positive action to embody today
- Feel supportive and achievable
- Inspire them forward

Tone: Like a caring cosmic friend who understands them.
Format: Include relevant emoji(s) that enhance the cosmic feeling. Plain text, 2 lines separated by one newline.
User context:
${userFacts}`,
		};
	}

	if (action === 'lucky_number_explanation') {
		const luckyNumber = clampInt(payload?.luckyNumber ?? 7, 1, 9, 7);
		return {
			system: `You are a warm numerology sage creating personalized, uplifting insights for a premium app.
Your explanations feel intimate and meaningful, filled with quiet wisdom.
Numbers are cosmic guides—help the person feel their personal connection.
${commonRules}`,
			user: `Explain this lucky number as a personal cosmic gift for the user. 🔮

Lucky number: ${luckyNumber}
User context:
${userFacts}

Structure (keep total ~80 words):
1. Opening: ONE sentence capturing the essence & cosmic energy of this number for them
2. Life areas: Three distinct insights for:
   - ❤️ Love & Relationships (warmth, connection)
   - 💼 Career & Purpose (direction, growth)
   - ✨ Inner Luck & Intuition (spiritual resonance)
   Each insight should feel personally relevant and grounded in their birth details
3. Closing: ONE inspiring sentence encouraging them to trust this number's guidance

Tone: Like sharing a secret cosmic gift. Warm, specific, actionable. Include subtle emoji that enhance the message.`,
		};
	}

	if (action === 'natal_map_summary') {
		const chartFacts = buildChartFacts(payload?.chart);
		if (!chartFacts) return { error: 'Missing chart in payload.chart' };
		return {
			system: `You are a compassionate astrologer writing intimate natal chart summaries for profound self-discovery.
Your voice honors the person's unique journey while illuminating their true potential.
Speak directly to them about their gifts and growing edges with warmth and wisdom.
${commonRules}`,
			user: `Write a warm, personal natal map summary using the structure below. 🌟

User details:
${userFacts}

Chart data:
${chartFacts}

--- OUTPUT STRUCTURE (FOLLOW EXACTLY) ---

Core Theme: 🌠
(120-130 words capturing their soul's central narrative and life path)

Strengths: 💫
(120-130 words celebrating their natural gifts, talents, and harmonious placements)

Growing Edge: 🌙
(120-130 words on their challenges and opportunities for growth, written with compassion)

--- GUIDELINES ---
Each section is ONE flowing paragraph.
Use their birth details naturally in the descriptions.
Tone: warm, personal, encouraging, grounded, and wise.
Include the emoji shown above at the start of each section heading.
No sections should feel like criticism. Frame challenges as invitations to evolve and grow.
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
