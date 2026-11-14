import {
  decodeB64, percentiles, stretchValue, stretchSigned, lut, lutDiverging, pixToSky, formatRA, formatDec,
  flagNames, parseState, computeView, isDiffView, skyToPix, stackImage,
} from './sky.js';
import { t, setLang, getLang } from './i18n.js';
import { scatterChart, chartTable, SERIES, wlColor } from './charts.js';
import { encodeGif } from './gif.js';
import { CUBE_URL, nearestSlice } from './cube.js';
import { depthStart, depthLive, depthLoad, depthHide } from './depth.js';

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries([
  'search', 'q', 'fov', 'mode', 'go', 'sky', 'overlay', 'stage', 'empty', 'loading', 'loadingMsg', 'loadingSub',
  'play', 'prev', 'next', 'scrub', 'fps', 'fpsVal', 'timeline', 'frameInfo', 'cursor', 'stretch', 'cmap', 'lo', 'hi',
  'cross', 'flagView', 'link', 'copy', 'toast', 'hudDate', 'hudIdx', 'hudScale', 'view', 'viewHelp', 'detchips',
  'preset', 'loadingBar', 'wlMatch', 'zoom', 'gif', 'cands', 'candCount', 'showCands', 'flagSummary', 'expDetails', 'expSummary', 'expList', 'examples', 'compare', 'listen',
].map(id => [id, $(id)]));

const ALL_DETS = [1, 2, 3, 4, 5, 6];
const state = {
  data: null, target: null,
  images: [], variances: [], flags: [],   // as delivered (one per frame)
  shown: [],                              // what the current view displays
  idx: 0, playing: false, timer: null, levels: [0, 1], abort: null,
  dets: new Set(ALL_DETS), selected: null,
  compare: false, split: 0.5, splitDrag: false, splitMoved: false,
};

// ------------------------------------------------------------------ helpers
async function api(path, params, signal) {
  const url = new URL(path, location.href);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) url.searchParams.set(k, v);
  const r = await fetch(url, { signal });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || `${r.status} ${r.statusText}`);
  return body;
}

function setLoading(on, msg = '', sub = '') {
  els.loading.hidden = !on;
  els.go.disabled = on;
  els.loadingMsg.textContent = msg;
  els.loadingSub.textContent = sub;
}

function toast(msg, isErr = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('err', isErr);
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { els.toast.hidden = true; }, isErr ? 7000 : 2500);
}

function info(dl, rows) {
  dl.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    if (v instanceof Node) dd.append(v); else dd.textContent = v;
    return [dt, dd];
  }));
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const isStack = () => els.view.value === 'stack';

// ------------------------------------------------------------------ detectors
function buildDetChips() {
  const ranges = { 1: '0.75–1.09', 2: '1.10–1.62', 3: '1.63–2.42', 4: '2.42–3.82', 5: '3.83–4.41', 6: '4.42–5.00' };
  els.detchips.replaceChildren(...ALL_DETS.map(d => {
    const b = el('button', 'detchip', `D${d}`);
    b.type = 'button';
    b.dataset.det = d;
    b.title = `${ranges[d]} µm`;
    b.setAttribute('aria-pressed', 'true');
    b.onclick = () => {
      if (state.dets.has(d) && state.dets.size === 1) return;          // keep at least one
      state.dets.has(d) ? state.dets.delete(d) : state.dets.add(d);
      syncDetUi();
      requery();
    };
    return b;
  }));
}

function syncDetUi() {
  for (const b of els.detchips.children) b.setAttribute('aria-pressed', String(state.dets.has(Number(b.dataset.det))));
  const key = [...state.dets].sort().join(',');
  const match = [...els.preset.options].find(o => o.value === key);
  els.preset.value = match ? key : 'custom';
}

function setDets(list) {
  const ds = list.filter(d => ALL_DETS.includes(d));
  state.dets = new Set(ds.length ? ds : ALL_DETS);
  syncDetUi();
}

els.preset.onchange = () => {
  if (els.preset.value === 'custom') return;
  setDets(els.preset.value.split(',').map(Number));
  requery();
};

function requery() {
  if (state.target) run({ q: els.q.value.trim(), ...state.target, fov: els.fov.value, mode: els.mode.value });
}

// ------------------------------------------------------------------ load
async function run(opts) {
  document.dispatchEvent(new CustomEvent('radians:run'));       // ui.js: switch from the landing page to the viewer
  if (state.abort) state.abort.abort();
  const ctl = new AbortController();
  state.abort = ctl;
  stop();
  els.empty.hidden = true;
  const t0 = performance.now();
  let poll = null, showProgress = false;
  els.loadingBar.hidden = true;
  const tick = setInterval(() => {
    const s = Math.round((performance.now() - t0) / 1000);
    if (!showProgress) els.loadingSub.textContent = s < 8 ? '' : t('slow', { s });
  }, 1000);
  try {
    let target;
    if (opts.ra !== null && opts.ra !== undefined && opts.dec !== null && opts.dec !== undefined) {
      target = { name: opts.name ?? opts.q ?? null, ra: opts.ra, dec: opts.dec, pmra: opts.pmra, pmdec: opts.pmdec };
    } else {
      setLoading(true, t('finding', { q: opts.q }));
      target = await api('api/resolve', { q: opts.q }, ctl.signal);
    }
    state.target = target;
    setLoading(true, t('reading'));
    depthStart();
    const job = Math.random().toString(36).slice(2, 12);
    poll = setInterval(async () => {
      try {
        const p = await api('api/progress', { job }, ctl.signal);
        if (p.stage === 'read' && p.total) {
          showProgress = true;
          els.loadingSub.textContent = t('readingN', { done: p.done, total: p.total, pct: Math.round(100 * p.done / p.total) });
          els.loadingBar.hidden = false;
          els.loadingBar.value = p.done / p.total;
        }
        if (p.preview) depthLive(p.preview); else if (p.stage === 'process') {
          els.loadingSub.textContent = t('processing');
          els.loadingBar.value = 1;
        }
      } catch { /* progress is cosmetic */ }
    }, 1000);
    const data = await api('api/frames', {
      ra: target.ra.toFixed(6), dec: target.dec.toFixed(6), fov: opts.fov, mode: opts.mode,
      pmra: target.pmra, pmdec: target.pmdec, detectors: [...state.dets].sort().join(','), job,
      matched: els.wlMatch.checked,
    }, ctl.signal);
    if (!data.frames || !data.frames.length) {
      state.data = null;
      els.empty.hidden = false;
      els.empty.innerHTML = `<p>${t('noData')}</p>`;
      renderCandidates();
      depthHide();
      return;
    }
    load(data, opts.frame ?? 0);
    document.dispatchEvent(new CustomEvent('radians:loaded', { detail: data }));
    depthLoad(gridParams(), api);
    syncUrl();
    if (opts.autoplay !== false) play();
  } catch (e) {
    if (e.name !== 'AbortError') {
      depthHide();
      toast(e.message, true);
      if (!state.data) els.empty.hidden = false;
    }
  } finally {
    clearInterval(tick);
    clearInterval(poll);
    if (state.abort === ctl) { setLoading(false); els.loadingBar.hidden = true; }
  }
}

function load(data, startIdx) {
  state.data = data;
  state.selected = null;
  const n = data.grid.n;
  state.images = data.frames.map(f => decodeB64(f.image, Float32Array));
  state.variances = data.frames.map(f => decodeB64(f.variance, Float32Array));
  state.flags = data.frames.map(f => decodeB64(f.flags, Uint32Array));
  els.sky.width = els.sky.height = n;
  els.overlay.width = els.overlay.height = Math.max(400, n * 8);      // sharper markers
  els.hudScale.textContent = `${(data.grid.fov / 60).toFixed(1)}′ × ${(data.grid.fov / 60).toFixed(1)}′`;
  applyView(startIdx);
  renderCandidates();
  onLoaded();
}

// ------------------------------------------------------------------ views
function applyView(startIdx = state.idx) {
  if (!state.data) return;
  state.shown = computeView(state.images, state.variances, els.view.value);
  els.scrub.max = state.shown.length - 1;
  els.viewHelp.textContent = isDiffView(els.view.value) ? t('viewHelpDiff') : isStack() ? t('viewHelpStack') : '';
  computeLevels();
  buildTimeline();
  show(isStack() ? 0 : startIdx);
}

function computeLevels() {
  if (!state.shown.length) return;
  if (isDiffView(els.view.value)) {
    // symmetric limit from the absolute differences; "white point" slider still applies
    const abs = state.shown.map(a => a.map(Math.abs));
    state.levels = [0, percentiles(abs, [Number(els.hi.value)])[0] || 1];
  } else {
    // one set of levels for every frame, so brightness changes are real, not display artefacts
    state.levels = percentiles(state.shown, [Number(els.lo.value), Number(els.hi.value)]);
  }
}

function frameFlags(i) {
  if (!isStack()) return state.flags[i];
  const out = new Uint32Array(state.flags[0].length);
  for (const f of state.flags) for (let k = 0; k < out.length; k++) out[k] |= f[k];
  return out;
}

