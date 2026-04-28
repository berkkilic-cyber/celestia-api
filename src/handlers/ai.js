// src/handlers/ai.js
// import { callLlama } from '../lib/llama.js';
import { callOpenAI } from '../lib/openai.js';
import { buildChartFacts } from '../lib/chart.js';
import { pickLocale, clampInt, requireBirthData } from '../lib/locale.js';
import { dailyCosmicMessagePrompt, natalMapSummaryPrompt } from '../prompts.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function actionConfig(action) {
	// const base = { model: 'llama-3.1-8b-instant', max_output_tokens: 70, temperature: 0.85 };
	const base = { model: 'gpt-4o-mini', max_output_tokens: 70, temperature: 0.85 };
	switch (action) {
		case 'daily_cosmic_message':
			return { ...base, max_output_tokens: 70, temperature: 0.9 };
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

	const userFacts = [
		`Birth date: ${bd.day}-${bd.month}-${bd.year}`,
		`Birth time: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
		bd.latitude != null && bd.longitude != null ? `Location: lat ${bd.latitude}, lon ${bd.longitude}` : 'Location: (not provided)',
	].join('\n');

	if (action === 'daily_cosmic_message') {
		const today = new Date().toISOString().slice(0, 10);
		return dailyCosmicMessagePrompt({ userFacts, locale, today });
	}

	if (action === 'natal_map_summary') {
		const chartFacts = buildChartFacts(payload?.chart);
		if (!chartFacts) return { error: 'Missing chart in payload.chart' };
		return natalMapSummaryPrompt({ userFacts, chartFacts, locale });
	}

	return { error: 'Unsupported action' };
}

export async function handleAI(request, env, authUserId) {
	const body = await request.json();
	const { action, payload = {}, lang } = body;
	const locale = pickLocale(lang);

	if (!action) return { error: 'Missing action', status: 400 };

	const cfg = actionConfig(action);
	if (!cfg) return { error: 'Unknown action', status: 400 };

	const prompt = buildPrompt(action, payload, locale);
	if (prompt?.error) return { error: prompt.error, status: 400 };

	const day = new Date().toISOString().slice(0, 10);

	// daily_cosmic_message: strict 1 per user per day, stored in KV
	if (action === 'daily_cosmic_message') {
		const kvKey = `daily-cosmic:${authUserId}:${locale}:${day}`;
		const cached = await env.NATAL_ANALYSIS_KV.get(kvKey, 'json');
		if (cached?.result) return { data: { action, locale, result: cached.result } };

		const out = await callOpenAI(env, cfg, prompt.system, prompt.user);
		if (out?.error) return { error: out.error, details: out.raw, status: out.status || 500 };

		try {
			await env.NATAL_ANALYSIS_KV.put(kvKey, JSON.stringify({ result: out.text }), { expirationTtl: 60 * 60 * 48 });
		} catch (_) {}
		return { data: { action, locale, result: out.text } };
	}

	// Other actions: edge CDN cache per user/day/action/locale
	const cacheKeyUrl = new URL(request.url);
	cacheKeyUrl.pathname = '/__ai_cache__';
	cacheKeyUrl.searchParams.set('u', String(authUserId));
	cacheKeyUrl.searchParams.set('a', String(action));
	cacheKeyUrl.searchParams.set('l', String(locale));
	cacheKeyUrl.searchParams.set('d', day);
	const cacheKeyReq = new Request(cacheKeyUrl.toString(), { method: 'GET' });
	const cache = caches.default;
	const cached = await cache.match(cacheKeyReq);
	if (cached) return { rawResponse: cached };

	const out = await callOpenAI(env, cfg, prompt.system, prompt.user);
	if (out?.error) return { error: out.error, details: out.raw, status: out.status || 500 };

	const responseBody = { action, locale, result: out.text };
	const res = new Response(JSON.stringify(responseBody), {
		status: 200,
		headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, 'Cache-Control': 'public, max-age=86400' },
	});
	await cache.put(cacheKeyReq, res.clone());
	return { rawResponse: res };
}
