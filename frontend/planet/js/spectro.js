// Forced spectrophotometry on SPHEREx Level-2 spectral images (all exposures, all 102 channels, all epochs).
import { $, el, esc, toast, fmtRA, fmtDec, parseRA, parseDec, mjdToDate, mjdToYear, propagate, state, bus, api, download,
  DET_COLORS, angSep } from './util.js';
import { findImages, loadFrames, framesCovering, groupByTime, maskOf, ALL_FLAGS, BAD_FLAGS, subsampleItems, interleaveItems } from './spx.js';
import { Plot } from './plot.js';

const EPOCH_COLORS = ['#66d9ff', '#ff8a3d', '#5be38f', '#ff6bd6', '#ffd84d', '#a98bff', '#ff5d6c', '#9fe8c8'];
const FEATURES = [[1.282, 'Paβ'], [1.4, 'H₂O'], [1.875, 'Paα'], [1.9, 'H₂O'], [2.2, 'CH₄'], [2.7, 'H₂O'], [3.05, 'H₂O ice'], [3.3, 'CH₄ / PAH'],
  [4.05, 'Brα'], [4.27, 'CO₂'], [4.67, 'CO']];
const REF_BANDS = { J: [1.235, 1594], H: [1.662, 1024], Ks: [2.159, 666.7], W1: [3.353, 309.54], W2: [4.603, 171.787] };

// erf approximation (Abramowitz & Stegun 7.1.26)
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const Phi = x => 0.5 * (1 + erf(x / Math.SQRT2));

