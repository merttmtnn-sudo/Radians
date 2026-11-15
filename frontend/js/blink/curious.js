// "For the curious", under the Type box: where the star sits among its neighbours (H-R diagram), how
// it moves, whether it pulses, and what other catalogues list there. Nothing is asked until a tool's
// button is pressed. The *Lines functions only turn answers into i18n keys, so node can test them.
import { scatterChart } from '../core/charts.js';
import { compass } from './finds.js';

export const TOOLS = ['hr', 'motion', 'period', 'star'];
const LY_PER_PC = 3.2616;

/** km/s across the sky from a motion in arcsec/yr and a parallax in mas; null without a parallax. */
export function speedKms(rate, parallaxMas) {
  return parallaxMas > 0 && Number.isFinite(rate) ? 4.74 * rate * 1000 / parallaxMas : null;
}

/** "How it moves": [[key, vars], ...]. cand: the SPHEREx mover at this spot (or null); gaia: the
 * /api/curious/motion answer (or null when the spot has no Gaia star); fit: the /api/quick/motion
 * answer, a line through the star's position in every pass of the fast band (or null). */
export function motionLines(cand, gaia, fit = null) {
  const out = [];
  const g = gaia && gaia.reachable && gaia.found ? gaia : null;
  const f = fit && fit.ok ? fit : null;
  if (cand) {
    out.push(['cuMotionOurs', { rate: cand.rate_arcsec_yr.toFixed(2), dir: cand.dir, n: cand.points?.length ?? '?' }]);
    const v = g && g.parallax_ok ? speedKms(cand.rate_arcsec_yr, g.parallax_mas) : null;
    if (v != null) out.push(['cuSpeed', { v: Math.round(v) }]);
  } else if (!(f && f.significant)) out.push(['cuMotionStill', {}]);
  if (f) {
    out.push([f.significant ? 'cuMotionFit' : 'cuMotionFitWeak',
      { rate: f.rate.toFixed(2), err: f.err.toFixed(2), dir: compass(f.direction_deg), n: f.n, b: fit.band }]);
    const v = !cand && f.significant && g && g.parallax_ok ? speedKms(f.rate, g.parallax_mas) : null;
    if (v != null) out.push(['cuSpeed', { v: Math.round(v) }]);
  } else if (fit && fit.reason === 'saturated') out.push(['cuMotionFitSat', {}]);
  if (gaia && !gaia.reachable) out.push(['tyGaiaDown', {}]);
  else if (!g) out.push(['tyNoGaia', {}]);
  else {
    out.push(g.rate >= 0.0005 ? ['cuMotionGaia', { rate: g.rate < 0.1 ? g.rate.toFixed(3) : g.rate.toFixed(2), dir: g.direction }] : ['cuMotionGaiaNone', {}]);
    if (g.parallax_ok) {
      const ly = 1000 / g.parallax_mas * LY_PER_PC;
      out.push(['tyGaiaDist', { d: ly < 100 ? ly.toFixed(1) : Math.round(ly).toLocaleString('en-US'), plx: g.parallax_mas.toFixed(1) }]);
    }
    if (g.speed_kms != null) out.push(['cuSpeedGaia', { v: Math.round(g.speed_kms) }]);
  }
  return out;
}

const days = (v) => (v < 20 ? v.toFixed(1) : String(Math.round(v)));
const month = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 7);
const NO_ANSWER = { too_faint: 'cuPeriodFaint', saturated: 'cuPeriodSat', empty: 'cuPeriodEmpty', wing: 'cuPeriodWing' };

/** "Does it pulse?": [[key, vars], ...] for a /api/curious/period answer. It answers two things: is
 * there a rhythm inside the visits, and did the brightness change from one visit to another. When
 * the spot cannot be tested (too faint, saturated, no star there) it says why and guesses nothing. */
