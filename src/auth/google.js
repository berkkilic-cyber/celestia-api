// src/auth/google.js
// Verifies Google identity token and returns user info

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUER = ['accounts.google.com', 'https://accounts.google.com'];

/**
 * Decode a base64url string
 */
function base64UrlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}

/**
 * Fetch Google's public keys and find the one matching the token's kid
 */
async function getGooglePublicKey(kid) {
  const res = await fetch(GOOGLE_CERTS_URL);
  const { keys } = await res.json();
  const key = keys.find(k => k.kid === kid);
  if (!key) throw new Error('Google public key not found');
  return await crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

/**
 * Verify Google identity token
 * Returns decoded payload if valid
 */
export async function verifyGoogleToken(identityToken, clientId) {
  const parts = identityToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(base64UrlDecode(headerB64));
  const payload = JSON.parse(base64UrlDecode(payloadB64));

  // Verify expiry
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Google token expired');
  }

  // Verify issuer
  if (!GOOGLE_ISSUER.includes(payload.iss)) {
    throw new Error('Invalid Google token issuer');
  }

  // Verify audience matches your client ID
  if (payload.aud !== clientId) {
    throw new Error('Google token audience mismatch');
  }

  // Verify signature
  const publicKey = await getGooglePublicKey(header.kid);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = Uint8Array.from(
    atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')),
    c => c.charCodeAt(0)
  );

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    signature,
    data
  );

  if (!valid) throw new Error('Google token signature invalid');

  return {
    google_user_id: payload.sub,
    email: payload.email || null,
    email_verified: payload.email_verified || false,
    name: payload.name || null,
    picture: payload.picture || null,
  };
}