export function measure(f, ra, dec, o) {
  const [x0, y0] = f.world2pix(ra, dec);
  const margin = 2;
  if (!(x0 >= margin && y0 >= margin && x0 <= f.nx - 1 - margin && y0 <= f.ny - 1 - margin)) return null;
  const sigma = Math.max(0.3, (f.hdr.PSF_FWHM || 7) / 2.3548 / f.pixScale);
  const omega = (f.hdr.OMEGA_MEDIAN || f.pixScale ** 2) * (Math.PI / 180 / 3600) ** 2;
  const conv = omega * 1e12; // (MJy/sr) * px  ->  µJy
  const nx = f.nx, I = f.image, Z = f.zodi, V = f.variance, F = f.flags, bad = o.badMask;
  // saturated source? (OVERFLOW = bit 1 in the central 3x3) -> report the saturated footprint instead,
  // whose area grows with the source brightness and so still traces variability
  const OVER = 1 << 1;
  if (f.flagsAt(x0, y0, 1) & OVER) {
    let area = 0;
    for (let j = Math.floor(y0 - 8); j <= Math.ceil(y0 + 8); j++) for (let i = Math.floor(x0 - 8); i <= Math.ceil(x0 + 8); i++) {
      if (i < 0 || j < 0 || i >= nx || j >= f.ny || Math.hypot(i - x0, j - y0) > 8) continue;
      if (F[j * nx + i] & OVER) area++;
    }
    const k0 = Math.round(y0) * nx + Math.round(x0);
    return { saturated: true, satArea: area, wave: f.wave[k0], mjd: f.mjd, det: f.det, obsid: f.item.obsid, frame: f };
  }
  const val = k => I[k] - (o.zodi ? Z[k] : 0);
  const ok = k => isFinite(I[k]) && !(F[k] & bad) && isFinite(V[k]) && V[k] > 0;
  let res = null;
  if (o.method === 'psf') {
    const R = 3.2;
    const fit = (xc, yc) => {
      let Spp = 0, Sp = 0, S1 = 0, Spd = 0, Sd = 0, n = 0;
      const pix = [];
      for (let j = Math.floor(yc - R); j <= Math.ceil(yc + R); j++) for (let i = Math.floor(xc - R); i <= Math.ceil(xc + R); i++) {
        if (i < 0 || j < 0 || i >= nx || j >= f.ny || Math.hypot(i - xc, j - yc) > R) continue;
        const k = j * nx + i;
        if (!ok(k)) continue;
        const P = (Phi((i + 0.5 - xc) / sigma) - Phi((i - 0.5 - xc) / sigma)) * (Phi((j + 0.5 - yc) / sigma) - Phi((j - 0.5 - yc) / sigma));
        const w = 1 / V[k], d = val(k);
        Spp += w * P * P; Sp += w * P; S1 += w; Spd += w * P * d; Sd += w * d; n++;
        pix.push([P, d, w]);
      }
      if (n < 6) return null;
      const det = Spp * S1 - Sp * Sp;
      if (!(det > 0)) return null;
      const A = (S1 * Spd - Sp * Sd) / det, b = (Spp * Sd - Sp * Spd) / det;
      let chi2 = 0; for (const [P, d, w] of pix) chi2 += w * (d - A * P - b) ** 2;
      return { A, b, varA: S1 / det, chi2, n };
    };
    let best = fit(x0, y0), bx = x0, by = y0;
    if (o.recenter && best) {
      for (let dy = -1; dy <= 1.001; dy += 0.25) for (let dx = -1; dx <= 1.001; dx += 0.25) {
        const r = fit(x0 + dx, y0 + dy);
        if (r && r.chi2 < best.chi2) { best = r; bx = x0 + dx; by = y0 + dy; }
      }
    }
    if (!best) return null;
    const chi2r = best.chi2 / Math.max(1, best.n - 2);
    res = { flux: best.A * conv, err: Math.sqrt(best.varA * Math.max(1, chi2r)) * conv, chi2r, npix: best.n, x: bx, y: by };
  } else {
    const r = o.aper, [r1, r2] = o.ann;
    const ap = [], an = [];
    for (let j = Math.floor(y0 - r2); j <= Math.ceil(y0 + r2); j++) for (let i = Math.floor(x0 - r2); i <= Math.ceil(x0 + r2); i++) {
      if (i < 0 || j < 0 || i >= nx || j >= f.ny) continue;
      const d = Math.hypot(i - x0, j - y0), k = j * nx + i;
      if (d <= r) ap.push(k); else if (d >= r1 && d <= r2 && ok(k)) an.push(val(k));
    }
    const apOk = ap.filter(ok);
    if (apOk.length < ap.length * 0.75 || an.length < 6) return null;
    an.sort((a, b) => a - b);
    const bkg = an[an.length >> 1];
    const mad = an.map(v => Math.abs(v - bkg)).sort((a, b) => a - b)[an.length >> 1] * 1.4826;
    let sum = 0, vs = 0;
    for (const k of apOk) { sum += val(k) - bkg; vs += V[k]; }
    sum *= ap.length / apOk.length;
    const apcorr = 1 - Math.exp(-(r * r) / (2 * sigma * sigma));
    const err = Math.sqrt(vs + ap.length ** 2 * mad ** 2 / an.length);
    res = { flux: sum / apcorr * conv, err: err / apcorr * conv, chi2r: NaN, npix: apOk.length, x: x0, y: y0 };
  }
  const k0 = Math.round(y0) * nx + Math.round(x0);
  res.wave = f.wave[k0]; res.bw = f.bw[k0];
  res.flags = f.flagsAt(x0, y0, 1);
  res.flagNames = f.flagList(res.flags).filter(n => n !== 'FULLSAMPLE' && n !== 'SOURCE');
  res.bad = !!(res.flags & bad);
  res.snr = res.flux / res.err;
  res.mjd = f.mjd; res.det = f.det; res.obsid = f.item.obsid; res.rel = f.item.rel; res.frame = f;
  return isFinite(res.flux) && isFinite(res.wave) ? res : null;
}

