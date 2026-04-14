// src/db/users.js
// D1 queries for users table

function generateId() {
  return crypto.randomUUID();
}

export async function createUser(db, { apple_user_id, google_user_id, email, name, is_guest }) {
  const id = generateId();
  await db.prepare(`
    INSERT INTO users (id, apple_user_id, google_user_id, email, name, is_guest)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, apple_user_id || null, google_user_id || null, email || null, name || null, is_guest ? 1 : 0).run();

  return { id, apple_user_id, google_user_id, email, name, is_guest: is_guest ? 1 : 0 };
}

export async function findUserByAppleId(db, appleUserId) {
  return await db.prepare(`
    SELECT * FROM users WHERE apple_user_id = ?
  `).bind(appleUserId).first();
}

export async function findUserByGoogleId(db, googleUserId) {
  return await db.prepare(`
    SELECT * FROM users WHERE google_user_id = ?
  `).bind(googleUserId).first();
}

export async function findUserById(db, id) {
  return await db.prepare(`
    SELECT * FROM users WHERE id = ?
  `).bind(id).first();
}

export async function scheduleDeleteUser(db, id) {
  const deleteAt = Math.floor(Date.now() / 1000) + 30 * 86400; // 30 days from now
  await db.prepare(`UPDATE users SET delete_scheduled_at = ? WHERE id = ?`).bind(deleteAt, id).run();
  return deleteAt;
}

export async function cancelDeleteUser(db, id) {
  await db.prepare(`UPDATE users SET delete_scheduled_at = NULL WHERE id = ?`).bind(id).run();
}

export async function purgeDeletedUsers(db) {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await db.prepare(
    `SELECT id FROM users WHERE delete_scheduled_at IS NOT NULL AND delete_scheduled_at <= ?`
  ).bind(now).all();

  for (const user of results) {
    await db.prepare(`DELETE FROM credit_transactions WHERE user_id = ?`).bind(user.id).run();
    await db.prepare(`DELETE FROM credits WHERE user_id = ?`).bind(user.id).run();
    await db.prepare(`DELETE FROM subscriptions WHERE user_id = ?`).bind(user.id).run();
    await db.prepare(`DELETE FROM iap_purchases WHERE user_id = ?`).bind(user.id).run();
    await db.prepare(`DELETE FROM users WHERE id = ?`).bind(user.id).run();
  }

  return results.length;
}

export async function upgradeGuestUser(db, id, { apple_user_id, google_user_id, email, name }) {
  const sets = ['is_guest = 0'];
  const vals = [];
  if (apple_user_id) { sets.push('apple_user_id = ?'); vals.push(apple_user_id); }
  if (google_user_id) { sets.push('google_user_id = ?'); vals.push(google_user_id); }
  if (email) { sets.push('email = ?'); vals.push(email); }
  if (name) { sets.push('name = ?'); vals.push(name); }
  await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
}

export async function updateUser(db, id, fields) {
  const allowed = ['name', 'birth_date', 'birth_time', 'birth_place', 'email',
                    'latitude', 'longitude', 'sun_sign', 'moon_sign', 'rising_sign'];
  const updates = Object.entries(fields)
    .filter(([k]) => allowed.includes(k))
    .map(([k]) => `${k} = ?`);
  const values = Object.entries(fields)
    .filter(([k]) => allowed.includes(k))
    .map(([, v]) => v);

  if (updates.length === 0) return;

  await db.prepare(`
    UPDATE users SET ${updates.join(', ')} WHERE id = ?
  `).bind(...values, id).run();
}

// ── Device tokens ─────────────────────────────────────────────────────────────

export async function upsertDeviceToken(db, userId, token, platform = 'ios') {
  const existing = await db.prepare(
    `SELECT id, user_id FROM device_tokens WHERE token = ?`
  ).bind(token).first();

  const now = Math.floor(Date.now() / 1000);

  if (existing) {
    // Token exists — update user_id and timestamp (device may have switched accounts)
    await db.prepare(
      `UPDATE device_tokens SET user_id = ?, updated_at = ? WHERE id = ?`
    ).bind(userId, now, existing.id).run();
  } else {
    const id = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO device_tokens (id, user_id, token, platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, userId, token, platform, now, now).run();
  }
}

export async function removeDeviceToken(db, token) {
  await db.prepare(`DELETE FROM device_tokens WHERE token = ?`).bind(token).run();
}
