// SPHEREx Time-Lapse: query all SPHEREx exposures covering a position, cut them out, reproject onto a
// common north-up grid, stack by survey epoch / visit / detector, and blink them like a little video.
import { $, $$, el, esc, toast, fmtRA, fmtDec, parseRA, parseDec, mjdToDate, mjdToYear, propagate, state, bus, api, download,
  TEST_TARGETS, DET_COLORS, DET_RANGE, writeUrl, clamp } from './util.js';
import { findImages, loadFrames, groupByTime, maskOf, BAD_FLAGS, subsampleItems as subsample, interleaveItems as interleave } from './spx.js';
import * as IM from './imaging.js';

const CONTAM = ['GHOST', 'GHOST_FPA', 'GHOST_EXT', 'CROSSTALK', 'DICHROIC', ...BAD_FLAGS];
const OV_COLORS = { gaia: '#5be38f', catwise: '#66d9ff', allwise: '#ff6bd6', '2mass': '#ffd84d' };

export class Blink {
  constructor() {
    this.frames = [];
    this.products = [];
    this.cur = 0;
    this.playing = false;
    this.dir = 1;
    this.excluded = new Set();
    this.repro = new Map();
    this.cats = {};
    this.click = null;
    this.dets = new Set([1, 2, 3, 4, 5, 6]);
    this.rels = new Set(['dr1', 'qr3', 'dr1_deep', 'qr3_deep']);
    this.cv = $('#blinkCanvas'); this.ov = $('#blinkOverlay');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.buildUI();
    new ResizeObserver(() => this.layout()).observe($('#blinkViewer'));
  }

  buildUI() {
    const pre = $('#blinkPreset');
    for (const t of TEST_TARGETS) pre.append(el('option', { value: t.id }, t.name));
    pre.onchange = () => { const t = TEST_TARGETS.find(x => x.id === pre.value); if (t) state.setTarget(t, 'blink'); };
    const dets = $('#blinkDets');
    for (let d = 1; d <= 6; d++) {
      const c = el('span', { class: 'chip on', title: `${DET_RANGE[d][0]}–${DET_RANGE[d][1]} µm` }, el('span', { class: 'det-dot', style: `background:${DET_COLORS[d]}` }), 'D' + d);
      c.onclick = () => { c.classList.toggle('on'); c.classList.contains('on') ? this.dets.add(d) : this.dets.delete(d); };
      dets.append(c);
    }
    const rels = $('#blinkRels');
    for (const [k, lab] of [['dr1', 'DR1'], ['qr3', 'QR3'], ['dr1_deep', 'DR1 deep'], ['qr3_deep', 'QR3 deep']]) {
      const c = el('span', { class: 'chip on', title: 'SPHEREx data release ' + lab }, lab);
      c.onclick = () => { c.classList.toggle('on'); c.classList.contains('on') ? this.rels.add(k) : this.rels.delete(k); };
      rels.append(c);
    }
    $('#blinkResolve').onclick = () => this.resolve();
    $('#blinkName').addEventListener('keydown', e => { if (e.key === 'Enter') this.resolve(); });
    $('#blinkLoad').onclick = () => this.load();
    const rebuildIds = ['blinkMode', 'blinkBand', 'blinkDiff', 'blinkZodi', 'blinkBkg', 'blinkMask', 'blinkSmooth', 'blinkUpsample', 'blinkWmin', 'blinkWmax'];
    for (const id of rebuildIds) $('#' + id).addEventListener('change', () => { if (['blinkZodi', 'blinkBkg', 'blinkMask', 'blinkUpsample'].includes(id)) this.repro.clear(); this.rebuild(); });
    for (const id of ['blinkStretch', 'blinkCmap', 'blinkLo', 'blinkHi', 'blinkGlobal', 'blinkInvert']) $('#' + id).addEventListener('change', () => { this.computeScales(); this.render(); });
    for (const id of ['ovCross', 'ovTrack', 'ovFlags', 'ovCompass']) $('#' + id).addEventListener('change', () => this.render());
    for (const [id, cat] of [['ovGaia', 'gaia'], ['ovCatwise', 'catwise'], ['ovAllwise', 'allwise'], ['ov2mass', '2mass']])
      $('#' + id).addEventListener('change', e => { if (e.target.checked) this.loadCatalog(cat); else this.render(); });
    $('#bpPlay').onclick = () => this.togglePlay();
    $('#bpPrev').onclick = () => this.step(-1);
    $('#bpNext').onclick = () => this.step(1);
    $('#bpSlider').oninput = e => { this.cur = +e.target.value; this.render(); };
    $('#bpPng').onclick = () => this.savePng();
    $('#bpVideo').onclick = () => this.recordVideo();
    $('#bpShare').onclick = () => this.share();
    $('#blinkSpecHere').onclick = () => { if (this.click) bus.emit('spectrum-at', { ra: this.click.ra, dec: this.click.dec, fromBlink: true }); };
    this.ov.addEventListener('mousemove', e => this.hover(e));
    this.ov.addEventListener('mouseleave', () => { $('#blinkCursor').textContent = 'Move over the image. Click to measure a spectrum at that position.'; });
    this.ov.addEventListener('click', e => this.onClick(e));
    bus.on('target', ({ target, source }) => { if (target) this.fillTarget(target); });
  }