function render() {
  const { data } = state;
  if (!data) return;
  const n = data.grid.n;
  const cmp = compareOn();
  const img = state.shown[cmp ? compareB() : state.idx];
  const imgA = cmp ? state.shown[0] : img;
  const sx = cmp ? Math.round(state.split * n) : -1;            // columns left of this show the first visit
  const flg = frameFlags(state.idx);
  const ctx = els.sky.getContext('2d');
  const out = ctx.createImageData(n, n);
  const diffView = isDiffView(els.view.value);
  const table = diffView ? lutDiverging() : lut(els.cmap.value);
  const [lo, hi] = state.levels;
  const kind = els.stretch.value;
  const showFlags = els.flagView.checked;
  for (let y = 0; y < n; y++) {
    const row = n - 1 - y;                                   // FITS y is up, canvas y is down
    for (let x = 0; x < n; x++) {
      const i = y * n + x, o = (row * n + x) * 4;
      const v = x < sx ? imgA[i] : img[i];
      const tv = diffView ? stretchSigned(v, hi, kind) : stretchValue(v, lo, hi, kind);
      if (Number.isNaN(tv)) { out.data[o] = 30; out.data[o + 1] = 12; out.data[o + 2] = 40; out.data[o + 3] = 255; continue; }
      const k = (diffView ? Math.round(128 + tv * 127) : Math.round(tv * 255)) * 3;
      out.data[o] = table[k]; out.data[o + 1] = table[k + 1]; out.data[o + 2] = table[k + 2]; out.data[o + 3] = 255;
      if (showFlags && (flg[i] & data.bad_mask)) { out.data[o] = 255; out.data[o + 1] *= 0.4; out.data[o + 2] *= 0.4; }
    }
  }
  ctx.putImageData(out, 0, 0);
  drawOverlay();
}

// ------------------------------------------------------------------ before / after
const compareOn = () => state.compare && !isStack() && state.shown.length > 1;
const compareB = () => (state.idx === 0 ? state.shown.length - 1 : state.idx);
const frameLabel = (i) => { const f = state.data.frames[i]; return `E${f.epoch} · ${f.date_start.slice(0, 7)}`; };

function drawSplit(ctx) {
  const W = els.overlay.width, x = state.split * W, fs = Math.max(13, W / 38);
  ctx.save();
  ctx.strokeStyle = '#ffb347'; ctx.lineWidth = Math.max(2, W / 400);
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, W); ctx.stroke();
  ctx.fillStyle = '#ffb347';
  ctx.beginPath(); ctx.arc(x, W * 0.22, fs * 0.9, 0, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = '#000'; ctx.font = `600 ${fs}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('‹ ›', x, W * 0.22 + 1);
  ctx.font = `500 ${fs * 0.85}px ui-monospace, monospace`; ctx.textBaseline = 'top';
  for (const [lab, right] of [[frameLabel(0), false], [frameLabel(compareB()), true]]) {
    const tw = ctx.measureText(lab).width + fs, bx = right ? x + fs * 0.6 : x - fs * 0.6 - tw, by = W - fs * 2.6;
    ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.fillRect(bx, by, tw, fs * 1.5);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(lab, bx + tw / 2, by + fs * 0.3);
  }
  ctx.restore();
}

function setCompare(on) {
  state.compare = on;
  els.compare.setAttribute('aria-pressed', String(on));
  els.stage.classList.toggle('comparing', on);
  if (!state.data) return;
  if (on) {
    stop();
    if (isStack()) { els.view.value = 'images'; els.view.dispatchEvent(new Event('change')); }
    show(state.shown.length - 1);
    toast(t('compareHint'));
  } else show(state.idx);
}
els.compare.onclick = () => setCompare(!state.compare);

function setSplit(e) {
  const r = els.overlay.getBoundingClientRect();
  state.split = Math.min(0.98, Math.max(0.02, (e.clientX - r.left) / r.width));
  render();
}
els.overlay.addEventListener('pointerdown', (e) => {
  if (!compareOn() || zoomState.z !== 1) return;
  state.splitDrag = true; state.splitMoved = false;
  els.overlay.setPointerCapture(e.pointerId);
  setSplit(e);
});
els.overlay.addEventListener('pointermove', (e) => { if (state.splitDrag) { state.splitMoved = true; setSplit(e); } });
els.overlay.addEventListener('pointerup', () => { state.splitDrag = false; });

// ------------------------------------------------------------------ overlay
const COLORS = { moving: '#6fc3ff', variable: '#ffb347', transient: '#ff6fb5' };

function toCanvas(x, y) {
  const W = els.overlay.width, n = state.data.grid.n, k = W / n;
  return [(x + 0.5) * k, (n - 1 - y + 0.5) * k, k];
}

function frameMjd() {
  if (isStack()) return null;
  return state.data.frames[state.idx].mjd;
}

function drawOverlay() {
  const ctx = els.overlay.getContext('2d');
  const W = els.overlay.width;
  ctx.clearRect(0, 0, W, W);
  if (!state.data) return;
  if (els.cross.checked && state.target) drawTargetMarker(ctx);
  drawExtras(ctx);
  if (els.showCands.checked) for (const [i, c] of (state.data.candidates || []).entries()) drawCandidate(ctx, c, i === state.selected);
  if (compareOn()) drawSplit(ctx);
}

function drawTargetMarker(ctx) {
  const n = state.data.grid.n;
  let x = (n - 1) / 2, y = (n - 1) / 2;
  if (!isStack()) {
    // where the target should be during this frame (proper motion included by the API)
    const f = state.data.frames[state.idx];
    const pts = state.data.exposures.filter(e => e.mjd >= f.mjd_start - 1e-6 && e.mjd <= f.mjd_end + 1e-6);
    if (pts.length) {
      x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    }
  }
  const [cx, cy, k] = toCanvas(x, y);
  const r = Math.max(14, 3 * k);
  ctx.strokeStyle = 'rgba(111,195,255,.9)';
  ctx.lineWidth = 2;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * r, cy + dy * r);
    ctx.lineTo(cx + dx * r * 2, cy + dy * r * 2);
    ctx.stroke();
  }
}

function drawCandidate(ctx, c, selected) {
  const col = COLORS[c.type] || '#fff';
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = selected ? 3 : 1.5;
  const [cx, cy, k] = toCanvas(c.x, c.y);
  const r = Math.max(10, 2.2 * k);
  ctx.setLineDash([]);
  if (c.type === 'moving' && c.points.length > 1) {
    // the track through each epoch, with the current epoch highlighted
    const pts = c.points.map(p => toCanvas(p.x, p.y));
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.stroke();
    const mjd = frameMjd();
    let cur = -1;
    if (mjd !== null) cur = c.points.reduce((b, p, i) => (Math.abs(p.mjd - mjd) < Math.abs(c.points[b].mjd - mjd) ? i : b), 0);
    pts.forEach(([px, py], i) => {
      ctx.beginPath();
      ctx.arc(px, py, i === cur ? 5 : 2.5, 0, 2 * Math.PI);
      ctx.fill();
    });
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.3, 0, 2 * Math.PI);
    ctx.stroke();
  } else if (c.type === 'variable') {
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.3, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 1.4); ctx.lineTo(cx + r * 1.4, cy); ctx.lineTo(cx, cy + r * 1.4); ctx.lineTo(cx - r * 1.4, cy);
    ctx.closePath();
    ctx.stroke();
  }
  if (selected) {
    ctx.font = `${Math.max(12, k * 1.6)}px system-ui`;
    ctx.fillText(t(c.type), cx + r * 1.6, cy - r * 1.2);
  }
}

// ------------------------------------------------------------------ candidates panel
function candText(c) {
  if (c.type === 'moving') return t('movingDesc', { rate: c.rate_arcsec_yr, pa: c.pa_deg, sig: c.significance, n: c.points.length });
  if (c.type === 'variable') return t('variableDesc', { ratio: c.ratio, dets: c.detectors.map(d => 'D' + d.detector).join(', '), sig: c.significance });
  return t('transientDesc', { epoch: c.epoch, sig: c.significance });
}

function renderCandidates() {
  const cands = state.data?.candidates || [];
  els.candCount.textContent = state.data ? `(${cands.length})` : '';
  if (!state.data) { els.cands.replaceChildren(); return; }
  if (!cands.length) { els.cands.replaceChildren(el('li', 'muted small', t('noCands'))); return; }
  els.cands.replaceChildren(...cands.map((c, i) => {
    const li = el('li', 'cand' + (i === state.selected ? ' on' : ''));
    const head = el('button', 'candhead');
    head.type = 'button';
    const dot = el('span', 'dot');
    dot.style.background = COLORS[c.type];
    head.append(dot, el('b', '', t(c.type)), el('span', 'small', ' ' + candText(c)));
    head.onclick = () => { state.selected = state.selected === i ? null : i; renderCandidates(); drawOverlay(); };
    li.append(head);
    const known = catalogMatch(c);
    const tags = el('div', 'tags');
    if (c.is_target) tags.append(el('span', 'tag', t('isTarget')));
    if (known === 'unchecked') { /* Gaia not loaded (yet): say nothing */ }
    else if (known) tags.append(el('span', 'tag', t('knownGaia', { g: known.g?.toFixed(1) ?? '?', pm: (Math.hypot(known.pmra || 0, known.pmdec || 0) / 1000).toFixed(2) })));
    else if (!c.is_target) tags.append(el('span', 'tag new', t('notInGaia')));   // your own target: say nothing
    if (c.low_confidence) tags.append(el('span', 'tag warn', t('lowConf')));
    if (tags.childElementCount) li.append(tags);
    try { li.append(candVisual(c, known)); } catch (err) { console.warn('candidate visual', err); }
    if (i === state.selected) {
      const d = el('div', 'canddetail small');
      d.append(el('div', '', `${formatRA(c.ra)} ${formatDec(c.dec)}`));
      const a = el('a', '', t('simbad'));
      a.href = `https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${c.ra.toFixed(5)}+${c.dec >= 0 ? '%2B' : ''}${c.dec.toFixed(5)}&Radius=15&Radius.unit=arcsec`;
      a.target = '_blank';
      a.rel = 'noopener';
      const rep = el('button', 'linkbtn', t('copyReport'));
      rep.type = 'button';
      rep.onclick = async () => {
        try { await navigator.clipboard.writeText(candReport(c, known)); toast(t('copied')); }
        catch { toast(t('copyFail'), true); }
      };
      const png = el('button', 'linkbtn', t('saveFinding'));
      png.type = 'button';
      png.onclick = () => saveFinding(c, known);
      const acts = el('div', 'candacts');
      acts.append(a, rep, png);
      d.append(acts);
      li.append(d);
    }
    return li;
  }));
}

els.showCands.onchange = drawOverlay;

// ------------------------------------------------------------------ candidate card visuals
// Position of a candidate in frame i (movers follow their fitted track; the rest stay put).
function candPos(c, i) {
  const f = state.data.frames[i];
  if (c.type !== 'moving' || !c.points?.length) return [c.x, c.y];
  let best = c.points[0];
  for (const p of c.points) if (Math.abs(p.mjd - f.mjd) < Math.abs(best.mjd - f.mjd)) best = p;
  return [best.x, best.y];
}

// 3x3-pixel sum around (x, y) in frame i: a quick brightness for the sparkline
function quickFlux(i, x, y) {
  const n = state.data.grid.n, img = state.images[i];
  const ix = Math.round(x), iy = Math.round(y);
  let s = 0, k = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = ix + dx, yy = iy + dy;
    if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
    const v = img[yy * n + xx];
    if (Number.isFinite(v)) { s += v; k++; }
  }
  return k ? s * 9 / k : NaN;
}

// small greyscale cut-out (2*R+1 px) of frame i centred on (x, y)
const CUT_R = 6;
function cutout(i, x, y, lo, hi) {
  const n = state.data.grid.n, img = state.images[i], S = 2 * CUT_R + 1;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d'), out = ctx.createImageData(S, S);
  const cx = Math.round(x), cy = Math.round(y);
  for (let r = 0; r < S; r++) for (let q = 0; q < S; q++) {
    const xx = cx - CUT_R + q, yy = cy + CUT_R - r;              // canvas row 0 = top = highest FITS y
    const v = xx >= 0 && yy >= 0 && xx < n && yy < n ? img[yy * n + xx] : NaN;
    const tv = stretchValue(v, lo, hi, 'asinh');
    const g = Number.isNaN(tv) ? 25 : Math.round(tv * 255), o = (r * S + q) * 4;
    out.data[o] = out.data[o + 1] = out.data[o + 2] = g; out.data[o + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  cv.className = 'cut';
  return cv;
}

function sparkline(vals, hi) {
  const W = 120, H = 34, ok = vals.map((v, i) => [i, v]).filter(([, v]) => Number.isFinite(v));
  const NS = 'http://www.w3.org/2000/svg', svgEl = document.createElementNS(NS, 'svg');
  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`); svgEl.setAttribute('class', 'spark');
  if (ok.length < 2) return svgEl;
  const lo = Math.min(...ok.map(o => o[1])), top = Math.max(...ok.map(o => o[1]));
  const X = i => 6 + i / Math.max(1, vals.length - 1) * (W - 12), Y = v => H - 5 - (v - lo) / ((top - lo) || 1) * (H - 10);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ok.map(([i, v], j) => `${j ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(''));
  svgEl.append(path);
  for (const [i, v] of ok) {
    const d = document.createElementNS(NS, 'circle');
    d.setAttribute('cx', X(i)); d.setAttribute('cy', Y(v)); d.setAttribute('r', i === hi ? 3.2 : 2.2);
    if (i === hi) d.setAttribute('class', 'hi');
    svgEl.append(d);
  }
  return svgEl;
}

// the track of a mover, scaled up, with the catalogue direction for comparison
function trackPlot(c, catPa) {
  const NS = 'http://www.w3.org/2000/svg', W = 70, svgEl = document.createElementNS(NS, 'svg');
  svgEl.setAttribute('viewBox', `0 0 ${W} ${W}`); svgEl.setAttribute('class', 'track');
  const pts = c.points;
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length, my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  const span = Math.max(0.6, ...pts.map(p => Math.hypot(p.x - mx, p.y - my))) * 2.4;
  const P = p => [W / 2 + (p.x - mx) / span * W * 0.8, W / 2 - (p.y - my) / span * W * 0.8];   // as on the image: +x right (west), +y up (north)
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svgEl.append(e); return e; };
  if (catPa !== null && catPa !== undefined) {           // PA is east of north: east = -x on our grid
    const a = catPa * Math.PI / 180, L = W * 0.38;
    mk('line', { x1: W / 2 + Math.sin(a) * L, y1: W / 2 + Math.cos(a) * L, x2: W / 2 - Math.sin(a) * L, y2: W / 2 - Math.cos(a) * L, class: 'cat' });
  }
  const q = pts.map(P);
  mk('path', { d: q.map(([x, y], j) => `${j ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(''), class: 'trk' });
  q.forEach(([x, y], j) => mk('circle', { cx: x, cy: y, r: j === q.length - 1 ? 3.4 : 2.4, class: j === q.length - 1 ? 'last' : '' }));
  return svgEl;
}

