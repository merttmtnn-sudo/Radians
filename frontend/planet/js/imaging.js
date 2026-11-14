// Image processing: reprojection of SPHEREx frames onto a common north-up grid, stacking,
// differencing, smoothing, stretches and colour maps.
import { D2R, R2D, mod } from './util.js';

// Common tangent-plane grid centred on (ra0, dec0): north up, east left.
export function makeGrid(ra0, dec0, sizeDeg, scaleArcsec) {
  const n = Math.max(8, Math.round(sizeDeg * 3600 / scaleArcsec));
  return { ra0, dec0, n, scale: scaleArcsec / 3600, sd0: Math.sin(dec0 * D2R), cd0: Math.cos(dec0 * D2R) };
}
export function gridToWorld(g, i, j) {
  const xi = -(i + 0.5 - g.n / 2) * g.scale * D2R, eta = (g.n / 2 - j - 0.5) * g.scale * D2R;
  const den = g.cd0 - eta * g.sd0;
  return [mod(g.ra0 + Math.atan2(xi, den) * R2D, 360), Math.atan2(g.sd0 + eta * g.cd0, Math.hypot(xi, den)) * R2D];
}
export function worldToGrid(g, ra, dec) {
  const a = (ra - g.ra0) * D2R, d = dec * D2R;
  const cd = Math.cos(d), sd = Math.sin(d), ca = Math.cos(a);
  const cosc = g.sd0 * sd + g.cd0 * cd * ca;
  const xi = cd * Math.sin(a) / cosc * R2D, eta = (g.cd0 * sd - g.sd0 * cd * ca) / cosc * R2D;
  return [-xi / g.scale + g.n / 2 - 0.5, -eta / g.scale + g.n / 2 - 0.5];
}

// Map of frame pixel coordinates for every grid pixel (coarse WCS evaluation + bilinear interpolation)
const pixMapCache = new WeakMap();
function pixelMap(frame, g) {
  let m = pixMapCache.get(frame);
  const key = `${g.ra0},${g.dec0},${g.n},${g.scale}`;
  if (m && m.key === key) return m;
  const step = 8, nc = Math.ceil(g.n / step) + 1;
  const cx = new Float64Array(nc * nc), cy = new Float64Array(nc * nc);
  for (let b = 0; b < nc; b++) for (let a = 0; a < nc; a++) {
    const [ra, dec] = gridToWorld(g, Math.min(a * step, g.n), Math.min(b * step, g.n));
    const [x, y] = frame.world2pix(ra, dec);
    cx[b * nc + a] = x; cy[b * nc + a] = y;
  }
  const X = new Float32Array(g.n * g.n), Y = new Float32Array(g.n * g.n);
  for (let j = 0; j < g.n; j++) {
    const b = Math.min(Math.floor(j / step), nc - 2), tb = (j - b * step) / step;
    for (let i = 0; i < g.n; i++) {
      const a = Math.min(Math.floor(i / step), nc - 2), ta = (i - a * step) / step;
      const k = b * nc + a;
      X[j * g.n + i] = (1 - ta) * (1 - tb) * cx[k] + ta * (1 - tb) * cx[k + 1] + (1 - ta) * tb * cx[k + nc] + ta * tb * cx[k + nc + 1];
      Y[j * g.n + i] = (1 - ta) * (1 - tb) * cy[k] + ta * (1 - tb) * cy[k + 1] + (1 - ta) * tb * cy[k + nc] + ta * tb * cy[k + nc + 1];
    }
  }
  m = { key, X, Y };
  pixMapCache.set(frame, m);
  return m;
}

export function median(arr, maxN = 4000) {
  const v = [];
  const st = Math.max(1, Math.floor(arr.length / maxN));
  for (let i = 0; i < arr.length; i += st) if (isFinite(arr[i])) v.push(arr[i]);
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}

// Resample one frame onto the grid. Returns {img, w} (w = inverse variance weights, 0 where masked).
// Catmull-Rom weights
const cr = t => { const t2 = t * t, t3 = t2 * t; return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2]; };