export function periodLines(d) {
  if (!d || !d.ok) return [[d && d.reason === 'saturated' && d.wings ? 'cuPeriodSatWings' : NO_ANSWER[d && d.reason] || 'cuPeriodNone', {}]];
  const out = [];
  if (d.convincing) {
    const short = d.period_d < 20;                        // the error is written as finely as the period
    out.push(['cuPeriod', { p: days(d.period_d), err: short ? Math.max(d.err_d, 0.1).toFixed(1) : String(Math.max(1, Math.round(d.err_d))) }]);
    out.push(['cuPeriodDetail', { amp: Math.max(1, Math.round(d.amplitude_pct)), c: Math.round(d.cycles) }]);
    if (d.aliased) out.push(['cuPeriodAlias', {}]);
  } else if (d.search) out.push(['cuPeriodNoRhythm', { lo: days(d.search.lo_d), hi: days(d.search.hi_d) }]);
  else out.push(['cuPeriodNoSearch', {}]);
  const ch = d.change;
  if (!ch) out.push(['cuChangeOne', {}]);
  else if (ch.significant) {
    out.push([ch.brighter ? 'cuChangeBrighter' : 'cuChangeFainter',
      { pct: Math.round(ch.pct), sigma: Math.round(ch.sigma), a: month(ch.from_mjd), b: month(ch.to_mjd) }]);
  } else out.push(['cuChangeSteady', { pct: Math.max(1, Math.round(Math.max(ch.pct, 3 * ch.err_pct))) }]);
  const left = Object.values(d.dropped || {}).reduce((s, v) => s + v, 0);
  out.push(['cuPeriodUsed', { n: d.n, left }]);
  return out;
}

/** Is it a known variable star? [[key, vars], ...] for a /api/curious/variable answer (or null), next
 * to our own answer d: a catalogue period is compared with ours when we found one. */
export function knownLines(k, d) {
  if (!k) return [];
  const out = [], v = k.vsx || {}, g = k.gaia || {};
  if (v.reachable === false) out.push(['cuKnownDown', { cat: 'VSX' }]);
  else if (v.found) out.push([v.period_d ? 'cuKnownVsxPeriod' : 'cuKnownVsx', { name: v.name, type: v.type || '?', p: v.period_d ? days(v.period_d) : '' }]);
  if (g.reachable === false) out.push(['cuKnownDown', { cat: 'Gaia DR3' }]);
  else if (g.found && g.variable) out.push([g.class ? 'cuKnownGaiaClass' : 'cuKnownGaia', { cls: g.class || '' }]);
  if (!out.length) out.push(['cuKnownNone', {}]);
  if (d && d.ok && d.convincing && v.found && v.period_d) {
    out.push([Math.abs(d.period_d / v.period_d - 1) < 0.1 ? 'cuKnownAgree' : 'cuKnownDiffer', {}]);
  }
  return out;
}

