// Positional astronomy for the planetarium: time scales, precession, horizontal coordinates,
// Sun / Moon / planets (JPL approximate Keplerian elements, Meeus lunar theory), magnitudes, rise/set.
import { D2R, R2D, mod } from './util.js';

export const jdFromDate = d => d.getTime() / 86400000 + 2440587.5;
export const T = jd => (jd - 2451545.0) / 36525;

// Greenwich mean sidereal time (degrees)
export function gmst(jd) {
  const t = T(jd);
  return mod(280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t - t * t * t / 38710000, 360);
}
export const obliquity = jd => (23.439291 - 0.0130042 * T(jd)) * D2R;

// ---------- small matrix helpers ----------
export const mul = (A, B) => A.map((r, i) => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
export const mulv = (A, v) => [A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2], A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
  A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2]];
export const transpose = A => [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]];
const Rz = a => { const c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
const Ry = a => { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
const Rx = a => { const c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };

export const radec2v = (ra, dec) => { const a = ra * D2R, d = dec * D2R; return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]; };
export const v2radec = v => { const r = Math.hypot(v[0], v[1], v[2]); return [mod(Math.atan2(v[1], v[0]) * R2D, 360), Math.asin(v[2] / r) * R2D]; };

// IAU 1976 precession J2000 -> mean equator of date
export function precessionMatrix(jd) {
  const t = T(jd);
  const as = D2R / 3600;
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t ** 3) * as;
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t ** 3) * as;
  const theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t ** 3) * as;
  return mul(Rz(z), mul(Ry(-theta), Rz(zeta)));
}

// Matrix J2000 equatorial -> horizontal (x=North, y=East, z=Up), for observer lat/lon (deg).
export function horizMatrix(jd, lat, lon) {
  const lst = (gmst(jd) + lon) * D2R;
  const phi = lat * D2R;
  const A = [[-Math.sin(phi), 0, Math.cos(phi)], [0, 1, 0], [Math.cos(phi), 0, Math.sin(phi)]];
  // hour-angle frame: v' = Rz(-lst) v  (y' = -cosδ sinH)
  return mul(A, mul(Rz(-lst), precessionMatrix(jd)));
}
export const hor2altaz = v => [Math.asin(Math.max(-1, Math.min(1, v[2]))) * R2D, mod(Math.atan2(v[1], v[0]) * R2D, 360)];
export const altaz2v = (alt, az) => { const a = alt * D2R, z = az * D2R; return [Math.cos(a) * Math.cos(z), Math.cos(a) * Math.sin(z), Math.sin(a)]; };

// Bennett refraction (degrees) for apparent altitude from true altitude
export function refraction(altDeg) {
  if (altDeg < -1.9) return 0;
  const h = Math.max(altDeg, -1.9);
  return (1.02 / Math.tan((h + 10.3 / (h + 5.11)) * D2R)) / 60;
}

// Ecliptic (J2000) <-> equatorial (J2000)
const EPS0 = 23.4392911 * D2R;
export const ecl2equ = v => [v[0], v[1] * Math.cos(EPS0) - v[2] * Math.sin(EPS0), v[1] * Math.sin(EPS0) + v[2] * Math.cos(EPS0)];
// Galactic -> equatorial J2000 rotation
export const GAL2EQ = transpose([[-0.0548755604, -0.8734370902, -0.4838350155], [0.4941094279, -0.4448296300, 0.7469822445],
  [-0.8676661490, -0.1980763734, 0.4559837762]]);

