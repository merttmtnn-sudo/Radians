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

// matplotlib's perceptually uniform maps, 10 evenly spaced samples (dark -> bright)
export const PALETTE_STOPS = {
  gray: ['#000000', '#ffffff'],
  invert: ['#ffffff', '#000000'],
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  heat: ['#000000', '#8c0000', '#ff4d00', '#ffd21a', '#ffffff'],
  tint: ['#000000', '#ffb347'],
  rgb: ['#4d7bff', '#3ddc84', '#ff5a3d'],
};
function fromStops(stops) {
  const rgb = stops.map(h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16) / 255));
  return (t) => {
    const f = Math.min(1, Math.max(0, t)) * (rgb.length - 1), i = Math.min(rgb.length - 2, Math.floor(f)), u = f - i;
    return rgb[i].map((a, k) => a + (rgb[i + 1][k] - a) * u);
  };
}

export const COLORMAPS = {
  gray: t => [t, t, t],
  invert: t => [1 - t, 1 - t, 1 - t],
  inferno: fromStops(PALETTE_STOPS.inferno),
  viridis: fromStops(PALETTE_STOPS.viridis),
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
    det: p.get('det'), view: p.get('view') === 'time' ? 'timecolor' : p.get('view'),   // 'time': the name in older shared links
    lang: p.get('lang'), wl: p.get('wl') !== '0',
    wlc: num('wlc'), wlw: num('wlw'),
    src: p.get('src'), band: num('band'),
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
    case 'stack': case 'timecolor': return [stackImage(images, variances)];   // 'timecolor' is drawn from the frames (timeColorChannels)
    default: return images;
  }
}

export const isDiffView = (v) => v.startsWith('diff');

/** Diverging lookup table: index 0 = most negative (blue: was here), 128 = zero (black), 255 = most positive
 * (orange: is here now). */
export function lutDiverging() {
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i - 128) / 127;
    const [r, g, b] = t >= 0 ? [t, 0.66 * t, 0.26 * t] : [-0.30 * t, -0.62 * t, -t];
    out[i * 3] = r * 255; out[i * 3 + 1] = g * 255; out[i * 3 + 2] = b * 255;
  }
  return out;
}

/** Colour of visit k of n for the colour-by-time view: blue -> green -> red. */
export function timeColour(k, n) {
  const u = n > 1 ? k / (n - 1) : 0.5;
  return u < 0.5 ? [0.2 + 0.2 * u, 0.45 + 1.1 * u, 1 - 1.2 * u] : [0.3 + 1.4 * (u - 0.5), 1 - 1.3 * (u - 0.5), 0.4 - 0.6 * (u - 0.5)];
}

/** Colour by time: every visit in its own colour (timeColour: the first blue, the middle green, the
 * last red), added up and divided by the colour total. What stays put comes out white; what moves
 * leaves a blue -> green -> red trail. A pixel a visit did not see is left out of that pixel's sum.
 * Returns {r, g, b} images on the brightness scale of the visits, or null with fewer than two. */
export function timeColorChannels(images) {
  const F = images.length;
  if (F < 2) return null;
  const n = images[0].length, cols = images.map((_, k) => timeColour(k, F));
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const sum = [0, 0, 0], tot = [0, 0, 0];
    for (let k = 0; k < F; k++) {
      const v = images[k][i];
      if (!Number.isFinite(v)) continue;
      for (let c = 0; c < 3; c++) { sum[c] += v * cols[k][c]; tot[c] += cols[k][c]; }
    }
    for (let c = 0; c < 3; c++) out[c][i] = tot[c] ? sum[c] / tot[c] : NaN;
  }
  return { r: out[0], g: out[1], b: out[2] };
}

export const BEFORE_RGB = [78, 168, 255];     // blue: it was here
export const NOW_RGB = [255, 159, 67];        // orange: it is here now
const DIFF_BACKDROP = [5, 8, 14];

/** Lookup table for a wavelength-matched difference: index 0 = much fainter now (blue), 128 = no
 * change (dark), 255 = much brighter now (orange). */
