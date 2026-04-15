// src/handlers/tarot.js
// import { callLlama } from '../lib/llama.js';
import { callOpenAI } from '../lib/openai.js';
import { pickLocale } from '../lib/locale.js';
import { tarotPrompt } from '../prompts.js';

const VALID_SPREAD_TYPES = ['single_card', 'yes_no', 'three_card', 'love', 'career', 'celtic_cross'];

const SPREAD_CARD_COUNTS = {
	single_card: 1,
	yes_no: 1,
	three_card: 3,
	love: 5,
	career: 5,
	celtic_cross: 10,
};

const SPREAD_POSITIONS = {
	single_card: ['Kart'],
	yes_no: ['Kart'],
	three_card: ['Geçmiş', 'Şimdi', 'Gelecek'],
	love: ['Durum', 'Zorluk', 'Tavsiye', 'Sonuç', 'Anahtar Enerji'],
	career: ['Durum', 'Zorluk', 'Tavsiye', 'Sonuç', 'Anahtar Enerji'],
	celtic_cross: ['Şimdi', 'Zorluk', 'Geçmiş', 'Gelecek', 'Yukarı', 'Aşağı', 'Tavsiye', 'Dış Etki', 'Umutlar/Korkular', 'Sonuç'],
};

// const CFG = { model: 'llama-3.1-8b-instant', max_output_tokens: 1500, temperature: 0.85 };
const CFG = { model: 'gpt-4o-mini', max_output_tokens: 1500, temperature: 0.85 };

function parseResponse(text) {
	console.log('[TAROT-DEBUG] Raw response length:', text?.length);
	console.log('[TAROT-DEBUG] First 400 chars:', text?.substring(0, 400));

	let cleaned = text
		.trim()
		.replace(/^```(?:json)?\s*\n?/i, '')
		.replace(/\n?```\s*$/i, '');

	// Try to extract JSON if there's extra text
	const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		cleaned = jsonMatch[0];
		console.log('[TAROT-DEBUG] Extracted JSON from text');
	}

	let parsed;
	try {
		parsed = JSON.parse(cleaned);
	} catch (parseErr) {
		console.error('[TAROT-DEBUG] JSON parse error:', parseErr.message);
		throw new Error(`Invalid JSON: ${parseErr.message}`);
	}

	if (typeof parsed.reading !== 'string' || !parsed.reading.trim()) {
		console.error('[TAROT-DEBUG] Missing or empty reading');
		throw new Error('reading must be a non-empty string');
	}
	if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) {
		console.error('[TAROT-DEBUG] Missing or empty summary');
		throw new Error('summary must be a non-empty string');
	}
	if (!Array.isArray(parsed.cards)) {
		console.error('[TAROT-DEBUG] Cards is not an array');
		throw new Error('cards must be an array');
	}

	for (let i = 0; i < parsed.cards.length; i++) {
		const card = parsed.cards[i];
		if (typeof card.name !== 'string' || !card.name.trim()) {
			console.error(`[TAROT-DEBUG] Card ${i}: missing or empty name`);
			throw new Error(`Card ${i}: name must be a non-empty string`);
		}
		if (typeof card.reversed !== 'boolean') {
			console.error(`[TAROT-DEBUG] Card ${i}: reversed is not boolean`);
			throw new Error(`Card ${i}: reversed must be boolean`);
		}
		if (typeof card.positionLabel !== 'string' || !card.positionLabel.trim()) {
			console.error(`[TAROT-DEBUG] Card ${i}: missing or empty positionLabel`);
			throw new Error(`Card ${i}: positionLabel must be non-empty`);
		}
		if (typeof card.interpretation !== 'string' || !card.interpretation.trim()) {
			console.error(`[TAROT-DEBUG] Card ${i} (${card.name}): MISSING OR EMPTY INTERPRETATION`);
			throw new Error(
				`Card ${i} (${card.name}): interpretation is REQUIRED and must be non-empty. Every card must have a detailed explanation.`,
			);
		}
		console.log(`[TAROT-DEBUG] Card ${i}: "${card.name}" ✓ has interpretation (${card.interpretation.length} chars)`);
	}

	console.log('[TAROT-DEBUG] ✓ All cards validated with interpretations');
	return {
		reading: parsed.reading,
		summary: parsed.summary,
		cards: parsed.cards.map((c) => ({
			name: c.name,
			reversed: c.reversed,
			positionLabel: c.positionLabel,
			interpretation: c.interpretation,
		})),
	};
}

export async function handleTarot(request, env) {
	const body = await request.json();
	const { spreadType, cards, question, lang } = body;

	if (!spreadType || !VALID_SPREAD_TYPES.includes(spreadType)) {
		return { error: `spreadType must be one of: ${VALID_SPREAD_TYPES.join(', ')}`, status: 400 };
	}

	const expectedCount = SPREAD_CARD_COUNTS[spreadType];
	if (!Array.isArray(cards) || cards.length !== expectedCount) {
		return { error: `${spreadType} requires exactly ${expectedCount} card(s)`, status: 400 };
	}

	for (let i = 0; i < cards.length; i++) {
		if (!cards[i]?.name?.trim()) return { error: `cards[${i}] must have a non-empty name`, status: 400 };
		if (typeof cards[i].reversed !== 'boolean') return { error: `cards[${i}].reversed must be a boolean`, status: 400 };
	}

	const locale = pickLocale(lang);
	const { system, user } = tarotPrompt({
		spreadType,
		cards,
		positions: SPREAD_POSITIONS[spreadType],
		question,
		locale,
		expectedCount,
	});

	for (let attempt = 0; attempt < 2; attempt++) {
		const out = await callOpenAI(env, CFG, system, user);

		console.log(`[TAROT] Attempt ${attempt + 1} - API Response:`, {
			error: out?.error,
			hasText: !!out?.text,
			textLength: out?.text?.length,
			first300: out?.text?.substring(0, 300),
		});

		if (out?.error) {
			console.error('[TAROT] API Error:', out.error);
			return { error: out.error, details: out.raw, status: out.status || 500 };
		}

		try {
			const result = parseResponse(out.text);
			console.log('[TAROT] ✓ Successfully parsed tarot reading');
			return { data: result };
		} catch (e) {
			console.error(`[TAROT] ✗ Parse attempt ${attempt + 1} failed:`, e.message);
			if (attempt === 1) {
				console.error('[TAROT] Full output:', out.text);
				return { error: 'Failed to parse AI response', detail: e.message, fullOutput: out.text, status: 502 };
			}
		}
	}
}
