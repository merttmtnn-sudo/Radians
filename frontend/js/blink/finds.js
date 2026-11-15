// Plain words for the candidate cards: what changed, how clear it is, and what the catalogues say.
// No page access here (only numbers in, i18n keys out), so the node tests can load this file.

export const TOO_FAST = 11;          // arcsec/yr: Barnard's Star, the fastest known star, moves 10.4
export const MATCH_ARCSEC = 7;       // about one SPHEREx pixel
export const CAT_NAMES = { gaia: 'Gaia DR3', simbad: 'SIMBAD', catwise: 'CatWISE2020' };
const CAT_ORDER = ['gaia', 'simbad', 'catwise'];
const MJD_J2000 = 51544.5;

const DIRS = ['north', 'north_east', 'east', 'south_east', 'south', 'south_west', 'west', 'north_west'];

/** Position angle (degrees east of north) -> 'north', 'north_east', ... */
export function compass(pa) {
  return DIRS[Math.round((((pa % 360) + 360) % 360) / 45) % 8];
}

/** How far above the noise, in words: {key, vars: {z}}. */
export function clarity(z) {
  const n = Math.round(z || 0);
  return { key: n >= 20 ? 'fVeryClear' : n >= 8 ? 'fClear' : 'fFaint', vars: { z: n } };
}

export const tooFast = (c) => c.type === 'moving' && c.rate_arcsec_yr > TOO_FAST;

/** Angular separation of two sky positions (degrees in, arcsec out). */
export function sepArcsec(ra1, dec1, ra2, dec2) {
  const cosd = Math.cos(0.5 * (dec1 + dec2) * Math.PI / 180);
  return Math.hypot(((ra1 - ra2 + 540) % 360 - 180) * cosd, dec1 - dec2) * 3600;
}

export const MERGE_ARCSEC = 9;       // about one SPHEREx point-spread width

/** One list from the two finders.
 * tracking: finds of the all-detector tracker (sources followed across visits);
 * difference: finds on the fast band's wavelength-matched difference picture.
 * Every find carries `sky`: the [ra, dec] of each position it has (a mover has several).
 * Two finds of the same type whose positions come within `radius` are one thing seen twice: one card
 * (the tracker's, which has the full track), with methods = both and `also` = the other find.
 * Returns new objects {...find, methods, also}; the tracker's finds first, in their own order. */
export function mergeFinds(tracking, difference, radius = MERGE_ARCSEC) {
  const closest = (a, b) => Math.min(...a.sky.flatMap(p => b.sky.map(q => sepArcsec(p[0], p[1], q[0], q[1]))));
  const used = new Set();
  const out = tracking.map((a) => {
    let best = -1, bd = Infinity;
    difference.forEach((b, j) => {
      if (used.has(j) || b.type !== a.type) return;
      const d = closest(a, b);
      if (d < bd) { bd = d; best = j; }
    });
    if (best < 0 || bd > radius) return { ...a, methods: ['tracking'], also: null };
    used.add(best);
    return { ...a, methods: ['tracking', 'difference'], also: difference[best] };
  });
  difference.forEach((b, j) => { if (!used.has(j)) out.push({ ...b, methods: ['difference'], also: null }); });
  return out;
}

/** The headline of a card: {key, vars, from, to} where from/to are the epochs compared (if any).
 * epochs: the sorted epoch numbers of the view. pair: {brighter, from, to} when the page already knows
 * which two visits it shows side by side, so the words match the pictures. */
export function headline(c, epochs = [], pair = null) {
  if (c.method === 'difference' && c.type !== 'moving') {      // first visit against the last (c.from, c.to)
    const from = c.from ?? null, to = c.to ?? null;
    if (c.kind === 'appeared') return { key: 'fAppeared', vars: {}, to };
    if (c.kind === 'vanished') return { key: 'fVanished', vars: {}, from };
    const brighter = c.kind === 'brightened';
    if (!c.ratio) return { key: brighter ? 'fBrighter' : 'fFainter', vars: {}, from, to };   // saturated: no number
    if (brighter && c.ratio >= 2) return { key: 'fBrighterX', vars: { x: c.ratio.toFixed(1) }, from, to };
    const pct = Math.round(brighter ? (c.ratio - 1) * 100 : (1 - 1 / c.ratio) * 100);
    return { key: brighter ? 'fBrighterBy' : 'fFainterBy', vars: { pct }, from, to };
  }
  if (c.type === 'moving') {
    return { key: 'fMover', vars: { rate: c.rate_arcsec_yr, dir: compass(c.pa_deg) } };
  }
  if (c.type === 'variable') {
    const best = (c.detectors || []).reduce((a, d) => (!a || d.ratio > a.ratio ? d : a), null);
    const fl = best?.fluxes || [];
    if (!pair && fl.length < 2) return { key: 'fChanged', vars: { x: c.ratio } };
    let brighter, from, to;
    if (pair) ({ brighter, from, to } = pair);
    else {
      const hi = fl.reduce((a, f) => (f.flux_ujy > a.flux_ujy ? f : a));
      const lo = fl.reduce((a, f) => (f.flux_ujy < a.flux_ujy ? f : a));
      brighter = hi.epoch > lo.epoch;
      from = Math.min(hi.epoch, lo.epoch); to = Math.max(hi.epoch, lo.epoch);
    }
    const ratio = c.ratio || best.ratio;
    if (brighter && ratio >= 2) return { key: 'fBrighterX', vars: { x: ratio.toFixed(1) }, from, to };
    const pct = Math.round(brighter ? (ratio - 1) * 100 : (1 - 1 / ratio) * 100);
    return { key: brighter ? 'fBrighterBy' : 'fFainterBy', vars: { pct }, from, to };
  }
  const first = epochs[0], last = epochs[epochs.length - 1];
  if (epochs.length > 1 && c.epoch === last) return { key: 'fAppeared', vars: {}, to: c.epoch };
  if (epochs.length > 1 && c.epoch === first) return { key: 'fVanished', vars: {}, from: c.epoch };
  return { key: 'fOnlyOnce', vars: {}, to: c.epoch };
}

