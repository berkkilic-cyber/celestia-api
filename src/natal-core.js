// src/natal-core.js
import * as Astro from 'astronomy-engine';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function norm360(x) {
  const r = x % 360;
  return r < 0 ? r + 360 : r;
}

// 12 tropical signs
const SIGNS = [
  'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
  'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
];

// Parse 0–360° into sign + degree + minute
function parseZodiac(lon) {
  const signIndex = Math.floor(lon / 30);      // 0..11
  const sign = SIGNS[signIndex];
  const degInSign = lon - signIndex * 30;
  const deg = Math.floor(degInSign);
  const min = Math.floor((degInSign - deg) * 60);
  return { sign, deg, min, signIndex: signIndex + 1 }; // 1..12 for signIndex
}

// Main planets + Pluto
const BODIES = [
  { name: 'Sun',     glyph: '☉', body: 'Sun' },
  { name: 'Moon',    glyph: '☽', body: 'Moon' },
  { name: 'Mercury', glyph: '☿', body: 'Mercury' },
  { name: 'Venus',   glyph: '♀', body: 'Venus' },
  { name: 'Mars',    glyph: '♂', body: 'Mars' },
  { name: 'Jupiter', glyph: '♃', body: 'Jupiter' },
  { name: 'Saturn',  glyph: '♄', body: 'Saturn' },
  { name: 'Uranus',  glyph: '♅', body: 'Uranus' },
  { name: 'Neptune', glyph: '♆', body: 'Neptune' },
  { name: 'Pluto',   glyph: '♇', body: 'Pluto' },
];

const NODE = { name: 'North Node', glyph: '☊' }; // True North Node

/** Geocentric ecliptic longitude using GeoVector (Worker-safe) */
function eclipticLonOfBody(bodyEnum, time) {
  if (!bodyEnum) throw new Error('Missing Astro.Body enum');
  const geo = Astro.GeoVector(bodyEnum, time, true); // x,y,z in AU
  const lon = Math.atan2(geo.y, geo.x) * RAD2DEG;
  return norm360(lon);
}

/** True Node via Moon/Sun relationship */
function trueNodeLongitude(time) {
  const moon = eclipticLonOfBody(Astro.Body.Moon, time);
  const sun  = eclipticLonOfBody(Astro.Body.Sun, time);
  return norm360(moon - sun + 180); // North Node
}

/** ASC + MC (Meeus-style) — returns RAMC, eps, phi for Placidus */
function ascMc(time, latDeg, lonDeg) {
  const eps = Astro.e_tilt(time).tobl * DEG2RAD; // nutation-corrected obliquity
  const phi = latDeg * DEG2RAD;
  const gst = Astro.SiderealTime(time);   // in hours
  const ramcDeg = norm360(gst * 15 + lonDeg); // RAMC in degrees
  const theta = ramcDeg * DEG2RAD;         // local sidereal angle

  // MC: ecliptic longitude of the meridian (use sin/cos to preserve quadrant)
  const mcRad = Math.atan2(Math.sin(theta), Math.cos(eps) * Math.cos(theta));
  const mc = norm360(mcRad * RAD2DEG);

  // ASC: ecliptic longitude of the eastern horizon
  const ascRad = Math.atan2(
    Math.cos(theta),
    -(Math.sin(eps) * Math.tan(phi) + Math.cos(eps) * Math.sin(theta))
  );
  const asc = norm360(ascRad * RAD2DEG);

  return { asc, mc, ramc: ramcDeg, eps, phi };
}

/** Placidus house cusps via iterative semi-arc method.
 *  Returns array of 12 cusp longitudes [cusp1..cusp12] (indices 0–11). */
