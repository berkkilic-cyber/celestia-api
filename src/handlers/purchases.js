// src/handlers/purchases.js
// Handlers for Apple IAP: subscription, credit packs, restore, and App Store notifications

import { verifyAndDecodeJWS, verifyNotification } from '../auth/apple-iap.js';
import { addCredits, getCredits } from '../db/credits.js';
import {
	SUBSCRIPTION_PRODUCTS,
	CREDIT_PRODUCTS,
	getSubscription,
	upsertSubscription,
	updateSubscriptionStatus,
	renewSubscription,
	getSubscriptionByAppleId,
	isIapProcessed,
	processIapPurchase,
} from '../db/subscriptions.js';

// ── POST /purchases/verify ──────────────────────────────────────────────────
// Client sends signedTransaction from StoreKit 2 after purchase.
// Handles both subscriptions and credit packs.

export async function handleVerifyPurchase(request, env, userId) {
	const { signedTransaction } = await request.json();
	if (!signedTransaction) {
		return { error: 'signedTransaction required', status: 400 };
	}

	let txInfo;
	try {
		txInfo = await verifyAndDecodeJWS(signedTransaction);
	} catch (e) {
		console.error('[IAP] JWS verification failed:', e.message);
		return { error: 'Transaction verification failed', detail: e.message, status: 400 };
	}

	const productId = txInfo.productId;
	const transactionId = String(txInfo.transactionId);
	const originalTransactionId = String(txInfo.originalTransactionId);

	// ── Subscription purchase ────────────────────────────────────────────────
	const subProduct = SUBSCRIPTION_PRODUCTS[productId];
	if (subProduct) {
		const periodStart = Math.floor(txInfo.purchaseDate / 1000);
		const periodEnd = Math.floor(txInfo.expiresDate / 1000);

		// Check if this subscription already exists in DB
		const existingSub = await getSubscription(env.celestia_db, userId);
		const alreadyActive = existingSub && existingSub.apple_original_transaction_id === originalTransactionId && existingSub.status === 'active';

		const subscription = await upsertSubscription(env.celestia_db, userId, {
			tier: subProduct.tier,
			period: subProduct.period,
			status: 'active',
			appleOriginalTransactionId: originalTransactionId,
			periodStart,
			periodEnd,
		});

		// Grant initial credits only on first activation (not on re-verify from flush/restore)
		if (!alreadyActive) {
			await addCredits(env.celestia_db, userId, subProduct.credits, `subscription_${subProduct.tier}_initial`);
		}

		const credits = await getCredits(env.celestia_db, userId);
		return {
			data: {
				type: 'subscription',
				subscription: {
					tier: subscription.tier,
					period: subscription.period,
					status: subscription.status,
					currentPeriodEnd: subscription.current_period_end,
				},
				balance: credits.balance,
			},
		};
	}

	// ── Credit pack purchase (consumable) ────────────────────────────────────
	const creditAmount = CREDIT_PRODUCTS[productId];
	if (creditAmount) {
		// Replay prevention
		const alreadyProcessed = await isIapProcessed(env.celestia_db, transactionId);
		if (alreadyProcessed) {
			const credits = await getCredits(env.celestia_db, userId);
			return { data: { type: 'credits', alreadyProcessed: true, balance: credits.balance } };
		}

		const { newBalance } = await processIapPurchase(env.celestia_db, userId, {
			productId,
			creditsGranted: creditAmount,
			appleTransactionId: transactionId,
		});

		console.log(`[IAP] Granted ${creditAmount} credits to user ${userId} for ${productId}`);
		return {
			data: {
				type: 'credits',
				creditsGranted: creditAmount,
				balance: newBalance,
			},
		};
	}

	return { error: `Unknown product: ${productId}`, status: 400 };
}

// ── POST /purchases/restore ─────────────────────────────────────────────────
// Client sends array of signed transactions on restore purchases.

export async function handleRestorePurchases(request, env, userId) {
	const { signedTransactions } = await request.json();
	if (!Array.isArray(signedTransactions) || signedTransactions.length === 0) {
		return { error: 'signedTransactions array required', status: 400 };
	}

	let restoredSubscription = null;
	let creditsRestored = 0;

	for (const jws of signedTransactions) {
		let txInfo;
		try {
			txInfo = await verifyAndDecodeJWS(jws);
		} catch (e) {
			console.error('[RESTORE] Skipping invalid transaction:', e.message);
			continue;
		}

		const productId = txInfo.productId;

		// Restore subscription — only restore the latest valid one
		const subProduct = SUBSCRIPTION_PRODUCTS[productId];
		if (subProduct && txInfo.expiresDate) {
			const periodEnd = Math.floor(txInfo.expiresDate / 1000);
			const now = Math.floor(Date.now() / 1000);

			// Only restore if subscription hasn't expired
			if (periodEnd > now) {
				const periodStart = Math.floor(txInfo.purchaseDate / 1000);
				const originalTransactionId = String(txInfo.originalTransactionId);

				restoredSubscription = await upsertSubscription(env.celestia_db, userId, {
					tier: subProduct.tier,
					period: subProduct.period,
					status: 'active',
					appleOriginalTransactionId: originalTransactionId,
					periodStart,
					periodEnd,
				});
			}
		}

		// Restore credit packs — skip already-processed ones
		const creditAmount = CREDIT_PRODUCTS[productId];
		if (creditAmount) {
			const transactionId = String(txInfo.transactionId);
			const alreadyProcessed = await isIapProcessed(env.celestia_db, transactionId);
			if (!alreadyProcessed) {
				await processIapPurchase(env.celestia_db, userId, {
					productId,
					creditsGranted: creditAmount,
					appleTransactionId: transactionId,
				});
				creditsRestored += creditAmount;
			}
		}
	}

	const credits = await getCredits(env.celestia_db, userId);
	return {
		data: {
			restored: true,
			subscription: restoredSubscription
				? {
						tier: restoredSubscription.tier,
						period: restoredSubscription.period,
						status: restoredSubscription.status,
						currentPeriodEnd: restoredSubscription.current_period_end,
					}
				: null,
			creditsRestored,
			balance: credits.balance,
		},
	};
}

