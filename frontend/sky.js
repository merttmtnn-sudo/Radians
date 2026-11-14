// Pure helpers (no DOM) so they can be unit-tested with node.

export function decodeB64(b64, Type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer);
}

/** Percentiles (0-100) of the finite values of several arrays, from an even sample. */
export function percentiles(arrays, ps, maxSamples = 200000) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const step = Math.max(1, Math.floor(total / maxSamples));
  const vals = [];
  for (const a of arrays) for (let i = 0; i < a.length; i += step) if (Number.isFinite(a[i])) vals.push(a[i]);
  if (!vals.length) return ps.map(() => 0);
  vals.sort((x, y) => x - y);
  return ps.map(p => vals[Math.min(vals.length - 1, Math.max(0, Math.round((p / 100) * (vals.length - 1))))]);
}

/** Map a value to 0..1 given black/white levels and a stretch. */
export function stretchValue(v, lo, hi, kind) {
  if (!Number.isFinite(v)) return NaN;
  let t = (v - lo) / (hi - lo || 1);
  t = Math.min(1, Math.max(0, t));
  switch (kind) {
    case 'log': return Math.log10(1 + 999 * t) / 3;
    case 'sqrt': return Math.sqrt(t);
    case 'asinh': return Math.asinh(10 * t) / Math.asinh(10);
    default: return t;
  }
}

export const COLORMAPS = {
  gray: t => [t, t, t],
  invert: t => [1 - t, 1 - t, 1 - t],
  // black -> deep red -> orange -> pale yellow -> white
  heat: t => [Math.min(1, t * 2.2), Math.min(1, Math.max(0, t * 2 - 0.45)), Math.min(1, Math.max(0, t * 3 - 2))],
};

/** 256-entry RGB lookup table for a colormap. */
export function lut(name) {
  const f = COLORMAPS[name] || COLORMAPS.gray;
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = f(i / 255);
    out[i * 3] = r * 255; out[i * 3 + 1] = g * 255; out[i * 3 + 2] = b * 255;
  }
  return out;
}

const D2R = Math.PI / 180;

/** Pixel (0-based, FITS orientation: y up) on our TAN grid -> [ra, dec] degrees. */
export function pixToSky(x, y, grid) {
  const c = (grid.n - 1) / 2;
  const s = grid.pixel_scale / 3600 * D2R;
  const xi = -(x - c) * s;      // east is to the left
  const eta = (y - c) * s;
  const ra0 = grid.ra * D2R, dec0 = grid.dec * D2R;
  const den = Math.cos(dec0) - eta * Math.sin(dec0);
  const ra = ra0 + Math.atan2(xi, den);
  const dec = Math.atan2(Math.sin(dec0) + eta * Math.cos(dec0), Math.hypot(xi, den));
  return [((ra / D2R) % 360 + 360) % 360, dec / D2R];
}

/** [ra, dec] degrees -> pixel on our TAN grid (inverse of pixToSky). */
export function skyToPix(ra, dec, grid) {
  const c = (grid.n - 1) / 2;
  const s = grid.pixel_scale / 3600 * D2R;
  const a = ra * D2R, d = dec * D2R, a0 = grid.ra * D2R, d0 = grid.dec * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  const xi = Math.cos(d) * Math.sin(a - a0) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc;
  return [c - xi / s, c + eta / s];
}

function sexa(v, digits) {
  const sign = v < 0 ? '-' : '';
  v = Math.abs(v);
  let a = Math.floor(v), m = Math.floor((v - a) * 60), s = ((v - a) * 60 - m) * 60;
  s = Number(s.toFixed(digits));
  if (s >= 60) { s -= 60; m += 1; }
  if (m >= 60) { m -= 60; a += 1; }
  const ss = s.toFixed(digits).padStart(digits ? digits + 3 : 2, '0');
  return [sign, String(a).padStart(2, '0'), String(m).padStart(2, '0'), ss];
}

export function formatRA(deg) {
  const [, h, m, s] = sexa(deg / 15, 2);
  return `${h}h${m}m${s}s`;
}

export function formatDec(deg) {
  const [sign, d, m, s] = sexa(deg, 1);
  return `${sign || '+'}${d}°${m}′${s}″`;
}

export function flagNames(value, bits, badMask) {
  const out = [];
  for (const [bit, name] of Object.entries(bits)) {
    const b = Number(bit);
    if ((value >>> b) & 1) out.push({ name, bad: ((badMask >>> b) & 1) === 1 });
  }
  return out;
}

/** Read view settings from a URL query string (with defaults). */
export function parseState(search) {
  const p = new URLSearchParams(search);
  const num = (k) => (p.has(k) && p.get(k) !== '' && Number.isFinite(Number(p.get(k))) ? Number(p.get(k)) : null);
  return {
    q: p.get('q') || null,
    ra: num('ra'), dec: num('dec'),
    pmra: num('pmra'), pmdec: num('pmdec'),
    fov: num('fov'), mode: p.get('mode'), fps: num('fps'),
    stretch: p.get('stretch'), cmap: p.get('cmap'),
    frame: num('frame'), embed: p.get('embed') === '1',
  };
}
