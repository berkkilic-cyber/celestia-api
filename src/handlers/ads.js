// src/handlers/ads.js
// AdMob SSV callback: https://celestia-api.berk-kilic.workers.dev/api/ads/rewarded-callback

import { addCredits, getCredits } from '../db/credits.js';

const GOOGLE_KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
let cachedKeys = null;
let cachedKeysExpiry = 0;

/**
 * Fetch and cache Google's SSV public keys
 */
async function getGoogleKeys() {
	const now = Date.now();
	if (cachedKeys && now < cachedKeysExpiry) return cachedKeys;

	const res = await fetch(GOOGLE_KEYS_URL);
	if (!res.ok) throw new Error(`Failed to fetch Google keys: ${res.status}`);

	const data = await res.json();
	cachedKeys = data.keys;
	cachedKeysExpiry = now + 60 * 60 * 1000; // cache 1 hour
	return cachedKeys;
}

/**
 * Import an ECDSA public key from base64-encoded DER
 */
async function importKey(base64Key) {
	const binaryStr = atob(base64Key);
	const bytes = new Uint8Array(binaryStr.length);
	for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

	return crypto.subtle.importKey('spki', bytes.buffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

/**
 * Convert DER-encoded ECDSA signature to IEEE P1363 (raw r||s) format
 * Web Crypto expects P1363, but AdMob sends DER
 */
function derToP1363(derSig) {
	// DER: 30 <totalLen> 02 <rLen> <rBytes> 02 <sLen> <sBytes>
	let offset = 0;
	if (derSig[offset++] !== 0x30) throw new Error('Invalid DER signature');
	offset++; // skip total length

	// Read r
	if (derSig[offset++] !== 0x02) throw new Error('Invalid DER r marker');
	const rLen = derSig[offset++];
	let r = derSig.slice(offset, offset + rLen);
	offset += rLen;

	// Read s
	if (derSig[offset++] !== 0x02) throw new Error('Invalid DER s marker');
	const sLen = derSig[offset++];
	let s = derSig.slice(offset, offset + sLen);

	// Strip leading zero padding (DER uses it for positive sign)
	if (r.length > 32 && r[0] === 0) r = r.slice(1);
	if (s.length > 32 && s[0] === 0) s = s.slice(1);

	// Pad to 32 bytes each (P-256 = 32 byte coordinates)
	const result = new Uint8Array(64);
	result.set(r, 32 - r.length);
	result.set(s, 64 - s.length);
	return result;
}

/**
 * Verify the AdMob SSV signature
 * Per Google docs: signature and key_id are the last two params.
 * Message = query string up to (not including) &signature=
 */
async function verifySignature(rawQueryString, keyId, signature) {
	const keys = await getGoogleKeys();
	const keyData = keys.find((k) => String(k.keyId) === String(keyId));
	if (!keyData) throw new Error(`Unknown key_id: ${keyId}`);

	const pubKey = await importKey(keyData.base64);

	// Message = everything before &signature=
	const sigIndex = rawQueryString.indexOf('&signature=');
	if (sigIndex === -1) throw new Error('No signature in query string');
	const message = rawQueryString.substring(0, sigIndex);

	// Decode base64url signature
	const sigBase64 = signature.replace(/-/g, '+').replace(/_/g, '/');
	const pad = sigBase64.length % 4;
	const padded = pad ? sigBase64 + '='.repeat(4 - pad) : sigBase64;
	const sigBinary = atob(padded);
	const sigBytes = new Uint8Array(sigBinary.length);
	for (let i = 0; i < sigBinary.length; i++) sigBytes[i] = sigBinary.charCodeAt(i);

	// Convert DER to P1363 format for Web Crypto
	const p1363Sig = derToP1363(sigBytes);

	const encoder = new TextEncoder();
	const messageBytes = encoder.encode(message);

	return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, p1363Sig, messageBytes);
}

/**
 * Handle AdMob rewarded ad SSV callback
 * AdMob sends a GET with query params in alphabetical order,
 * with signature and key_id always last (in that order).
 */
export async function handleRewardedCallback(request, env) {
	const url = new URL(request.url);
	const userId = url.searchParams.get('user_id');
	const rewardAmount = parseInt(url.searchParams.get('reward_amount'), 10);
	const rewardItem = url.searchParams.get('reward_item');
	const keyId = url.searchParams.get('key_id');
	const signature = url.searchParams.get('signature');
	const transactionId = url.searchParams.get('transaction_id');

	if (!keyId || !signature) {
		return { error: 'Missing required parameters (key_id, signature)', status: 400 };
	}

	// Verify Google SSV signature using the raw query string (preserves param order)
	const rawQS = url.href.split('?')[1];
	if (!rawQS) return { error: 'Missing query string', status: 400 };

	try {
		const valid = await verifySignature(rawQS, keyId, signature);
		if (!valid) return { error: 'Invalid signature', status: 400 };
	} catch (e) {
		console.error('[ADMOB-SSV] Verification error:', e.message);
		return { error: 'Signature verification failed', detail: e.message, status: 400 };
	}

	// If no user_id or reward_amount, just acknowledge the valid callback (e.g. test pings)
	if (!userId || !rewardAmount || !Number.isFinite(rewardAmount) || rewardAmount <= 0) {
		return { data: { success: true, message: 'Verified, no reward applied' } };
	}

	// Prevent replay: check if this transaction was already processed
	const replayKey = `ad_reward:${transactionId}`;
	if (transactionId) {
		const existing = await env.NATAL_ANALYSIS_KV.get(replayKey);
		if (existing) return { data: { success: true, message: 'Already processed' } };
	}

	// Verify user exists
	const credits = await getCredits(env.celestia_db, userId);
	if (!credits) return { error: 'User not found', status: 404 };

	// Credit the user
	const newBalance = await addCredits(env.celestia_db, userId, rewardAmount, 'ad_reward');

	// Mark transaction as processed (30-day TTL)
	if (transactionId) {
		await env.NATAL_ANALYSIS_KV.put(replayKey, '1', { expirationTtl: 60 * 60 * 24 * 30 });
	}

	console.log(`[ADMOB-SSV] Credited ${rewardAmount} ${rewardItem} to user ${userId}. New balance: ${newBalance}`);
	return { data: { success: true, balance: newBalance } };
}
