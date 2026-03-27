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
 * Verify the AdMob SSV signature
 * The message is the full query string up to (not including) &signature=
 */
async function verifySignature(queryString, keyId, signature) {
	const keys = await getGoogleKeys();
	const keyData = keys.find((k) => String(k.keyId) === String(keyId));
	if (!keyData) throw new Error(`Unknown key_id: ${keyId}`);

	const pubKey = await importKey(keyData.base64);

	// Message = everything before &signature=
	const sigIndex = queryString.indexOf('&signature=');
	if (sigIndex === -1) throw new Error('No signature in query string');
	const message = queryString.substring(0, sigIndex);

	// Decode base64url signature
	const sigBase64 = signature.replace(/-/g, '+').replace(/_/g, '/');
	const sigBinary = atob(sigBase64);
	const sigBytes = new Uint8Array(sigBinary.length);
	for (let i = 0; i < sigBinary.length; i++) sigBytes[i] = sigBinary.charCodeAt(i);

	const encoder = new TextEncoder();
	const messageBytes = encoder.encode(message);

	return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, sigBytes, messageBytes);
}

/**
 * Handle AdMob rewarded ad SSV callback
 * AdMob sends a GET with query params: ad_network, ad_unit, custom_data,
 * key_id, reward_amount, reward_item, signature, timestamp, transaction_id, user_id
 */
export async function handleRewardedCallback(request, env) {
	const url = new URL(request.url);
	const userId = url.searchParams.get('user_id');
	const rewardAmount = parseInt(url.searchParams.get('reward_amount'), 10);
	const rewardItem = url.searchParams.get('reward_item');
	const keyId = url.searchParams.get('key_id');
	const signature = url.searchParams.get('signature');
	const transactionId = url.searchParams.get('transaction_id');

	if (!userId || !rewardAmount || !keyId || !signature) {
		return { error: 'Missing required parameters', status: 400 };
	}

	if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
		return { error: 'Invalid reward_amount', status: 400 };
	}

	// Prevent replay: check if this transaction was already processed
	const replayKey = `ad_reward:${transactionId}`;
	if (transactionId) {
		const existing = await env.NATAL_ANALYSIS_KV.get(replayKey);
		if (existing) return { data: { success: true, message: 'Already processed' } };
	}

	// Verify Google SSV signature
	try {
		const queryString = url.search.substring(1); // remove leading ?
		const valid = await verifySignature(queryString, keyId, signature);
		if (!valid) return { error: 'Invalid signature', status: 400 };
	} catch (e) {
		console.error('[ADMOB-SSV] Verification error:', e.message);
		return { error: 'Signature verification failed', detail: e.message, status: 400 };
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
