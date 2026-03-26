// src/handlers/tarot.js
import { callLlama } from '../lib/llama.js';
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

const CFG = { model: 'llama-3.1-8b-instant', max_output_tokens: 1500, temperature: 0.85 };

function formatCards(cards, spreadType) {
	const positions = SPREAD_POSITIONS[spreadType];
	return cards.map((c, i) => `Position ${i + 1} (${positions[i]}): ${c.name}${c.reversed ? ' (Reversed)' : ''}`).join('\n');
}

function parseResponse(text) {
	let cleaned = text
		.trim()
		.replace(/^```(?:json)?\s*\n?/i, '')
		.replace(/\n?```\s*$/i, '');
	const parsed = JSON.parse(cleaned);

	if (typeof parsed.reading !== 'string' || !parsed.reading.trim()) throw new Error('reading must be a non-empty string');
	if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) throw new Error('summary must be a non-empty string');
	if (!Array.isArray(parsed.cards)) throw new Error('cards must be an array');

	for (const card of parsed.cards) {
		if (typeof card.name !== 'string' || !card.name.trim()) throw new Error('Each card must have a non-empty name');
		if (typeof card.reversed !== 'boolean') throw new Error('Each card must have a boolean reversed field');
		if (typeof card.positionLabel !== 'string' || !card.positionLabel.trim())
			throw new Error('Each card must have a non-empty positionLabel');
		if (typeof card.interpretation !== 'string' || !card.interpretation.trim())
			throw new Error('Each card must have a non-empty interpretation');
	}

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
				'Write entirely in Turkish with correct Turkish characters (ç, ş, ğ, ı, ö, ü, İ). Use warm, intimate Turkish language that honors the spiritual depth. Speak with the familiarity and care of someone who truly knows them.',
			'de-DE':
				'Write entirely in German with precision and thoughtful clarity. German astrology values substantive insight—be specific and grounded. Use "du" to create warmth and directness.',
			'fr-FR':
				'Write entirely in French with poetic elegance and personal warmth. French astrology values nuance and soul connection—incorporate this into your language. Use "tu" form for intimacy.',
			en: 'Write entirely in English with conversational warmth and wisdom. Speak directly with "you," creating a tone of intimate mentorship.',
		}[locale] ||
		'Write entirely in English with conversational warmth and wisdom. Speak directly with "you," creating a tone of intimate mentorship.';

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
		`Spread type: ${spreadType}`,
		`Tone: ${TONE_MAP[spreadType]}`,
		'',
		'Cards drawn:',
		formatCards(cards, spreadType),
		questionLine,
		'',
		'Return ONLY valid JSON with this exact structure, no markdown, no preamble:',
		'{',
		'  "reading": "<250-300 word reading split into 2-3 short paragraphs separated by \\n\\n>",',
		'  "summary": "<1-2 sentence summary of the overall message>",',
		'  "cards": [',
		'    { "name": "<card name>", "reversed": <bool>, "positionLabel": "<label>", "interpretation": "<2-3 sentences>" }',
		'  ]',
		'}',
		`The cards array must have exactly ${expectedCount} element(s), matching positions: ${SPREAD_POSITIONS[spreadType].join(', ')}.`,
	].join('\n');

	for (let attempt = 0; attempt < 2; attempt++) {
		const out = await callLlama(env, CFG, system, user);
		if (out?.error) return { error: out.error, details: out.raw, status: out.status || 500 };
		try {
			return { data: parseResponse(out.text) };
		} catch (e) {
			if (attempt === 1) return { error: 'Failed to parse AI response', detail: e.message, status: 502 };
		}
	}
}