// ── GET /user/subscription ──────────────────────────────────────────────────

export async function handleGetSubscription(env, userId) {
	const sub = await getSubscription(env.celestia_db, userId);
	if (!sub) {
		return { data: { subscription: null } };
	}

	const now = Math.floor(Date.now() / 1000);
	const isActive = sub.status === 'active' && sub.current_period_end > now;

	return {
		data: {
			subscription: {
				tier: sub.tier,
				period: sub.period,
				status: isActive ? 'active' : 'expired',
				currentPeriodStart: sub.current_period_start,
				currentPeriodEnd: sub.current_period_end,
			},
		},
	};
}

// ── POST /api/apple/notifications ───────────────────────────────────────────
// App Store Server Notifications V2 webhook.

export async function handleAppleNotification(request, env) {
	const { signedPayload } = await request.json();
	if (!signedPayload) {
		return { error: 'signedPayload required', status: 400 };
	}

	let notification;
	try {
		notification = await verifyNotification(signedPayload);
	} catch (e) {
		console.error('[APPLE-NOTIFY] Verification failed:', e.message);
		return { error: 'Notification verification failed', status: 400 };
	}

	const { notificationType, subtype } = notification;
	const txInfo = notification.data?.transactionInfo;

	if (!txInfo) {
		console.log(`[APPLE-NOTIFY] ${notificationType} — no transaction info, acknowledging`);
		return { data: { ok: true } };
	}

	const originalTransactionId = String(txInfo.originalTransactionId);
	const productId = txInfo.productId;
	const subProduct = SUBSCRIPTION_PRODUCTS[productId];

	console.log(`[APPLE-NOTIFY] ${notificationType}/${subtype || '-'} for ${productId} (origTx: ${originalTransactionId})`);

	switch (notificationType) {
		case 'DID_RENEW': {
			if (!subProduct) break;
			const transactionId = String(txInfo.transactionId);
			const periodStart = Math.floor(txInfo.purchaseDate / 1000);
			const periodEnd = Math.floor(txInfo.expiresDate / 1000);
			await renewSubscription(env.celestia_db, originalTransactionId, periodStart, periodEnd);

			// Grant renewal credits — deduplicate by transaction ID
			const renewalKey = `renewal:${transactionId}`;
			const alreadyGranted = await env.NATAL_ANALYSIS_KV.get(renewalKey);
			if (!alreadyGranted) {
				const sub = await getSubscriptionByAppleId(env.celestia_db, originalTransactionId);
				if (sub) {
					await addCredits(env.celestia_db, sub.user_id, subProduct.credits, 'subscription_renewal');
					await env.NATAL_ANALYSIS_KV.put(renewalKey, '1', { expirationTtl: 60 * 60 * 24 * 45 });
					console.log(`[APPLE-NOTIFY] Renewed + granted ${subProduct.credits} credits to user ${sub.user_id}`);
				}
			} else {
				console.log(`[APPLE-NOTIFY] Renewal ${transactionId} already granted, skipping`);
			}
			break;
		}

		case 'EXPIRED':
		case 'DID_FAIL_TO_RENEW': {
			await updateSubscriptionStatus(env.celestia_db, originalTransactionId, 'expired');
			break;
		}

		case 'REFUND':
		case 'REVOKE': {
			await updateSubscriptionStatus(env.celestia_db, originalTransactionId, 'revoked');
			break;
		}

		case 'DID_CHANGE_RENEWAL_STATUS': {
			// User toggled auto-renew on/off — we just log it, status stays active until expiry
			const autoRenew = subtype === 'AUTO_RENEW_ENABLED';
			console.log(`[APPLE-NOTIFY] Auto-renew ${autoRenew ? 'enabled' : 'disabled'} for ${originalTransactionId}`);
			break;
		}

		case 'SUBSCRIBED': {
			// Initial subscription or resubscribe — handled by /purchases/verify from client
			// But we handle it here too in case the client call failed
			if (!subProduct) break;
			const sub = await getSubscriptionByAppleId(env.celestia_db, originalTransactionId);
			if (sub) {
				const periodStart = Math.floor(txInfo.purchaseDate / 1000);
				const periodEnd = Math.floor(txInfo.expiresDate / 1000);
				await renewSubscription(env.celestia_db, originalTransactionId, periodStart, periodEnd);
			}
			break;
		}

		default:
			console.log(`[APPLE-NOTIFY] Unhandled notification type: ${notificationType}`);
	}

	return { data: { ok: true } };
}