// the two frames a card compares, the candidate's position and quick flux in every frame, and a shared stretch
function candFrames(c) {
  const F = state.data.frames.length;
  const pos = state.data.frames.map((_, i) => candPos(c, i));
  const flux = pos.map(([x, y], i) => quickFlux(i, x, y));
  // which two frames to compare
  let a = 0, b = F - 1;
  if (c.type === 'variable') {
    const ok = flux.map((v, i) => [i, v]).filter(([, v]) => Number.isFinite(v));
    if (ok.length >= 2) { a = ok.reduce((m, o) => (o[1] < m[1] ? o : m))[0]; b = ok.reduce((m, o) => (o[1] > m[1] ? o : m))[0]; }
  } else if (c.type === 'transient') {
    b = Math.max(0, state.data.frames.findIndex(f => f.epoch === c.epoch));
    a = b === 0 ? Math.min(1, F - 1) : 0;
  }
  // shared stretch for both cut-outs, so a brightness change is real
  const vals = [];
  for (const i of [a, b]) {
    const [x, y] = pos[i], n = state.data.grid.n, img = state.images[i];
    for (let dy = -CUT_R; dy <= CUT_R; dy++) for (let dx = -CUT_R; dx <= CUT_R; dx++) {
      const xx = Math.round(x) + dx, yy = Math.round(y) + dy;
      if (xx >= 0 && yy >= 0 && xx < n && yy < n && Number.isFinite(img[yy * n + xx])) vals.push(img[yy * n + xx]);
    }
  }
  vals.sort((p, q) => p - q);
  const lo = vals[Math.floor(vals.length * 0.05)] ?? 0, hi = vals[Math.floor(vals.length * 0.995)] ?? 1;
  return { pos, flux, a, b, lo, hi };
}

function candVisual(c, known) {
  const box = el('div', 'cvis');
  const F = state.data.frames.length;
  if (!F || F > 60 || !state.images.length) return box;
  const { pos, flux, a, b, lo, hi } = candFrames(c);
  const cuts = el('div', 'cuts');
  for (const [i, lab] of [[a, 'cutA'], [b, 'cutB']]) {
    const fig = el('figure', '');
    fig.append(cutout(i, ...pos[i], lo, hi), el('figcaption', 'mono', `E${state.data.frames[i].epoch} · ${state.data.frames[i].date_start.slice(0, 7)}`));
    fig.title = t(lab);
    cuts.append(fig);
  }
  box.append(cuts);
  let right = el('div', 'cright');
  if (c.type === 'moving') {
    const tg = state.target;
    const catPm = c.is_target && tg && Number.isFinite(tg.pmra) ? Math.hypot(tg.pmra, tg.pmdec) / 1000
      : known && known !== 'unchecked' ? Math.hypot(known.pmra || 0, known.pmdec || 0) / 1000 : null;
    const catPa = c.is_target && tg && Number.isFinite(tg.pmra) ? (Math.atan2(tg.pmra, tg.pmdec) * 180 / Math.PI + 360) % 360
      : known && known !== 'unchecked' ? (Math.atan2(known.pmra || 0, known.pmdec || 0) * 180 / Math.PI + 360) % 360 : null;
    right.append(trackPlot(c, catPa));
    if (catPm) {
      const cmp = el('div', 'cmp mono');
      cmp.append(el('span', 'k', t('cmpRadians')), el('span', '', `${c.rate_arcsec_yr.toFixed(2)}″/yr`),
        el('span', 'k', c.is_target ? t('cmpCatalogue') : 'Gaia DR3'), el('span', '', `${catPm.toFixed(2)}″/yr`));
      box.append(right); right = null;
      box.append(cmp);
    }
  } else {
    right.append(sparkline(flux, b));
  }
  if (right) box.append(right);
  // confidence: significance on a 0-30σ scale; doubtful pixels shown in amber
  const conf = el('div', 'conf' + (c.low_confidence ? ' low' : ''));
  const bar = el('div', 'bar'), fill = el('i', '');
  fill.style.width = `${Math.min(100, (c.significance || 0) / 30 * 100)}%`;
  bar.append(fill);
  conf.append(el('span', 'small dim', t('confidence')), bar, el('span', 'small mono', `${(c.significance || 0).toFixed(1)}σ`));
  box.append(conf);
  return box;
}