function placidusCusps(ramc, eps, phi, asc, mc) {
  const ic = norm360(mc + 180);

  // Convert RA → ecliptic longitude (on the ecliptic where β = 0)
  // tan(λ) = tan(α) / cos(ε)
  function ra2lon(ra) {
    const raRad = ra * DEG2RAD;
    const lonRad = Math.atan2(Math.sin(raRad), Math.cos(eps) * Math.cos(raRad));
    return norm360(lonRad * RAD2DEG);
  }

  // Iterate to find a Placidus cusp.
  // formula(dsa, nsa) returns the target RA for the cusp.
  function computeCusp(initialOffset, formula) {
    let ra = norm360(ramc + initialOffset);
    for (let i = 0; i < 50; i++) {
      const lon = ra2lon(ra);
      const lonRad = lon * DEG2RAD;
      const dec = Math.asin(Math.sin(eps) * Math.sin(lonRad));
      const tanProd = Math.tan(phi) * Math.tan(dec);
      if (Math.abs(tanProd) > 1) return null; // circumpolar — can't compute
      const ad = Math.asin(tanProd) * RAD2DEG; // ascensional difference
      const dsa = 90 + ad; // diurnal semi-arc (degrees)
      const nsa = 90 - ad; // nocturnal semi-arc (degrees)
      const newRa = norm360(formula(dsa, nsa));
      let diff = newRa - ra;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;
      if (Math.abs(diff) < 0.0001) break;
      ra = newRa;
    }
    return ra2lon(ra);
  }

  // Above horizon (MC → 11 → 12 → ASC): RA = RAMC + fraction * DSA
  const cusp11 = computeCusp(30,  (dsa) => ramc + dsa / 3);
  const cusp12 = computeCusp(60,  (dsa) => ramc + 2 * dsa / 3);
  // Below horizon (ASC → 2 → 3 → IC): RA = RAMC + 180 - fraction * NSA
  const cusp2  = computeCusp(120, (_dsa, nsa) => ramc + 180 - 2 * nsa / 3);
  const cusp3  = computeCusp(150, (_dsa, nsa) => ramc + 180 - nsa / 3);

  // If any cusp failed (polar latitudes), fall back to equal houses
  if (cusp11 === null || cusp12 === null || cusp2 === null || cusp3 === null) {
    return Array.from({ length: 12 }, (_, i) => norm360(asc + i * 30));
  }

  // Build all 12 cusps (index 0 = cusp 1, etc.)
  const cusps = new Array(12);
  cusps[0]  = asc;                        // cusp 1 = ASC
  cusps[1]  = cusp2;                      // cusp 2
  cusps[2]  = cusp3;                      // cusp 3
  cusps[3]  = ic;                         // cusp 4 = IC
  cusps[4]  = norm360(cusp11 + 180);      // cusp 5 (opposite of 11)
  cusps[5]  = norm360(cusp12 + 180);      // cusp 6 (opposite of 12)
  cusps[6]  = norm360(asc + 180);         // cusp 7 = DSC
  cusps[7]  = norm360(cusp2 + 180);       // cusp 8 (opposite of 2)
  cusps[8]  = norm360(cusp3 + 180);       // cusp 9 (opposite of 3)
  cusps[9]  = mc;                         // cusp 10 = MC
  cusps[10] = cusp11;                     // cusp 11
  cusps[11] = cusp12;                     // cusp 12

  return cusps;
}

/** Determine which Placidus house (1–12) a planet longitude falls in.
 *  Cusps are unequal widths, so we check consecutive cusp boundaries. */
function planetHousePlacidus(lon, cusps) {
  for (let i = 0; i < 12; i++) {
    const start = cusps[i];
    const end = cusps[(i + 1) % 12];
    if (start < end) {
      if (lon >= start && lon < end) return i + 1;
    } else {
      // Wraps across 0°
      if (lon >= start || lon < end) return i + 1;
    }
  }
  return 1; // fallback
}

/** Shorter-arc midpoint between two ecliptic longitudes (0–360°).
 *  Naive (a+b)/2 fails when positions straddle 0° Aries. */
function shortArcMidpoint(lon1, lon2) {
  let diff = lon2 - lon1;
  // Normalize diff to [-180, +180]
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return norm360(lon1 + diff / 2);
}