  fillTarget(t) {
    $('#blinkRA').value = fmtRA(t.ra, 3); $('#blinkDec').value = fmtDec(t.dec, 2).replace('−', '-');
    $('#blinkName').value = t.name || '';
    $('#blinkPmRa').value = t.pmra || ''; $('#blinkPmDec').value = t.pmdec || '';
    $('#blinkEpoch').value = t.epoch ?? 2000;
    this.plx = t.plx || 0;
    const p = TEST_TARGETS.find(x => x.name === t.name);
    $('#blinkPreset').value = p ? p.id : '';
  }
  readTarget() {
    const ra = parseRA($('#blinkRA').value), dec = parseDec($('#blinkDec').value);
    if (!isFinite(ra) || !isFinite(dec) || Math.abs(dec) > 90) throw new Error('Please enter a valid RA and Dec');
    return { name: $('#blinkName').value.trim() || 'Custom position', ra, dec, pmra: +$('#blinkPmRa').value || 0, pmdec: +$('#blinkPmDec').value || 0,
      epoch: +$('#blinkEpoch').value || 2000, plx: this.plx || 0 };
  }
  async resolve() {
    const name = $('#blinkName').value.trim();
    if (!name) return;
    try {
      const r = await api('/api/sx/resolve?name=' + encodeURIComponent(name));
      state.setTarget({ ...r, name: r.name || name }, 'blink');
      toast(`Resolved ${r.name}: ${fmtRA(r.ra, 1)} ${fmtDec(r.dec, 0)}`);
    } catch (e) { toast('Name not resolved: ' + e.message, true); }
  }

  progress(frac, text) {
    const p = $('#blinkProgress');
    p.classList.toggle('hidden', frac === null);
    const bar = p.querySelector('.bar');
    bar.classList.toggle('indet', frac < 0);
    if (frac >= 0) bar.style.width = (frac * 100).toFixed(1) + '%';
    p.querySelector('.ptxt').textContent = text || '';
  }

  async load() {
    let t;
    try { t = this.readTarget(); } catch (e) { return toast(e.message, true); }
    if (!state.target || Math.abs(state.target.ra - t.ra) > 1e-6 || Math.abs(state.target.dec - t.dec) > 1e-6 || state.target.name !== t.name)
      state.setTarget(t, 'blink-load');
    this.target = state.target || t;
    this.abort?.abort();
    const ctl = this.abort = new AbortController();
    this.stop();
    this.frames = []; this.products = []; this.repro.clear(); this.cats = {}; this.click = null; this.excluded.clear();
    $('#blinkSpecHere').disabled = true;
    const size = +$('#blinkFov').value;
    this.size = size;
    const pmc = $('#blinkPmCenter').checked && (t.pmra || t.pmdec);
    const q = pmc ? propagate(t, 2025.9) : t;
    $('#blinkLoad').disabled = true;
    try {
      this.progress(-1, 'Querying the IRSA SPHEREx archive (first query ≈ 20 s)…');
      const res = await findImages(q.ra, q.dec);
      if (ctl.signal.aborted) return;
      let items = res.items.filter(it => this.dets.has(it.det) && this.rels.has(it.rel));
      const wmin = +$('#blinkWmin').value || 0, wmax = +$('#blinkWmax').value || 99;
      items = items.filter(it => it.wmax >= wmin && it.wmin <= wmax);
      if (!items.length) { this.progress(null); $('#blinkLoad').disabled = false; return toast(res.items.length ? 'No exposures match the detector / release / wavelength filters' : 'SPHEREx has no exposures covering this position yet', true); }
      const maxPer = +$('#blinkMax').value;
      if (maxPer) {
        // budget sized for a normal field (3 surveys); deep fields with many monthly epochs get fewer per epoch
        const nEp = groupByTime(items, 45).length;
        items = subsample(items, Math.min(maxPer, Math.max(1, Math.floor(maxPer * 18 / (6 * nEp)))));
      }
      const meanMjd = items.reduce((a, b) => a + b.mjd, 0) / items.length;
      this.center = pmc ? propagate(t, mjdToYear(meanMjd)) : { ra: t.ra, dec: t.dec };
      this.items = items;
      this.makeGrid();
      $('#blinkEmpty').classList.add('hidden');
      $('#blinkCount').textContent = `(${items.length} used of ${res.count})`;
      let lastBuild = 0, lastList = 0;
      this.progress(0, `Cutting out ${items.length} exposures…`);
      writeUrl(this.urlParams());
      // cutouts are aligned with the detector, which is rotated on the sky: fetch a slightly larger
      // square so the north-up display grid is completely covered
      await loadFrames(interleave(items), this.center.ra, this.center.dec, Math.min(0.5, size * 1.45), {
        signal: ctl.signal,
        onFrame: f => {
          this.frames.push(f);
          const now = performance.now();
          if (now - lastBuild > 900) { lastBuild = now; this.rebuild(true); }
          if (now - lastList > 3000) { lastList = now; this.renderList(); }
        },
        onProgress: (d, n, failed) => this.progress(d / n, `Loaded ${d}/${n} exposures${failed ? ` (${failed} failed)` : ''} — cached for next time`),
      });
      if (ctl.signal.aborted) return;
      this.progress(null);
      this.rebuild();
      for (const [id, cat] of [['ovGaia', 'gaia'], ['ovCatwise', 'catwise'], ['ovAllwise', 'allwise'], ['ov2mass', '2mass']]) if ($('#' + id).checked) this.loadCatalog(cat);
      toast(`${this.frames.length} SPHEREx exposures ready → ${this.products.length} frames`);
      if (this.products.length > 1 && !this.playing) this.togglePlay();
    } catch (e) {
      if (!ctl.signal.aborted) { this.progress(null); toast('Loading failed: ' + e.message, true); }
    } finally { $('#blinkLoad').disabled = false; }
  }

