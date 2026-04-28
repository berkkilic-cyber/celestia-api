// src/db/subscriptions.js
// D1 queries for subscriptions and IAP purchases

import { addCredits } from './credits.js';

// ── Product Definitions ─────────────────────────────────────────────────────

export const SUBSCRIPTION_PRODUCTS = {
	'com.bkpersonalprojects.celestia.premium.monthly': { tier: 'premium', period: 'monthly', credits: 60 },
	'com.bkpersonalprojects.celestia.premium.yearly': { tier: 'premium', period: 'yearly', credits: 60 },
	'com.bkpersonalprojects.celestia.premiumplus.monthly': { tier: 'premium_plus', period: 'monthly', credits: 200 },
	'com.bkpersonalprojects.celestia.premiumplus.yearly': { tier: 'premium_plus', period: 'yearly', credits: 200 },
};

export const CREDIT_PRODUCTS = {
	'com.bkpersonalprojects.celestia.credits.10': 10,
	'com.bkpersonalprojects.celestia.credits.30': 30,
	'com.bkpersonalprojects.celestia.credits.75': 75,
	'com.bkpersonalprojects.celestia.credits.200': 200,
};

// ── Subscription Operations ─────────────────────────────────────────────────

/**
 * Get current subscription for a user
 */
export async function getSubscription(db, userId) {
	return db.prepare(`SELECT * FROM subscriptions WHERE user_id = ?`).bind(userId).first();
}

/**
 * Create or update a subscription after a verified purchase.
 * Returns the upserted subscription row.
 */
export async function upsertSubscription(db, userId, { tier, period, status, appleOriginalTransactionId, periodStart, periodEnd }) {
	const existing = await getSubscription(db, userId);

	if (existing) {
		await db
			.prepare(
				`UPDATE subscriptions
			 SET tier = ?, period = ?, status = ?, apple_original_transaction_id = ?,
			     current_period_start = ?, current_period_end = ?
			 WHERE user_id = ?`
			)
			.bind(tier, period, status, appleOriginalTransactionId, periodStart, periodEnd, userId)
			.run();
	} else {
		const id = crypto.randomUUID();
		await db
			.prepare(
				`INSERT INTO subscriptions (id, user_id, tier, period, status, apple_original_transaction_id, current_period_start, current_period_end)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(id, userId, tier, period, status, appleOriginalTransactionId, periodStart, periodEnd)
			.run();
	}

	return getSubscription(db, userId);
}

/**
 * Update subscription status (for expirations, refunds, etc.)
 */
export async function updateSubscriptionStatus(db, appleOriginalTransactionId, status) {
	await db
		.prepare(`UPDATE subscriptions SET status = ? WHERE apple_original_transaction_id = ?`)
		.bind(status, appleOriginalTransactionId)
		.run();
}

/**
 * Update subscription period dates on renewal
 */
export async function renewSubscription(db, appleOriginalTransactionId, periodStart, periodEnd) {
	await db
		.prepare(
			`UPDATE subscriptions SET status = 'active', current_period_start = ?, current_period_end = ?
		 WHERE apple_original_transaction_id = ?`
		)
		.bind(periodStart, periodEnd, appleOriginalTransactionId)
		.run();
}

/**
 * Find subscription by Apple original transaction ID
 */
export async function getSubscriptionByAppleId(db, appleOriginalTransactionId) {
	return db.prepare(`SELECT * FROM subscriptions WHERE apple_original_transaction_id = ?`).bind(appleOriginalTransactionId).first();
}

// ── IAP Credit Pack Operations ──────────────────────────────────────────────

/**
 * Check if a credit pack purchase was already processed (replay prevention)
 */
export async function isIapProcessed(db, appleTransactionId) {
	const row = await db.prepare(`SELECT id FROM iap_purchases WHERE apple_transaction_id = ?`).bind(appleTransactionId).first();
	return !!row;
}

/**
 * Record a credit pack purchase and grant credits
 */
export async function processIapPurchase(db, userId, { productId, creditsGranted, appleTransactionId }) {
	const id = crypto.randomUUID();
	await db
		.prepare(
			`INSERT INTO iap_purchases (id, user_id, product_id, credits_granted, apple_transaction_id)
		 VALUES (?, ?, ?, ?, ?)`
		)
		.bind(id, userId, productId, creditsGranted, appleTransactionId)
		.run();

	const newBalance = await addCredits(db, userId, creditsGranted, `iap_${productId}`);
	return { id, newBalance };
}