export function computeComposite(person1, person2) {
  const chart1 = computeNatal(person1);
  const chart2 = computeNatal(person2);

  // Midpoint ASC & MC
  const asc = shortArcMidpoint(chart1.asc, chart2.asc);
  const mc = shortArcMidpoint(chart1.mc, chart2.mc);

  // Midpoint each of the 12 house cusps
  const houses = chart1.houses.map((c, i) =>
    shortArcMidpoint(c, chart2.houses[i])
  );

  // Composite planets
  const planets = chart1.planets.map((p1) => {
    const p2 = chart2.planets.find((p) => p.name === p1.name);
    const lon = shortArcMidpoint(p1.lon, p2.lon);
    const retrograde = p1.retrograde && p2.retrograde;
    const parsed = parseZodiac(lon);
    const house = planetHousePlacidus(lon, houses);
    return {
      name: p1.name,
      glyph: p1.glyph,
      lon,
      retrograde,
      house,
      ...parsed,
    };
  });

  const ascParsed = parseZodiac(asc);
  const mcParsed = parseZodiac(mc);

  return {
    asc,
    mc,
    houses,
    ascDetail: { lon: asc, ...ascParsed },
    mcDetail: { lon: mc, ...mcParsed },
    planets,
  };
}

export function computeNatal(p) {
  const {
    year, month, day,
    hour, minute,
    tzOffsetMinutes,
    latitude, longitude,
  } = p;

  // Base UTC millis
  const utcMillis =
    Date.UTC(year, month - 1, day, hour, minute, 0) -
    tzOffsetMinutes * 60_000;

  const time = new Astro.AstroTime(new Date(utcMillis));

  // ASC & MC + Placidus parameters
  const { asc, mc, ramc, eps, phi } = ascMc(time, latitude, longitude);

  // Placidus house cusps
  const houses = placidusCusps(ramc, eps, phi, asc, mc);

  // Small time delta (1 hour) for retrograde check
  const dtMs = 60 * 60 * 1000;
  const timeNext = new Astro.AstroTime(new Date(utcMillis + dtMs));

  // Planets
  const planets = BODIES.map((b) => {
    const bodyEnum = Astro.Body[b.body];

    // Position now
    const lonNow = eclipticLonOfBody(bodyEnum, time);

    // Position later (for retrograde detection)
    const lonNext = eclipticLonOfBody(bodyEnum, timeNext);
    const diff = norm360(lonNext - lonNow);
    const retrograde = diff > 180; // going backwards along zodiac

    const parsed = parseZodiac(lonNow);
    const house = planetHousePlacidus(lonNow, houses);

    return {
      name: b.name,
      glyph: b.glyph,
      lon: lonNow,
      retrograde,
      house,        // 1..12
      ...parsed,    // sign, deg, min, signIndex
    };
  });

  // True North Node
  const nnLon = trueNodeLongitude(time);
  const nnData = parseZodiac(nnLon);
  const northNode = {
    name: 'North Node',
    glyph: '☊',
    lon: nnLon,
    retrograde: false,
    house: planetHousePlacidus(nnLon, houses),
    ...nnData,
  };

  // South Node (always opposite)
  const snLon = norm360(nnLon + 180);
  const snData = parseZodiac(snLon);
  const southNode = {
    name: 'South Node',
    glyph: '☋',
    lon: snLon,
    retrograde: false,
    house: planetHousePlacidus(snLon, houses),
    ...snData,
  };

  planets.push(northNode, southNode);

  // ASC / MC enhanced breakdown
  const ascParsed = parseZodiac(asc);
  const mcParsed  = parseZodiac(mc);

  return {
    // For your existing map component (keeps compatibility)
    asc,
    mc,
    houses,          // 12 cusps (Placidus)

    // Rich data for premium features
    ascDetail: {
      lon: asc,
      ...ascParsed,
    },
    mcDetail: {
      lon: mc,
      ...mcParsed,
    },

    planets,         // extended planet list
  };
}
