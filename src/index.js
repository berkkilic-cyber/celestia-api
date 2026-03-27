// src/index.js
// ── Router only. No business logic here. ──────────────────────────────────────

import { computeComposite } from './natal-core.js';
import { validateSession, extractToken } from './auth/session.js';
import { gateCredits } from './middleware/credits.js';

import { handleNatal, handleNatalAnalysis, handleNatalChat, buildAnalysisCacheKey } from './handlers/natal.js';
import { pickLocale } from './lib/locale.js';
import { handleTarot } from './handlers/tarot.js';
import { handleRelationshipScore, handleRelationshipChat } from './handlers/relationship.js';
import { handleAI } from './handlers/ai.js';
import { handleAppleAuth, handleGoogleAuth, handleGuestAuth, handleLogout, handleGetMe, handleGetCredits } from './handlers/auth.js';
import { handlePlacesAutocomplete, handlePlacesDetails } from './handlers/places.js';
import { handleRewardedCallback } from './handlers/ads.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	'Access-Control-Expose-Headers': 'X-Credits-Balance, X-Credits-Cost',
};

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
	});
}

// Routes that require auth + credit gating
const PROTECTED_ROUTES = new Set(['/tarot', '/natal-chat', '/relationship-score', '/relationship-chat', '/ai']);

