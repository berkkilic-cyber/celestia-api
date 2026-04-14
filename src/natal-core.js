// src/natal-core.js
// Natal & composite chart computation using celestine (Swiss Ephemeris algorithms)
import { calculateChart } from 'celestine';

function norm360(x) {
  const r = x % 360;
  return r < 0 ? r + 360 : r;
}

const SIGNS = [
  'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
  'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
];

function parseZodiac(lon) {
  const signIndex = Math.floor(lon / 30);
  const sign = SIGNS[signIndex];
  const degInSign = lon - signIndex * 30;
  const deg = Math.floor(degInSign);
  const min = Math.floor((degInSign - deg) * 60);
  return { sign, deg, min, signIndex: signIndex + 1 };
}

const PLANET_GLYPHS = {
  Sun: '☉', Moon: '☽', Mercury: '☿', Venus: '♀', Mars: '♂',
  Jupiter: '♃', Saturn: '♄', Uranus: '♅', Neptune: '♆', Pluto: '♇',
};

const INCLUDED_PLANETS = new Set(Object.keys(PLANET_GLYPHS));

function shortArcMidpoint(lon1, lon2) {
  let diff = lon2 - lon1;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return norm360(lon1 + diff / 2);
}

function planetHousePlacidus(lon, cusps) {
  for (let i = 0; i < 12; i++) {
    const start = cusps[i];
    const end = cusps[(i + 1) % 12];
    if (start < end) {
      if (lon >= start && lon < end) return i + 1;
    } else {
      if (lon >= start || lon < end) return i + 1;
    }
  }
  return 1;
}

function runChart(year, month, day, hour, minute, tzOffsetMinutes, latitude, longitude) {
  const timezone = tzOffsetMinutes / 60;
  return calculateChart({
    year, month, day, hour, minute, second: 0,
    latitude, longitude, timezone,
    houseSystem: 'placidus',
  });
}

export function computeNatal(p) {
  const { year, month, day, hour, minute, tzOffsetMinutes, latitude, longitude } = p;

  const chart = runChart(year, month, day, hour, minute, tzOffsetMinutes, latitude, longitude);

  const asc = chart.angles.ascendant.longitude;
  const mc = chart.angles.midheaven.longitude;
  const houses = chart.houses.cusps.map(c => c.longitude);

  const planets = chart.planets
    .filter(cp => INCLUDED_PLANETS.has(cp.name))
    .map(cp => ({
      name: cp.name,
      glyph: PLANET_GLYPHS[cp.name] || '',
      lon: cp.longitude,
      retrograde: cp.isRetrograde,
      house: cp.house,
      ...parseZodiac(cp.longitude),
    }));

  // Nodes
  for (const node of chart.nodes) {
    const isNorth = node.name === 'North Node';
    planets.push({
      name: node.name,
      glyph: isNorth ? '☊' : '☋',
      lon: node.longitude,
      retrograde: false,
      house: node.house,
      ...parseZodiac(node.longitude),
    });
  }

  return {
    asc,
    mc,
    houses,
    ascDetail: { lon: asc, ...parseZodiac(asc) },
    mcDetail: { lon: mc, ...parseZodiac(mc) },
    planets,
  };
}

export function computeComposite(person1, person2) {
  const chart1 = computeNatal(person1);
  const chart2 = computeNatal(person2);

  const asc = shortArcMidpoint(chart1.asc, chart2.asc);
  const mc = shortArcMidpoint(chart1.mc, chart2.mc);

  const houses = chart1.houses.map((c, i) =>
    shortArcMidpoint(c, chart2.houses[i])
  );

  const planets = chart1.planets.map((p1) => {
    const p2 = chart2.planets.find((p) => p.name === p1.name);
    if (!p2) return p1;
    const lon = shortArcMidpoint(p1.lon, p2.lon);
    const retrograde = p1.retrograde && p2.retrograde;
    const house = planetHousePlacidus(lon, houses);
    return {
      name: p1.name,
      glyph: p1.glyph,
      lon,
      retrograde,
      house,
      ...parseZodiac(lon),
    };
  });

  return {
    asc,
    mc,
    houses,
    ascDetail: { lon: asc, ...parseZodiac(asc) },
    mcDetail: { lon: mc, ...parseZodiac(mc) },
    planets,
  };
}
