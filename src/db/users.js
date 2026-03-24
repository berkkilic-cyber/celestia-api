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

export async function updateUser(db, id, fields) {
  const allowed = ['name', 'birth_date', 'birth_time', 'birth_place', 'email'];
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