/** "Other catalogues": rows [name, id or null, magnitudes text, stateKey or null]. */
export function starRows(gaia, surveys) {
  const mags = (m) => Object.entries(m || {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' · ');
  const rows = [];
  if (gaia && !gaia.reachable) rows.push(['Gaia DR3', null, '', 'cuUnreachable']);
  else if (!gaia || !gaia.found) rows.push(['Gaia DR3', null, '', 'cuNotListed']);
  else rows.push(['Gaia DR3', gaia.id, mags({ G: gaia.g, 'BP−RP': gaia.bp_rp }), null]);
  for (const s of surveys || []) {
    rows.push(s.state === 'found' ? [s.survey, `${s.id} (${s.sep_arcsec}″)`, mags(s.mags), null]
      : [s.survey, null, '', s.state === 'none' ? 'cuNotListed' : 'cuUnreachable']);
  }
  return rows;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * host: an empty element. ctx(): what is being measured right now, or null:
 *   { ra, dec, mjd, pmra, pmdec, gaiaId, cand, spot, wings,
 *     points: [{mjd, wavelength, value, err, flagged, saturated}] }.
 *   spot: the "is a star there" check of the photometry ({state: 'star' | 'empty' | 'wing'}) or null.
 * Returns { reset() } to call whenever another spot is measured, and { redraw() } on a language change.
 */
export function createCurious(host, { t, ctx }) {
  const s = { tool: null, data: {}, busy: null, failed: false, token: 0, open: false };
  const get = async (path, params) => {
    const u = new URL(path, location.href);
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') u.searchParams.set(k, v);
    const r = await fetch(u);
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  };

  async function load(tool, c) {
    const gaia = () => (c.gaiaId ? get('api/curious/motion', { gaia_id: c.gaiaId }) : Promise.resolve(null));
    if (tool === 'hr') return get('api/curious/hr', { ra: c.ra.toFixed(4), dec: c.dec.toFixed(4), gaia_id: c.gaiaId });
    if (tool === 'motion') {
      const [g, fit] = await Promise.all([gaia(), c.fitAt ? get('api/quick/motion', c.fitAt).catch(() => null) : Promise.resolve(null)]);
      return { gaia: g, fit };
    }
    if (tool === 'period') {
      // what the catalogues know is worth showing even where we cannot test the star ourselves
      const known = get('api/curious/variable', { ra: c.ra.toFixed(6), dec: c.dec.toFixed(6), gaia_id: c.gaiaId }).catch(() => null);
      if (c.spot && (c.spot.state === 'empty' || c.spot.state === 'wing')) return { ok: false, reason: c.spot.state, known: await known };
      const r = await fetch(new URL('api/curious/period', location.href), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: c.points, wings: !!c.wings }) });
      if (!r.ok) throw new Error(String(r.status));
      return { ...(await r.json()), known: await known };
    }
    const [g, x] = await Promise.all([gaia(), get('api/curious/xmatch', { ra: c.ra.toFixed(6), dec: c.dec.toFixed(6), pmra: c.pmra, pmdec: c.pmdec, mjd: c.mjd.toFixed(1) })]);
    return { gaia: g, surveys: x.surveys };
  }

  async function run(tool) {
    s.tool = tool;
    const c = ctx();
    if (!c) return;
    if (s.data[tool]) { draw(); return; }
    const token = s.token;
    s.busy = tool; s.failed = false; draw();
    try {
      const d = await load(tool, c);
      if (token !== s.token) return;
      s.data[tool] = d;
    } catch { if (token === s.token) s.failed = true; }
    if (token === s.token) { s.busy = null; draw(); }
  }

  const lines = (out, list) => {
    const box = el('div', 'culines');
    list.forEach(([key, vars], i) => box.append(el('p', i === 0 ? 'first' : '', t(key, { ...vars, dir: vars.dir ? t('cdir_' + vars.dir) : '' }))));
    out.append(box);
  };

  function drawHr(out, d) {
    if (!d.reachable) { out.append(el('p', 'muted small', t('tyGaiaDown'))); return; }
    if (!d.stars.length) { out.append(el('p', 'muted small', t('cuHrNone'))); return; }
    const me = d.star && d.star.found && d.star.abs_g != null && d.star.bp_rp != null ? d.star : null;
    const chart = el('div', 'cuchart');
    out.append(chart, el('p', 'muted small', t(me ? 'cuHrNote' : 'cuHrNoStar', { n: d.stars.length.toLocaleString('en-US') })));
    // brighter is up: plot minus the absolute magnitude and print it back as it is
    scatterChart(chart, {
      series: [{ name: t('cuHrOthers'), color: '#8a8f99', points: d.stars.map(([x, y]) => ({ x, y: -y })) },
        ...(me ? [{ name: t('cuHrThis'), color: '#FFB347', points: [{ x: me.bp_rp, y: -me.abs_g, tip: [t('cuHrThis'), `BP−RP ${me.bp_rp.toFixed(2)} · M(G) ${me.abs_g.toFixed(2)}`] }] }] : [])],
      xLabel: t('cuColour'), yLabel: t('cuAbsMag'), xFmt: v => v.toFixed(1), yFmt: v => (-v).toFixed(0), height: 300,
    });
  }

  function drawPeriod(out, d) {
    lines(out, periodLines(d));
    const known = knownLines(d.known, d);
    if (known.length) {
      const box = el('div', 'culines cuknown');
      box.append(el('h5', '', t('cuKnownTitle')), ...known.map(([key, vars]) => el('p', '', t(key, vars))));
      out.append(box);
    }
    if (!d.ok) return;
    const two = el('div', 'cutwo'), curve = el('div', 'cuchart'), second = el('div', 'cuchart');
    two.append(curve, second);
    out.append(two, el('p', 'muted small', t('cuPeriodNote')));
    // the light curve itself: every usable point, and the level of each visit with its error
    const t0 = d.points.length ? d.points[0][0] : 0;
    scatterChart(curve, {
      series: [{ name: t('cuPoints'), color: '#8a8f99', points: d.points.map(([x, y]) => ({ x: x - t0, y })) },
        { name: t('cuVisits'), color: '#FFB347', points: d.visits.map(v => ({ x: v.mjd - t0, y: v.level, err: v.err,
          tip: [month(v.mjd), `${v.level.toFixed(3)} ± ${v.err.toFixed(3)} · ${v.n}`] })) }],
      xLabel: t('cuDaysSince', { d: month(t0) }), yLabel: t('cuRatio'), xFmt: v => v.toFixed(0), yFmt: v => v.toFixed(2), height: 240 });
    if (d.convincing) {
      scatterChart(second, { series: [{ name: 'fold', color: '#FFB347', points: d.folded.flatMap(([ph, v]) => [{ x: ph, y: v }, { x: ph + 1, y: v }]) }],
        xLabel: t('cuPhase'), yLabel: t('cuRatio'), xFmt: v => v.toFixed(1), yFmt: v => v.toFixed(2), height: 240 });
    } else if (d.search) {
      // how well each trial period fits, against the height that scrambled data reach one time in a hundred
      const xs = d.periodogram.map(([x]) => x);
      scatterChart(second, { series: [{ name: t('cuPower'), color: '#8a8f99', points: d.periodogram.map(([x, y]) => ({ x, y })) }],
        lines: [{ name: t('cuChanceLine'), color: '#FFB347', dash: '5 4', points: [{ x: Math.min(...xs), y: d.threshold }, { x: Math.max(...xs), y: d.threshold }] }],
        xLabel: t('cuPeriodDays'), yLabel: t('cuPower'), xFmt: v => v.toFixed(0), yFmt: v => v.toFixed(2), height: 240 });
    }
  }

  function drawStar(out, d) {
    const table = el('table', 'cutable');
    const head = el('tr');
    for (const k of ['cuCatalogue', 'cuName', 'cuMags']) head.append(el('th', '', t(k)));
    table.append(head);
    for (const [name, id, mags, state] of starRows(d.gaia, d.surveys)) {
      const tr = el('tr');
      tr.append(el('td', '', name));
      if (state) { const td = el('td', 'muted', t(state)); td.colSpan = 2; tr.append(td); } else tr.append(el('td', 'mono', id), el('td', 'mono', mags));
      table.append(tr);
    }
    out.append(table, el('p', 'muted small', t('cuStarNote')));
  }

  function draw() {
    const c = ctx();
    host.hidden = !c;
    if (!c) { host.replaceChildren(); return; }
    const det = el('details', 'curious');
    det.open = s.open;
    det.ontoggle = () => { s.open = det.open; };
    det.append(el('summary', '', t('cuTitle')));
    const bar = el('div', 'cubar');
    for (const k of TOOLS) {
      const b = el('button', 'btn sm', t('cuTool_' + k));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(s.tool === k));
      b.onclick = () => run(k);
      bar.append(b);
    }
    const out = el('div', 'cuout');
    det.append(bar, out);
    host.replaceChildren(det);
    if (!s.tool) return;
    if (s.busy) { out.append(el('p', 'muted small', t('cuWorking'))); return; }
    const d = s.data[s.tool];
    if (s.failed || !d) { out.append(el('p', 'muted small', t('cuFailed'))); return; }
    if (s.tool === 'hr') drawHr(out, d);
    else if (s.tool === 'motion') { lines(out, motionLines(c.cand, d.gaia, d.fit)); out.append(el('p', 'muted small', t('cuMotionNote'))); }
    else if (s.tool === 'period') drawPeriod(out, d);
    else drawStar(out, d);
  }

  return {
    /** another spot is being measured: forget the answers, keep the section open and the tool chosen */
    reset() { s.data = {}; s.busy = null; s.failed = false; s.token += 1; if (s.tool && s.open && ctx()) run(s.tool); else draw(); },
    redraw: draw,
  };
}
