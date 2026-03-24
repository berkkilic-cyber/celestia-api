// src/lib/llama.js

async function callRaw(env, cfg, input) {
	if (!env.LLAMA_API_KEY) {
		return { error: 'Missing LLAMA_API_KEY secret on Worker', status: 500 };
	}

	const LLAMA_API_URL = env.LLAMA_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
	//   LLAMA_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
	//   LLAMA_API_URL = 'https://api.together.xyz/v1/chat/completions';

	const res = await fetch(LLAMA_API_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.LLAMA_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: cfg.model,
			messages: input,
			temperature: cfg.temperature,
			max_tokens: cfg.max_output_tokens,
		}),
	});

	const raw = await res.json();
	if (!res.ok) {
		return { error: raw?.error?.message || 'Llama API error', status: res.status, raw };
	}

	const text = raw?.choices?.[0]?.message?.content?.trim() || '';

	return { text, raw };
}

/**
 * Call Llama with a system + user message pair
 */
export async function callLlama(env, cfg, system, user) {
	return callRaw(env, cfg, [
		{ role: 'system', content: system },
		{ role: 'user', content: user },
	]);
}

/**
 * Call Llama with a full messages array (for chat sessions)
 */
export async function callLlamaChat(env, cfg, messages) {
	return callRaw(env, cfg, messages);
}