// ---------- Sun & planets: JPL "Approximate positions of the planets" (Standish), 1800-2050 ----------
// a(AU), e, I, L, long.peri, long.node  + rates per century
const EL = {
  mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593], [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  venus: [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255], [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
  earth: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0], [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  mars: [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891], [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  saturn: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
  uranus: [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503], [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
  neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574], [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
  pluto: [[39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684], [-0.00031596, 0.00005170, 0.00004818, 145.20780515, -0.04062942, -0.01183482]],
};
function helioEcl(name, jd) {
  const t = T(jd);
  const [e0, r] = EL[name];
  const a = e0[0] + r[0] * t, e = e0[1] + r[1] * t, I = (e0[2] + r[2] * t) * D2R, L = e0[3] + r[3] * t, wb = e0[4] + r[4] * t, Om = e0[5] + r[5] * t;
  const w = (wb - Om) * D2R, M = mod(L - wb + 180, 360) - 180;
  let E = M * D2R + e * Math.sin(M * D2R);
  for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M * D2R) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om * D2R), sO = Math.sin(Om * D2R), cI = Math.cos(I), sI = Math.sin(I);
  return [(cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp, (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    (sw * sI) * xp + (cw * sI) * yp];
}

const PLANET_INFO = {
  mercury: { name: 'Mercury', tr: 'Merkür', radius: 2439.7, color: '#c9b8a6', mag: (r, d, i) => -0.613 + 5 * Math.log10(r * d) + 0.06328 * i - 0.0016336 * i * i + 3.3644e-5 * i ** 3 - 3.4565e-7 * i ** 4 + 1.6893e-9 * i ** 5 - 3.0334e-12 * i ** 6 },
  venus: { name: 'Venus', tr: 'Venüs', radius: 6051.8, color: '#fff3d1', mag: (r, d, i) => -4.384 + 5 * Math.log10(r * d) - 0.001044 * i + 3.687e-4 * i * i - 2.814e-6 * i ** 3 + 8.938e-9 * i ** 4 },
  mars: { name: 'Mars', tr: 'Mars', radius: 3389.5, color: '#ff8a5c', mag: (r, d, i) => -1.601 + 5 * Math.log10(r * d) + 0.02267 * i - 1.302e-4 * i * i },
  jupiter: { name: 'Jupiter', tr: 'Jüpiter', radius: 69911, color: '#f2d7a8', mag: (r, d, i) => -9.395 + 5 * Math.log10(r * d) + 3.7e-4 * i + 6.16e-4 * i * i },
  saturn: { name: 'Saturn', tr: 'Satürn', radius: 58232, color: '#f0d890', mag: (r, d, i) => -8.914 + 5 * Math.log10(r * d) + 0.026 * i },
  uranus: { name: 'Uranus', tr: 'Uranüs', radius: 25362, color: '#a6e3ef', mag: (r, d, i) => -7.110 + 5 * Math.log10(r * d) + 0.00869 * i },
  neptune: { name: 'Neptune', tr: 'Neptün', radius: 24622, color: '#7fa6ff', mag: (r, d, i) => -7.00 + 5 * Math.log10(r * d) + 0.002 * i },
  pluto: { name: 'Pluto', tr: 'Plüton', radius: 1188, color: '#d9c7b0', mag: (r, d) => -1.0 + 5 * Math.log10(r * d) },
};
const AU_KM = 149597870.7;

// Sun (geocentric, J2000 equatorial unit vector + distance)
export function sunPos(jd) {
  const e = helioEcl('earth', jd);
  const v = ecl2equ([-e[0], -e[1], -e[2]]);
  const r = Math.hypot(...v);
  const [ra, dec] = v2radec(v);
  return { id: 'sun', name: 'Sun', tr: 'Güneş', ra, dec, dist: r, mag: -26.74, diam: 2 * Math.atan(696000 / (r * AU_KM)) * R2D, kind: 'sun', color: '#fff6c8' };
}

export function planetPos(name, jd) {
  // light-time corrected geocentric position
  let lt = 0, g, h, e;
  for (let i = 0; i < 2; i++) {
    h = helioEcl(name, jd - lt);
    e = helioEcl('earth', jd);
    g = [h[0] - e[0], h[1] - e[1], h[2] - e[2]];
    lt = Math.hypot(...g) * 0.0057755183;
  }
  const d = Math.hypot(...g), r = Math.hypot(...h), R = Math.hypot(...e);
  const i = Math.acos(Math.max(-1, Math.min(1, (r * r + d * d - R * R) / (2 * r * d)))) * R2D; // phase angle
  const info = PLANET_INFO[name];
  const [ra, dec] = v2radec(ecl2equ(g));
  let mag = info.mag(r, d, i);
  if (name === 'saturn') mag += 0; // ring tilt ignored
  return { id: name, name: info.name, tr: info.tr, ra, dec, dist: d, rsun: r, phaseAngle: i, illum: (1 + Math.cos(i * D2R)) / 2,
    mag, diam: 2 * Math.atan(info.radius / (d * AU_KM)) * R2D, kind: 'planet', color: info.color };
}

// Moon - Meeus ch. 47 (main periodic terms), accuracy ~ a few arcmin
export function moonPos(jd) {
  const t = T(jd);
  const Lp = mod(218.3164477 + 481267.88123421 * t, 360), D = mod(297.8501921 + 445267.1114034 * t, 360);
  const M = mod(357.5291092 + 35999.0502909 * t, 360), Mp = mod(134.9633964 + 477198.8675055 * t, 360);
  const F = mod(93.2720950 + 483202.0175233 * t, 360);
  const s = x => Math.sin(x * D2R), c = x => Math.cos(x * D2R);
  const lon = Lp + 6.288774 * s(Mp) + 1.274027 * s(2 * D - Mp) + 0.658314 * s(2 * D) + 0.213618 * s(2 * Mp) - 0.185116 * s(M)
    - 0.114332 * s(2 * F) + 0.058793 * s(2 * D - 2 * Mp) + 0.057066 * s(2 * D - M - Mp) + 0.053322 * s(2 * D + Mp)
    + 0.045758 * s(2 * D - M) - 0.040923 * s(M - Mp) - 0.034720 * s(D) - 0.030383 * s(M + Mp) + 0.015327 * s(2 * D - 2 * F)
    - 0.012528 * s(Mp + 2 * F) + 0.010980 * s(Mp - 2 * F) + 0.010675 * s(4 * D - Mp) + 0.010034 * s(3 * Mp) + 0.008548 * s(4 * D - 2 * Mp);
  const lat = 5.128122 * s(F) + 0.280602 * s(Mp + F) + 0.277693 * s(Mp - F) + 0.173237 * s(2 * D - F) + 0.055413 * s(2 * D - Mp + F)
    + 0.046271 * s(2 * D - Mp - F) + 0.032573 * s(2 * D + F) + 0.017198 * s(2 * Mp + F) + 0.009266 * s(2 * D + Mp - F) + 0.008822 * s(2 * Mp - F);
  const dist = 385000.56 - 20905.355 * c(Mp) - 3699.111 * c(2 * D - Mp) - 2955.968 * c(2 * D) - 569.925 * c(2 * Mp) + 48.888 * c(M)
    - 3.149 * c(2 * F) + 246.158 * c(2 * D - 2 * Mp) - 152.138 * c(2 * D - M - Mp) - 170.733 * c(2 * D + Mp) - 204.586 * c(2 * D - M)
    - 129.620 * c(M - Mp) + 108.743 * c(D) + 104.755 * c(M + Mp);
  // ecliptic of date -> approx J2000 by removing precession in longitude
  const lonJ2000 = lon - 1.396971 * t;
  const v = ecl2equ([c(lat) * c(lonJ2000), c(lat) * s(lonJ2000), s(lat)]);
  const [ra, dec] = v2radec(v);
  const sun = sunPos(jd);
  const elong = Math.acos(Math.max(-1, Math.min(1, v[0] * Math.cos(sun.dec * D2R) * Math.cos(sun.ra * D2R) + v[1] * Math.cos(sun.dec * D2R) * Math.sin(sun.ra * D2R) + v[2] * Math.sin(sun.dec * D2R))));
  const phaseAngle = Math.atan2(sun.dist * AU_KM * Math.sin(elong), dist - sun.dist * AU_KM * Math.cos(elong));
  const illum = (1 + Math.cos(phaseAngle)) / 2;
  const i = phaseAngle * R2D;
  const mag = -12.73 + 0.026 * Math.abs(i) + 4e-9 * i ** 4;
  // waxing if Moon is east of the Sun
  const waxing = mod(lon - (mod(280.46646 + 36000.76983 * t, 360)), 360) < 180;
  return { id: 'moon', name: 'Moon', tr: 'Ay', ra, dec, distKm: dist, dist: dist / AU_KM, illum, phaseAngle: i, waxing, mag,
    diam: 2 * Math.atan(1737.4 / dist) * R2D, kind: 'moon', color: '#f4f1e8' };
}

export const PLANETS = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
export function solarSystem(jd) {
  return [sunPos(jd), moonPos(jd), ...PLANETS.map(p => planetPos(p, jd))];
}

export function moonPhaseName(m) {
  const k = m.illum;
  if (k < 0.03) return 'New Moon';
  if (k > 0.97) return 'Full Moon';
  if (Math.abs(k - 0.5) < 0.06) return m.waxing ? 'First Quarter' : 'Last Quarter';
  return (m.waxing ? 'Waxing ' : 'Waning ') + (k < 0.5 ? 'Crescent' : 'Gibbous');
}

// Rise / transit / set by sampling (works for any moving object): posFn(jd) -> {ra, dec}
export function riseTransitSet(posFn, jd0, lat, lon, h0 = -0.5667) {
  const altAt = jd => { const p = posFn(jd); const v = mulv(horizMatrix(jd, lat, lon), radec2v(p.ra, p.dec)); return Math.asin(v[2]) * R2D; };
  const start = jd0 - 0.5, step = 1 / 72; // 20 min
  let prev = altAt(start) - h0, rise = null, set = null, transit = null, maxAlt = -99;
  for (let i = 1; i <= 72; i++) {
    const jd = start + i * step, a = altAt(jd), cur = a - h0;
    if (a > maxAlt) { maxAlt = a; transit = jd; }
    if (prev < 0 && cur >= 0 && rise === null) rise = bisect(altAt, jd - step, jd, h0);
    if (prev >= 0 && cur < 0 && set === null) set = bisect(altAt, jd - step, jd, h0);
    prev = cur;
  }
  // refine transit
  if (transit) { let a = transit - step, b = transit + step; for (let k = 0; k < 30; k++) { const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3; if (altAt(m1) < altAt(m2)) a = m1; else b = m2; } transit = (a + b) / 2; maxAlt = altAt(transit); }
  return { rise, set, transit, maxAlt, circumpolar: rise === null && set === null && altAt(jd0) > h0, neverRises: rise === null && set === null && altAt(jd0) <= h0 };
}
function bisect(f, a, b, h0) {
  let fa = f(a) - h0;
  for (let i = 0; i < 25; i++) { const m = (a + b) / 2, fm = f(m) - h0; if ((fa < 0) === (fm < 0)) { a = m; fa = fm; } else b = m; }
  return (a + b) / 2;
}

// B-V colour index -> RGB (Ballesteros temperature + blackbody approximation)
export function bvToRgb(bv) {
  bv = Math.max(-0.4, Math.min(2.0, bv));
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  let r, g, b;
  const x = t / 100;
  r = x <= 66 ? 255 : 329.7 * Math.pow(x - 60, -0.1332);
  g = x <= 66 ? 99.47 * Math.log(x) - 161.1 : 288.1 * Math.pow(x - 60, -0.0755);
  b = x >= 66 ? 255 : x <= 19 ? 0 : 138.5 * Math.log(x - 10) - 305.0;
  // soften towards white like the eye does
  const k = 0.55;
  return [r, g, b].map(c => Math.round(255 * (1 - k) + Math.max(0, Math.min(255, c)) * k));
}