// Is this candidate a star Gaia DR3 already lists? (Gaia moved to the candidate's date; a mover must
// also move like the Gaia star.) Returns the Gaia source, null (not in Gaia) or 'unchecked'.
function catalogMatch(c) {
  if (typeof ex === 'undefined' || !ex.gaia || !ex.gaia.length || !state.data) return 'unchecked';
  const mjd = c.mjd ?? (c.points?.length ? c.points[0].mjd : currentMjd());
  const cosd = Math.cos(c.dec * Math.PI / 180);
  let best = null, bd = 1e9;
  for (const s of ex.gaia) {
    const [ra, dec] = gaiaAt(s, mjd);
    const d = Math.hypot((ra - c.ra) * cosd, dec - c.dec) * 3600;
    if (d < bd) { bd = d; best = s; }
  }
  if (!best || bd > 7) return null;                        // ~1 SPHEREx pixel
  if (c.type === 'moving') {
    const pm = Math.hypot(best.pmra || 0, best.pmdec || 0) / 1000;
    if (Math.abs(pm - c.rate_arcsec_yr) > Math.max(1.5, 0.3 * pm)) return null;
  }
  return best;
}

function candReport(c, known) {
  const g = state.data.grid, fs = state.data.frames;
  const lines = [
    'Radians candidate report (NASA SPHEREx)',
    `Type: ${t(c.type)}: ${candText(c)}`,
    `Position (ICRS): ${formatRA(c.ra)} ${formatDec(c.dec)} = ${c.ra.toFixed(5)} ${c.dec.toFixed(5)} deg`,
    `Visits: ${fs.length}, ${fs[0].date_start.slice(0, 10)} to ${fs[fs.length - 1].date_end.slice(0, 10)}; detectors ${[...state.dets].sort().map(d => 'D' + d).join(' ')}`,
    `Field: ${formatRA(g.ra)} ${formatDec(g.dec)}, ${(g.fov / 60).toFixed(1)}' wide`,
    `Gaia DR3: ${known === 'unchecked' ? 'not checked' : known ? `source ${known.id}, G ${known.g?.toFixed(2)}, pm ${(Math.hypot(known.pmra || 0, known.pmdec || 0) / 1000).toFixed(3)}"/yr` : 'no match within 7" (G < 19)'}`,
    `View: ${location.href}`,
    `SIMBAD: https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${c.ra.toFixed(5)}+${c.dec >= 0 ? '%2B' : ''}${c.dec.toFixed(5)}&Radius=15&Radius.unit=arcsec`,
  ];
  return lines.join('\n');
}

// ------------------------------------------------------------------ frame info
function show(i) {
  const { data } = state;
  if (!data) return;
  const N = state.shown.length;
  state.idx = ((i % N) + N) % N;
  els.scrub.value = state.idx;
  render();
  const tgt = state.target;
  let rows;
  if (isStack()) {
    const fs = data.frames;
    els.hudDate.textContent = `${fs[0].date_start.slice(0, 10)} → ${fs[fs.length - 1].date_end.slice(0, 10)}`;
    els.hudIdx.textContent = t('stackLabel', { n: fs.length });
    rows = [
      [t('kTarget'), tgt.name ? tgt.name.replace(/^NAME /, '') : t('coordinates')],
      [t('kExposures'), String(fs.reduce((s, f) => s + f.n_exposures, 0))],
    ];
    renderExposures(fs.flatMap(f => f.exposures || []));
  } else {
    const f = data.frames[state.idx];
    const sameDay = f.date_start.slice(0, 10) === f.date_end.slice(0, 10);
    els.hudDate.textContent = sameDay ? f.date_start.slice(0, 10) : `${f.date_start.slice(0, 10)} → ${f.date_end.slice(0, 10)}`;
    els.hudIdx.textContent = `${state.idx + 1} / ${N}`;
    if (compareOn()) els.hudDate.textContent = `${frameLabel(0)}  ⟷  ${frameLabel(compareB())}`;
    const wl = f.wavelength_min ? (f.wavelength_min === f.wavelength_max ? `${f.wavelength_min.toFixed(3)} µm`
      : `${f.wavelength_min.toFixed(2)}–${f.wavelength_max.toFixed(2)} µm`) : '—';
    rows = [
      [t('kTarget'), tgt.name ? tgt.name.replace(/^NAME /, '') : t('coordinates')],
      [t('kCentre'), `${formatRA(data.grid.ra)} ${formatDec(data.grid.dec)}`],
      [t('kEpoch'), `${f.epoch}`],
      [t('kDates'), `${f.date_start} → ${f.date_end} UTC`],
      [t('kExposures'), `${f.n_exposures}`],
      [t('kDetectors'), f.detectors.map(d => 'D' + d).join(' ')],
      [t('kWavelength'), wl],
    ];
    renderExposures(f.exposures || []);
  }
  if (tgt.pmra) rows.push([t('kPm'), t('pmFollow', { v: (Math.hypot(tgt.pmra, tgt.pmdec) / 1000).toFixed(2) })]);
  info(els.frameInfo, rows);
  renderFlagSummary();
  for (const [j, li] of [...els.timeline.children].entries()) li.firstChild.classList.toggle('on', j === state.idx);
  syncCube();
  syncUrl(true);
}

function renderExposures(list) {
  els.expSummary.textContent = t('exposureList', { n: list.length });
  els.expList.replaceChildren(...list.slice(0, 300).map(e =>
    el('li', '', `${e.date}  D${e.detector}  ${e.wavelength ? e.wavelength.toFixed(3) + ' µm' : ''}  ${e.obs_id}`)));
}

function renderFlagSummary() {
  const flg = frameFlags(state.idx);
  const bits = state.data.flag_bits;
  const counts = {};
  for (let i = 0; i < flg.length; i++) {
    let v = flg[i];
    for (let b = 0; v; b++, v >>>= 1) if (v & 1) counts[b] = (counts[b] || 0) + 1;
  }
  const items = Object.entries(counts).filter(([b]) => bits[b])
    .map(([b, c]) => ({ name: bits[b], pct: (100 * c) / flg.length, bad: ((state.data.bad_mask >>> b) & 1) === 1 }))
    .sort((a, b) => b.pct - a.pct);
  els.flagSummary.replaceChildren(el('div', 'lbl', t('flagSummary')), ...items.map(it => {
    const s = el('span', 'flagname' + (it.bad ? ' bad' : ''), `${it.name} ${it.pct < 1 ? it.pct.toFixed(1) : Math.round(it.pct)}%`);
    return s;
  }));
  if (!items.length) els.flagSummary.append(el('span', 'muted small', t('none')));
}

function buildTimeline() {
  const frames = isStack() ? [] : state.data.frames;
  els.timeline.replaceChildren(...frames.map((f, i) => {
    const li = el('li');
    const b = el('button', '', frames.length > 12 ? `${i + 1}`
      : `E${f.epoch} · ${f.date_start.slice(0, 7)}${f.detectors.length === 1 ? ' D' + f.detectors[0] : ''}`);
    b.type = 'button';
    b.title = `${f.date_start} → ${f.date_end}`;
    b.onclick = () => { stop(); show(i); };
    li.append(b);
    return li;
  }));
}

// ------------------------------------------------------------------ playback
function play() {
  if (!state.data || state.shown.length < 2) return;
  state.playing = true;
  els.play.textContent = '⏸';
  els.play.setAttribute('aria-label', 'Pause');
  clearInterval(state.timer);
  state.timer = setInterval(() => show(state.idx + 1), 1000 / Number(els.fps.value));
}

function stop() {
  state.playing = false;
  clearInterval(state.timer);
  els.play.textContent = '▶';
  els.play.setAttribute('aria-label', 'Play');
}

els.play.onclick = () => (state.playing ? stop() : play());
els.prev.onclick = () => { stop(); show(state.idx - 1); };
els.next.onclick = () => { stop(); show(state.idx + 1); };
els.scrub.oninput = () => { stop(); show(Number(els.scrub.value)); };
els.fps.oninput = () => { els.fpsVal.textContent = els.fps.value; if (state.playing) play(); syncUrl(true); };
for (const e of [els.stretch, els.cmap, els.cross, els.flagView]) e.onchange = () => { render(); syncUrl(true); };
for (const e of [els.lo, els.hi]) e.oninput = () => { computeLevels(); render(); };
els.view.onchange = () => { const was = state.playing; applyView(); if (was) play(); syncUrl(true); };

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
  if (e.key === ' ') { e.preventDefault(); state.playing ? stop() : play(); }
  else if (e.key === 'ArrowRight') { stop(); show(state.idx + 1); }
  else if (e.key === 'ArrowLeft') { stop(); show(state.idx - 1); }
});

// ------------------------------------------------------------------ cursor readout
els.overlay.addEventListener('mousemove', (e) => {
  const { data } = state;
  if (!data) return;
  const rect = els.overlay.getBoundingClientRect();
  const n = data.grid.n;
  const x = Math.floor((e.clientX - rect.left) / rect.width * n);
  const y = n - 1 - Math.floor((e.clientY - rect.top) / rect.height * n);
  if (x < 0 || y < 0 || x >= n || y >= n) return;
  const [ra, dec] = pixToSky(x, y, data.grid);
  const i = y * n + x;
  const v = state.shown[state.idx][i];
  const flags = flagNames(frameFlags(state.idx)[i], data.flag_bits, data.bad_mask);
  const fl = el('span');
  if (!flags.length) fl.textContent = t('none');
  for (const f of flags) fl.append(el('span', 'flagname' + (f.bad ? ' bad' : ''), f.name));
  info(els.cursor, [
    ['RA, Dec', `${formatRA(ra)} ${formatDec(dec)}`],
    [t('kDegrees'), `${ra.toFixed(5)}, ${dec.toFixed(5)}`],
    [t('kPixel'), `${x}, ${y}`],
    [t('kValue'), Number.isFinite(v) ? `${v.toFixed(4)} MJy/sr` : t('noDataPx')],
    [t('kFlags'), fl],
    ...extraCursorRows(x, y),
  ]);
});

