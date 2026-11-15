// The "Type" box under the spectrum: what the catalogues say about the object, what our own fit of
// its SPHEREx spectrum says, whether the two agree, and the molecular fingerprints in the light.
// typeLines() only turns an /api/spectype answer into i18n keys, so the node tests can load it.

/** Pickles writes ranges without a dash ('B57V' is B5-7 V, 'K01II' is K0-1 II) and marks metal-rich
 * and metal-weak giants with a leading r or w ('rK2III'), which says nothing about the type. */
export function prettyType(name) {
  const s = String(name || '').replace(/^[rw](?=[OBAFGKM])/, '');
  const m = /^([OBAFGKMLTY])(\d)(\d)([IV]+)?$/.exec(s);
  return m ? `${m[1]}${m[2]}–${m[3]}${m[4] || ''}` : s;
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : null);
const LY_PER_PC = 3.2616;

/** The catalogue column: [[key, vars], ...]. cat is the "catalogue" part of the answer, or null. */
export function catalogueLines(cat, pending, failed) {
  if (!cat) return [[failed ? 'tyCatFail' : pending ? 'tyChecking' : 'tyCatFail', {}]];
  const out = [];
  const s = cat.simbad || {};
  if (!s.ok) out.push(['tySimbadDown', {}]);
  else if (!s.found) out.push(['tyNoSimbad', {}]);
  else out.push(s.sptype ? ['tySimbadType', { id: cleanName(s.id), type: s.sptype }] : ['tySimbadNoType', { id: cleanName(s.id) }]);
  const g = cat.gaia || {};
  if (!g.ok) out.push(['tyGaiaDown', {}]);
  else if (!g.found) out.push(['tyNoGaia', {}]);
  else {
    const vals = [num(g.teff) && `${num(g.teff)} K`, num(g.logg, 1) && `log g ${num(g.logg, 1)}`,
      num(g.mh, 1) && `[M/H] ${num(g.mh, 1).replace('-', '−')}`].filter(Boolean);
    out.push(num(g.teff) ? ['tyGaia', { vals: vals.join(', ') }] : ['tyGaiaNoTeff', {}]);
    if (num(g.distance_pc)) {
      const ly = g.distance_pc * LY_PER_PC;
      out.push(['tyGaiaDist', { d: ly < 100 ? ly.toFixed(1) : Math.round(ly).toLocaleString('en-US'), plx: num(g.parallax_mas, 1) ?? '?' }]);
    }
    if (num(g.p_star, 2)) out.push(['tyGaiaStar', { p: Math.round(g.p_star * 100) }]);
  }
  return out;
}

const cleanName = (id) => String(id || '').replace(/^(NAME|V\*|\*\*|\*|EM\*|PM\*|BD\*)\s+/i, '').trim();

/** Our column: [[key, vars], ...] from the "fit" part of the answer. */
export function oursLines(fit, spot = null) {
  // photometry gives a number anywhere: without a star at the spot a type would describe nothing
  if (spot && spot.state === 'empty') return [['tySpotEmpty', {}]];
  if (spot && spot.state === 'wing') return [['tySpotWing', {}]];
  if (!fit) return [];
  if (fit.note === 'saturated') return [['tySaturated', {}]];
  if (fit.note === 'too_faint' || fit.note === 'no_library') return [['tyTooFaint', {}]];
  const out = [];
  if (fit.note === 'blend') out.push(['tyBlend', {}]);
  const st = fit.standards;
  if (st) {
    out.push(['tyBest', { type: prettyType(st.type) }]);
    const bits = [];
    if (st.range && st.range[0] !== st.range[1]) bits.push(['tyRange', { lo: st.range[0], hi: st.range[1] }]);
    if (st.teff) bits.push(['tyTeff', { teff: st.teff }]);
    out.push(...bits);
    const alts = [...new Set((st.alternatives || []).map(a => prettyType(a.type)))].filter(a => a !== prettyType(st.type));
    if (alts.length) out.push(['tyAlt', { list: alts.join(', ') }]);
    out.push(['tyFrom', { n: st.n_bins, chi: st.chi2_red }]);
  }
  const mo = fit.model;
  if (mo) {
    out.push(['tyModel', { teff: mo.teff, type: mo.type }]);
    if (mo.chi2_red > 5) out.push(['tyModelRough', { chi: mo.chi2_red }]);
    if (mo.at_edge) out.push(['tyModelEdge', {}]);
  }
  return out;
}

/** One fingerprint row: [labelKey, valueKey, vars]. */
export function printLine(f) {
  return [`fp_${f.id}`, `fpv_${f.verdict}`, { pct: f.depth == null ? '' : Math.round(Math.abs(f.depth) * 100) }];
}

/** Everything the box says, as keys: {catalogue, ours, verdict, prints}. */
export function typeLines(res) {
  // no usable spectrum (saturated, too faint): no verdict, and no rows that would all say "no data"
  const noStar = !!res.spot && (res.spot.state === 'empty' || res.spot.state === 'wing');
  const none = noStar || !res.fit || ['saturated', 'too_faint', 'no_library'].includes(res.fit.note);
  const prints = (res.fingerprints || []).filter(() => !none);
  return {
    catalogue: catalogueLines(res.catalogue, res.pending, res.catFail),
    ours: oursLines(res.fit, res.spot),
    verdict: res.agreement && !none ? [`tyAgree_${res.agreement}`, res.agreement] : null,
    prints: prints.some(f => f.verdict !== 'no_data') ? prints.map(printLine) : [],
  };
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Draw the box into `box` (emptied first). t: the i18n function. */
export function renderTypeBox(box, res, t) {
  const L = typeLines(res);
  const cols = el('div', 'typecols');
  for (const [title, lines, first] of [['tyCatalogue', L.catalogue, false], ['tyOurs', L.ours, true]]) {
    const col = el('div', 'typecol');
    col.append(el('h4', '', t(title)));
    lines.forEach(([key, vars], i) => col.append(el('p', first && i === 0 && key === 'tyBest' ? 'typebest' : '', t(key, vars))));
    cols.append(col);
  }
  const kids = [el('h3', '', t('tyTitle')), cols];
  if (L.verdict) kids.push(el('p', `typeverdict ${L.verdict[1]}`, t(L.verdict[0])));
  if (L.prints.length) {
    kids.push(el('h3', '', t('tyPrints')));
    const dl = el('dl', 'prints');
    for (const [label, value, vars] of L.prints) {
      const dd = el('dd', value.replace('fpv_', ''), t(value, vars));
      dl.append(el('dt', '', t(label)), dd);
    }
    kids.push(dl);
  }
  kids.push(el('p', 'muted small', t('tyNote')));
  box.replaceChildren(...kids);
}
