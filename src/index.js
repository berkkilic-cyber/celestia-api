// src/index.js
// ── Router only. No business logic here. ──────────────────────────────────────

import { computeComposite } from "./natal-core.js";
import { validateSession, extractToken } from "./auth/session.js";
import { gateCredits } from "./middleware/credits.js";

import { handleNatal, handleNatalAnalysis, handleNatalChat } from "./handlers/natal.js";
import { handleTarot } from "./handlers/tarot.js";
import { handleRelationshipScore } from "./handlers/relationship.js";
import { handleAI } from "./handlers/ai.js";
import { handleAppleAuth, handleGoogleAuth, handleLogout, handleGetMe, handleGetCredits } from "./handlers/auth.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Routes that require auth + credit gating
const PROTECTED_AI_ROUTES = new Set([
  "/natal-analysis",
  "/natal-chat",
  "/relationship-score",
  "/ai",
]);

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    try {

      // ── Health ───────────────────────────────────────────────────────────
      if (path === "/health") return json({ status: "ok" });

      // ── Public auth routes ───────────────────────────────────────────────
      if (path === "/auth/apple")  return dispatch(await handleAppleAuth(request, env));
      if (path === "/auth/google") return dispatch(await handleGoogleAuth(request, env));
      if (path === "/auth/logout") return dispatch(await handleLogout(request, env));

      // ── Fully public compute routes (no AI, no cost) ─────────────────────
      if (path === "/natal")     return dispatch(await handleNatal(request));
      if (path === "/composite") {
        const body = await request.json();
        const needed = ["year","month","day","hour","minute","tzOffsetMinutes","latitude","longitude"];
        for (const key of ["person1","person2"]) {
          if (!body[key]) return json({ error: `Missing: ${key}` }, 400);
          for (const k of needed) if (body[key][k] === undefined) return json({ error: `Missing: ${key}.${k}` }, 400);
        }
        return json(computeComposite(body.person1, body.person2));
      }

      // ── Tarot: soft gate (free spreads public, paid spreads require auth) ─
      if (path === "/tarot") {
        const bodyText = await request.text();
        const body = JSON.parse(bodyText);
        const spread = body?.spreadType;
        const isFreeSpread = spread === "single_card" || spread === "three_card";

        if (isFreeSpread) {
          // Free spreads: no auth, but daily limit on three_card still applies
          // For three_card without auth, we skip the daily limit (anonymous users)
          const req = new Request(request.url, { method: request.method, headers: request.headers, body: bodyText });
          return dispatch(await handleTarot(req, env));
        }

        // Paid spreads: require auth + credits
        const userId = await requireAuth(request, env);
        const gate = await gateCredits(path, body, userId, env.NATAL_ANALYSIS_KV, env.DB);
        if (!gate.ok) return json({ error: gate.error, ...(gate.balance !== undefined && { balance: gate.balance }) }, gate.status);

        const req = new Request(request.url, { method: request.method, headers: request.headers, body: bodyText });
        return dispatch(await handleTarot(req, env));
      }

      // ── Protected user routes ────────────────────────────────────────────
      if (path === "/user/me")      { const userId = await requireAuth(request, env); return dispatch(await handleGetMe(env, userId)); }
      if (path === "/user/credits") { const userId = await requireAuth(request, env); return dispatch(await handleGetCredits(env, userId)); }

      // ── Protected AI routes ──────────────────────────────────────────────
      if (PROTECTED_AI_ROUTES.has(path)) {
        const userId = await requireAuth(request, env);
        const bodyText = await request.text();
        const body = JSON.parse(bodyText);

        const gate = await gateCredits(path, body, userId, env.NATAL_ANALYSIS_KV, env.DB);
        if (!gate.ok) return json({ error: gate.error, ...(gate.balance !== undefined && { balance: gate.balance }) }, gate.status);

        const req = new Request(request.url, { method: request.method, headers: request.headers, body: bodyText });

        if (path === "/natal-analysis")     return dispatch(await handleNatalAnalysis(req, env));
        if (path === "/natal-chat")         return dispatch(await handleNatalChat(req, env));
        if (path === "/relationship-score") return dispatch(await handleRelationshipScore(req, env));
        if (path === "/ai") {
          // Inject userId for cache key
          const enriched = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: JSON.stringify({ ...body, userId }),
          });
          return dispatch(await handleAI(enriched, env));
        }
      }

      return json({ error: "Not found", path }, 404);

    } catch (err) {
      if (err?.status === 401) return json({ error: "Unauthorized" }, 401);
      console.error("Unhandled error:", err);
      return json({ error: "Internal error", message: err?.message }, 500);
    }
  },

  // ── Monthly subscription credit top-up ─────────────────────────────────────
  async scheduled(event, env, ctx) {
    if (event.cron === "0 0 1 * *") ctx.waitUntil(monthlyTopUp(env));
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert handler return value to a Response.
 * Handlers return { data } | { error, status? } | { rawResponse }
 */
function dispatch(result) {
  if (!result) return new Response(JSON.stringify({ error: "Empty handler result" }), { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  if (result.rawResponse) return result.rawResponse; // pre-built Response (e.g. cached)
  if (result.error) {
    return new Response(JSON.stringify({ error: result.error, ...(result.detail && { detail: result.detail }) }), {
      status: result.status || 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  return new Response(JSON.stringify(result.data), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function requireAuth(request, env) {
  const token = extractToken(request);
  const userId = await validateSession(env.NATAL_ANALYSIS_KV, token);
  if (!userId) throw { status: 401, message: "Unauthorized" };
  return userId;
}

async function monthlyTopUp(env) {
  const TIER_CREDITS = { premium: 60, premium_plus: 200 };
  const { results } = await env.DB.prepare(
    `SELECT user_id, tier FROM subscriptions WHERE status = 'active' AND current_period_end > ?`
  ).bind(Math.floor(Date.now() / 1000)).all();

  for (const sub of results) {
    const credits = TIER_CREDITS[sub.tier];
    if (!credits) continue;
    await env.DB.prepare(`UPDATE credits SET balance = balance + ? WHERE user_id = ?`).bind(credits, sub.user_id).run();
    await env.DB.prepare(`INSERT INTO credit_transactions (id, user_id, amount, action) VALUES (?, ?, ?, ?)`).bind(crypto.randomUUID(), sub.user_id, credits, "monthly_subscription_topup").run();
  }
  console.log(`Monthly top-up complete for ${results.length} subscribers`);
}
