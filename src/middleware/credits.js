// src/middleware/credits.js
import { ACTION_COSTS, consumeCredits, checkDailyAction, markDailyAction } from "../db/credits.js";

/**
 * Map route path + request body to an action key
 */
export function resolveAction(pathname, body) {
  if (pathname === "/tarot") {
    const spread = body?.spreadType;
    if (spread === "single_card")   return "tarot_single";       // free
    if (spread === "three_card")    return "tarot_daily_3card";  // free, daily limited
    if (spread === "yes_no")        return "tarot_yes_no";
    if (spread === "love")          return "tarot_love";
    if (spread === "career")        return "tarot_career";
    if (spread === "celtic_cross")  return "tarot_celtic";
  }
  if (pathname === "/natal-chat")         return "ai_qa";
  if (pathname === "/relationship-score") return "compatibility";
  if (pathname === "/natal-analysis")     return "natal_interpretation";
  if (pathname === "/ai")                 return "ai_qa";
  return null;
}

/**
 * Gate a request by checking and consuming credits.
 * Returns { ok: true } on success or { ok: false, error, status } on failure.
 */
export async function gateCredits(pathname, body, userId, kv, db) {
  const action = resolveAction(pathname, body);
  if (!action) return { ok: true }; // untracked route, pass through

  // Daily free 3-card: KV flag per user per day
  if (action === "tarot_daily_3card") {
    const used = await checkDailyAction(kv, userId, "tarot_daily_3card");
    if (used) return { ok: false, error: "daily_already_used", status: 429 };
    await markDailyAction(kv, userId, "tarot_daily_3card");
    return { ok: true, free: true };
  }

  // Free actions (cost = 0)
  if (ACTION_COSTS[action] === 0) return { ok: true, free: true };

  // Paid actions — consume from D1
  const result = await consumeCredits(db, userId, action);
  if (!result.success) {
    return {
      ok: false,
      error: result.error,
      status: result.error === "insufficient_credits" ? 402 : 429,
      balance: result.balance,
    };
  }

  return { ok: true, cost: result.cost, balance: result.balance };
}