// click a candidate on the image to select it
els.overlay.addEventListener('click', (e) => {
  if (!state.data) return;
  if (zoomState.dragged) { zoomState.dragged = false; return; }
  if (compareOn()) return;
  const cands = state.data.candidates || [];
  const rect = els.overlay.getBoundingClientRect();
  const n = state.data.grid.n;
  const x = (e.clientX - rect.left) / rect.width * n - 0.5;
  const y = n - 1 - ((e.clientY - rect.top) / rect.height * n - 0.5);
  let best = null, bd = 3;
  cands.forEach((c, i) => { const d = Math.hypot(c.x - x, c.y - y); if (d < bd) { best = i; bd = d; } });
  if (best !== null) { state.selected = best; renderCandidates(); drawOverlay(); }
  else photAt(x, y);
});

// ------------------------------------------------------------------ URL state
function syncUrl(replace = false) {
  if (!state.target || !state.data) return;
  const p = new URLSearchParams();
  const tg = state.target;
  if (els.q.value.trim()) p.set('q', els.q.value.trim());
  p.set('ra', tg.ra.toFixed(6));
  p.set('dec', tg.dec.toFixed(6));
  if (tg.pmra) { p.set('pmra', tg.pmra); p.set('pmdec', tg.pmdec); }
  p.set('fov', els.fov.value);
  p.set('mode', els.mode.value);
  if (state.dets.size < 6) p.set('det', [...state.dets].sort().join(','));
  if (els.view.value !== 'images') p.set('view', els.view.value);
  if (els.fps.value !== '2') p.set('fps', els.fps.value);
  if (els.stretch.value !== 'asinh') p.set('stretch', els.stretch.value);
  if (els.cmap.value !== 'gray') p.set('cmap', els.cmap.value);
  if (!els.wlMatch.checked) p.set('wl', '0');
  if (!state.playing && state.idx) p.set('frame', state.idx);
  if (getLang() !== 'en') p.set('lang', getLang());
  if (document.body.classList.contains('embed')) p.set('embed', '1');
  const url = `${location.pathname}?${p}`;
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  els.link.value = location.origin + url;
}

els.copy.onclick = async () => {
  try { await navigator.clipboard.writeText(els.link.value); toast(t('copied')); }
  catch { els.link.select(); toast(t('pressCopy')); }
};

function setSelect(sel, v) {
  if (v === null || v === undefined) return;
  const s = String(v);
  if (![...sel.options].some(o => o.value === s)) sel.add(new Option(s, s));
  sel.value = s;
}

// ------------------------------------------------------------------ language
function applyLang(l) {
  setLang(l);
  try { localStorage.setItem('radians-lang', getLang()); } catch { /* private mode */ }
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === getLang()));
  if (state.data) { applyView(state.idx); renderCandidates(); renderAnalysis(); renderNeossat(); syncUrl(true); }
  document.dispatchEvent(new CustomEvent('radians:lang'));
}
for (const b of document.querySelectorAll('[data-lang]')) b.onclick = () => applyLang(b.dataset.lang);

// ------------------------------------------------------------------ start
function fromUrl() {
  const s = parseState(location.search);
  document.body.classList.toggle('embed', s.embed);
  if (s.q) els.q.value = s.q;
  else if (s.ra !== null && s.dec !== null) els.q.value = `${s.ra} ${s.dec}`;
  if (s.fov) setSelect(els.fov, s.fov);
  if (s.mode) setSelect(els.mode, s.mode);
  if (s.view) setSelect(els.view, s.view);
  if (s.fps) { els.fps.value = s.fps; els.fpsVal.textContent = s.fps; }
  if (s.stretch) setSelect(els.stretch, s.stretch);
  if (s.cmap) setSelect(els.cmap, s.cmap);
  els.wlMatch.checked = s.wl;
  setDets(s.det ? s.det.split(',').map(Number) : ALL_DETS);
  const common = { fov: els.fov.value, mode: els.mode.value, frame: s.frame, autoplay: s.frame === null };
  if (s.ra !== null && s.dec !== null) run({ q: s.q, ra: s.ra, dec: s.dec, pmra: s.pmra, pmdec: s.pmdec, ...common });
  else if (s.q) run({ q: s.q, ...common });
}

els.search.onsubmit = (e) => {
  e.preventDefault();
  const q = els.q.value.trim();
  if (q) run({ q, fov: els.fov.value, mode: els.mode.value });
};
for (const e of [els.fov, els.mode]) e.onchange = requery;
els.examples.onclick = (e) => {
  const b = e.target.closest('button[data-q]');
  if (!b) return;
  els.q.value = b.dataset.q;
  setSelect(els.fov, b.dataset.fov || '240');
  setDets(b.dataset.det ? b.dataset.det.split(',').map(Number) : ALL_DETS);
  // data-wl="0": wavelength matching off. Across two detectors (WISE 0855: D5+D6) matching keeps
  // only 1–2 exposures per epoch, too few to see a faint target; each detector co-added on its own is enough.
  els.wlMatch.checked = b.dataset.wl !== '0';
  run({ q: b.dataset.q, fov: els.fov.value, mode: els.mode.value });
};
window.addEventListener('popstate', fromUrl);


// ================================================================== phase 4
// spectra and light curves, Gaia / SkyBoT overlays, NEOSSat archive, Aladin Lite context
const ex = { phot: null, click: null, tab: 'spectrum', gaia: [], sso: [], neo: null, deep: null, photAbort: null, aladin: null };
const e4 = Object.fromEntries(['analysis', 'photSource', 'photMode', 'photFlagged', 'chart', 'chartNote', 'ovGaia', 'ovSso',
  'ovStatus', 'neossat', 'ctx', 'ctxSurvey', 'ctxGaia', 'ctxCatwise', 'aladin'].map(id => [id, $(id)]));
const MJD_J2016 = 57388.5;
// absorption bands that shape cool stars, brown dwarfs and ices in SPHEREx's range
const SPECTRAL_BANDS = [{ x: 1.4, label: 'H₂O' }, { x: 1.9, label: 'H₂O' }, { x: 2.7, label: 'H₂O' },
  { x: 3.3, label: 'CH₄' }, { x: 4.27, label: 'CO₂' }, { x: 4.67, label: 'CO' }];
const DET_RANGE = { 1: '0.75–1.09', 2: '1.10–1.62', 3: '1.63–2.42', 4: '2.42–3.82', 5: '3.83–4.41', 6: '4.42–5.00' };
const mjdDate = (m) => new Date((m - 40587) * 86400000).toISOString().slice(0, 10);

function gridParams() {
  const tg = state.target;
  return { ra: tg.ra.toFixed(6), dec: tg.dec.toFixed(6), fov: els.fov.value, pmra: tg.pmra, pmdec: tg.pmdec,
    detectors: [...state.dets].sort().join(',') };
}

function onLoaded() {
  ex.deep = stackImage(state.images, state.variances);
  setPhot(state.data.exposures || [], null);
  loadCatalogues();
  loadNeossat();
  if (e4.ctx.open) updateAladin();
}

// ------------------------------------------------------------------ photometry
function setPhot(points, click) {
  ex.phot = points;
  ex.click = click;
  const sat = points.filter(p => p.saturated).length;
  e4.photMode.value = sat > points.length / 2 && points.some(p => Number.isFinite(p.wing_ujy)) ? 'wings' : 'aperture';
  renderAnalysis();
}

async function photAt(x, y) {
  // snap to the brightest pixel within 1.5 px of the click in the deep stack
  const n = state.data.grid.n;
  let bx = Math.round(x), by = Math.round(y), bv = -Infinity;
  for (let yy = Math.round(y) - 1; yy <= Math.round(y) + 1; yy++) {
    for (let xx = Math.round(x) - 1; xx <= Math.round(x) + 1; xx++) {
      if (xx < 0 || yy < 0 || xx >= n || yy >= n || Math.hypot(xx - x, yy - y) > 1.5) continue;
      const v = ex.deep ? ex.deep[yy * n + xx] : NaN;
      if (Number.isFinite(v) && v > bv) { bv = v; bx = xx; by = yy; }
    }
  }
  if (ex.photAbort) ex.photAbort.abort();
  const ctl = new AbortController();
  ex.photAbort = ctl;
  e4.analysis.hidden = false;
  e4.photSource.textContent = t('photLoading');
  try {
    const r = await api('api/photometry', { ...gridParams(), x: bx, y: by }, ctl.signal);
    setPhot(r.points, { x: r.x, y: r.y, ra: r.ra, dec: r.dec });
    drawOverlay();
  } catch (err) {
    if (err.name !== 'AbortError') { toast(err.message, true); renderAnalysis(); }
  }
}

function visitBands() {
  const eps = new Map();
  for (const f of state.data.frames) {
    const b = eps.get(f.epoch) || { x0: f.mjd_start, x1: f.mjd_end, label: `E${f.epoch}` };
    b.x0 = Math.min(b.x0, f.mjd_start); b.x1 = Math.max(b.x1, f.mjd_end);
    eps.set(f.epoch, b);
  }
  return [...eps.values()];
}

function epochIndex(points) {
  const ms = [...new Set(points.map(p => p.mjd))].sort((a, b) => a - b);
  const map = new Map();
  let k = 1;
  ms.forEach((m, i) => { if (i && m - ms[i - 1] > 20) k++; map.set(m, k); });
  return map;
}