  makeGrid() {
    const up = +$('#blinkUpsample').value;
    this.grid = IM.makeGrid(this.center.ra, this.center.dec, this.size, 6.15 / up);
  }

  settingsKey() { return [$('#blinkZodi').checked, $('#blinkMask').checked, $('#blinkBkg').checked, $('#blinkUpsample').value].join(); }
  reproFrame(f) {
    const key = f.item.uri + '|' + this.settingsKey();
    let r = this.repro.get(key);
    if (!r) {
      r = IM.reproject(f, this.grid, { zodi: $('#blinkZodi').checked, bkg: $('#blinkBkg').checked, badMask: $('#blinkMask').checked ? maskOf(BAD_FLAGS) : 0 });
      this.repro.set(key, r);
    }
    return r;
  }

  usableFrames() {
    const wmin = +$('#blinkWmin').value || 0, wmax = +$('#blinkWmax').value || 99;
    return this.frames.filter(f => {
      if (this.excluded.has(f.item.uri)) return false;
      if (!this.dets.has(f.det)) return false;
      const w = f.waveAt(this.center.ra, this.center.dec);
      f.wc = w;
      return !(isFinite(w) && (w < wmin || w > wmax));
    }).sort((a, b) => a.mjd - b.mjd);
  }

  rebuild(partial = false) {
    if (!this.frames.length || !this.grid) return;
    const up = +$('#blinkUpsample').value;
    if (Math.abs(this.grid.scale * 3600 - 6.15 / up) > 1e-6) { this.makeGrid(); this.repro.clear(); }
    const n = this.grid.n, N = n * n;
    const mode = $('#blinkMode').value, band = $('#blinkBand').value, diff = $('#blinkDiff').value;
    const frames = this.usableFrames();
    let groups;
    if (mode === 'exp') groups = frames.map(f => ({ frames: [f], mjd: f.mjd, first: f.mjd, last: f.mjd }));
    else groups = groupByTime(frames, mode === 'epoch' ? 45 : 1.0);
    const bandSets = band === 'rgb' ? [[1, 2], [3, 4], [5, 6]] : band === 'all' ? [[1, 2, 3, 4, 5, 6]] : [[+band]];
    let prods = [];
    let epochNo = 0;
    for (const g of groups) {
      const chans = bandSets.map(ds => g.frames.filter(f => ds.includes(f.det)));
      if (chans.every(c => !c.length)) continue;
      if (band === 'rgb' && mode === 'exp') { /* single exposure: put it in its colour channel */ }
      const imgs = chans.map(c => c.length ? IM.stack(c.map(f => this.reproFrame(f)), N) : { img: new Float32Array(N).fill(NaN), w: new Float32Array(N) });
      epochNo++;
      const members = chans.flat();
      const d0 = mjdToDate(g.first), d1 = mjdToDate(g.last);
      const label = mode === 'epoch' ? `Survey epoch ${epochNo}` : mode === 'visit' ? `Visit ${epochNo}` : `${members[0].item.obsid} D${members[0].det}`;
      prods.push({ label, mjd: g.mjd, first: g.first, last: g.last, members, imgs: imgs.map(x => x.img), ws: imgs.map(x => x.w),
        dateText: d0.toISOString().slice(0, 10) + (g.last - g.first > 1 ? ' → ' + d1.toISOString().slice(0, 10) : ' ' + d0.toISOString().slice(11, 16) + ' UT') });
    }
    // comparisons
    if (prods.length && diff !== 'none') {
      const C = prods[0].imgs.length;
      if (diff === 'sum') {
        const imgs = [], ws = [];
        for (let c = 0; c < C; c++) { const s = IM.stack(prods.map(p => ({ img: p.imgs[c], w: p.ws[c] })), N); imgs.push(s.img); ws.push(s.w); }
        const all = prods.flatMap(p => p.members);
        prods = [{ label: `Deep co-add of ${prods.length} frames`, mjd: prods.reduce((a, p) => a + p.mjd, 0) / prods.length, first: prods[0].first,
          last: prods[prods.length - 1].last, members: all, imgs, ws, dateText: `${mjdToDate(prods[0].first).toISOString().slice(0, 10)} → ${mjdToDate(prods[prods.length - 1].last).toISOString().slice(0, 10)}` }];
      } else {
        let ref = null;
        if (diff === 'median') {
          ref = [];
          for (let c = 0; c < C; c++) {
            const m = new Float32Array(N);
            const buf = [];
            for (let p = 0; p < N; p++) { buf.length = 0; for (const pr of prods) { const v = pr.imgs[c][p]; if (isFinite(v)) buf.push(v); } buf.sort((a, b) => a - b); m[p] = buf.length ? buf[buf.length >> 1] : NaN; }
            ref.push(m);
          }
        }
        const base = prods.map(p => p.imgs);
        prods = prods.map((p, i) => {
          const r = diff === 'first' ? base[0] : diff === 'prev' ? base[(i - 1 + base.length) % base.length] : ref;
          const imgs = p.imgs.map((im, c) => { const o = new Float32Array(N); for (let k = 0; k < N; k++) o[k] = im[k] - r[c][k]; return o; });
          return { ...p, imgs, signed: true, label: p.label + (diff === 'first' ? ' − first' : diff === 'prev' ? ' − previous' : ' − median') };
        });
      }
    }
    const sm = +$('#blinkSmooth').value;
    if (sm) for (const p of prods) p.imgs = p.imgs.map(im => IM.smooth(im, n, sm * +$('#blinkUpsample').value));
    this.products = prods;
    this.cur = Math.min(this.cur, Math.max(0, prods.length - 1));
    const sl = $('#bpSlider'); sl.max = Math.max(0, prods.length - 1); sl.value = this.cur;
    this.computeScales();
    this.render();
    if (!partial) this.renderList();
  }

