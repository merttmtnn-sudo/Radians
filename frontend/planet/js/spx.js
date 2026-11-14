// SPHEREx data access (through the local server) + a SPHEREx Level-2 frame model with full TAN-SIP WCS
// and the per-pixel spectral WCS (wavelength / bandwidth maps computed by the server from WCS-WAVE).
import { D2R, R2D, mod, api, mjdToYear } from './util.js';

const imageCache = new Map();
export async function findImages(ra, dec) {
  const key = ra.toFixed(5) + ',' + dec.toFixed(5);
  if (!imageCache.has(key)) imageCache.set(key, api(`/api/sx/images?ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}`)
    .then(r => { if (r.missing?.length) imageCache.delete(key); return r; }) // incomplete answer: ask again next time
    .catch(e => { imageCache.delete(key); throw e; }));
  return imageCache.get(key);
}

export class Frame {
  constructor(buf, item) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'SPX1') throw new Error('bad frame blob');
    const L = dv.getUint32(4, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, L)));
    let off = 8 + L; off += (4 - (off % 4)) % 4;
    const n = meta.nx * meta.ny;
    const take = (C) => { const a = new C(buf, off, n); off += n * 4; return a; };
    this.nx = meta.nx; this.ny = meta.ny; this.hdr = meta.hdr; this.flagNames = meta.flagNames;
    this.image = take(Float32Array); this.flags = take(Int32Array); this.variance = take(Float32Array);
    this.zodi = take(Float32Array); this.wave = take(Float32Array); this.bw = take(Float32Array);
    this.item = item;
    this.det = item.det || this.hdr.DETECTOR;
    this.mjd = this.hdr['MJD-AVG'] || item.mjd;
    this.year = mjdToYear(this.mjd);
    this.setupWcs();
  }
  setupWcs() {
    const h = this.hdr;
    let cd;
    if (h.CD1_1 !== undefined) cd = [[h.CD1_1, h.CD1_2 || 0], [h.CD2_1 || 0, h.CD2_2]];
    else cd = [[(h.PC1_1 ?? 1) * (h.CDELT1 ?? 1), (h.PC1_2 ?? 0) * (h.CDELT1 ?? 1)], [(h.PC2_1 ?? 0) * (h.CDELT2 ?? 1), (h.PC2_2 ?? 1) * (h.CDELT2 ?? 1)]];
    this.cd = cd;
    const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
    this.cdi = [[cd[1][1] / det, -cd[0][1] / det], [-cd[1][0] / det, cd[0][0] / det]];
    this.pixScale = Math.sqrt(Math.abs(det)) * 3600; // arcsec / px
    const poly = (pfx) => { const t = []; for (const k of Object.keys(h)) { const m = k.match(new RegExp(`^${pfx}_(\\d)_(\\d)$`)); if (m) t.push([+m[1], +m[2], h[k]]); } return t; };
    this.sipA = poly('A'); this.sipB = poly('B'); this.sipAP = poly('AP'); this.sipBP = poly('BP');
    this.ra0 = h.CRVAL1 * D2R; this.dec0 = h.CRVAL2 * D2R;
    this.sd0 = Math.sin(this.dec0); this.cd0 = Math.cos(this.dec0);
  }
  static evalPoly(t, u, v) { let s = 0; for (const [p, q, c] of t) s += c * Math.pow(u, p) * Math.pow(v, q); return s; }
  // 0-based pixel -> [ra, dec] degrees
  pix2world(x, y) {
    const h = this.hdr;
    const u = x + 1 - h.CRPIX1, v = y + 1 - h.CRPIX2;
    const U = u + Frame.evalPoly(this.sipA, u, v), V = v + Frame.evalPoly(this.sipB, u, v);
    const xi = (this.cd[0][0] * U + this.cd[0][1] * V) * D2R, eta = (this.cd[1][0] * U + this.cd[1][1] * V) * D2R;
    const den = this.cd0 - eta * this.sd0;
    const ra = this.ra0 + Math.atan2(xi, den);
    const dec = Math.atan2(this.sd0 + eta * this.cd0, Math.hypot(xi, den));
    return [mod(ra * R2D, 360), dec * R2D];
  }
  // [ra, dec] -> 0-based pixel [x, y]
  world2pix(ra, dec) {
    const a = ra * D2R - this.ra0, d = dec * D2R;
    const cd = Math.cos(d), sd = Math.sin(d), ca = Math.cos(a);
    const cosc = this.sd0 * sd + this.cd0 * cd * ca;
    const xi = cd * Math.sin(a) / cosc * R2D, eta = (this.cd0 * sd - this.sd0 * cd * ca) / cosc * R2D;
    const U = this.cdi[0][0] * xi + this.cdi[0][1] * eta, V = this.cdi[1][0] * xi + this.cdi[1][1] * eta;
    const u = U + Frame.evalPoly(this.sipAP, U, V), v = V + Frame.evalPoly(this.sipBP, U, V);
    return [u + this.hdr.CRPIX1 - 1, v + this.hdr.CRPIX2 - 1];
  }
  sampleMap(arr, x, y) {
    const i = Math.round(x), j = Math.round(y);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return NaN;
    return arr[j * this.nx + i];
  }
  waveAt(ra, dec) { const [x, y] = this.world2pix(ra, dec); return this.sampleMap(this.wave, x, y); }
  flagsAt(x, y, r = 1) {
    let f = 0;
    for (let j = Math.round(y) - r; j <= Math.round(y) + r; j++) for (let i = Math.round(x) - r; i <= Math.round(x) + r; i++) {
      if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) continue;
      f |= this.flags[j * this.nx + i];
    }
    return f;
  }
  flagList(f) { const out = []; for (const [b, [n]] of Object.entries(this.flagNames)) if (f & (1 << +b)) out.push(n); return out; }
}

