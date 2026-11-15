// False colour for infrared: SPHEREx sees 0.75-5.0 micron light, which no eye can see, so every
// infrared wavelength is painted with a visible colour (a "tint") and a few tinted layers are
// added together. Two mappings: a fixed rainbow (the same wavelength always gets the same
// colour) and "stretch" (the picked wavelengths are spread over the whole blue -> red range).
// Pure maths only: no DOM and no Node API, so it loads in the browser and in the tests.
// Colours are [r, g, b] with each channel 0..1.

export const IR_MIN_UM = 0.75;
export const IR_MAX_UM = 5.0;
export const VIS_MIN_NM = 380;
export const VIS_MAX_NM = 700;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const clamp01 = (x) => (Number.isFinite(x) ? clamp(x, 0, 1) : 0);

/**
 * The fixed rainbow: infrared wavelength (microns) -> visible wavelength (nm).
 * Log scale, because the SPHEREx channels are spaced evenly in log wavelength.
 * @param {number} um wavelength in microns, clamped to 0.75..5.0
 * @returns {number} 380..700 nm, or NaN for a non-finite input
 */
export function visibleNm(um) {
  if (typeof um !== 'number' || !Number.isFinite(um)) return NaN;
  const u = clamp(um, IR_MIN_UM, IR_MAX_UM);
  return VIS_MIN_NM + (VIS_MAX_NM - VIS_MIN_NM) * Math.log(u / IR_MIN_UM) / Math.log(IR_MAX_UM / IR_MIN_UM);
}

// Hand-placed hue stops, joined by straight lines. Every stop has one channel at exactly 1,
// and neighbours share that channel, so the largest channel stays 1 in between as well.
// The flat 440-450 nm stretch keeps "blue" a pure blue; the violet end stops at red 0.55
// so it never reads as magenta.
const STOPS = [
  [380, [0.55, 0, 1]], // violet
  [440, [0, 0, 1]],    // blue
  [450, [0, 0, 1]],
  [490, [0, 1, 1]],    // cyan
  [520, [0, 1, 0]],    // green
  [580, [1, 1, 0]],    // yellow
  [610, [1, 0.5, 0]],  // orange
  [645, [1, 0, 0]],    // red
  [700, [1, 0, 0]],
];

/**
 * Visible wavelength -> a saturated tint (largest channel exactly 1, no dimming at the ends:
 * the tints are multiplied into images, the image carries the brightness).
 * @param {number} nm wavelength in nanometres, clamped to 380..700
 * @returns {number[]} [r, g, b], each 0..1 (NaN channels for a non-finite input)
 */
export function nmToRgb(nm) {
  if (typeof nm !== 'number' || !Number.isFinite(nm)) return [NaN, NaN, NaN];
  const x = clamp(nm, VIS_MIN_NM, VIS_MAX_NM);
  for (let i = 1; i < STOPS.length; i++) {
    const [x1, c1] = STOPS[i];
    if (x <= x1) {
      const [x0, c0] = STOPS[i - 1];
      const t = (x - x0) / (x1 - x0);
      return c0.map((v, k) => v + (c1[k] - v) * t);
    }
  }
  return STOPS[STOPS.length - 1][1].slice();
}

/**
 * Fixed-rainbow tint of an infrared wavelength.
 * @param {number} um wavelength in microns
 * @returns {number[]} [r, g, b]
 */
export function rainbowTint(um) {
  return nmToRgb(visibleNm(um));
}

/**
 * Blue -> green -> red ramp of the "stretch" mapping. The channels always add up to 1,
 * so layers tinted with ramp colours share the light instead of piling it up.
 * @param {number} p position 0..1 (clamped)
 * @returns {number[]} [r, g, b]
 */
export function ramp(p) {
  const q = clamp01(p);
  return q < 0.5 ? [0, 2 * q, 1 - 2 * q] : [2 * q - 1, 2 - 2 * q, 0];
}

/**
 * Tints for the wavelengths the user picked, in the same order as the input.
 * 'fixed': each pick keeps its rainbow colour. 'stretch' (and anything else): the picks are
 * spread over the whole range, shortest = blue, longest = red.
 * @param {number[]} picksUm 1 to 3 wavelengths in microns (more are tolerated)
 * @param {string} [mapping='stretch']
 * @returns {number[][]} one [r, g, b] per pick
 */
