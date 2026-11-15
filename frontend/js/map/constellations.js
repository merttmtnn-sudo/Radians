// Constellation lines, names and "You're looking at: Orion".
// Data: d3-celestial by Olaf Frohn (BSD-3-Clause), saved in frontend/data/ (served at static/data/).
// Longitudes there run from -180 to 180 degrees; RA = longitude (+360 when negative).

let data = null;

export async function loadConstellations() {
  if (data) return data;
  const [lines, names, bounds] = await Promise.all(
    ['constellations.lines.json', 'constellations.json', 'constellations.bounds.json']
      .map((f) => fetch(`static/data/${f}`).then((r) => r.json())));
  data = { lines: lines.features, names: names.features, bounds: bounds.features };
  return data;
}

const toRa = (lon) => (lon < 0 ? lon + 360 : lon);

/** Polylines as arrays of [ra, dec]. */
export function linePaths() {
  const out = [];
  for (const f of data.lines) {
    for (const path of f.geometry.coordinates) out.push(path.map(([lon, lat]) => [toRa(lon), lat]));
  }
  return out;
}

/** Label positions and names in the chosen language. */
export function labels(lang) {
  return data.names.map((f) => {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    return { id: f.id, ra: toRa(lon), dec: lat, name: (lang === 'tr' && p.tr) || p.name, rank: Number(p.rank) || 3 };
  });
}

/** A ring made continuous in longitude (no jumps of ~360° between neighbouring vertices). */
const unwrapped = new WeakMap();
function continuous(ring) {
  if (!unwrapped.has(ring)) {
    const out = [ring[0].slice()];
    for (let i = 1; i < ring.length; i++) {
      let [x, y] = ring[i];
      const prev = out[i - 1][0];
      x += Math.round((prev - x) / 360) * 360;
      out.push([x, y]);
    }
    unwrapped.set(ring, out);
  }
  return unwrapped.get(ring);
}

function crosses(lon, lat, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Ray-casting point-in-polygon on a ring of [lon, lat] that may run across lon = ±180. */
function inside(lon, lat, ring) {
  const r = continuous(ring);
  return [lon, lon - 360, lon + 360].some((x) => crosses(x, lat, r));
}

/** The constellation that contains (ra, dec), as {id, name}, or null. */
export function constellationAt(ra, dec, lang) {
  if (!data) return null;
  const lon = ra > 180 ? ra - 360 : ra;
  // the two polar caps break planar tests: decide them by declination first
  if (dec > 86) return named('UMi', lang);
  if (dec < -82.5) return named('Oct', lang);
  for (const f of data.bounds) {
    const rings = f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map((p) => p[0]);
    if (rings.some((ring) => inside(lon, dec, ring))) return named(f.id, lang);
  }
  return null;
}

function named(id, lang) {
  const f = data.names.find((n) => n.id === id || n.id === id.replace(/\d$/, ''));
  if (!f) return { id, name: id };
  return { id: f.id, name: (lang === 'tr' && f.properties.tr) || f.properties.name };
}