const valueOf = (p) => (e4.photMode.value === 'wings' ? p.wing_ujy : p.flux_ujy);

function median(a) {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
}

function tipFor(p, ep) {
  const wings = e4.photMode.value === 'wings';
  const rows = [`${p.date} UTC · D${p.detector}`, `λ ${p.wavelength?.toFixed(3)} µm · ${t('epochN', { n: ep })}`,
    `${Math.round(valueOf(p)).toLocaleString()} µJy${p.err_ujy && !wings ? ' ± ' + Math.round(p.err_ujy).toLocaleString() : ''}`];
  if (p.flagged) {
    const bad = flagNames(p.flags || 0, state.data.flag_bits, state.data.bad_mask).filter(f => f.bad).map(f => f.name);
    rows.push(bad.join(' ') || 'flagged');
  }
  return rows;
}

function renderAnalysis() {
  if (!state.data || !ex.phot || !ex.phot.length) { e4.analysis.hidden = true; return; }
  e4.analysis.hidden = false;
  const tg = state.target;
  e4.photSource.textContent = ex.click
    ? t('photClicked', { pos: `${formatRA(ex.click.ra)} ${formatDec(ex.click.dec)}` })
    : `${t('photTarget', { name: tg.name ? tg.name.replace(/^NAME /, '') : t('coordinates') })} · ${t('clickHint')}`;
  for (const b of e4.analysis.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === ex.tab));
  const wings = e4.photMode.value === 'wings';
  const eps = epochIndex(ex.phot);
  const pts = ex.phot.filter(p => Number.isFinite(valueOf(p)) && (e4.photFlagged.checked || !p.flagged));
  const yFmt = v => Math.abs(v) >= 1e4 ? `${(v / 1000).toFixed(0)}k` : `${Math.round(v)}`;
  if (ex.tab === 'spectrum') {
    const byEp = new Map();
    for (const p of pts) { const k = eps.get(p.mjd); if (!byEp.has(k)) byEp.set(k, []); byEp.get(k).push(p); }
    scatterChart(e4.chart, {
      // one series, every point in the colour of its wavelength; the visit is in the tooltip
      series: [{ name: 'SPHEREx', color: '#888', points: [...byEp.keys()].sort((a, b) => a - b).flatMap(k => byEp.get(k).map(p => ({
        x: p.wavelength, y: valueOf(p), err: wings ? null : p.err_ujy, hollow: p.flagged, color: wlColor(p.wavelength),
        series: `${t('epochN', { n: k })} · ${mjdDate(p.mjd).slice(0, 7)}`, tip: tipFor(p, k) }))) }],
      marks: SPECTRAL_BANDS, strip: wlColor,
      xLabel: t('specX'), yLabel: wings ? t('wingY') : t('specY'), xFmt: v => v.toFixed(1), yFmt,
    });
    e4.chartNote.textContent = (wings ? t('chartNoteWings') + ' ' : '') + t('chartNoteSpec');
  } else if (ex.tab === 'lightcurve') {
    const byDet = new Map();
    for (const p of pts) { if (!byDet.has(p.detector)) byDet.set(p.detector, []); byDet.get(p.detector).push(p); }
    scatterChart(e4.chart, {
      series: [...byDet.keys()].sort().map(d => {
        const ps = byDet.get(d);
        const clean = ps.filter(p => !p.flagged).map(valueOf);
        const med = median(clean.length >= 3 ? clean : ps.map(valueOf));
        return {
          name: `D${d} · ${DET_RANGE[d]} µm`, color: SERIES[d - 1],
          points: ps.map(p => ({ x: p.mjd, y: valueOf(p) / med, err: wings || !p.err_ujy ? null : p.err_ujy / Math.abs(med),
            hollow: p.flagged, tip: tipFor(p, eps.get(p.mjd)) })),
        };
      }),
      bands: visitBands(),
      xLabel: t('lcX'), yLabel: t('lcY'), refLine: 1, xFmt: v => mjdDate(v).slice(0, 7), yFmt: v => v.toFixed(2),
    });
    e4.chartNote.textContent = (wings ? t('chartNoteWings') + ' ' : '') + t('chartNoteLc');
  } else {
    const num = v => (Number.isFinite(v) ? Math.round(v) : '');
    chartTable(e4.chart, [t('colDate'), t('colDet'), t('colWl'), t('colFlux'), t('colErr'), t('colWing'), t('colFlag')],
      ex.phot.map(p => [p.date, `D${p.detector}`, p.wavelength?.toFixed(3) ?? '', num(p.flux_ujy), num(p.err_ujy), num(p.wing_ujy),
        flagNames(p.flags || 0, state.data.flag_bits, state.data.bad_mask).map(f => f.name).join(' ')]));
    e4.chartNote.textContent = '';
  }
}