export class Spectro {
  constructor() {
    this.rows = [];
    this.dets = new Set([1, 2, 3, 4, 5, 6]);
    this.flagSel = new Set(BAD_FLAGS);
    this.plot = new Plot($('#spPlot'), $('#spTip'));
    this.lc = new Plot($('#lcPlot'), $('#spTip'));
    this.channels = null;
    this.buildUI();
  }
  buildUI() {
    const fl = $('#spFlags');
    for (const n of Object.keys(ALL_FLAGS)) {
      const c = el('span', { class: 'chip' + (this.flagSel.has(n) ? ' on' : '') }, n);
      c.onclick = () => { c.classList.toggle('on'); c.classList.contains('on') ? this.flagSel.add(n) : this.flagSel.delete(n); };
      fl.append(c);
    }
    const dets = $('#spDets');
    for (let d = 1; d <= 6; d++) {
      const c = el('span', { class: 'chip on' }, el('span', { class: 'det-dot', style: `background:${DET_COLORS[d]}` }), 'D' + d);
      c.onclick = () => { c.classList.toggle('on'); c.classList.contains('on') ? this.dets.add(d) : this.dets.delete(d); this.draw(); };
      dets.append(c);
    }
    $('#spRun').onclick = () => this.run();
    for (const id of ['spYUnit', 'spColor', 'spLogY', 'spBinned', 'spFeatures', 'spRef', 'spHideFlag', 'lcBand']) $('#' + id).addEventListener('change', () => this.draw());
    $('#spCsv').onclick = () => this.csv();
    $('#spPngBtn').onclick = () => download('spherex_spectrum.png', this.plot.png());
    const lb = $('#lcBand');
    lb.append(el('option', { value: 'rel' }, 'relative flux, all channels'));
    for (let d = 1; d <= 6; d++) lb.append(el('option', { value: d }, `D${d} flux`));
    lb.append(el('option', { value: 'sat' }, 'saturated footprint (very bright stars)'));
    bus.on('target', ({ target }) => { if (target) { $('#spRA').value = fmtRA(target.ra, 3); $('#spDec').value = fmtDec(target.dec, 2).replace('−', '-'); this.pos = null; } });
    bus.on('spectrum-at', p => { $('#spRA').value = fmtRA(p.ra, 3); $('#spDec').value = fmtDec(p.dec, 2).replace('−', '-'); this.pos = p; $('#spPm').checked = false; this.run(); });
    api('/api/sx/hips-properties').then(p => { this.channels = (p.data_cube_crval3_arr || '').split(/\s+/).map(Number).filter(isFinite); }).catch(() => {});
  }

  progress(frac, text) {
    const p = $('#spProgress');
    p.classList.toggle('hidden', frac === null);
    const bar = p.querySelector('.bar');
    bar.classList.toggle('indet', frac < 0);
    if (frac >= 0) bar.style.width = (frac * 100).toFixed(1) + '%';
    p.querySelector('.ptxt').textContent = text || '';
  }

