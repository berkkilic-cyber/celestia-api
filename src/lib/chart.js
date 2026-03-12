// src/lib/chart.js

function signName(p) {
  return p?.sign ?? "Unknown";
}

function fmtPlanet(p) {
  if (!p) return null;
  const rx = p.retrograde ? " (R)" : "";
  const house = Number.isFinite(p.house) ? `H${p.house}` : "H?";
  const deg = Number.isFinite(p.deg) ? `${p.deg}°` : "";
  const min = Number.isFinite(p.min) ? `${String(p.min).padStart(2, "0")}` : "";
  const d = deg && min ? `${deg}${min}` : deg || "";
  return `${p.name}: ${signName(p)} ${house}${d ? ` @${d}` : ""}${rx}`;
}

function pickPlanet(chart, name) {
  return chart?.planets?.find((p) => p?.name === name) || null;
}

export function buildChartFacts(chart) {
  if (!chart) return null;

  const asc = chart?.ascDetail
    ? `Ascendant: ${chart.ascDetail.sign} @${chart.ascDetail.deg}°${String(chart.ascDetail.min).padStart(2, "0")} (H1 starts near ${Math.round(chart.asc)}°)`
    : chart?.asc ? `Ascendant: ${Math.round(chart.asc)}°` : null;

  const mc = chart?.mcDetail
    ? `Midheaven (MC): ${chart.mcDetail.sign} @${chart.mcDetail.deg}°${String(chart.mcDetail.min).padStart(2, "0")}`
    : chart?.mc ? `Midheaven (MC): ${Math.round(chart.mc)}°` : null;

  const planets = [
    "Sun","Moon","Mercury","Venus","Mars",
    "Jupiter","Saturn","Uranus","Neptune","Pluto",
    "North Node","South Node",
  ].map((n) => fmtPlanet(pickPlanet(chart, n)));

  const houses = Array.isArray(chart?.houses) && chart.houses.length === 12
    ? `House cusps (deg): ${chart.houses.map((h) => Math.round(h)).join(", ")}`
    : null;

  return [asc, mc, ...planets, houses].filter(Boolean).join("\n");
}

export function formatSynastryAspects(aspects) {
  if (!Array.isArray(aspects) || aspects.length === 0) return "(none)";
  return aspects
    .map((a) => `${a.planet1} ${a.aspect} ${a.planet2} (orb ${a.orb}°)`)
    .join("\n");
}