for (const b of e4.analysis.querySelectorAll('[data-tab]')) b.onclick = () => { ex.tab = b.dataset.tab; renderAnalysis(); };
e4.photMode.onchange = renderAnalysis;
$('photCsv').onclick = () => {
  if (!ex.phot) return;
  const cols = ['date', 'mjd', 'detector', 'wavelength', 'bandwidth', 'flux_ujy', 'err_ujy', 'wing_ujy', 'background', 'flagged', 'saturated', 'flags', 'obs_id'];
  const rows = [cols.join(','), ...ex.phot.map(p => cols.map(k => p[k] ?? '').join(','))];
  const where = ex.click ? `${ex.click.ra.toFixed(5)}_${ex.click.dec.toFixed(5)}` : (state.target.name || 'target').replace(/[^A-Za-z0-9]+/g, '-');
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  a.download = `radians-${where}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
e4.photFlagged.onchange = renderAnalysis;
window.addEventListener('resize', () => { clearTimeout(ex.rt); ex.rt = setTimeout(renderAnalysis, 200); });

// ------------------------------------------------------------------ Gaia DR3 + SkyBoT overlays
function loadCatalogues() {
  const d = state.data;
  ex.gaia = []; ex.sso = [];
  e4.ovStatus.textContent = t('ovLoading');
  const rDeg = d.grid.fov / 3600 / Math.SQRT2;
  const centre = { ra: d.grid.ra.toFixed(6), dec: d.grid.dec.toFixed(6) };
  const live = () => state.data === d;
  api('api/gaia', { ...centre, radius: rDeg.toFixed(4) })
    .then(r => { if (live()) { ex.gaia = r.sources || []; drawOverlay(); renderCandidates(); if (ex.aladin) setAladinCats(); document.dispatchEvent(new CustomEvent('radians:catalogues')); } }).catch(() => {});
  api('api/sso', { ...centre, radius: Math.ceil(rDeg * 3600), mjd: d.frames.slice(0, 40).map(f => f.mjd.toFixed(3)).join(',') })
    .then(r => { if (live()) { ex.sso = r || []; drawOverlay(); } }).catch(() => {});
}

function currentMjd() {
  const fs = state.data.frames;
  return isStack() ? fs.reduce((a, f) => a + f.mjd, 0) / fs.length : fs[state.idx].mjd;
}

function gaiaAt(src, mjd) {
  const dt = (mjd - MJD_J2016) / 365.25;
  const dec = src.dec + (src.pmdec || 0) * dt / 3.6e6;
  const ra = src.ra + (src.pmra || 0) * dt / 3.6e6 / Math.cos(src.dec * Math.PI / 180);
  return [ra, dec];
}

function visibleExtras() {
  const { grid } = state.data;
  const n = grid.n, mjd = currentMjd();
  const inView = ([x, y]) => x >= -0.5 && y >= -0.5 && x <= n - 0.5 && y <= n - 0.5;
  const gaia = e4.ovGaia.checked ? ex.gaia.map(s => ({ s, p: skyToPix(...gaiaAt(s, mjd), grid) })).filter(o => inView(o.p)) : [];
  let sso = [];
  if (e4.ovSso.checked && !isStack()) {
    const hit = ex.sso.find(e => Math.abs(e.mjd - mjd) < 0.01);
    if (hit) sso = hit.objects.map(o => ({ o, p: skyToPix(o.ra, o.dec, grid) })).filter(v => inView(v.p));
  }
  return { gaia, sso };
}

function drawExtras(ctx) {
  if (!state.data || !state.data.frames.length) return;
  const { gaia, sso } = visibleExtras();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(126,224,195,.38)';
  for (const { s, p } of gaia) {
    const [cx, cy, k] = toCanvas(...p);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(3, k * (s.g < 12 ? 0.9 : 0.55)), 0, 2 * Math.PI);
    ctx.stroke();
    if (Math.hypot(s.pmra || 0, s.pmdec || 0) > 150) {      // fast movers: line = motion over the next 5 years
      const [x2, y2] = toCanvas(...skyToPix(...gaiaAt(s, currentMjd() + 5 * 365.25), state.data.grid));
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x2, y2); ctx.stroke();
    }
  }
  ctx.strokeStyle = '#b9a7ff';
  ctx.fillStyle = '#b9a7ff';
  ctx.lineWidth = 2;
  for (const { o, p } of sso) {
    const [cx, cy, k] = toCanvas(...p);
    const r = Math.max(6, k * 1.2);
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r); ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
    ctx.stroke();
    ctx.font = `${Math.max(11, Math.min(16, k * 1.3))}px system-ui`;
    ctx.fillText(o.name, cx + r + 3, cy - r);
  }
  if (ex.click) {                              // where the clicked spectrum was measured
    const [cx, cy, k] = toCanvas(ex.click.x, ex.click.y);
    ctx.strokeStyle = '#f0efec';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(6, 2 * k), 0, 2 * Math.PI); ctx.stroke();
    ctx.setLineDash([]);
  }
  e4.ovStatus.textContent = t('ovStatus', { g: gaia.length, s: sso.length });
}

function extraCursorRows(x, y) {
  if (!state.data || !state.data.frames.length) return [];
  const { gaia, sso } = visibleExtras();
  const rows = [];
  const g = gaia.find(o => Math.hypot(o.p[0] - x, o.p[1] - y) < 0.8);
  if (g) rows.push(['Gaia', t('gaiaTip', { g: g.s.g?.toFixed(1), pm: (Math.hypot(g.s.pmra || 0, g.s.pmdec || 0) / 1000).toFixed(3) })]);
  const s = sso.find(o => Math.hypot(o.p[0] - x, o.p[1] - y) < 1.5);
  if (s) rows.push(['SkyBoT', t('ssoTip', { name: s.o.name, cls: s.o.class, v: s.o.vmag })]);
  return rows;
}

e4.ovGaia.onchange = drawOverlay;
e4.ovSso.onchange = drawOverlay;

// ------------------------------------------------------------------ NEOSSat (CSA) via CADC
async function loadNeossat() {
  const d = state.data;
  ex.neo = 'loading';
  renderNeossat();
  try {
    const rows = await api('api/neossat', { ra: d.grid.ra.toFixed(6), dec: d.grid.dec.toFixed(6), radius: 0.25 });
    if (state.data === d) ex.neo = rows;
  } catch {
    if (state.data === d) ex.neo = 'fail';
  }
  renderNeossat();
}

function renderNeossat() {
  const ul = e4.neossat;
  if (ex.neo === 'loading') return ul.replaceChildren(el('li', 'muted small', t('neossatLoading')));
  if (ex.neo === 'fail') return ul.replaceChildren(el('li', 'muted small', t('neossatFail')));
  if (!Array.isArray(ex.neo) || !ex.neo.length) return ul.replaceChildren(el('li', 'muted small', t('neossatNone')));
  ul.replaceChildren(...ex.neo.slice(0, 12).map(o => {
    const li = el('li', 'small');
    const a = el('a', '', `${mjdDate(o.mjd)}${o.target ? ' · ' + o.target : ''}`);
    a.href = o.cadc_url; a.target = '_blank'; a.rel = 'noopener';
    li.append(a, el('span', 'muted', o.exptime ? ` ${o.exptime.toFixed(0)} s` : ''));
    return li;
  }));
  if (ex.neo.length > 12) ul.append(el('li', 'muted small', `+${ex.neo.length - 12}`));
}

// ------------------------------------------------------------------ Aladin Lite context view
const ALADIN_JS = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.6.5/dist/aladin.js';

async function updateAladin() {
  if (!state.data || !state.data.grid) return;
  try {
    if (!window.A) window.A = (await import(ALADIN_JS)).default;
    await window.A.init;
    const g = state.data.grid;
    if (!ex.aladin) {
      ex.aladin = window.A.aladin('#aladin', { fov: g.fov / 3600 * 3, target: `${g.ra} ${g.dec}`,
        cooFrame: 'ICRS', showReticle: false, showFullscreenControl: true, showLayersControl: true });
      ex.ovl = window.A.graphicOverlay({ color: '#ffb347', lineWidth: 2 });
      ex.aladin.addOverlay(ex.ovl);
    } else {
      ex.aladin.gotoRaDec(g.ra, g.dec);
      ex.aladin.setFoV(g.fov / 3600 * 3);
    }
    setSurvey();
    ex.ovl.removeAll();
    const n = g.n;
    ex.ovl.add(window.A.polygon([[-0.5, -0.5], [n - 0.5, -0.5], [n - 0.5, n - 0.5], [-0.5, n - 0.5]].map(([x, y]) => pixToSky(x, y, g))));
    setAladinCats();
  } catch (err) {
    toast('Aladin: ' + err.message, true);
  }
}

function setSurvey() {
  const opt = e4.ctxSurvey.selectedOptions[0];
  try {
    ex.hips = window.A.imageHiPS(opt.value, { name: opt.textContent, successCallback: () => { ex.hipsSlice = null; syncCube(); } });
    ex.aladin.setImageSurvey(ex.hips);
    ex.hipsSlice = null;
    syncCube();
  } catch (err) { toast('Aladin: ' + err.message, true); }
}

function setAladinCats() {
  const g = state.data.grid;
  for (const c of ex.cats || []) { try { ex.aladin.removeLayer(c); } catch { try { c.hide(); } catch { /* ignore */ } } }
  ex.cats = [];
  if (e4.ctxGaia.checked && ex.gaia.length) {        // Gaia DR3 from our own /api/gaia (ESA archive), at epoch J2016
    const c = window.A.catalog({ name: 'Gaia DR3', color: '#7ee0c3', sourceSize: 10, onClick: 'showPopup' });
    c.addSources(ex.gaia.map(s => window.A.source(s.ra, s.dec, { G: s.g?.toFixed(2), pmra: s.pmra?.toFixed(1), pmdec: s.pmdec?.toFixed(1), source_id: s.id })));
    ex.aladin.addCatalog(c);
    ex.cats.push(c);
  }
  if (e4.ctxCatwise.checked) {
    const c = window.A.catalogFromVizieR('II/365/catwise', `${g.ra} ${g.dec}`, g.fov / 3600 * 2.2, { onClick: 'showPopup', color: '#d55181', sourceSize: 10 });
    ex.aladin.addCatalog(c);
    ex.cats.push(c);
  }
}

e4.ctx.addEventListener('toggle', () => { if (e4.ctx.open) updateAladin(); });
e4.ctxSurvey.onchange = () => ex.aladin && setSurvey();
e4.ctxGaia.onchange = e4.ctxCatwise.onchange = () => ex.aladin && setAladinCats();

// ------------------------------------------------------------------ start
buildDetChips();
let startLang = parseState(location.search).lang;
try { startLang = startLang || localStorage.getItem('radians-lang'); } catch { /* private mode */ }
applyLang(startLang || 'en');
fromUrl();
window.radians = { state, ex };   // handle for debugging in the console


// ------------------------------------------------------------------ wavelength matching, zoom, GIF
els.wlMatch.onchange = () => { requery(); };

const zoomState = { z: 1, tx: 0, ty: 0, drag: null, dragged: false };
function applyZoom() {
  const W = els.stage.clientWidth, lim = (zoomState.z - 1) * W / 2;
  zoomState.tx = Math.max(-lim, Math.min(lim, zoomState.tx));
  zoomState.ty = Math.max(-lim, Math.min(lim, zoomState.ty));
  const tr = zoomState.z === 1 ? '' : `translate(${zoomState.tx}px, ${zoomState.ty}px) scale(${zoomState.z})`;
  els.sky.style.transform = els.overlay.style.transform = tr;
  els.zoom.textContent = `${zoomState.z}×`;
  els.overlay.style.cursor = zoomState.z > 1 ? 'grab' : '';
}
els.zoom.title = t('zoomHelp');
els.zoom.onclick = () => {
  const z = { 1: 2, 2: 4, 4: 1 }[zoomState.z];
  zoomState.tx *= z / zoomState.z; zoomState.ty *= z / zoomState.z; zoomState.z = z;
  applyZoom();
};
els.overlay.addEventListener('pointerdown', (e) => {
  if (zoomState.z === 1) return;
  zoomState.drag = { x: e.clientX, y: e.clientY, tx: zoomState.tx, ty: zoomState.ty };
  zoomState.dragged = false;
});
window.addEventListener('pointermove', (e) => {
  const d = zoomState.drag;
  if (!d) return;
  const dx = e.clientX - d.x, dy = e.clientY - d.y;
  if (Math.hypot(dx, dy) > 4) zoomState.dragged = true;
  zoomState.tx = d.tx + dx; zoomState.ty = d.ty + dy;
  applyZoom();
});
window.addEventListener('pointerup', () => { zoomState.drag = null; });

/** Palette indices of frame i with the current view, stretch and colour map (as render() shows it). */
function frameIndices(i, table) {
  const n = state.data.grid.n, img = state.shown[i];
  const diffView = isDiffView(els.view.value);
  const [lo, hi] = state.levels, kind = els.stretch.value;
  const px = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    const row = n - 1 - y;
    for (let x = 0; x < n; x++) {
      const tv = diffView ? stretchSigned(img[y * n + x], hi, kind) : stretchValue(img[y * n + x], lo, hi, kind);
      px[row * n + x] = Number.isNaN(tv) ? 0 : (diffView ? Math.round(128 + tv * 127) : Math.round(tv * 255));
    }
  }
  return px;
}

els.gif.onclick = () => {
  if (!state.data) return;
  toast(t('gifMaking'));
  setTimeout(() => {
    const n = state.data.grid.n, k = Math.max(1, Math.floor(480 / n)), W = n * k;
    const table = isDiffView(els.view.value) ? lutDiverging() : lut(els.cmap.value);
    const count = isStack() ? 1 : state.shown.length;
    const frames = [];
    for (let i = 0; i < count; i++) {
      const src = frameIndices(i, table), big = new Uint8Array(W * W);
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) big[y * W + x] = src[Math.floor(y / k) * n + Math.floor(x / k)];
      frames.push(big);
    }
    const delay = Math.round(100 / Number(els.fps.value || 2));
    const blob = new Blob([encodeGif(frames, W, W, table, delay)], { type: 'image/gif' });
    const a = document.createElement('a');
    const name = (state.target && (state.target.name || els.q.value) || 'radians').toString().replace(/[^\w.-]+/g, '-');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}-spherex.gif`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(t('gifDone'));
  }, 30);
};