  async run() {
    const ra = parseRA($('#spRA').value), dec = parseDec($('#spDec').value);
    if (!isFinite(ra) || !isFinite(dec)) return toast('Enter a valid RA/Dec', true);
    const t = state.target;
    const follow = $('#spPm').checked && t && angSep(t.ra, t.dec, ra, dec) < 1 / 3600 && (t.pmra || t.pmdec || t.plx);
    const src = follow ? t : { ra, dec, pmra: 0, pmdec: 0, plx: 0, epoch: 2000, name: 'Position' };
    this.src = src;
    this.abort?.abort();
    const ctl = this.abort = new AbortController();
    $('#spRun').disabled = true;
    bus.emit('spectrum-start');
    try {
      const q = follow ? propagate(src, 2025.9) : src;
      this.progress(-1, 'Querying SPHEREx exposures covering the position…');
      const res = await findImages(q.ra, q.dec);
      let items = res.items.filter(it => this.dets.has(it.det));
      if (!items.length) { this.progress(null); return toast('No SPHEREx exposures cover this position', true); }
      const cap = +$('#spMax').value;
      if (cap && items.length > cap) {
        // deep fields have thousands of exposures: keep an even sample over time and detectors
        const per = Math.max(2, Math.ceil(cap / (6 * groupByTime(items, 45).length)));
        items = subsampleItems(items, per);
        toast(`Deep field: using ${items.length} of ${res.items.length} exposures (change “Exposures” to measure more)`, false, 6000);
      }
      const meanMjd = items.reduce((a, b) => a + b.mjd, 0) / items.length;
      const c = follow ? propagate(src, mjdToYear(meanMjd)) : src;
      // reuse cutouts already loaded by the Time-Lapse tool when they contain the position
      const have = [], need = [];
      for (const it of items) { const f = framesCovering(it.uri, c.ra, c.dec, 0.006); f ? have.push(f) : need.push(it); }
      this.progress(0, `Measuring ${items.length} exposures (${have.length} already in memory)…`);
      const opts = { method: $('#spMethod').value, zodi: $('#spZodi').checked, recenter: $('#spRecenter').checked, badMask: maskOf([...this.flagSel]),
        aper: +$('#spAper').value || 2, ann: ($('#spAnn').value.split(/[-,\s]+/).map(Number).filter(isFinite).concat([4, 7])).slice(0, 2) };
      this.opts = opts;
      const rows = [];
      this.sat = [];
      const doMeasure = f => {
        const p = follow ? propagate(src, f.year, f.mjd) : src;
        const r = measure(f, p.ra, p.dec, opts);
        if (r?.saturated) this.sat.push(r); else if (r) rows.push(r);
      };
      have.forEach(doMeasure);
      let last = 0;
      const frames = await loadFrames(interleaveItems(need), c.ra, c.dec, 0.04, {
        signal: ctl.signal,
        onFrame: f => { doMeasure(f); const now = performance.now(); if (now - last > 700) { last = now; this.setRows(rows); } },
        onProgress: (d, n, failed) => this.progress((have.length + d) / items.length, `Measured ${have.length + d}/${items.length} exposures${failed ? ` (${failed} failed)` : ''}`),
      });
      if (ctl.signal.aborted) return;
      this.progress(null);
      this.setRows(rows);
      this.loadRefs();
      this.checkBlend(mjdToYear(meanMjd));
      toast(`Spectrum built from ${rows.length} measurements` + (this.sat.length ? ` (${this.sat.length} saturated exposures)` : ''));
    } catch (e) {
      if (!ctl.signal.aborted) { this.progress(null); toast('Spectrophotometry failed: ' + e.message, true); }
    } finally { $('#spRun').disabled = false; }
  }

  setRows(rows) {
    this.rows = rows.slice().sort((a, b) => a.mjd - b.mjd);
    const groups = groupByTime(this.rows.map(r => ({ mjd: r.mjd, r })), 45);
    groups.forEach((g, i) => g.frames.forEach(x => { x.r.epoch = i + 1; }));
    this.nEpochs = groups.length;
    this.epochDates = groups.map(g => `${mjdToDate(g.first).toISOString().slice(0, 10)} → ${mjdToDate(g.last).toISOString().slice(0, 10)}`);
    const nm = this.src?.name && this.src.name !== 'Position' ? this.src.name + ' · ' : '';
    $('#spTitle').textContent = `${nm}${fmtRA(this.src.ra, 1)} ${fmtDec(this.src.dec, 0)} · ${this.rows.length} points · ${this.nEpochs} epoch(s)`;
    const ns = this.sat?.length || 0;
    if (ns) {
      // saturated sources: epochs for the footprint light curve
      groupByTime(this.sat.map(s => ({ mjd: s.mjd, s })), 45).forEach((g, i) => g.frames.forEach(x => { x.s.epoch = i + 1; }));
      this.warn('sat', `⚠ Saturated in ${ns} of ${ns + this.rows.length} exposures — too bright for SPHEREx photometry. The light curve shows the saturated-footprint area instead (it grows with brightness).`);
      if (ns > this.rows.length && $('#lcBand').value !== 'sat') $('#lcBand').value = 'sat';
    } else this.warn('sat', '');
    this.draw();
  }