export function pickTints(picksUm, mapping = 'stretch') {
  const picks = Array.isArray(picksUm) ? picksUm : [];
  const n = picks.length;
  if (n === 0) return [];
  if (mapping === 'fixed') return picks.map((um) => rainbowTint(um));
  if (n === 1) return [[1, 1, 1]];

  // rank by wavelength; equal picks keep their input order so the result is deterministic
  const order = picks.map((_, i) => i).sort((a, b) => (picks[a] - picks[b]) || (a - b));
  const out = new Array(n);
  if (n === 2) {
    // only two images for three channels: green shows the average of both
    out[order[0]] = [0, 0.5, 1];
    out[order[1]] = [1, 0.5, 0];
    return out;
  }
  const short = picks[order[0]];
  const span = Math.log(picks[order[n - 1]] / short);
  order.forEach((idx, rank) => {
    let p;
    if (rank === 0) p = 0;
    else if (rank === n - 1) p = 1;
    else {
      p = Math.log(picks[idx] / short) / span;
      // all picks equal (span 0) or unusable numbers: fall back to an even spread
      if (!(span > 0) || !Number.isFinite(p)) p = rank / (n - 1);
      // with three layers the middle one must stay visibly different from both ends
      else if (n === 3) p = clamp(p, 0.25, 0.75);
    }
    out[idx] = ramp(p);
  });
  return out;
}

/**
 * Scale a colour's brightness.
 * @param {number[]} rgb
 * @param {number} k factor
 * @returns {number[]} each channel * k, clamped to 0..1
 */
export function scaleRgb(rgb, k) {
  return [0, 1, 2].map((i) => clamp01(rgb[i] * k));
}

/**
 * @param {number[]} rgb channels 0..1 (clamped)
 * @returns {string} '#rrggbb', lower case
 */
export function rgbToHex(rgb) {
  return '#' + [0, 1, 2].map((i) => Math.round(clamp01(rgb[i]) * 255).toString(16).padStart(2, '0')).join('');
}

/**
 * @param {string} hex '#rgb' or '#rrggbb', the '#' is optional
 * @returns {number[]|null} [r, g, b] 0..1, or null if it is not a hex colour
 */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

/**
 * The channel whose wavelength is nearest to um.
 * @param {{frame: number, band: number, channel: number, wave_um: number}[]} channels
 * @param {number} um wavelength in microns
 * @param {number[]|Set<number>} [skip] frames to ignore (e.g. the ones already picked)
 * @returns {object|null} the channel object; null if nothing is left to choose from
 */
export function nearestChannel(channels, um, skip) {
  if (!Array.isArray(channels) || !Number.isFinite(um)) return null;
  const skipped = skip instanceof Set ? skip : new Set(skip || []);
  let best = null; let bestDist = Infinity;
  for (const ch of channels) {
    if (!ch || skipped.has(ch.frame)) continue;
    const dist = Math.abs(ch.wave_um - um);
    if (!Number.isFinite(dist)) continue;
    // on a tie the lower frame wins, whatever the order of the list
    if (dist < bestDist || (dist === bestDist && ch.frame < best.frame)) { best = ch; bestDist = dist; }
  }
  return best;
}

/**
 * Colour-map stops that turn a grey image into a tinted one. The gain brightens by reaching
 * the full tint earlier (then holding it) instead of scaling past it, so the hue never shifts.
 * A gamma above 1 darkens the faint end: the map tiles jump from black straight to 14% grey
 * (their first non-zero level), which shows as speckle in the background unless it is toned down.
 * @param {number[]} tint [r, g, b]
 * @param {number} [gain=1] brightness gain, clamped to 0.1..8 (non-finite counts as 1)
 * @param {number} [steps=17] number of stops (at least 2)
 * @param {number} [gamma=1] exponent applied to the input level, clamped to 0.25..4 (non-finite counts as 1)
 * @returns {string[]} 'steps' hex colours from black upwards
 */
export function channelRamp(tint, gain = 1, steps = 17, gamma = 1) {
  const g = Number.isFinite(gain) ? clamp(gain, 0.1, 8) : 1;
  const n = Number.isFinite(steps) ? Math.max(2, Math.floor(steps)) : 17;
  const power = Number.isFinite(gamma) ? clamp(gamma, 0.25, 4) : 1;
  const out = [];
  for (let i = 0; i < n; i++) out.push(rgbToHex(scaleRgb(tint, Math.min(1, g * (i / (n - 1)) ** power))));
  return out;
}