export function reproject(frame, g, { zodi = true, badMask = 0, bkg = true, cubic = false, cov = null } = {}) {
  const { X, Y } = pixelMap(frame, g);
  const n = g.n * g.n, nx = frame.nx, ny = frame.ny;
  const img = new Float32Array(n).fill(NaN), w = new Float32Array(n);
  const I = frame.image, Z = frame.zodi, V = frame.variance, F = frame.flags;
  for (let p = 0; p < n; p++) {
    const x = X[p], y = Y[p];
    if (!(x >= -0.5 && y >= -0.5 && x <= nx - 0.5 && y <= ny - 0.5)) continue;
    if (cov) cov[p] = 1; // inside this exposure's footprint (even if the pixel itself is masked)
    const xi = Math.round(x), yi = Math.round(y);
    const c = yi * nx + xi;
    if (badMask && (F[c] & badMask)) continue;
    if (cubic) {
      // sharper bicubic (Catmull-Rom) when all 16 taps are valid; otherwise fall through to bilinear
      const x0 = Math.floor(x), y0 = Math.floor(y);
      if (x0 >= 1 && y0 >= 1 && x0 < nx - 2 && y0 < ny - 2) {
        const wx = cr(x - x0), wy = cr(y - y0);
        let s = 0, ok = true;
        for (let b = 0; b < 4 && ok; b++) {
          const row = (y0 - 1 + b) * nx;
          for (let a = 0; a < 4; a++) {
            const k = row + x0 - 1 + a;
            const v = I[k] - (zodi ? Z[k] : 0);
            if (!isFinite(v) || (badMask && (F[k] & badMask))) { ok = false; break; }
            s += wx[a] * wy[b] * v;
          }
        }
        if (ok) { img[p] = s; const vv = V[c]; w[p] = isFinite(vv) && vv > 0 ? 1 / vv : 1; continue; }
      }
    }
    // bilinear on valid neighbours
    const x0 = Math.max(0, Math.min(nx - 2, Math.floor(x))), y0 = Math.max(0, Math.min(ny - 2, Math.floor(y)));
    const tx = Math.max(0, Math.min(1, x - x0)), ty = Math.max(0, Math.min(1, y - y0));
    let s = 0, ws = 0;
    const nb = [[x0, y0, (1 - tx) * (1 - ty)], [x0 + 1, y0, tx * (1 - ty)], [x0, y0 + 1, (1 - tx) * ty], [x0 + 1, y0 + 1, tx * ty]];
    for (const [a, b, wt] of nb) {
      const k = b * nx + a;
      if (wt <= 0) continue;
      if (badMask && (F[k] & badMask)) continue;
      const val = I[k] - (zodi ? Z[k] : 0);
      if (!isFinite(val)) continue;
      s += wt * val; ws += wt;
    }
    if (ws <= 0) continue;
    img[p] = s / ws;
    const vv = V[c];
    w[p] = isFinite(vv) && vv > 0 ? 1 / vv : 1;
  }
  if (bkg) { const m = median(img); for (let p = 0; p < n; p++) img[p] -= m; }
  return { img, w };
}

// Inverse-variance weighted co-add of reprojected images
export function stack(list, n) {
  const s = new Float64Array(n), ws = new Float64Array(n);
  for (const { img, w } of list) for (let p = 0; p < n; p++) if (w[p] > 0 && isFinite(img[p])) { s[p] += img[p] * w[p]; ws[p] += w[p]; }
  const out = new Float32Array(n), wout = new Float32Array(n);
  for (let p = 0; p < n; p++) { out[p] = ws[p] > 0 ? s[p] / ws[p] : NaN; wout[p] = ws[p]; }
  return { img: out, w: wout };
}

export function smooth(img, n, sigma) {
  if (!sigma) return img;
  const r = Math.ceil(sigma * 3), k = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-i * i / (2 * sigma * sigma)));
  const pass = (src, dx, dy) => {
    const out = new Float32Array(n * n).fill(NaN);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      if (!isFinite(src[j * n + i])) continue;
      let s = 0, ws = 0;
      for (let t = -r; t <= r; t++) {
        const a = i + t * dx, b = j + t * dy;
        if (a < 0 || b < 0 || a >= n || b >= n) continue;
        const v = src[b * n + a];
        if (!isFinite(v)) continue;
        s += v * k[t + r]; ws += k[t + r];
      }
      out[j * n + i] = s / ws;
    }
    return out;
  };
  return pass(pass(img, 1, 0), 0, 1);
}

export function percentiles(arrs, ps) {
  const v = [];
  for (const a of arrs) { const st = Math.max(1, Math.floor(a.length / 20000)); for (let i = 0; i < a.length; i += st) if (isFinite(a[i])) v.push(a[i]); }
  if (!v.length) return ps.map(() => 0);
  v.sort((a, b) => a - b);
  return ps.map(p => v[Math.min(v.length - 1, Math.max(0, Math.floor(p / 100 * (v.length - 1))))]);
}