export default {
	async fetch(request, env) {
		// CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		const url = new URL(request.url);
		const path = url.pathname;

		try {
			// ── Health ───────────────────────────────────────────────────────────
			if (path === '/health') return json({ status: 'ok' });

			// ── Public auth routes ───────────────────────────────────────────────
			if (path === '/auth/apple') return dispatch(await handleAppleAuth(request, env));
			if (path === '/auth/google') return dispatch(await handleGoogleAuth(request, env));
			if (path === '/auth/guest' && request.method === 'POST') return dispatch(await handleGuestAuth(env));
			if (path === '/auth/logout') return dispatch(await handleLogout(request, env));

			// ── AdMob SSV callback (called by Google, no auth) ─────────────────
			// AdMob SSV callback: https://celestia-api.berk-kilic.workers.dev/api/ads/rewarded-callback
			if (path === '/api/ads/rewarded-callback') return dispatch(await handleRewardedCallback(request, env));

			// ── Google Places (public) ─────────────────────────────────────────
			if (path === '/places/autocomplete') return dispatch(await handlePlacesAutocomplete(request, env));
			if (path === '/places/details') return dispatch(await handlePlacesDetails(request, env));

			// ── Fully public compute routes (no AI, no cost) ─────────────────────
			if (path === '/natal') return dispatch(await handleNatal(request));
			if (path === '/composite') {
				const body = await request.json();
				const needed = ['year', 'month', 'day', 'hour', 'minute', 'tzOffsetMinutes', 'latitude', 'longitude'];
				for (const key of ['person1', 'person2']) {
					if (!body[key]) return json({ error: `Missing: ${key}` }, 400);
					for (const k of needed) if (body[key][k] === undefined) return json({ error: `Missing: ${key}.${k}` }, 400);
				}
				return json(computeComposite(body.person1, body.person2));
			}

			// ── Protected user routes ────────────────────────────────────────────
			if (path === '/user/me') {
				const userId = await requireAuth(request, env);
				return dispatch(await handleGetMe(env, userId));
			}
			if (path === '/user/credits') {
				const userId = await requireAuth(request, env);
				return dispatch(await handleGetCredits(env, userId));
			}

			// ── Natal analysis (cache-first, only charge on miss) ─────────────────
			if (path === '/natal-analysis') {
				const userId = await requireAuth(request, env);
				const cloned = request.clone();
				const body = await cloned.json();
				const locale = pickLocale(body.lang);
				const cacheKey = buildAnalysisCacheKey(body, locale);

				// try {
				//   const cached = await env.NATAL_ANALYSIS_KV.get(cacheKey, 'json');
				//   if (cached) return json(cached);
				// } catch (_) {}

				const gate = await gateCredits(path, body, userId, env.NATAL_ANALYSIS_KV, env.celestia_db);
				if (!gate.ok) return json({ error: gate.error, balance: gate.balance }, gate.status);

				const handlerResult = await handleNatalAnalysis(request, env);
				const res = dispatch(handlerResult);
				if (gate.balance !== undefined) res.headers.set('X-Credits-Balance', String(gate.balance));
				if (gate.cost !== undefined) res.headers.set('X-Credits-Cost', String(gate.cost));
				return res;
			}

			// ── Protected routes (auth + credit gating) ──────────────────────────
			if (PROTECTED_ROUTES.has(path)) {
				const userId = await requireAuth(request, env);
				const cloned = request.clone();
				const body = await cloned.json();
				const gate = await gateCredits(path, body, userId, env.NATAL_ANALYSIS_KV, env.celestia_db);
				if (!gate.ok) return json({ error: gate.error, balance: gate.balance }, gate.status);

				let handlerResult;
				if (path === '/tarot') handlerResult = await handleTarot(request, env);
				else if (path === '/natal-chat') handlerResult = await handleNatalChat(request, env);
				else if (path === '/relationship-score') handlerResult = await handleRelationshipScore(request, env);
				else if (path === '/relationship-chat') handlerResult = await handleRelationshipChat(request, env);
				else if (path === '/ai') handlerResult = await handleAI(request, env);

				const res = dispatch(handlerResult);
				if (gate.balance !== undefined) res.headers.set('X-Credits-Balance', String(gate.balance));
				if (gate.cost !== undefined) res.headers.set('X-Credits-Cost', String(gate.cost));
				return res;
			}

			return json({ error: 'Not found', path }, 404);
		} catch (err) {
			if (err?.status === 401) return json({ error: 'Unauthorized' }, 401);
			console.error('Unhandled error:', err);
			return json({ error: 'Internal error', message: err?.message }, 500);
		}
	},

	// ── Monthly subscription credit top-up ─────────────────────────────────────
	async scheduled(event, env, ctx) {
		if (event.cron === '0 0 1 * *') ctx.waitUntil(monthlyTopUp(env));
	},
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert handler return value to a Response.
 * Handlers return { data } | { error, status? } | { rawResponse }
 */
function dispatch(result) {
	if (!result)
		return new Response(JSON.stringify({ error: 'Empty handler result' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
		});
	if (result.rawResponse) return result.rawResponse; // pre-built Response (e.g. cached)
	if (result.error) {
		return new Response(JSON.stringify({ error: result.error, ...(result.detail && { detail: result.detail }) }), {
			status: result.status || 400,
			headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
		});
	}
	return new Response(JSON.stringify(result.data), {
		status: 200,
		headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
	});
}

async function requireAuth(request, env) {
	const token = extractToken(request);
	const userId = await validateSession(env.NATAL_ANALYSIS_KV, token);
	if (!userId) throw { status: 401, message: 'Unauthorized' };
	return userId;
}

async function monthlyTopUp(env) {
	const TIER_CREDITS = { premium: 60, premium_plus: 200 };
	const { results } = await env.celestia_db
		.prepare(`SELECT user_id, tier FROM subscriptions WHERE status = 'active' AND current_period_end > ?`)
		.bind(Math.floor(Date.now() / 1000))
		.all();

	for (const sub of results) {
		const credits = TIER_CREDITS[sub.tier];
		if (!credits) continue;
		await env.celestia_db.prepare(`UPDATE credits SET balance = balance + ? WHERE user_id = ?`).bind(credits, sub.user_id).run();
		await env.celestia_db
			.prepare(`INSERT INTO credit_transactions (id, user_id, amount, action) VALUES (?, ?, ?, ?)`)
			.bind(crypto.randomUUID(), sub.user_id, credits, 'monthly_subscription_topup')
			.run();
	}
	console.log(`Monthly top-up complete for ${results.length} subscribers`);
}