// ---- concurrent cutout loader with an in-memory cache shared by all tools ----
const frameCache = new Map();
export const cacheKey = (uri, ra, dec, size) => `${uri}|${ra.toFixed(5)}|${dec.toFixed(5)}|${(+size).toFixed(4)}`;
export function cachedFrame(uri, ra, dec, size) { return frameCache.get(cacheKey(uri, ra, dec, size)); }
export function framesCovering(uri, ra, dec, margin = 0.008) {
  // any cached cutout of this exposure that contains (ra, dec) with some margin
  for (const [k, f] of frameCache) {
    if (!k.startsWith(uri + '|') || !(f instanceof Frame)) continue;
    const [x, y] = f.world2pix(ra, dec);
    const m = margin * 3600 / f.pixScale;
    if (x >= m && y >= m && x <= f.nx - 1 - m && y <= f.ny - 1 - m) return f;
  }
  return null;
}

export async function loadFrames(items, ra, dec, size, { onFrame, onProgress, signal, concurrency = 10, cache = true } = {}) {
  let done = 0, failed = 0, idx = 0;
  const total = items.length;
  const out = new Array(total);
  async function worker() {
    while (idx < total) {
      if (signal?.aborted) return;
      const k = idx++;
      const it = items[k];
      const key = cacheKey(it.uri, ra, dec, size);
      try {
        let f = frameCache.get(key);
        if (!f) {
          const r = await fetch(`/api/sx/cutout?uri=${encodeURIComponent(it.uri)}&ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}&size=${(+size).toFixed(4)}`, { signal });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
          f = new Frame(await r.arrayBuffer(), it);
          if (cache) frameCache.set(key, f);
        }
        if (cache) out[k] = f;
        onFrame?.(f, k);
      } catch (e) {
        if (signal?.aborted) return;
        failed++;
        console.warn('cutout failed', it.uri, e.message);
      }
      done++;
      onProgress?.(done, total, failed);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  return out.filter(Boolean);
}

// ---- grouping into survey epochs / visits ----
// Group by time gaps. Fields near the ecliptic poles (SPHEREx deep fields) are observed almost
// continuously, so any group spanning more than ~2 months is split into ~monthly chunks.
export function groupByTime(frames, gapDays, maxSpan = gapDays >= 30 ? 60 : Infinity, chunk = 30) {
  const s = [...frames].sort((a, b) => a.mjd - b.mjd);
  let groups = [];
  for (const f of s) {
    const g = groups[groups.length - 1];
    if (g && f.mjd - g.last <= gapDays) { g.frames.push(f); g.last = f.mjd; }
    else groups.push({ frames: [f], first: f.mjd, last: f.mjd });
  }
  if (isFinite(maxSpan)) {
    const out = [];
    for (const g of groups) {
      if (g.last - g.first <= maxSpan) { out.push(g); continue; }
      const n = Math.ceil((g.last - g.first + 1e-6) / chunk);
      const parts = Array.from({ length: n }, () => []);
      for (const f of g.frames) parts[Math.min(n - 1, Math.floor((f.mjd - g.first) / chunk))].push(f);
      for (const p of parts) if (p.length) out.push({ frames: p, first: p[0].mjd, last: p[p.length - 1].mjd });
    }
    groups = out;
  }
  groups.forEach(g => { g.mjd = g.frames.reduce((a, f) => a + f.mjd, 0) / g.frames.length; });
  return groups;
}
// keep at most `perDetPerEpoch` items per detector per epoch, evenly spread
export function subsampleItems(items, perDetPerEpoch) {
  const out = [];
  for (const g of groupByTime(items, 45)) for (let d = 1; d <= 6; d++) {
    const list = g.frames.filter(it => it.det === d);
    if (list.length <= perDetPerEpoch) { out.push(...list); continue; }
    for (let k = 0; k < perDetPerEpoch; k++) out.push(list[Math.floor((k + 0.5) * list.length / perDetPerEpoch)]);
  }
  return out.sort((a, b) => a.mjd - b.mjd);
}
// download order: round-robin over (epoch, detector) so every epoch appears early
export function interleaveItems(items) {
  const lists = [];
  for (const g of groupByTime(items, 45)) for (let d = 1; d <= 6; d++) { const l = g.frames.filter(it => it.det === d); if (l.length) lists.push(l); }
  const out = [];
  for (let i = 0; out.length < items.length; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

// Flag bits that indicate unusable / contaminated pixels (SOURCE and FULLSAMPLE are informational)
export const BAD_FLAGS = ['TRANSIENT', 'OVERFLOW', 'SUR_ERROR', 'NONFUNC', 'MISSING_DATA', 'HOT', 'COLD', 'NONLINEAR', 'PERSIST', 'OUTLIER', 'SNOWBALL', 'BLOOM', 'STREAK', 'HALO'];
export const ALL_FLAGS = { TRANSIENT: 0, OVERFLOW: 1, SUR_ERROR: 2, NONFUNC: 6, DICHROIC: 7, MISSING_DATA: 9, HOT: 10, COLD: 11, FULLSAMPLE: 12,
  PHANMISS: 14, NONLINEAR: 15, PERSIST: 17, OUTLIER: 19, CROSSTALK: 20, SOURCE: 21, GHOST: 22, GHOST_FPA: 23, GHOST_EXT: 24, STREAK: 25,
  BLOOM: 26, SNOWBALL: 27, HALO: 28 };
export const maskOf = names => names.reduce((m, n) => m | (1 << ALL_FLAGS[n]), 0);
