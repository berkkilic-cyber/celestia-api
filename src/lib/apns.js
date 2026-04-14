// src/lib/apns.js
// Send a push notification to an APNs device token, signing with an .p8 key.
// Requires env.APNS_PRIVATE_KEY (.p8 contents), APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID.

function pemToArrayBuffer(pem) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function importApnsKey(pem) {
  return await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(pem),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

function base64urlFromString(str) {
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlFromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function signApnsJwt(env, key) {
  const header = { alg: 'ES256', kid: env.APNS_KEY_ID, typ: 'JWT' };
  const payload = { iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) };
  const signingInput = `${base64urlFromString(JSON.stringify(header))}.${base64urlFromString(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64urlFromBuffer(sig)}`;
}

export async function sendApnsPush({ env, token, title, body, production = true, data = {} }) {
  const key = await importApnsKey(env.APNS_PRIVATE_KEY);
  const jwt = await signApnsJwt(env, key);
  const host = production ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  const url = `https://${host}/3/device/${token}`;
  const payload = {
    aps: {
      alert: { title, body },
      sound: 'default',
    },
    ...data,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': env.APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return {
    status: res.status,
    ok: res.ok,
    apnsId: res.headers.get('apns-id'),
    body: text,
  };
}