  // warn when Gaia sources fall inside the SPHEREx PSF (6.2" pixels) at the SPHEREx epoch
  warn(key, text) {
    (this.warnings ||= {})[key] = text;
    $('#spWarn').textContent = Object.values(this.warnings).filter(Boolean).join('  ');
  }
  async checkBlend(year) {
    this.warn('blend', '');
    try {
      const c = propagate(this.src, year);
      const r = await api(`/api/sx/catalog?cat=gaia&ra=${c.ra.toFixed(6)}&dec=${c.dec.toFixed(6)}&radius=0.0045`);
      const near = r.rows.map(s => { const p = propagate(s, year); return { s, sep: angSep(p.ra, p.dec, c.ra, c.dec) * 3600 }; })
        .filter(x => x.sep > 1.5 && x.sep < 14 && x.s.mag < 19.5).sort((a, b) => a.sep - b.sep);
      if (near.length) this.warn('blend', `⚠ ${near.length} Gaia neighbour${near.length > 1 ? 's' : ''} within 14″ (closest G=${near[0].s.mag.toFixed(1)} at ${near[0].sep.toFixed(1)}″) — short-wavelength fluxes may be blended`);
    } catch (e) { console.warn('blend check', e); }
  }

  // nearest 2MASS (epoch ~1999) and AllWISE (epoch ~2010.5) counterpart, using the source's proper motion
  async loadRefs() {
    this.refPoints = [];
    try {
      for (const [cat, epoch] of [['2mass', 1999.0], ['allwise', 2010.5]]) {
        const p = propagate(this.src, epoch);
        const r = await api(`/api/sx/catalog?cat=${cat}&ra=${p.ra.toFixed(6)}&dec=${p.dec.toFixed(6)}&radius=0.0028`);
        let best = null, bd = 1e9;
        for (const s of r.rows) { const d = angSep(s.ra, s.dec, p.ra, p.dec); if (d < bd) { bd = d; best = s; } }
        if (!best || bd > 6 / 3600) continue;
        for (const [band, m] of Object.entries(best.bands || {})) if (isFinite(m) && REF_BANDS[band]) this.refPoints.push([band, m]);
      }
      this.draw();
    } catch (e) { console.warn('reference photometry', e); }
  }

  conv(fl, wave) {
    const u = $('#spYUnit').value;
    if (u === 'mjy') return fl / 1000;
    if (u === 'ab') return fl > 0 ? 23.9 - 2.5 * Math.log10(fl) : NaN;
    if (u === 'lfl') return fl * 1e-32 * 2.998e8 / (wave * 1e-6);
    return fl;
  }

