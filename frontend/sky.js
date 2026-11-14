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
    det: p.get('det'), view: p.get('view'), lang: p.get('lang'),
  };
}

/** Per-pixel median of the finite values across frames. */
export function medianImage(images) {
  const n = images[0].length, F = images.length, out = new Float32Array(n), buf = new Float64Array(F);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (let f = 0; f < F; f++) { const v = images[f][i]; if (Number.isFinite(v)) buf[k++] = v; }
    if (!k) { out[i] = NaN; continue; }
    const s = buf.subarray(0, k).sort();
    out[i] = k % 2 ? s[(k - 1) >> 1] : 0.5 * (s[k / 2 - 1] + s[k / 2]);
  }
  return out;
}

/** Inverse-variance weighted mean of all frames (falls back to a plain mean without variances). */
export function stackImage(images, variances) {
  const n = images[0].length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let num = 0, den = 0, sum = 0, cnt = 0;
    for (let f = 0; f < images.length; f++) {
      const v = images[f][i];
      if (!Number.isFinite(v)) continue;
      sum += v; cnt++;
      const w = variances && Number.isFinite(variances[f][i]) && variances[f][i] > 0 ? 1 / variances[f][i] : 0;
      num += w * v; den += w;
    }
    out[i] = den > 0 ? num / den : cnt ? sum / cnt : NaN;
  }
  return out;
}

function diff(a, b) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

/** Frames to display for a view: images, diff_median, diff_prev, diff_first or stack. */
export function computeView(images, variances, view) {
  if (!images.length) return [];
  switch (view) {
    case 'diff_median': { const m = medianImage(images); return images.map(im => diff(im, m)); }
    case 'diff_prev': return images.map((im, i) => diff(im, images[(i - 1 + images.length) % images.length]));
    case 'diff_first': return images.map(im => diff(im, images[0]));
    case 'stack': return [stackImage(images, variances)];
    default: return images;
  }
}

export const isDiffView = (v) => v.startsWith('diff');

/** Diverging lookup table: index 0 = most negative (blue), 128 = zero (black), 255 = most positive (white). */
export function lutDiverging() {
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i - 128) / 127;
    const [r, g, b] = t >= 0 ? [t, t, t] : [-0.35 * t, -0.65 * t, -t];
    out[i * 3] = r * 255; out[i * 3 + 1] = g * 255; out[i * 3 + 2] = b * 255;
  }
  return out;
}

/** Signed stretch for difference images: -1..1 (NaN for missing data). */
export function stretchSigned(v, lim, kind) {
  if (!Number.isFinite(v)) return NaN;
  const s = stretchValue(Math.abs(v), 0, lim, kind);
  return v < 0 ? -s : s;
}