/** A catalogue entry moved to a date with its proper motion (mas/yr; epoch in years, 2016 for Gaia). */
export function positionAt(src, mjd) {
  const dt = (mjd - MJD_J2000) / 365.25 - ((src.epoch ?? 2016) - 2000);
  const dec = src.dec + (src.pmdec || 0) * dt / 3.6e6;
  const ra = src.ra + (src.pmra || 0) * dt / 3.6e6 / Math.cos(src.dec * Math.PI / 180);
  return [ra, dec];
}

/** The catalogue entry closest to candidate c at its date, within MATCH_ARCSEC; null if none.
 * A mover only matches an entry that moves about as fast (a background star under it is not it). */
export function nearestAt(rows, c, mjd, radius = MATCH_ARCSEC) {
  const cosd = Math.cos(c.dec * Math.PI / 180);
  let best = null, bd = Infinity;
  for (const s of rows || []) {
    const [ra, dec] = positionAt(s, mjd);
    const d = Math.hypot(((ra - c.ra + 540) % 360 - 180) * cosd, dec - c.dec) * 3600;
    if (d < bd) { bd = d; best = s; }
  }
  if (!best || bd > radius) return null;
  if (c.type === 'moving') {
    const pm = Math.hypot(best.pmra || 0, best.pmdec || 0) / 1000;
    if (Math.abs(pm - c.rate_arcsec_yr) > Math.max(1.5, 0.3 * pm)) return null;
  }
  return best;
}

/** 'NAME Barnard's star' -> 'Barnard's star', 'V* R Dra' -> 'R Dra'. */
export const cleanId = (id) => String(id || '').replace(/^(NAME|V\*|\*\*|\*|EM\*|PM\*|BD\*)\s+/i, '').trim();

function hitName(cat, row) {
  if (cat === 'gaia') return `Gaia DR3 ${String(row.id).replace(/^Gaia DR3\s+/, '')}`;
  return cleanId(row.id);
}

/** What the catalogues say about one candidate.
 * states: {gaia|simbad|catwise: 'ok' | 'fail' | 'wait'}; hits: {gaia|simbad|catwise: row | null}.
 * Returns null (say nothing: it is the user's own target) or {kind, key, vars}, kind one of
 * 'known', 'wait', 'unchecked', 'new', 'notin', 'partly'. */
export function catalogueStatus(c, states, hits) {
  if (c.is_target) return null;
  const found = CAT_ORDER.filter(k => hits[k]);
  if (found.length) {
    // two names are enough to look it up; SIMBAD's is the one people know
    const names = found.slice(0, 2).map(k => hitName(k, hits[k]));
    return { kind: 'known', key: 'fKnown', vars: { names: names.join(' · ') } };
  }
  if (CAT_ORDER.some(k => states[k] === 'wait')) return { kind: 'wait', key: 'fChecking', vars: {} };
  const checked = CAT_ORDER.filter(k => states[k] === 'ok').map(k => CAT_NAMES[k]);
  const unchecked = CAT_ORDER.filter(k => states[k] !== 'ok').map(k => CAT_NAMES[k]);
  if (!checked.length) return { kind: 'unchecked', key: 'fUnchecked', vars: {} };
  if (unchecked.length) {
    return { kind: 'partly', key: 'fPartly', vars: { checked: checked.join(', '), unchecked: unchecked.join(', ') } };
  }
  // a mover faster than any star is most likely an artefact: do not call it new
  return tooFast(c) ? { kind: 'notin', key: 'fNotIn', vars: { cats: checked.join(', ') } }
    : { kind: 'new', key: 'fNew', vars: { cats: checked.join(', ') } };
}
