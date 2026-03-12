// src/auth/session.js
// JWT generation and KV session management

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Generate a secure random session token
 */
function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a new session, store in KV, return token
 * KV key: session:{token} → user_id
 */
export async function createSession(kv, userId) {
  const token = generateToken();
  await kv.put(
    `session:${token}`,
    userId,
    { expirationTtl: SESSION_TTL_SECONDS }
  );
  return token;
}

/**
 * Validate a session token from KV
 * Returns user_id if valid, null if not
 */
export async function validateSession(kv, token) {
  if (!token) return null;
  const userId = await kv.get(`session:${token}`);
  return userId || null;
}

/**
 * Delete a session (logout)
 */
export async function deleteSession(kv, token) {
  await kv.delete(`session:${token}`);
}

/**
 * Extract Bearer token from Authorization header
 */
export function extractToken(request) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