// ---- colour maps ----
const CMAP_STOPS = {
  gray: [[0, 0, 0], [255, 255, 255]],
  inferno: [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]],
  viridis: [[68, 1, 84], [70, 50, 127], [54, 92, 141], [39, 127, 142], [31, 161, 135], [74, 194, 109], [159, 218, 58], [253, 231, 37]],
  magma: [[0, 0, 4], [44, 17, 95], [114, 31, 129], [183, 55, 121], [241, 96, 93], [254, 159, 109], [254, 223, 160], [252, 253, 191]],
  cubehelix: [[0, 0, 0], [22, 31, 64], [26, 87, 74], [80, 120, 47], [161, 121, 74], [207, 132, 159], [199, 180, 238], [255, 255, 255]],
  heat: [[0, 0, 0], [128, 0, 0], [255, 64, 0], [255, 200, 0], [255, 255, 255]],
  cool: [[0, 0, 0], [0, 40, 110], [0, 140, 210], [120, 230, 255], [255, 255, 255]],
  diverging: [[40, 90, 255], [20, 20, 40], [0, 0, 0], [40, 20, 20], [255, 90, 40]],
};
const lutCache = {};
export function lut(name) {
  if (lutCache[name]) return lutCache[name];
  const st = CMAP_STOPS[name] || CMAP_STOPS.gray;
  const L = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (st.length - 1), a = Math.floor(t), b = Math.min(st.length - 1, a + 1), f = t - a;
    for (let c = 0; c < 3; c++) L[i * 3 + c] = st[a][c] * (1 - f) + st[b][c] * f;
  }
  return (lutCache[name] = L);
}

export function stretchFn(kind, lo, hi, histSample) {
  const span = hi - lo || 1;
  if (kind === 'linear') return v => (v - lo) / span;
  if (kind === 'sqrt') return v => Math.sqrt(Math.max(0, (v - lo) / span));
  if (kind === 'log') return v => Math.log10(1 + 999 * Math.max(0, (v - lo) / span)) / 3;
  if (kind === 'histeq' && histSample && histSample.length) {
    const s = histSample;
    return v => { let a = 0, b = s.length - 1; while (a < b) { const m = (a + b) >> 1; if (s[m] < v) a = m + 1; else b = m; } return a / (s.length - 1); };
  }
  const beta = 0.08; // asinh softening
  const norm = Math.asinh(1 / beta);
  return v => Math.asinh(Math.max(0, (v - lo) / span) / beta) / norm;
}

// Render a float image (or 3 for RGB) into ImageData
export function toImageData(imgs, n, scales, { stretch = 'asinh', cmap = 'gray', invert = false, flagMask = null, signed = false } = {}) {
  const id = new ImageData(n, n);
  const d = id.data;
  if (imgs.length === 3) {
    const fns = imgs.map((_, c) => stretchFn(stretch === 'histeq' ? 'asinh' : stretch, scales[c][0], scales[c][1]));
    for (let p = 0; p < n * n; p++) {
      for (let c = 0; c < 3; c++) {
        const v = imgs[c][p];
        let t = isFinite(v) ? fns[c](v) : 0;
        t = Math.max(0, Math.min(1, t));
        if (invert) t = 1 - t;
        d[p * 4 + c] = t * 255;
      }
      d[p * 4 + 3] = 255;
    }
    return id;
  }
  const img = imgs[0];
  const L = lut(signed ? (cmap === 'gray' ? 'gray' : 'diverging') : cmap);
  let hs = null;
  if (stretch === 'histeq') { hs = []; for (let p = 0; p < img.length; p += Math.max(1, Math.floor(img.length / 5000))) if (isFinite(img[p])) hs.push(img[p]); hs.sort((a, b) => a - b); }
  const f = signed ? (v => (v - scales[0]) / (scales[1] - scales[0])) : stretchFn(stretch, scales[0], scales[1], hs);
  for (let p = 0; p < n * n; p++) {
    const v = img[p];
    const o = p * 4;
    if (!isFinite(v)) { d[o] = 18; d[o + 1] = 18; d[o + 2] = 40; d[o + 3] = 255; continue; }
    let t = Math.max(0, Math.min(1, f(v)));
    if (invert) t = 1 - t;
    const k = Math.round(t * 255) * 3;
    d[o] = L[k]; d[o + 1] = L[k + 1]; d[o + 2] = L[k + 2]; d[o + 3] = 255;
    if (flagMask && flagMask[p]) { d[o] = d[o] * 0.4 + 255 * 0.6; d[o + 1] *= 0.4; d[o + 2] = d[o + 2] * 0.4 + 200 * 0.6; }
  }
  return id;
}