  draw() {
    const unit = $('#spYUnit').value;
    const hide = $('#spHideFlag').checked;
    const rows = this.rows.filter(r => this.dets.has(r.det) && !(hide && r.bad));
    this.shown = rows;
    $('#spCount').textContent = rows.length ? `(${rows.length} shown of ${this.rows.length})` : '';
    const colorBy = $('#spColor').value;
    const colorOf = r => colorBy === 'det' ? DET_COLORS[r.det] : colorBy === 'snr' ? `hsl(${Math.max(0, Math.min(120, r.snr * 4))},90%,60%)` : EPOCH_COLORS[(r.epoch - 1) % EPOCH_COLORS.length];
    const ab = unit === 'ab';
    const pts = rows.map(r => {
      const y = this.conv(r.flux, r.wave);
      const e = ab ? 1.0857 * r.err / Math.abs(r.flux) : Math.abs(this.conv(r.flux + r.err, r.wave) - y);
      return { x: r.wave, y, e, color: colorOf(r), hollow: r.bad,
        tip: `<b>${r.wave.toFixed(4)} µm</b> · D${r.det} · epoch ${r.epoch}<br>${r.flux.toFixed(1)} ± ${r.err.toFixed(1)} µJy (S/N ${r.snr.toFixed(1)})<br>${mjdToDate(r.mjd).toISOString().slice(0, 16).replace('T', ' ')} UT · ${esc(r.obsid)}${r.flagNames.length ? '<br><span style="color:#ffcc4d">' + r.flagNames.join(', ') + '</span>' : ''}` };
    });
    const series = [{ points: pts, color: '#66d9ff', size: 2.4 }];
    // binned spectrum per epoch
    if ($('#spBinned').checked && rows.length) {
      const centers = this.channels && this.channels.length > 50 ? this.channels : null;
      for (let e = 1; e <= this.nEpochs; e++) {
        const rs = rows.filter(r => r.epoch === e && !r.bad);
        const bins = new Map();
        for (const r of rs) {
          const key = centers ? centers.reduce((bi, c, i) => Math.abs(c - r.wave) < Math.abs(centers[bi] - r.wave) ? i : bi, 0) : Math.round(Math.log(r.wave) * 80);
          const b = bins.get(key) || { s: 0, w: 0, x: 0, n: 0 };
          const w = 1 / (r.err * r.err);
          b.s += r.flux * w; b.w += w; b.x += r.wave; b.n++;
          bins.set(key, b);
        }
        const bp = [...bins.values()].map(b => ({ x: b.x / b.n, f: b.s / b.w, e: 1 / Math.sqrt(b.w) })).sort((a, b) => a.x - b.x)
          .map(b => ({ x: b.x, y: this.conv(b.f, b.x), e: 0 }));
        series.push({ points: bp, color: EPOCH_COLORS[(e - 1) % EPOCH_COLORS.length], line: true, dots: false, width: 1.8 });
      }
    }
    if ($('#spRef').checked && this.refPoints?.length) {
      const rp = this.refPoints.map(([b, m]) => { const [w, zp] = REF_BANDS[b]; const fl = zp * 1e6 * 10 ** (-0.4 * m); return { x: w, y: this.conv(fl, w), e: 0, color: '#ffffff', tip: `<b>${b}</b> = ${m.toFixed(2)} mag → ${fl.toFixed(0)} µJy (${b === 'W1' || b === 'W2' ? 'AllWISE' : '2MASS'})` }; });
      series.push({ points: rp, color: '#ffffff', shape: 'diamond', size: 4, outline: true });
    }
    const legend = colorBy === 'epoch' ? Array.from({ length: this.nEpochs || 0 }, (_, i) => ({ label: `Epoch ${i + 1}: ${this.epochDates[i]}`, color: EPOCH_COLORS[i % EPOCH_COLORS.length] }))
      : colorBy === 'det' ? [1, 2, 3, 4, 5, 6].map(d => ({ label: 'D' + d, color: DET_COLORS[d] })) : [];
    if ($('#spRef').checked && this.refPoints?.length) legend.push({ label: '2MASS / AllWISE', color: '#ffffff' });
    const yl = { ujy: 'Flux density Fν (µJy)', mjy: 'Flux density Fν (mJy)', ab: 'AB magnitude', lfl: 'λFλ (W m⁻²)' }[unit];
    this.plot.set({ series, legend, xLabel: 'Wavelength (µm)', yLabel: yl, logY: $('#spLogY').checked && !ab, invertY: ab, xRange: [0.7, 5.05],
      markers: $('#spFeatures').checked ? FEATURES.map(([x, l]) => ({ x, label: l, color: 'rgba(255,204,77,0.55)' })) : [],
      empty: this.sat?.length ? 'Every exposure is saturated at this position — no flux can be measured. See the saturated-footprint light curve below.' : 'Choose a target and press “Measure spectrum”. Test targets: WISE 0855 (methane & water absorption), R Dra / RW Aur (variability).' });
    this.drawLc(rows, colorOf);
    this.table(rows);
  }

