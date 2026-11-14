// "For the curious", under the Type box: where the star sits among its neighbours (H-R diagram), how
// it moves, whether it pulses, and what other catalogues list there. Nothing is asked until a tool's
// button is pressed. The *Lines functions only turn answers into i18n keys, so node can test them.
import { scatterChart } from '../core/charts.js';

export const TOOLS = ['hr', 'motion', 'period', 'star'];
const LY_PER_PC = 3.2616;

/** km/s across the sky from a motion in arcsec/yr and a parallax in mas; null without a parallax. */
export function speedKms(rate, parallaxMas) {
  return parallaxMas > 0 && Number.isFinite(rate) ? 4.74 * rate * 1000 / parallaxMas : null;
}

/** "How it moves": [[key, vars], ...]. cand: the SPHEREx mover at this spot (or null); gaia: the
 * /api/curious/motion answer (or null when the spot has no Gaia star). */
export function motionLines(cand, gaia) {
  const out = [];
  const g = gaia && gaia.reachable && gaia.found ? gaia : null;
  if (cand) {
    out.push(['cuMotionOurs', { rate: cand.rate_arcsec_yr.toFixed(2), dir: cand.dir, n: cand.points?.length ?? '?' }]);
    const v = g && g.parallax_ok ? speedKms(cand.rate_arcsec_yr, g.parallax_mas) : null;
    if (v != null) out.push(['cuSpeed', { v: Math.round(v) }]);
  } else out.push(['cuMotionStill', {}]);
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

/** "Does it pulse?": [[key, vars], ...] for a /api/curious/period answer. */
export function periodLines(d) {
  if (!d || !d.ok) return [['cuPeriodNone', {}]];
  const vars = { p: Math.round(d.period_d), err: Math.max(1, Math.round(d.err_d)) };
  return [[d.convincing ? 'cuPeriod' : 'cuPeriodWeak', vars], ['cuPeriodCycles', { c: d.cycles.toFixed(1) }]];
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
 *   { ra, dec, mjd, pmra, pmdec, gaiaId, cand, points: [{mjd, wavelength, value}] }.
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
    if (tool === 'motion') return { gaia: await gaia() };
    if (tool === 'period') {
      const r = await fetch(new URL('api/curious/period', location.href), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points: c.points }) });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
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
    if (!d.ok) return;
    const two = el('div', 'cutwo'), gram = el('div', 'cuchart'), fold = el('div', 'cuchart');
    two.append(gram, fold);
    out.append(two, el('p', 'muted small', t('cuPeriodNote')));
    scatterChart(gram, { series: [{ name: 'LS', color: '#8a8f99', points: d.periodogram.map(([x, y]) => ({ x, y })) }],
      xLabel: t('cuPeriodDays'), yLabel: t('cuPower'), xFmt: v => v.toFixed(0), yFmt: v => v.toFixed(2), height: 240 });
    scatterChart(fold, { series: [{ name: 'fold', color: '#FFB347', points: d.folded.flatMap(([ph, v]) => [{ x: ph, y: v }, { x: ph + 1, y: v }]) }],
      xLabel: t('cuPhase'), yLabel: t('cuRatio'), xFmt: v => v.toFixed(1), yFmt: v => v.toFixed(2), height: 240 });
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
    else if (s.tool === 'motion') { lines(out, motionLines(c.cand, d.gaia)); out.append(el('p', 'muted small', t('cuMotionNote'))); }
    else if (s.tool === 'period') drawPeriod(out, d);
    else drawStar(out, d);
  }

  return {
    /** another spot is being measured: forget the answers, keep the section open and the tool chosen */
    reset() { s.data = {}; s.busy = null; s.failed = false; s.token += 1; if (s.tool && s.open && ctx()) run(s.tool); else draw(); },
    redraw: draw,
  };
}
