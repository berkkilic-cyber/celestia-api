// src/lib/locale.js

export function pickLocale(lang) {
  if (!lang) return "en-US";
  const s = String(lang).toLowerCase();
  if (s.startsWith("tr")) return "tr-TR";
  if (s.startsWith("de")) return "de-DE";
  if (s.startsWith("fr")) return "fr-FR";
  if (s.startsWith("ar")) return "ar";
  if (s.startsWith("hi")) return "hi";
  if (s.startsWith("pt")) return "pt-BR";
  if (s.startsWith("es")) return "es";
  if (s.startsWith("zh")) return "zh";
  return "en-US";
}

export function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

export function requireBirthData(bd) {
  if (!bd) return "Missing birthData";
  const { year, month, day } = bd;
  if (!year || !month || !day) return "birthData must include year, month, day";
  return null;
}
