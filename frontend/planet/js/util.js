// Shared helpers: DOM, formatting, coordinate parsing, events, shared target state.
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const mod = (a, n) => ((a % n) + n) % n;

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- events ----------
const listeners = {};
export const bus = {
  on(ev, fn) { (listeners[ev] ||= []).push(fn); },
  emit(ev, data) { (listeners[ev] || []).forEach(f => { try { f(data); } catch (e) { console.error(e); } }); },
};

// ---------- toast ----------
let toastTimer;
export function toast(msg, err = false, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- sexagesimal ----------
const pad = (n, w, d = 0) => { const s = n.toFixed(d); const [i, f] = s.split('.'); return i.padStart(w, '0') + (f ? '.' + f : ''); };
export function fmtRA(deg, d = 2) {
  let h = mod(deg, 360) / 15;
  let hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = ((h - hh) * 60 - mm) * 60;
  if (+ss.toFixed(d) >= 60) { ss = 0; mm++; } if (mm >= 60) { mm = 0; hh = (hh + 1) % 24; }
  return `${pad(hh, 2)}h${pad(mm, 2)}m${pad(ss, 2, d)}s`;
}
export function fmtDec(deg, d = 1) {
  const s = deg < 0 ? '−' : '+';
  let a = Math.abs(deg), dd = Math.floor(a), mm = Math.floor((a - dd) * 60), ss = ((a - dd) * 60 - mm) * 60;
  if (+ss.toFixed(d) >= 60) { ss = 0; mm++; } if (mm >= 60) { mm = 0; dd++; }
  return `${s}${pad(dd, 2)}°${pad(mm, 2)}′${pad(ss, 2, d)}″`;
}
export function fmtDeg(deg, d = 1) {
  const s = deg < 0 ? '−' : '+';
  let a = Math.abs(deg), dd = Math.floor(a), mm = Math.floor((a - dd) * 60), ss = ((a - dd) * 60 - mm) * 60;
  if (+ss.toFixed(d) >= 60) { ss = 0; mm++; } if (mm >= 60) { mm = 0; dd++; }
  return `${s}${dd}°${pad(mm, 2)}′${pad(ss, 2, d)}″`;
}
export function fmtHours(h) { h = mod(h, 24); const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return `${pad(hh + (mm === 60 ? 1 : 0), 2)}:${pad(mm === 60 ? 0 : mm, 2)}`; }

// parse "08h55m10.831s", "08 55 10.8", "133.795", "8:55:10.8" -> degrees
export function parseRA(s) {
  s = String(s).trim().toLowerCase().replace(/−/g, '-');
  if (!s) return NaN;
  if (/^[+-]?\d+(\.\d+)?(d|°)?$/.test(s)) return parseFloat(s);
  const p = s.replace(/[hms:°'"]/g, ' ').trim().split(/\s+/).map(Number);
  if (p.some(isNaN)) return NaN;
  return 15 * ((p[0] || 0) + (p[1] || 0) / 60 + (p[2] || 0) / 3600);
}
export function parseDec(s) {
  s = String(s).trim().toLowerCase().replace(/−/g, '-');
  if (!s) return NaN;
  if (/^[+-]?\d+(\.\d+)?(d|°)?$/.test(s) && !/\s/.test(s)) return parseFloat(s);
  const neg = s.startsWith('-');
  const p = s.replace(/^[+-]/, '').replace(/[dms:°'"′″]/g, ' ').trim().split(/\s+/).map(Number);
  if (p.some(isNaN)) return NaN;
  const v = (p[0] || 0) + (p[1] || 0) / 60 + (p[2] || 0) / 3600;
  return neg ? -v : v;
}
// a free-form "ra dec" string -> {ra, dec} or null
export function parseCoordPair(s) {
  s = s.trim().replace(/,/g, ' ').replace(/−/g, '-');
  let m = s.match(/^([+]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)$/);
  if (m) { const ra = +m[1], dec = +m[2]; if (ra >= 0 && ra < 360 && Math.abs(dec) <= 90) return { ra, dec }; }
  m = s.match(/^(\d{1,2}[h:\s]\s*\d{1,2}[m:\s]\s*\d{1,2}(?:\.\d+)?s?)\s*([+-]\s*\d{1,2}[d°:\s]\s*\d{1,2}['′m:\s]\s*\d{1,2}(?:\.\d+)?["″s]?)$/i);
  if (m) { const ra = parseRA(m[1]), dec = parseDec(m[2].replace(/\s+/g, ' ')); if (isFinite(ra) && isFinite(dec)) return { ra, dec }; }
  const parts = s.split(/\s+/);
  if (parts.length === 6) {
    const ra = parseRA(parts.slice(0, 3).join(' ')), dec = parseDec(parts.slice(3).join(' '));
    if (isFinite(ra) && isFinite(dec)) return { ra, dec };
  }
  return null;
}

// ---------- time ----------
export const MJD_J2000 = 51544.5;
export const mjdToYear = mjd => 2000 + (mjd - MJD_J2000) / 365.25;
export const mjdToDate = mjd => new Date((mjd - 40587) * 86400000);
export const dateToMjd = d => d.getTime() / 86400000 + 40587;
export const fmtDateUTC = (d, withTime = true) => d.toISOString().slice(0, withTime ? 16 : 10).replace('T', ' ') + (withTime ? ' UT' : '');

// ---------- angular helpers ----------
export function angSep(ra1, de1, ra2, de2) {
  const a = Math.sin((de2 - de1) * D2R / 2) ** 2 + Math.cos(de1 * D2R) * Math.cos(de2 * D2R) * Math.sin((ra2 - ra1) * D2R / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) * R2D;
}
// Apply proper motion (mas/yr, pmra includes cos dec) from epoch0 to epoch1 (years). Optional parallax
// displacement (mas) when the Sun's ecliptic longitude and SPHEREx (Earth-orbit) position are known.
export function propagate(src, year, mjd) {
  const dt = year - (src.epoch ?? 2000);
  let ra = src.ra, dec = src.dec;
  if (src.pmra || src.pmdec) {
    dec = src.dec + (src.pmdec || 0) * dt / 3.6e6;
    ra = src.ra + (src.pmra || 0) * dt / 3.6e6 / Math.cos(((src.dec + dec) / 2) * D2R);
  }
  if (src.plx && mjd) {
    // annual parallax from Earth position (SPHEREx is in low Earth orbit)
    const [X, Y, Z] = earthHelio(mjd); // AU, equatorial J2000 (Earth relative to Sun)
    const a = ra * D2R, d = dec * D2R, p = src.plx / 3.6e6; // deg
    const dra = p * (X * Math.sin(a) - Y * Math.cos(a)) / Math.cos(d);
    const ddec = p * (X * Math.cos(a) * Math.sin(d) + Y * Math.sin(a) * Math.sin(d) - Z * Math.cos(d));
    ra += dra; dec += ddec;
  }
  return { ra: mod(ra, 360), dec };
}
// Earth heliocentric position (AU), equatorial J2000 - low precision (good to ~0.01 AU)
export function earthHelio(mjd) {
  const n = mjd - MJD_J2000;
  const L = (280.460 + 0.9856474 * n) * D2R, g = (357.528 + 0.9856003 * n) * D2R;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R; // Sun's ecliptic longitude
  const R = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
  const eps = 23.439 * D2R;
  // Sun geocentric -> Earth heliocentric = minus
  const xs = R * Math.cos(lam), ys = R * Math.cos(eps) * Math.sin(lam), zs = R * Math.sin(eps) * Math.sin(lam);
  return [-xs, -ys, -zs];
}

// ---------- shared target ----------
export const state = {
  target: null, // {name, ra, dec, pmra, pmdec, plx, epoch, type}
  setTarget(t, source) {
    this.target = t ? { epoch: 2000, pmra: 0, pmdec: 0, plx: 0, ...t } : null;
    const nm = $('#targetName'), co = $('#targetCoords');
    if (t) { nm.textContent = t.name || 'Custom position'; co.textContent = `${fmtRA(t.ra, 1)} ${fmtDec(t.dec, 0)}`; }
    else { nm.textContent = 'No target'; co.textContent = ''; }
    bus.emit('target', { target: this.target, source });
  },
};

// The five test targets named in the challenge (positions/proper motions from SIMBAD, epoch J2000;
// WISE 0855 position is the one quoted in the challenge text, with Gaia-era astrometry from Kirkpatrick+2021).
export const TEST_TARGETS = [
  { id: 'barnard', name: "Barnard's Star", type: 'Nearby M dwarf · fastest proper motion', ra: 269.4520769586, dec: 4.6933649666,
    pmra: -801.551, pmdec: 10362.394, plx: 546.976, epoch: 2000 },
  { id: 'epsindb', name: 'Epsilon Indi B (Ba+Bb)', type: 'Binary brown dwarf', ra: 331.0441465885, dec: -56.7828441951,
    pmra: 3981.977, pmdec: -2466.832, plx: 270.658, epoch: 2000 },
  { id: 'wise0855', name: 'WISE 0855−0714', type: 'Coldest known brown dwarf (Y dwarf)', ra: 133.81890825, dec: -7.247048,
    pmra: -8123.7, pmdec: 673.2, plx: 439.0, epoch: 2000, note: 'Challenge position 08h55m10.831s −07d14m42.53s' },
  { id: 'rwaur', name: 'RW Aurigae', type: 'Variable young star (T Tauri)', ra: 76.95652603458, dec: 30.40143817389,
    pmra: 7.23, pmdec: -20.33, plx: 15.42, epoch: 2000 },
  { id: 'rdra', name: 'R Draconis', type: 'Mira variable (red giant)', ra: 248.16761083295, dec: 66.75497941722,
    pmra: -20.643, pmdec: 6.149, plx: 1.2509, epoch: 2000 },
];

// ---------- URL state ----------
export function readUrl() {
  const p = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  for (const [k, v] of h) if (!p.has(k)) p.set(k, v);
  return p;
}
export function writeUrl(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  history.replaceState(null, '', location.pathname + '?' + p.toString());
}

export async function api(path) {
  const r = await fetch(path);
  const j = await r.json().catch(() => ({ error: 'bad response' }));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

export function download(name, blobOrUrl) {
  const a = document.createElement('a');
  a.href = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); if (typeof blobOrUrl !== 'string') URL.revokeObjectURL(a.href); }, 1000);
}

// detector colours (blue -> red), used everywhere
export const DET_COLORS = { 1: '#7aa2ff', 2: '#5fd3ff', 3: '#5be38f', 4: '#ffd84d', 5: '#ff9a52', 6: '#ff5d6c' };
export const DET_RANGE = { 1: [0.75, 1.09], 2: [1.10, 1.62], 3: [1.63, 2.42], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.41, 5.00] };
