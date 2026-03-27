// src/db/credits.js
// D1 queries for credits and transactions

const SIGNUP_BONUS = 5;
const DAILY_CAP = 200;

// Credit cost per action
export const ACTION_COSTS = {
  tarot_yes_no: 1,
  tarot_love: 2,
  tarot_career: 2,
  tarot_celtic: 4,
  ai_qa: 1,
  compatibility: 0,
  transit_forecast: 2,
  natal_interpretation: 0,
  // Free actions — not consumed
  daily_cosmic_message: 0,
  tarot_single: 0,
  tarot_daily_3card: 0,
  natal_chart: 0,
};

/**
 * Initialize credits for a new user
 */
export async function initCredits(db, userId) {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`
    INSERT INTO credits (user_id, balance, daily_spent, daily_reset_at)
    VALUES (?, ?, 0, ?)
  `).bind(userId, SIGNUP_BONUS, now).run();

  // Log signup bonus transaction
  await logTransaction(db, userId, SIGNUP_BONUS, 'signup_bonus');
}

/**
 * Get current credit balance for a user
 */
export async function getCredits(db, userId) {
  const row = await db.prepare(`
    SELECT * FROM credits WHERE user_id = ?
  `).bind(userId).first();
  return row;
}

/**
 * Consume credits for an action
 * Returns { success, balance, error }
 */
export async function consumeCredits(db, userId, action) {
  const cost = ACTION_COSTS[action];
  if (cost === undefined) return { success: false, error: 'Unknown action' };
  if (cost === 0) return { success: true, free: true };

  const credits = await getCredits(db, userId);
  if (!credits) return { success: false, error: 'User credits not found' };

  // Check and reset daily cap if needed
  const now = Math.floor(Date.now() / 1000);
  const lastReset = credits.daily_reset_at || 0;
  const isNewDay = (now - lastReset) > 86400; // 24 hours
  const dailySpent = isNewDay ? 0 : credits.daily_spent;

  // Check daily cap
  if (dailySpent + cost > DAILY_CAP) {
    return { success: false, error: 'daily_cap_reached', daily_cap: DAILY_CAP };
  }

  // Check balance
  if (credits.balance < cost) {
    return { success: false, error: 'insufficient_credits', balance: credits.balance };
  }

  // Deduct credits
  await db.prepare(`
    UPDATE credits
    SET balance = balance - ?,
        daily_spent = ?,
        daily_reset_at = ?
    WHERE user_id = ?
  `).bind(cost, dailySpent + cost, isNewDay ? now : lastReset, userId).run();

  // Log transaction
  await logTransaction(db, userId, -cost, action);

  return {
    success: true,
    balance: credits.balance - cost,
    cost,
  };
}

/**
 * Add credits (from IAP purchase or subscription renewal)
 */
export async function addCredits(db, userId, amount, reason) {
  await db.prepare(`
    UPDATE credits SET balance = balance + ? WHERE user_id = ?
  `).bind(amount, userId).run();

  await logTransaction(db, userId, amount, reason);

  const updated = await getCredits(db, userId);
  return updated.balance;
}

/**
 * Log every credit movement for audit trail
 */
async function logTransaction(db, userId, amount, action) {
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO credit_transactions (id, user_id, amount, action)
    VALUES (?, ?, ?, ?)
  `).bind(id, userId, amount, action).run();
}

/**
 * Check if daily free action was already used today
 * Used for daily 3-card tarot
 */
export async function checkDailyAction(kv, userId, action) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const key = `daily:${userId}:${action}:${today}`;
  const used = await kv.get(key);
  return !!used;
}

export async function markDailyAction(kv, userId, action) {
  const today = new Date().toISOString().split('T')[0];
  const key = `daily:${userId}:${action}:${today}`;
  // Expires after 48h to be safe across timezones
  await kv.put(key, '1', { expirationTtl: 60 * 60 * 48 });
}