  drawLc(rows, colorOf) {
    const band = $('#lcBand').value;
    let pts = [];
    if (band === 'sat') {
      pts = (this.sat || []).filter(s => this.dets.has(s.det)).map(s => ({ x: s.mjd, y: s.satArea, e: 0, color: DET_COLORS[s.det],
        tip: `${mjdToDate(s.mjd).toISOString().slice(0, 10)} · D${s.det} · ${isFinite(s.wave) ? s.wave.toFixed(3) + ' µm · ' : ''}${s.satArea} saturated px` }));
      return this.lc.set({ series: [{ points: pts, color: '#66d9ff', size: 2.2 }], xLabel: 'Date (UTC)', yLabel: 'Saturated pixels (r ≤ 8 px)',
        xFmt: v => mjdToDate(v).toISOString().slice(0, 10), xTicks: (a, b) => Plot.ticks(a, b, false, 5),
        legend: [1, 2, 3, 4, 5, 6].map(d => ({ label: 'D' + d, color: DET_COLORS[d] })), empty: 'No saturated exposures — pick a flux light curve.' });
    }
    if (band === 'rel') {
      // flux relative to the all-epoch mean in each wavelength bin -> variability independent of colour
      const bins = new Map();
      for (const r of rows) { if (r.bad) continue; const k = Math.round(Math.log(r.wave) * 60); const b = bins.get(k) || { s: 0, w: 0 }; const w = 1 / r.err ** 2; b.s += r.flux * w; b.w += w; bins.set(k, b); }
      pts = rows.filter(r => !r.bad).map(r => { const b = bins.get(Math.round(Math.log(r.wave) * 60)); const m = b.s / b.w; return m > 0 && r.snr > 3 ? { x: r.mjd, y: r.flux / m, e: r.err / m, color: DET_COLORS[r.det],
        tip: `${mjdToDate(r.mjd).toISOString().slice(0, 10)} · ${r.wave.toFixed(3)} µm · ratio ${(r.flux / m).toFixed(3)}` } : null; }).filter(Boolean);
    } else {
      pts = rows.filter(r => r.det === +band).map(r => ({ x: r.mjd, y: r.flux, e: r.err, color: colorOf(r), tip: `${mjdToDate(r.mjd).toISOString().slice(0, 10)} · ${r.wave.toFixed(3)} µm · ${r.flux.toFixed(1)} µJy` }));
    }
    this.lc.set({ series: [{ points: pts, color: '#66d9ff', size: 2.2 }], xLabel: 'Date (UTC)', yLabel: band === 'rel' ? 'Flux / mean' : 'µJy',
      xFmt: v => mjdToDate(v).toISOString().slice(0, 10), xTicks: (a, b) => Plot.ticks(a, b, false, 5),
      legend: band === 'rel' ? [1, 2, 3, 4, 5, 6].map(d => ({ label: 'D' + d, color: DET_COLORS[d] })) : [], empty: 'Light curve appears after measuring.' });
  }

  table(rows) {
    const body = rows.slice(0, 1500).map(r => `<tr class="${r.bad ? 'flagged' : ''}"><td>${mjdToDate(r.mjd).toISOString().slice(0, 16).replace('T', ' ')}</td><td>D${r.det}</td><td>${r.wave.toFixed(4)}</td><td>${r.bw.toFixed(4)}</td>
      <td>${r.flux.toFixed(2)}</td><td>${r.err.toFixed(2)}</td><td>${r.snr.toFixed(1)}</td><td>${r.epoch}</td><td style="text-align:left">${esc(r.flagNames.join(' '))}</td><td style="text-align:left">${esc(r.obsid)}</td></tr>`).join('');
    $('#spTable').innerHTML = `<table><thead><tr><th>UTC</th><th>Det</th><th>λ µm</th><th>Δλ µm</th><th>Fν µJy</th><th>σ µJy</th><th>S/N</th><th>Epoch</th><th style="text-align:left">Flags</th><th style="text-align:left">Obs ID</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  csv() {
    if (!this.rows.length) return toast('Nothing to export yet', true);
    const head = 'mjd,utc,detector,wavelength_um,bandwidth_um,flux_uJy,flux_err_uJy,snr,epoch,flagged,flags,obs_id,release,method,ra_deg,dec_deg';
    const lines = this.rows.map(r => { const [ra, dec] = r.frame.pix2world(r.x, r.y); return [r.mjd.toFixed(6), mjdToDate(r.mjd).toISOString(), r.det, r.wave.toFixed(5), r.bw.toFixed(5), r.flux.toFixed(4), r.err.toFixed(4),
      r.snr.toFixed(2), r.epoch, r.bad ? 1 : 0, r.flagNames.join('|'), r.obsid, r.rel, this.opts.method, ra.toFixed(6), dec.toFixed(6)].join(','); });
    download(`spherex_spectrophotometry_${(this.src?.name || 'position').replace(/\W+/g, '_')}.csv`, new Blob([head + '\n' + lines.join('\n')], { type: 'text/csv' }));
  }
}
