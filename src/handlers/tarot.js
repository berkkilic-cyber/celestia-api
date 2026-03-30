// src/handlers/tarot.js
// import { callLlama } from '../lib/llama.js';
import { callOpenAI } from '../lib/openai.js';
import { pickLocale } from '../lib/locale.js';

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

const TONE_MAP = {
	single_card: 'reflective and personal',
	yes_no: 'direct and clear',
	three_card: 'narrative and flowing',
	love: 'warm and romantic',
	career: 'professional and strategic',
	celtic_cross: 'deep and comprehensive',
};

// const CFG = { model: 'llama-3.1-8b-instant', max_output_tokens: 1500, temperature: 0.85 };
const CFG = { model: 'gpt-4o-mini', max_output_tokens: 1500, temperature: 0.85 };

function formatCards(cards, spreadType) {
	const positions = SPREAD_POSITIONS[spreadType];
	return cards.map((c, i) => `Position ${i + 1} (${positions[i]}): ${c.name}${c.reversed ? ' (Reversed)' : ''}`).join('\n');
}

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
	const langInstruction =
		{
			'tr-TR':
				'Write ENTIRELY in Turkish with CORRECT Turkish characters ALWAYS (ç, ş, ğ, ı, ö, ü, İ). Never use c instead of ç, s instead of ş, g instead of ğ, etc. Check spelling carefully. Use warm, intimate Turkish language that honors spiritual depth. Speak with familiarity and care. Use "sen" for directness',
			'de-DE':
				'Write ENTIRELY in German with correct spelling and grammar. German values precision and substantive insight—be specific, grounded, and accurate. Use "du" form for warmth and directness. Proofread for accurate spelling.',
			'fr-FR':
				'Write ENTIRELY in French with elegant, poetic language and correct spelling. French values nuance and soul connection—incorporate this with linguistic precision. Use "tu" form for intimacy. Ensure all accents (é, è, ê, à, ù, etc.) are correct.',
			en: 'Write ENTIRELY in English with conversational warmth, wisdom, and correct spelling. Speak directly with "you," creating intimate mentorship. Proofread for accuracy and clarity.',
		}[locale] ||
		'Write ENTIRELY in English with conversational warmth, wisdom, and correct spelling. Speak directly with "you," creating intimate mentorship. Proofread for accuracy and clarity.';

	const system = [
		'You are a wise, compassionate tarot reader creating deeply personal, meaningful readings.',
		langInstruction,
		"Your voice is warm, never clinical—speak like you truly understand the querent's heart.",
		'Tone: calm, premium, grounded, uplifting. Mirror hope without false promises. No emojis. No disclaimers.',
		'Let the cards tell their story, and help the person hear what they need to know.',
	].join('\n');

	const questionLine = question?.trim()
		? `\nThe querent's question: "${question.trim()}"\nAddress this question directly in your reading.`
		: '';

	const user = [
		'CRITICAL: Every card MUST have a detailed interpretation. No exceptions.',
		'Return ONLY valid JSON with this exact structure, no markdown, no preamble:',
		'',
		'{',
		'  "reading": "<250-300 word reading split into 2-3 short paragraphs separated by two newlines>",',
		'  "summary": "<1-2 sentence summary of the overall message>",',
		'  "cards": [',
		'    { "name": "<card name>", "reversed": <bool>, "positionLabel": "<position label>", "interpretation": "<2-3 sentences of detailed explanation specific to this position>" }',
		'  ]',
		'}',
		'',
		`Spread type: ${spreadType}`,
		`Tone: ${TONE_MAP[spreadType]}`,
		'',
		'Cards drawn:',
		formatCards(cards, spreadType),
		questionLine,
		'',
		`The cards array MUST have exactly ${expectedCount} element(s) in this exact order: ${SPREAD_POSITIONS[spreadType].join(', ')}.`,
		'EVERY card must have a non-empty interpretation field explaining its meaning in this position.',
		'The interpretation should be specific to the card, position, and question (if any).',
	].join('\n');

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