  computeScales() {
    const P = this.products;
    if (!P.length) return;
    const lo = +$('#blinkLo').value, hi = +$('#blinkHi').value;
    const glob = $('#blinkGlobal').checked;
    const C = P[0].imgs.length;
    const sc = (imgs, signed) => {
      if (signed) { const a = IM.percentiles(imgs.map(im => im.map(Math.abs)), [hi])[0] || 1; return [-a, a]; }
      return IM.percentiles(imgs, [lo, hi]);
    };
    for (const p of P) p.scales = [];
    for (let c = 0; c < C; c++) {
      if (glob) { const s = sc(P.map(p => p.imgs[c]), P[0].signed); for (const p of P) p.scales[c] = s; }
      else for (const p of P) p.scales[c] = sc([p.imgs[c]], p.signed);
    }
  }

  layout() {
    const v = $('#blinkViewer').getBoundingClientRect();
    const side = Math.max(50, Math.floor(Math.min(v.width, v.height)));
    const left = Math.floor((v.width - side) / 2), top = Math.floor((v.height - side) / 2);
    for (const c of [this.cv, this.ov]) Object.assign(c.style, { width: side + 'px', height: side + 'px', left: left + 'px', top: top + 'px' });
    this.side = side;
    this.ov.width = side * this.dpr; this.ov.height = side * this.dpr;
    this.render();
  }

  render() {
    const P = this.products[this.cur];
    if (!P || !this.grid) { this.drawOverlay(); return; }
    const n = this.grid.n;
    if (this.cv.width !== n) { this.cv.width = n; this.cv.height = n; }
    const C = P.imgs.length;
    let flagMask = null;
    if ($('#ovFlags').checked) flagMask = this.flagMaskFor(P);
    const id = IM.toImageData(C === 3 ? P.imgs : [P.imgs[0]], n, C === 3 ? P.scales : P.scales[0],
      { stretch: $('#blinkStretch').value, cmap: $('#blinkCmap').value, invert: $('#blinkInvert').checked, flagMask, signed: !!P.signed && C === 1 });
    this.cv.getContext('2d').putImageData(id, 0, 0);
    this.cv.style.imageRendering = +$('#blinkUpsample').value > 1 ? 'auto' : 'pixelated';
    $('#bpSlider').value = this.cur;
    const dets = [...new Set(P.members.map(f => f.det))].sort();
    const ws = P.members.map(f => f.wc).filter(isFinite);
    const wtxt = ws.length ? (ws.length === 1 ? `λ ${ws[0].toFixed(3)} µm` : `λ ${Math.min(...ws).toFixed(2)}–${Math.max(...ws).toFixed(2)} µm`) : '';
    $('#blinkStamp').textContent = `${P.dateText}\n${P.label} · ${dets.map(d => 'D' + d).join('+')} · ${wtxt}\nframe ${this.cur + 1}/${this.products.length}`;
    this.drawOverlay();
    this.renderMeta();
    this.highlightList();
  }