// ------------------------------------------------------------------ finding card (a PNG to share)
function saveFinding(c, known) {
  const W = 1200, H = 630, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const light = document.documentElement.dataset.theme === 'light';
  const fg = light ? '#000000' : '#ffffff', dim = light ? '#555555' : '#9a9a9a', line = light ? '#dddddd' : '#262626';
  g.fillStyle = light ? '#ffffff' : '#000000'; g.fillRect(0, 0, W, H);
  g.imageSmoothingEnabled = false;
  // left: the frame as shown, with the candidate ringed
  const n = state.data.grid.n, S = 470, X0 = 50, Y0 = 90;
  g.drawImage(els.sky, X0, Y0, S, S);
  g.strokeStyle = line; g.lineWidth = 1; g.strokeRect(X0 - 0.5, Y0 - 0.5, S + 1, S + 1);
  const px = X0 + (c.x + 0.5) / n * S, py = Y0 + (n - 1 - c.y + 0.5) / n * S;
  g.strokeStyle = COLORS[c.type] || '#ffb347'; g.lineWidth = 3;
  g.beginPath(); g.arc(px, py, 22, 0, 2 * Math.PI); g.stroke();
  // brand line
  g.fillStyle = '#ffb347'; g.beginPath(); g.arc(58, 46, 7, 0, 2 * Math.PI); g.fill();
  g.fillStyle = fg; g.font = '700 26px "Inter Tight", system-ui'; g.textBaseline = 'middle'; g.fillText('Radians', 76, 47);
  g.fillStyle = dim; g.font = '400 16px "JetBrains Mono", monospace'; g.fillText('NASA SPHEREx · radians.onrender.com', 196, 48);
  // right: what was found
  const RX = 570;
  g.textBaseline = 'alphabetic';
  g.fillStyle = COLORS[c.type] || '#ffb347'; g.font = '600 17px "JetBrains Mono", monospace';
  g.fillText(t('findingKicker').toUpperCase(), RX, 116);
  g.fillStyle = fg; g.font = '700 44px "Inter Tight", system-ui';
  g.fillText(t(c.type), RX, 166);
  const name = (state.target.name || els.q.value || '').replace(/^(NAME|V\*|\*)\s+/, '');
  g.fillStyle = dim; g.font = '500 22px "Inter Tight", system-ui';
  g.fillText(c.is_target && name ? name : `${formatRA(c.ra)} ${formatDec(c.dec)}`, RX, 200);
  g.fillStyle = fg; g.font = '400 21px "Inter Tight", system-ui';
  wrapText(g, candText(c), RX, 242, W - RX - 50, 29);
  // before / after cut-outs on a shared stretch
  const { pos, a, b, lo, hi } = candFrames(c), CS = 150;
  [[a, 0], [b, 1]].forEach(([i, k]) => {
    const cut = cutout(i, ...pos[i], lo, hi), x = RX + k * (CS + 24), y = 320;
    g.drawImage(cut, x, y, CS, CS);
    g.strokeStyle = line; g.strokeRect(x - 0.5, y - 0.5, CS + 1, CS + 1);
    g.fillStyle = dim; g.font = '400 15px "JetBrains Mono", monospace';
    g.fillText(frameLabel(i), x, y + CS + 24);
  });
  const fsx = state.data.frames;
  const facts = [
    `${fsx.length} ${t('findingVisits')} · ${fsx[0].date_start.slice(0, 10)} → ${fsx[fsx.length - 1].date_end.slice(0, 10)}`,
    known && known !== 'unchecked' ? `Gaia DR3 ${known.id}` : (c.is_target || known === 'unchecked' ? '' : t('notInGaia')),
  ].filter(Boolean);
  g.fillStyle = dim; g.font = '400 16px "JetBrains Mono", monospace';
  facts.forEach((f, k) => g.fillText(f, RX, 540 + k * 24));
  g.font = '400 13px "Inter Tight", system-ui';
  g.fillText(t('findingFoot'), 50, H - 22);
  cv.toBlob((blob) => {
    const a2 = document.createElement('a');
    a2.href = URL.createObjectURL(blob);
    a2.download = `radians-${(name || 'finding').replace(/[^\w.-]+/g, '-')}-${c.type}.png`;
    a2.click();
    setTimeout(() => URL.revokeObjectURL(a2.href), 5000);
  }, 'image/png');
  const done = () => toast(t('findingSaved'));
  if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, done); else done();
}

function wrapText(g, text, x, y, maxW, lh) {
  let lineText = '';
  for (const w of text.split(' ')) {
    const test = lineText ? `${lineText} ${w}` : w;
    if (g.measureText(test).width > maxW && lineText) { g.fillText(lineText, x, y); y += lh; lineText = w; }
    else lineText = test;
  }
  if (lineText) g.fillText(lineText, x, y);
}

// ------------------------------------------------------------------ listen: the chart as sound
let sound = null;
function stopSound() {
  if (!sound) return;
  try { sound.ctx.close(); } catch { /* already closed */ }
  clearTimeout(sound.timer);
  sound = null;
  els.listen.textContent = t('listen');
  els.listen.setAttribute('aria-pressed', 'false');
}
els.listen.onclick = () => {
  if (sound) { stopSound(); return; }
  if (!ex.phot || ex.tab === 'table') { toast(t('listenNone')); return; }
  const key = ex.tab === 'spectrum' ? (p) => p.wavelength : (p) => p.mjd;
  let pts = ex.phot.filter(p => Number.isFinite(valueOf(p)) && Number.isFinite(key(p)) && (e4.photFlagged.checked || !p.flagged))
    .sort((p, q) => key(p) - key(q));
  if (ex.tab === 'lightcurve') {
    // each detector divided by its own median, as on the chart
    const med = new Map();
    for (const d of new Set(pts.map(p => p.detector))) med.set(d, median(pts.filter(p => p.detector === d).map(valueOf)));
    pts = pts.map(p => ({ ...p, v_: valueOf(p) / med.get(p.detector) }));
  } else pts = pts.map(p => ({ ...p, v_: valueOf(p) }));
  if (pts.length < 3) { toast(t('listenNone')); return; }
  const step = Math.ceil(pts.length / 160);
  pts = pts.filter((_, i) => i % step === 0);
  const vs = pts.map(p => p.v_).sort((x, y) => x - y);
  const lo = vs[Math.floor(vs.length * 0.05)], hi = vs[Math.floor(vs.length * 0.95)];
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { toast(t('listenNone')); return; }
  const ctx = new AC(), master = ctx.createGain();
  master.gain.value = 0.18; master.connect(ctx.destination);
  const dur = Math.min(9, Math.max(3, pts.length * 0.06)), dt = dur / pts.length, t0 = ctx.currentTime + 0.05;
  pts.forEach((p, i) => {
    const u = Math.min(1, Math.max(0, (p.v_ - lo) / ((hi - lo) || 1)));
    const osc = ctx.createOscillator(), env = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 220 * 2 ** (2.5 * u);                    // brighter = higher, over 2.5 octaves
    const ts = t0 + i * dt;
    env.gain.setValueAtTime(0.0001, ts);
    env.gain.linearRampToValueAtTime(p.flagged ? 0.4 : 1, ts + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, ts + Math.max(0.05, dt * 1.6));
    let node = env;
    if (ctx.createStereoPanner) { const pan = ctx.createStereoPanner(); pan.pan.value = -0.8 + 1.6 * i / pts.length; env.connect(pan); node = pan; }
    osc.connect(env); node.connect(master);
    osc.start(ts); osc.stop(ts + Math.max(0.06, dt * 1.8));
  });
  sound = { ctx, timer: setTimeout(stopSound, (dur + 0.4) * 1000) };
  els.listen.textContent = t('listenStop');
  els.listen.setAttribute('aria-pressed', 'true');
};

// ?compare=1 opens straight in the before/after view (shareable)
if (new URLSearchParams(location.search).get('compare') === '1') {
  document.addEventListener('radians:loaded', () => setTimeout(() => setCompare(true), 0), { once: true });
}

// ------------------------------------------------------------------ SPHEREx all-sky cube in the context view follows the frame's wavelength
function syncCube() {
  if (!ex.hips || !ex.aladin || !state.data || e4.ctxSurvey.value !== CUBE_URL) return;
  const f = isStack() ? null : state.data.frames[state.idx];
  // only a narrow-band frame has a meaningful wavelength; a whole-epoch stack spans 0.75-5 µm
  const narrow = f && f.wavelength_min && f.wavelength_max && f.wavelength_max - f.wavelength_min <= 0.3;
  const i = nearestSlice(narrow ? (f.wavelength_min + f.wavelength_max) / 2 : 2.2);
  clearTimeout(ex.cubeTimer);                         // while blinking, wait until the frame settles
  ex.cubeTimer = setTimeout(() => {
    if (ex.hipsSlice === i) return;
    ex.hipsSlice = i;
    try { ex.hips.setSliceNumber(i); } catch { /* single-plane survey */ }
  }, ex.hipsSlice == null ? 0 : 700);
}

// ------------------------------------------------------------------ IRSA's official spectrophotometry tool
$('irsaSpec').onclick = async () => {
  const p = ex.click || state.target;
  if (!p) return;
  const coo = `${p.ra.toFixed(6)} ${p.dec.toFixed(6)}`;
  try { await navigator.clipboard.writeText(coo); toast(t('irsaCopied')); } catch { toast(coo); }
  window.open('https://irsa.ipac.caltech.edu/applications/spherex/tool-spectrophotometry', '_blank', 'noopener');
};
