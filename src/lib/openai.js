// src/lib/openai.js

async function callRaw(env, cfg, input) {
  if (!env.OPENAI_API_KEY) {
    return { error: "Missing OPENAI_API_KEY secret on Worker", status: 500 };
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      input,
      temperature: cfg.temperature,
      max_output_tokens: cfg.max_output_tokens,
    }),
  });

  const raw = await res.json();
  if (!res.ok) {
    return { error: raw?.error?.message || "OpenAI error", status: res.status, raw };
  }

  const chunks = raw?.output?.flatMap((o) => o?.content || []).filter(Boolean) || [];
  const text = chunks
    .map((c) => (c?.type === "output_text" ? c?.text : ""))
    .filter(Boolean)
    .join("")
    .trim();

  return { text, raw };
}

/**
 * Call OpenAI with a system + user message pair
 */
export async function callOpenAI(env, cfg, system, user) {
  return callRaw(env, cfg, [
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
}

/**
 * Call OpenAI with a full messages array (for chat sessions)
 */
export async function callOpenAIChat(env, cfg, messages) {
  return callRaw(env, cfg, messages);
}