  flagMaskFor(P) {
    const g = this.grid, n = g.n, m = new Uint8Array(n * n);
    const bad = maskOf(CONTAM);
    for (const f of P.members) {
      for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) {
        const [ra, dec] = IM.gridToWorld(g, i, j);
        const [x, y] = f.world2pix(ra, dec);
        const xi = Math.round(x), yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= f.nx || yi >= f.ny) continue;
        if (f.flags[yi * f.nx + xi] & bad) m[j * n + i] = 1;
      }
      if (P.members.length > 12) break; // keep it fast for big stacks
    }
    return m;
  }

  g2s(i, j) { const s = this.side * this.dpr / this.grid.n; return [(i + 0.5) * s, (j + 0.5) * s]; }

  drawOverlay() {
    const ctx = this.ov.getContext('2d');
    ctx.clearRect(0, 0, this.ov.width, this.ov.height);
    const P = this.products[this.cur];
    if (!P || !this.grid) return;
    const g = this.grid, s = this.dpr, W = this.ov.width;
    const pxs = W / g.n;
    // catalogs
    for (const [cat, rows] of Object.entries(this.cats)) {
      const id = { gaia: 'ovGaia', catwise: 'ovCatwise', allwise: 'ovAllwise', '2mass': 'ov2mass' }[cat];
      if (!$('#' + id).checked || !rows) continue;
      ctx.strokeStyle = OV_COLORS[cat]; ctx.lineWidth = 1.2 * s; ctx.globalAlpha = 0.85;
      for (const r of rows) {
        const p = propagate(r, mjdToYear(P.mjd), r.plx ? P.mjd : null);
        const [i, j] = IM.worldToGrid(g, p.ra, p.dec);
        if (i < -2 || j < -2 || i > g.n + 1 || j > g.n + 1) continue;
        const [x, y] = this.g2s(i, j);
        const rad = Math.max(4 * s, Math.min(10 * s, (21 - (r.mag || 18)) * 1.2 * s));
        ctx.beginPath();
        if (cat === 'gaia') ctx.arc(x, y, rad, 0, Math.PI * 2);
        else if (cat === 'catwise') ctx.rect(x - rad, y - rad, rad * 2, rad * 2);
        else if (cat === 'allwise') { ctx.moveTo(x - rad, y - rad); ctx.lineTo(x + rad, y + rad); ctx.moveTo(x + rad, y - rad); ctx.lineTo(x - rad, y + rad); }
        else { ctx.moveTo(x - rad, y); ctx.lineTo(x + rad, y); ctx.moveTo(x, y - rad); ctx.lineTo(x, y + rad); }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // predicted track of the target (proper motion + parallax)
    const t = this.target;
    if ($('#ovTrack').checked && t && (t.pmra || t.pmdec || t.plx)) {
      const pts = this.products.map(p => { const q = propagate(t, mjdToYear(p.mjd), p.mjd); return this.g2s(...IM.worldToGrid(g, q.ra, q.dec)); });
      ctx.strokeStyle = 'rgba(255,138,61,0.55)'; ctx.lineWidth = 1 * s; ctx.setLineDash([3 * s, 3 * s]);
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.stroke(); ctx.setLineDash([]);
      pts.forEach((p, i) => { ctx.fillStyle = i === this.cur ? '#ff8a3d' : 'rgba(255,138,61,0.5)'; ctx.beginPath(); ctx.arc(p[0], p[1], (i === this.cur ? 2.5 : 1.6) * s, 0, Math.PI * 2); ctx.fill(); });
      const c = pts[this.cur];
      if (c) { ctx.strokeStyle = '#ff8a3d'; ctx.lineWidth = 1.6 * s; ctx.beginPath(); ctx.arc(c[0], c[1], Math.max(9 * s, pxs * 2.2), 0, Math.PI * 2); ctx.stroke(); }
    }
    // crosshair
    if ($('#ovCross').checked) {
      const c = W / 2, gap = Math.max(10 * s, pxs * 3), len = 14 * s;
      ctx.strokeStyle = 'rgba(102,217,255,0.9)'; ctx.lineWidth = 1.4 * s; ctx.beginPath();
      ctx.moveTo(c - gap - len, c); ctx.lineTo(c - gap, c); ctx.moveTo(c + gap, c); ctx.lineTo(c + gap + len, c);
      ctx.moveTo(c, c - gap - len); ctx.lineTo(c, c - gap); ctx.moveTo(c, c + gap); ctx.lineTo(c, c + gap + len); ctx.stroke();
    }
    // clicked position
    if (this.click) {
      const [x, y] = this.g2s(...IM.worldToGrid(g, this.click.ra, this.click.dec));
      ctx.strokeStyle = '#ffcc4d'; ctx.lineWidth = 1.5 * s; ctx.beginPath(); ctx.arc(x, y, 7 * s, 0, Math.PI * 2); ctx.stroke();
    }
    // compass + scale bar
    if ($('#ovCompass').checked) {
      const x0 = W - 18 * s, y0 = W - 18 * s, L = 34 * s;
      ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 1.5 * s; ctx.font = `${12 * s}px Segoe UI, sans-serif`;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0, y0 - L); ctx.moveTo(x0, y0); ctx.lineTo(x0 - L, y0); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillText('N', x0, y0 - L - 4 * s); ctx.textAlign = 'right'; ctx.fillText('E', x0 - L - 4 * s, y0 + 4 * s);
      const arcmin = g.n * g.scale * 60;
      const bar = arcmin > 8 ? 2 : arcmin > 3 ? 1 : 0.5;
      const bl = bar / 60 / g.scale * pxs;
      ctx.beginPath(); ctx.moveTo(14 * s, W - 16 * s); ctx.lineTo(14 * s + bl, W - 16 * s); ctx.stroke();
      ctx.textAlign = 'left'; ctx.fillText(bar >= 1 ? bar + '′' : bar * 60 + '″', 14 * s, W - 22 * s);
    }
  }

  renderMeta() {
    const P = this.products[this.cur];
    if (!P) return;
    const rows = [['Frame', esc(P.label)], ['Date', esc(P.dateText)], ['Mean MJD', P.mjd.toFixed(4)], ['Exposures', P.members.length]];
    const dets = [...new Set(P.members.map(f => f.det))].sort();
    rows.push(['Detectors', dets.map(d => `<span class="det-dot" style="background:${DET_COLORS[d]}"></span>D${d}`).join(' ')]);
    if (P.members.length === 1) {
      const f = P.members[0], h = f.hdr;
      const [x, y] = f.world2pix(this.center.ra, this.center.dec);
      const fl = f.flagList(f.flagsAt(x, y, 1)).filter(n => n !== 'FULLSAMPLE');
      rows.push(['Obs ID', esc(f.item.obsid) + ' · ' + f.item.rel.toUpperCase()], ['λ at center', isFinite(f.wc) ? f.wc.toFixed(4) + ' µm (Δλ ' + f.sampleMap(f.bw, x, y).toFixed(3) + ')' : '—'],
        ['Exposure', (h.XPOSURE || 0).toFixed(1) + ' s'], ['PSF FWHM', (h.PSF_FWHM || 0).toFixed(2) + '″'], ['Pixel scale', f.pixScale.toFixed(2) + '″'],
        ['Data quality', `L1 ${esc(h.L1DQAFLG || '?')} · L2 ${esc(h.L2DQAFLG || '?')}`], ['Source mask', (h.PXSRCMSK ?? '—') + ' % of pixels'],
        ['Flags at target', fl.length ? `<span style="color:var(--warn)">${fl.join(', ')}</span>` : '<span style="color:var(--good)">none</span>'],
        ['Glow flags', ['HE_AIRGLOW_CONT', 'SHUTTLE_GLOW_CONT', 'AURORA_CONT'].filter(k => h[k]).map(k => k.replace('_CONT', '')).join(', ') || 'none']);
    } else {
      const ws = P.members.map(f => f.wc).filter(isFinite);
      if (ws.length) rows.push(['λ range', Math.min(...ws).toFixed(3) + '–' + Math.max(...ws).toFixed(3) + ' µm']);
      const flagged = P.members.filter(f => { const [x, y] = f.world2pix(this.center.ra, this.center.dec); return f.flagsAt(x, y, 1) & maskOf(BAD_FLAGS); }).length;
      rows.push(['Flagged at target', `${flagged} of ${P.members.length} exposures`]);
    }
    if (this.target && (this.target.pmra || this.target.pmdec)) {
      const p = propagate(this.target, mjdToYear(P.mjd), P.mjd);
      rows.push(['Predicted pos.', fmtRA(p.ra, 2) + ' ' + fmtDec(p.dec, 1)]);
    }
    $('#blinkMeta').innerHTML = '<table>' + rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('') + '</table>';
  }

  renderList() {
    const fr = [...this.frames].sort((a, b) => a.mjd - b.mjd);
    const bad = maskOf(BAD_FLAGS);
    const body = fr.map(f => {
      const [x, y] = f.world2pix(this.center.ra, this.center.dec);
      const fl = f.flagsAt(x, y, 1);
      const w = f.waveAt(this.center.ra, this.center.dec);
      const ex = this.excluded.has(f.item.uri);
      return `<tr data-uri="${esc(f.item.uri)}" class="${fl & bad ? 'flagged' : ''} ${ex ? 'excluded' : ''}" title="${esc(f.flagList(fl).join(', '))}">
        <td><input type="checkbox" ${ex ? '' : 'checked'}></td><td>${mjdToDate(f.mjd).toISOString().slice(0, 16).replace('T', ' ')}</td>
        <td><span class="det-dot" style="background:${DET_COLORS[f.det]}"></span>D${f.det}</td><td>${isFinite(w) ? w.toFixed(3) : '—'}</td><td>${esc(f.item.rel)}</td><td>${fl & bad ? '⚑' : ''}</td></tr>`;
    }).join('');
    const list = $('#blinkList');
    list.innerHTML = `<table><thead><tr><th></th><th>UTC</th><th>Det</th><th>λ µm</th><th>Rel</th><th>Flag</th></tr></thead><tbody>${body}</tbody></table>`;
    list.querySelectorAll('tr[data-uri]').forEach(tr => {
      tr.querySelector('input').onchange = e => { const u = tr.dataset.uri; e.target.checked ? this.excluded.delete(u) : this.excluded.add(u); tr.classList.toggle('excluded', !e.target.checked); this.rebuild(true); };
      tr.onclick = e => {
        if (e.target.tagName === 'INPUT') return;
        const i = this.products.findIndex(p => p.members.some(f => f.item.uri === tr.dataset.uri));
        if (i >= 0) { this.cur = i; this.render(); }
      };
    });
    this.highlightList();
  }
  highlightList() {
    const P = this.products[this.cur];
    const set = new Set(P ? P.members.map(f => f.item.uri) : []);
    $$('#blinkList tr[data-uri]').forEach(tr => tr.classList.toggle('cur', set.has(tr.dataset.uri)));
  }

  async loadCatalog(cat) {
    if (!this.center) return;
    if (this.cats[cat]) return this.render();
    const rad = this.size * 0.75 + (this.target && Math.hypot(this.target.pmra, this.target.pmdec) > 1000 ? 0.03 : 0);
    try {
      toast(`Loading ${cat.toUpperCase()} sources…`, false, 1500);
      const r = await api(`/api/sx/catalog?cat=${cat}&ra=${this.center.ra.toFixed(6)}&dec=${this.center.dec.toFixed(6)}&radius=${rad.toFixed(4)}`);
      this.cats[cat] = r.rows;
      this.render();
    } catch (e) { toast(`${cat} query failed: ${e.message}`, true); }
  }

  screenToGrid(e) {
    const s = this.grid.n / this.side;
    return [e.offsetX * s - 0.5, e.offsetY * s - 0.5];
  }
  hover(e) {
    const P = this.products[this.cur];
    if (!P || !this.grid) return;
    const [i, j] = this.screenToGrid(e);
    const [ra, dec] = IM.gridToWorld(this.grid, i, j);
    const n = this.grid.n, k = Math.round(j) * n + Math.round(i);
    const v = P.imgs.map(im => im[k]);
    let extra = '';
    if (P.members.length === 1) {
      const f = P.members[0], [x, y] = f.world2pix(ra, dec);
      const fl = f.flagList(f.flagsAt(x, y, 0)).filter(n => n !== 'FULLSAMPLE');
      extra = `\nλ ${f.sampleMap(f.wave, x, y).toFixed(4)} µm  pix (${x.toFixed(1)}, ${y.toFixed(1)})\nflags: ${fl.join(', ') || 'none'}`;
    }
    const near = this.nearestCat(ra, dec, P);
    $('#blinkCursor').textContent = `${fmtRA(ra, 2)} ${fmtDec(dec, 1)}\nRA ${ra.toFixed(5)}°  Dec ${dec.toFixed(5)}°\nvalue ${v.map(x => isFinite(x) ? x.toFixed(4) : '—').join(' / ')} MJy/sr${extra}${near ? '\n' + near : ''}`;
    $('#blinkCursor').style.whiteSpace = 'pre-wrap';
  }
  nearestCat(ra, dec, P) {
    let best = null, bd = 6 / 3600;
    for (const [cat, rows] of Object.entries(this.cats)) for (const r of rows || []) {
      const p = propagate(r, mjdToYear(P.mjd));
      const d = Math.hypot((p.ra - ra) * Math.cos(dec * Math.PI / 180), p.dec - dec);
      if (d < bd) { bd = d; best = `${r.id}  ${r.band}=${(r.mag || NaN).toFixed(2)}`; }
    }
    return best;
  }
  onClick(e) {
    if (!this.grid) return;
    const [i, j] = this.screenToGrid(e);
    const [ra, dec] = IM.gridToWorld(this.grid, i, j);
    this.click = { ra, dec };
    $('#blinkSpecHere').disabled = false;
    this.drawOverlay();
  }

  // ---- playback ----
  togglePlay() { this.playing ? this.stop() : this.play(); }
  play() {
    if (this.products.length < 2) return;
    this.playing = true; $('#bpPlay').textContent = '❚❚';
    let last = performance.now();
    const loop = now => {
      if (!this.playing) return;
      const fps = +$('#bpFps').value;
      if (now - last >= 1000 / fps) { last = now; this.advance(); }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { this.playing = false; $('#bpPlay').textContent = '▶'; cancelAnimationFrame(this.raf); }
  advance() {
    const n = this.products.length;
    if (n < 2) return;
    if ($('#bpBounce').checked) { if (this.cur + this.dir >= n || this.cur + this.dir < 0) this.dir *= -1; this.cur += this.dir; }
    else this.cur = (this.cur + 1) % n;
    this.render();
  }
  step(d) { this.stop(); const n = this.products.length; if (!n) return; this.cur = (this.cur + d + n) % n; this.render(); }

  composite() {
    const W = this.ov.width, c = document.createElement('canvas');
    c.width = W; c.height = W;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = +$('#blinkUpsample').value > 1;
    x.drawImage(this.cv, 0, 0, W, W);
    x.drawImage(this.ov, 0, 0);
    x.font = `${13 * this.dpr}px Consolas, monospace`; x.fillStyle = '#fff'; x.shadowColor = '#000'; x.shadowBlur = 4;
    $('#blinkStamp').textContent.split('\n').forEach((l, i) => x.fillText(l, 10 * this.dpr, (20 + i * 16) * this.dpr));
    x.fillText('SPHEREx · NASA/JPL-Caltech/IPAC', 10 * this.dpr, W - 36 * this.dpr);
    return c;
  }
  savePng() {
    if (!this.products.length) return toast('Nothing to save yet', true);
    this.composite().toBlob(b => download(`spherex_${(this.target?.name || 'field').replace(/\W+/g, '_')}_${this.cur + 1}.png`, b));
  }
  async recordVideo() {
    if (this.products.length < 2) return toast('Load at least two frames first', true);
    if (!window.MediaRecorder) return toast('Video recording is not supported in this browser', true);
    this.stop();
    const first = this.composite();
    const rc = document.createElement('canvas'); rc.width = first.width; rc.height = first.height;
    const rx = rc.getContext('2d');
    const stream = rc.captureStream(30);
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6e6 });
    const chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    const fps = +$('#bpFps').value;
    toast('Recording one loop…', false, 2000);
    rec.start();
    const loops = this.products.length < 6 ? 3 : 1;
    for (let k = 0; k < this.products.length * loops; k++) {
      this.cur = k % this.products.length; this.render();
      rx.drawImage(this.composite(), 0, 0);
      await new Promise(r => setTimeout(r, 1000 / fps));
    }
    rec.stop();
    await new Promise(r => (rec.onstop = r));
    download(`spherex_${(this.target?.name || 'field').replace(/\W+/g, '_')}_timelapse.webm`, new Blob(chunks, { type: 'video/webm' }));
  }
  urlParams() {
    const t = this.target || {};
    return { view: 'blink', name: t.name, ra: t.ra?.toFixed(6), dec: t.dec?.toFixed(6), pmra: t.pmra || undefined, pmdec: t.pmdec || undefined,
      epoch: t.epoch && t.epoch !== 2000 ? t.epoch : undefined, plx: t.plx || undefined, fov: $('#blinkFov').value, mode: $('#blinkMode').value,
      band: $('#blinkBand').value, diff: $('#blinkDiff').value !== 'none' ? $('#blinkDiff').value : undefined, cmap: $('#blinkCmap').value !== 'gray' ? $('#blinkCmap').value : undefined };
  }
  share() {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...this.urlParams(), auto: 1 })) if (v !== undefined && v !== '') p.set(k, v);
    const url = `${location.origin}${location.pathname}?${p}`;
    const embed = `<iframe src="${url}&embed=1" width="720" height="640" style="border:0" title="SPHEREx time-lapse"></iframe>`;
    navigator.clipboard?.writeText(url + '\n\n' + embed).then(() => toast('Link + embed code copied to clipboard'), () => prompt('Copy this link:', url));
  }
  applyUrl(p) {
    const set = (id, k) => { if (p.has(k)) { const e = $('#' + id); if ([...(e.options || [])].length === 0 || [...e.options].some(o => o.value === p.get(k))) e.value = p.get(k); } };
    set('blinkFov', 'fov'); set('blinkMode', 'mode'); set('blinkBand', 'band'); set('blinkDiff', 'diff'); set('blinkCmap', 'cmap');
    if (p.get('embed') === '1') document.body.classList.add('embed');
  }
}
