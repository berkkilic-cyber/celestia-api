// src/auth/apple-iap.js
// Verify Apple StoreKit 2 signed transactions (JWS / App Store Server Notifications V2)

const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
let cachedAppleKeys = null;
let cachedAppleKeysExpiry = 0;

/**
 * Decode a base64url string to a UTF-8 string
 */
function base64UrlDecode(str) {
	const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
	const binary = atob(padded);
	return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/**
 * Decode base64url to raw bytes
 */
function base64UrlToBytes(str) {
	const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
	const binary = atob(padded);
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Fetch and cache Apple's public keys
 */
async function getAppleKeys() {
	const now = Date.now();
	if (cachedAppleKeys && now < cachedAppleKeysExpiry) return cachedAppleKeys;

	const res = await fetch(APPLE_KEYS_URL);
	if (!res.ok) throw new Error(`Failed to fetch Apple keys: ${res.status}`);

	const data = await res.json();
	cachedAppleKeys = data.keys;
	cachedAppleKeysExpiry = now + 60 * 60 * 1000; // 1 hour cache
	return cachedAppleKeys;
}

/**
 * Extract the certificate chain from JWS header and derive the public key.
 * Apple's App Store signed transactions use x5c (certificate chain) in the header.
 * Falls back to kid-based lookup from Apple's public keys endpoint.
 */
async function getSigningKey(header) {
	// App Store JWS uses x5c certificate chain
	if (header.x5c && header.x5c.length > 0) {
		const certDer = base64UrlToBytes(
			header.x5c[0].replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '')
		);

		// The leaf certificate's public key — import as X.509
		// Apple uses ES256 (ECDSA P-256) for App Store signed data
		return crypto.subtle.importKey('spki', extractSpkiFromCert(certDer), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
	}

	// Fallback: use kid from Apple's published keys
	if (header.kid) {
		const keys = await getAppleKeys();
		const key = keys.find((k) => k.kid === header.kid);
		if (!key) throw new Error(`Apple key not found for kid: ${header.kid}`);

		const alg = key.kty === 'EC' ? { name: 'ECDSA', namedCurve: key.crv || 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
		const usage = ['verify'];
		return crypto.subtle.importKey('jwk', key, alg, false, usage);
	}

	throw new Error('No x5c chain or kid in JWS header');
}

/**
 * Extract SubjectPublicKeyInfo (SPKI) from a DER-encoded X.509 certificate.
 * Finds the SPKI structure within the TBS certificate.
 */
function extractSpkiFromCert(certDer) {
	// X.509 DER structure:
	// SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
	// tbsCertificate: SEQUENCE { version, serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo, ... }
	// We need to find subjectPublicKeyInfo — the 7th element in tbsCertificate

	let offset = 0;

	function readTag() {
		const tag = certDer[offset++];
		return tag;
	}

	function readLength() {
		let len = certDer[offset++];
		if (len & 0x80) {
			const numBytes = len & 0x7f;
			len = 0;
			for (let i = 0; i < numBytes; i++) {
				len = (len << 8) | certDer[offset++];
			}
		}
		return len;
	}

	function skipElement() {
		readTag();
		const len = readLength();
		offset += len;
	}

	function readElement() {
		const start = offset;
		readTag();
		const len = readLength();
		const end = offset + len;
		offset = end;
		return certDer.slice(start, end);
	}

	// Outer SEQUENCE (Certificate)
	readTag(); // 0x30
	readLength();

	// TBS Certificate SEQUENCE
	readTag(); // 0x30
	readLength();

	// [0] version (explicit tag)
	if (certDer[offset] === 0xa0) {
		skipElement();
	}

	// serialNumber
	skipElement();
	// signature algorithm
	skipElement();
	// issuer
	skipElement();
	// validity
	skipElement();
	// subject
	skipElement();

	// subjectPublicKeyInfo — this is what we need
	const spki = readElement();
	return spki.buffer.slice(spki.byteOffset, spki.byteOffset + spki.byteLength);
}

/**
 * Verify and decode an Apple JWS signed transaction or notification.
 * Returns the decoded payload object.
 */
export async function verifyAndDecodeJWS(jws) {
	const parts = jws.split('.');
	if (parts.length !== 3) throw new Error('Invalid JWS format');

	const [headerB64, payloadB64, signatureB64] = parts;
	const header = JSON.parse(base64UrlDecode(headerB64));

	// Verify algorithm is ES256
	if (header.alg !== 'ES256') throw new Error(`Unsupported JWS algorithm: ${header.alg}`);

	// Get the signing key
	const publicKey = await getSigningKey(header);

	// Verify signature
	const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
	const signature = base64UrlToBytes(signatureB64);

	const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, data);
	if (!valid) throw new Error('JWS signature verification failed');

	// Decode and return payload
	return JSON.parse(base64UrlDecode(payloadB64));
}

/**
 * Verify an App Store Server Notification V2.
 * The outer JWS contains a signedPayload which itself is a JWS containing the notification data.
 */
export async function verifyNotification(signedPayload) {
	const outer = await verifyAndDecodeJWS(signedPayload);

	// The notification data contains a signedTransactionInfo and optionally signedRenewalInfo
	const result = { ...outer };

	if (outer.data?.signedTransactionInfo) {
		result.data.transactionInfo = await verifyAndDecodeJWS(outer.data.signedTransactionInfo);
	}

	if (outer.data?.signedRenewalInfo) {
		result.data.renewalInfo = await verifyAndDecodeJWS(outer.data.signedRenewalInfo);
	}

	return result;
}