export function lutBeforeNow() {
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i - 128) / 127, a = Math.min(1, Math.abs(t)), tint = t < 0 ? BEFORE_RGB : NOW_RGB;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = DIFF_BACKDROP[c] + (tint[c] - DIFF_BACKDROP[c]) * a;
  }
  return out;
}

/** A difference value on -1..1 for lutBeforeNow: linear up to `limit` (10 sigma of the difference
 * noise), with a small knee so that 1-sigma noise stays dark. NaN for missing data. */
export function matchedDiffValue(v, limit, knee = 0.1) {
  if (!Number.isFinite(v)) return NaN;
  const a = Math.min(1, Math.abs(v) / (limit || 1));
  const s = a <= knee ? 0 : (a - knee) / (1 - knee);
  return v < 0 ? -s : s;
}

/** Minimal FITS file (one float32 image, sky WCS from a header dict) as bytes. */
export function fitsBytes(img, n, cards) {
  const card = (k, v, c = '') => {
    const val = typeof v === 'string' ? `'${v.replace(/'/g, "''")}'`.padEnd(20) : String(v).padStart(20);
    return (k.padEnd(8) + '= ' + val + (c ? ' / ' + c : '')).slice(0, 80).padEnd(80);
  };
  const lines = [card('SIMPLE', 'T'), card('BITPIX', -32), card('NAXIS', 2), card('NAXIS1', n), card('NAXIS2', n)]
    .map((l, i) => (i === 0 ? 'SIMPLE  =                    T'.padEnd(80) : l));
  for (const [k, v, c] of cards) lines.push(card(k, v, c));
  lines.push('END'.padEnd(80));
  let head = lines.join('');
  head = head.padEnd(Math.ceil(head.length / 2880) * 2880, ' ');
  const dataLen = Math.ceil((n * n * 4) / 2880) * 2880;
  const buf = new ArrayBuffer(head.length + dataLen), u8 = new Uint8Array(buf), dv = new DataView(buf);
  for (let i = 0; i < head.length; i++) u8[i] = head.charCodeAt(i) & 0x7f;
  for (let i = 0; i < n * n; i++) dv.setFloat32(head.length + i * 4, img[i], false);   // big-endian, NaN stays NaN
  return u8;
}

/** Signed stretch for difference images: -1..1 (NaN for missing data). */
export function stretchSigned(v, lim, kind) {
  if (!Number.isFinite(v)) return NaN;
  const s = stretchValue(Math.abs(v), 0, lim, kind);
  return v < 0 ? -s : s;
}

// ---------------------------------------------------------------- colour composite (3 detector groups)
/** Detector groups for a false-colour image: short, middle and long SPHEREx wavelengths. */
export const RGB_GROUPS = { b: [1, 2], g: [3, 4], r: [5, 6] };   // 0.75–1.6, 1.6–3.8, 3.8–5.0 µm

/** Inverse-variance co-add of same-size images; NaN where no image has a usable pixel. */
export function ivCoadd(images, variances) {
  const n = images[0].length, num = new Float64Array(n), den = new Float64Array(n), out = new Float32Array(n);
  images.forEach((img, j) => {
    const v = variances[j];
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(img[i]) && Number.isFinite(v[i]) && v[i] > 0) { num[i] += img[i] / v[i]; den[i] += 1 / v[i]; }
    }
  });
  for (let i = 0; i < n; i++) out[i] = den[i] > 0 ? num[i] / den[i] : NaN;
  return out;
}

/** Per-epoch red/green/blue channels from per-(epoch, detector) frames
 *  [{epoch, detector, image, variance}], plus the same over all epochs under the key 'all'.
 *  A channel with no data is null. */
export function rgbChannels(frames) {
  const out = {};
  const build = (fs) => {
    const ch = {};
    for (const [c, dets] of Object.entries(RGB_GROUPS)) {
      const sel = fs.filter(f => dets.includes(f.detector));
      ch[c] = sel.length ? ivCoadd(sel.map(f => f.image), sel.map(f => f.variance)) : null;
    }
    return ch;
  };
  for (const e of [...new Set(frames.map(f => f.epoch))]) out[e] = build(frames.filter(f => f.epoch === e));
  out.all = build(frames);
  return out;
}
