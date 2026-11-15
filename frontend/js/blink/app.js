import {
  decodeB64, percentiles, stretchValue, stretchSigned, lut, lutDiverging, pixToSky, formatRA, formatDec, fitsBytes,
  flagNames, parseState, computeView, isDiffView, skyToPix, stackImage, rgbChannels,
  timeColorChannels, lutBeforeNow, matchedDiffValue,
} from './sky.js';
import { t, setLang, getLang } from '../core/i18n.js';
import { scatterChart, chartTable, SERIES, wlColor } from '../core/charts.js';
import { encodeGif } from './gif.js';
import { renderTypeBox } from './typebox.js';
import { createCurious } from './curious.js';
import { CUBE_URL, nearestSlice } from '../core/cube.js';
const CUBE_NAME = 'SPHEREx DR1';
import { depthStart, depthLive, depthLoad, depthHide } from './depth.js';
import { getPalette, setPalette, viewerCmap } from '../core/palette.js';
import { loadAladin, QUIET } from '../core/aladin.js';
import { curated, TARGETS } from '../content/facts.js';
import { headline, clarity, catalogueStatus, nearestAt, tooFast, cleanId, CAT_NAMES, mergeFinds } from './finds.js';

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries([
  'search', 'q', 'fov', 'mode', 'go', 'sky', 'overlay', 'stage', 'empty', 'loading', 'loadingMsg', 'loadingSub',
  'play', 'prev', 'next', 'scrub', 'fps', 'fpsVal', 'timeline', 'frameInfo', 'cursor', 'stretch', 'cmap', 'lo', 'hi',
  'wlWin', 'wlBox', 'wlC', 'wlW', 'wlLab', 'rgbNote',
  'cross', 'flagView', 'smooth', 'link', 'copy', 'toast', 'hudDate', 'hudIdx', 'hudScale', 'view', 'viewHelp', 'detchips',
  'srcBar', 'srcSeg', 'bandChips', 'srcStatus', 'deepStatus',
  'preset', 'loadingBar', 'wlMatch', 'zoom', 'gif', 'cands', 'candCount', 'candRange', 'showCands', 'flagSummary', 'expDetails', 'expSummary', 'expList', 'examples', 'compare', 'listen',
].map(id => [id, $(id)]));

const ALL_DETS = [1, 2, 3, 4, 5, 6];
const state = {
  data: null, target: null,
  images: [], variances: [], flags: [],   // as delivered (one per frame)
  shown: [],                              // what the current view displays
  idx: 0, playing: false, timer: null, levels: [0, 1], abort: null,
  dets: new Set(ALL_DETS), selected: null,
  compare: false, split: 0.5, splitDrag: false, splitMoved: false,
  params: null, rgb: null,                // last /api/frames query; colour channels built from it
  // Two data sets per target. 'quick': one detector band from the fast engine (a preview within
  // seconds, then the whole band). 'deep': all detectors co-added (/api/frames), read afterwards.
  // state.data is whichever of the two is on screen.
  src: 'quick', band: null, quick: null, deepData: null, qabort: null,
  sharp: null,                            // 'sharp': one super-resolution picture per visit from all detectors (see loadSharp)
  md: null,                               // wavelength-matched differences of the fast band (see matchedDiffs)
  qc: null,                               // finds on the fast band's difference picture (see loadQuickChanges)
  cands: [],                              // the cards: both finders' finds, merged, on the grid on screen
  deepBusy: false,
  tcLevels: [0, 1],                       // shared brightness levels of the colour-by-time picture
};
const NATIVE_PX = 6.15;                   // arcsec per SPHEREx detector pixel (the all-detector grid)

// ------------------------------------------------------------------ helpers
async function api(path, params, signal) {
  const url = new URL(path, location.href);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) url.searchParams.set(k, v);
  const r = await fetch(url, { signal });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(errorText(body.detail, r.status));
    e.code = body.detail === 'IRSA_UNAVAILABLE' || (!body.detail && r.status >= 502) ? 'unavailable' : body.detail;
    throw e;
  }
  return body;
}

/** Readable message for an API error: never a raw HTML page from a proxy or the archive. */
function errorText(detail, status) {
  if (detail === 'IRSA_UNAVAILABLE') return t('irsaDown');
  if (detail === 'IRSA_FAILED') return t('irsaFailed');
  if (typeof detail === 'string' && detail.length < 300 && !/<[a-z!]/i.test(detail)) return detail;
  if (status >= 502) return t('serverDown');
  return `${t('errorGeneric')} (${status})`;
}
const sleep = (ms, signal) => new Promise((res, rej) => {
  const id = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(id); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
});

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
const isTimeColor = () => els.view.value === 'timecolor';
/** One combined picture instead of one per visit (the stack, or colour by time). */
const isStack = () => els.view.value === 'stack' || isTimeColor();
const isMatched = () => els.view.value === 'diff_matched';
/** Views that subtract the first visit from every other one. The first visit minus itself is an empty
 * picture, so in these views it is the reference: the player starts at the second visit and skips it. */
const skipsFirst = () => (isMatched() || els.view.value === 'diff_first') && state.shown.length > 1;

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
      requeryDeep();
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
  requeryDeep();
};

function requery(extra = {}) {
  if (state.target) run({ q: els.q.value.trim(), ...state.target, fov: els.fov.value, mode: els.mode.value,
    src: state.src, band: state.band, ...extra });
}
/** Detector chips, frame modes and the wavelength tools work on the all-detector data. */
const requeryDeep = () => requery({ src: 'deep' });

// ------------------------------------------------------------------ fast band / all detectors
function buildBandChips() {
  const ranges = { 1: [0.75, 1.09], 2: [1.10, 1.62], 3: [1.63, 2.42], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.00] };
  els.bandChips.replaceChildren(...ALL_DETS.map(d => {
    const b = el('button', 'detchip', `D${d}`);
    b.type = 'button';
    b.dataset.band = d;
    b.dataset.lo = ranges[d][0].toFixed(2);
    b.dataset.hi = ranges[d][1].toFixed(2);
    b.setAttribute('aria-pressed', 'false');
    b.onclick = () => setBand(d);
    return b;
  }));
  syncSrcUi();
}

function syncSrcUi() {
  els.srcBar.hidden = !state.target;
  for (const b of els.srcSeg.children) b.setAttribute('aria-pressed', String(b.dataset.src === state.src));
  const band = state.src === 'quick' ? (state.quick?.quick.band ?? state.band) : null;
  for (const b of els.bandChips.children) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.band) === band));
    b.title = t('bandTitle', { b: b.dataset.band, lo: b.dataset.lo, hi: b.dataset.hi });
  }
}

/** Put a data set that is already in memory on screen (switching between the two). */
function showSet(d) {
  const was = state.playing;
  stop();
  load(d, 0);
  if (was) play();
  syncUrl(true);
}

// The choice (fast band or all detectors, and which band) is remembered for the next new spot.
const saved = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };

function setSrc(src) {
  if (!state.target || src === state.src) return;
  state.src = src;
  if (src !== 'sharp') save('radians-src', src);    // sharpening is asked for per spot, not remembered
  syncSrcUi();
  if (src === 'sharp') {
    if (state.sharp?.frames?.length) showSet(state.sharp);
    else if (state.deepData?.frames?.length) loadSharp();
    else toast(t('needDeep'));                      // it is made from the all-detector exposures: when they are in
  } else if (src === 'deep') {
    if (state.deepData?.frames?.length) showSet(state.deepData);
    else toast(t('needDeep'));                      // being read: it goes on screen when it arrives
  } else if (state.quick?.frames?.length) showSet(state.quick);
  else startQuick();
}

/** One sharpened picture per visit: every exposure of the visit, all detector bands together,
 * combined on pixels half the size (the server keeps the exposures the all-detector view read, so
 * nothing is downloaded). It replaces the pictures only: finds and measurements stay those of the
 * all-detector data and are moved onto the finer grid. */
async function loadSharp() {
  const deep = state.deepData;
  if (!deep?.frames?.length || state.sharpBusy) return;
  state.sharpBusy = true;
  els.deepStatus.textContent = t('sharpMaking');
  try {
    const d = await api('api/frames', { ...state.params, mode: 'epoch', sharp: 2, candidates: false }, state.abort?.signal);
    if (state.deepData !== deep) return;             // another spot was opened meanwhile
    if (!d.frames?.length) { els.deepStatus.textContent = d.message || t('sharpNone'); if (state.src === 'sharp') setSrc('deep'); return; }
    state.sharp = d;
    const thin = d.frames.filter(f => f.thin).length;
    els.deepStatus.textContent = t(thin ? 'sharpReadyThin' : 'sharpReady', { n: thin, min: d.sharp.min_exposures });
    if (state.src === 'sharp') showSet(d);
  } catch (e) {
    if (e.name !== 'AbortError') { els.deepStatus.textContent = t('deepFailed', { msg: e.message }); if (state.src === 'sharp') setSrc('deep'); }
  } finally { state.sharpBusy = false; }
}
els.srcSeg.onclick = (e) => { const b = e.target.closest('button[data-src]'); if (b) setSrc(b.dataset.src); };

function setBand(b) {
  if (!state.target) return;
  state.band = b;
  state.src = 'quick';
  save('radians-src', 'quick');
  save('radians-band', String(b));
  syncSrcUi();
  startQuick();
}

/** (Re)load only the fast band, e.g. after picking another band; the all-detector data stays. */
async function startQuick() {
  if (state.qabort) state.qabort.abort();
  const ctl = new AbortController();
  state.qabort = ctl;
  try {
    const shown = await runQuick(state.target, { autoplay: state.playing }, ctl.signal, false);
    if (!shown) toast(t('quickNone'), true);
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message, true);
  }
}

function quickStatus(q, shown, blocking) {
  const p = q.progress, b = q.band;
  let msg;
  if (q.state === 'ready') {
    const um = q.band_um || [];
    msg = t('quickFull', { b, lo: um[0], hi: um[1], n: q.n_band, p: (q.passes || []).length });
  } else if (shown) msg = p && p.total ? t('quickPreview', { b, done: p.done, total: p.total }) : t('quickPreviewWait', { b });
  else msg = p && p.total ? t('quickReading', { b, done: p.done, total: p.total }) : t('quickLooking');
  if (!shown && blocking) {
    els.loadingSub.textContent = msg;
    if (p && p.total) { els.loadingBar.hidden = false; els.loadingBar.value = p.done / p.total; }
  } else els.srcStatus.textContent = msg;
}

/** The fast band: follow the engine's build (/api/quick) and show each revision as it is ready:
 * first a preview, then the whole band. Returns true once something is on screen. */
async function runQuick(target, opts, signal, blocking) {
  // prefer: the band picked last time; the server uses it only for a spot that has no band of its own
  const base = { ra: target.ra.toFixed(6), dec: target.dec.toFixed(6), fov: els.fov.value, band: state.band,
    prefer: state.band ? null : (Number(saved('radians-band')) || null), pmra: target.pmra, pmdec: target.pmdec };
  let have = -1, shown = false;
  if (blocking) setLoading(true, t('reading'), t('quickLooking'));
  else els.srcStatus.textContent = t('quickLooking');
  for (;;) {
    let d;
    try {
      d = await api('api/quick', { ...base, have, wait: 12 }, signal);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (shown) els.srcStatus.textContent = t('quickBroke');
      return shown;
    }
    const q = d.quick;
    if (q.state === 'error') {
      if (shown) els.srcStatus.textContent = t('quickBroke');
      return shown;
    }
    if (d.frames) {                                  // a newer revision: preview, then the whole band
      have = q.rev;
      if (!d.frames.length) return shown;
      state.quick = d;
      if (state.src === 'quick') {
        const was = state.playing;
        stop();
        load(d, shown ? state.idx : (opts.frame ?? 0));
        if (shown ? was : opts.autoplay !== false) play();
        if (!shown && blocking) document.dispatchEvent(new CustomEvent('radians:loaded', { detail: d }));
        syncUrl(shown);
      }
      if (blocking && !shown) { setLoading(false); els.loadingBar.hidden = true; }
      shown = true;
      syncSrcUi();
    }
    quickStatus(q, shown, blocking);
    if (q.state === 'ready') { loadQuickChanges(); renderAnalysis(); return shown; }
  }
}

/** All detectors (/api/frames). With background = true the fast band is already on screen: nothing
 * is covered, progress goes to the status line, and the result fills the panels that need every band. */
async function runDeep(target, opts, ctl, background) {
  const t0 = performance.now();
  let showProgress = false, retrying = false;
  const say = (msg, sub = '') => (background ? (els.deepStatus.textContent = sub || msg) : setLoading(true, msg, sub));
  const tick = background ? null : setInterval(() => {
    const s = Math.round((performance.now() - t0) / 1000);
    // while waiting to ask IRSA again, the retry countdown owns this line
    if (!showProgress && !retrying) els.loadingSub.textContent = s < 8 ? '' : t('slow', { s });
  }, 1000);
  say(t('reading'), background ? t('deepStart') : '');
  state.deepBusy = true;
  depthStart();
  const job = Math.random().toString(36).slice(2, 12);
  const poll = setInterval(async () => {
    try {
      const p = await api('api/progress', { job }, ctl.signal);
      if (p.stage === 'read' && p.total) {
        showProgress = true;
        if (background) els.deepStatus.textContent = t('deepReading', { done: p.done, total: p.total });
        else {
          els.loadingSub.textContent = t('readingN', { done: p.done, total: p.total, pct: Math.round(100 * p.done / p.total) });
          els.loadingBar.hidden = false;
          els.loadingBar.value = p.done / p.total;
        }
      }
      if (p.preview) depthLive(p.preview); else if (p.stage === 'process') {
        if (background) els.deepStatus.textContent = t('processing');
        else { els.loadingSub.textContent = t('processing'); els.loadingBar.value = 1; }
      }
    } catch { /* progress is cosmetic */ }
  }, 1000);
  try {
    const params = {
      ra: target.ra.toFixed(6), dec: target.dec.toFixed(6), fov: opts.fov, mode: opts.mode,
      pmra: target.pmra, pmdec: target.pmdec, detectors: [...state.dets].sort().join(','),
      matched: els.wlMatch.checked, ...wlParams(),
    };
    const query = { ...params, job };
    // NASA's archive has short outages: wait and ask again a few times before giving up
    let data;
    for (let attempt = 1; ; attempt++) {
      try {
        data = await api('api/frames', query, ctl.signal);
        break;
      } catch (e) {
        if (e.code !== 'unavailable' || attempt >= 4) throw e;
        retrying = true;
        for (let s = 20; s > 0; s--) {
          say(t('irsaRetry'), t('irsaRetryIn', { s, n: attempt, max: 3 }));
          await sleep(1000, ctl.signal);
        }
        retrying = false;
        say(t('reading'), background ? t('deepStart') : '');
      }
    }
    state.params = params;
    state.deepData = data;
    if (!data.frames || !data.frames.length) {
      const w = data.wl_window;
      const why = w ? t('wlNone', { lo: w[0].toFixed(2), hi: w[1].toFixed(2) }) : t('noData');
      depthHide();
      if (background) { els.deepStatus.textContent = why; return; }
      state.data = null;
      els.empty.hidden = false;
      els.empty.innerHTML = `<p>${why}</p>`;
      renderCandidates();
      return;
    }
    if (state.src === 'deep') {
      const was = state.playing;
      stop();
      load(data, background ? 0 : (opts.frame ?? 0));
      if (!background) document.dispatchEvent(new CustomEvent('radians:loaded', { detail: data }));
      syncUrl(background);
      if (background ? was : opts.autoplay !== false) play();
    } else adoptDeep(data);
    if (state.src === 'sharp') loadSharp();
    depthLoad(gridParams(), api);
    els.deepStatus.textContent = background ? t('deepReady') : '';
  } catch (e) {
    if (e.name === 'AbortError' || !background) throw e;
    depthHide();
    els.deepStatus.textContent = t('deepFailed', { msg: e.message });
  } finally {
    clearInterval(tick);
    clearInterval(poll);
    if (state.abort === ctl) { state.deepBusy = false; renderCandidates(); }
  }
}

/** The all-detector data arrived while the fast band is on screen: fill what needs every band
 * (the target's 0.75-5 µm spectrum and light curve) and leave the picture alone. */
function adoptDeep(data) {
  setPhot(data.exposures || [], null, data.spot);
  rebuildCands();
}

// ------------------------------------------------------------------ one candidate list from two finders
/** Finds on the fast band's difference picture (first visit against the last), once per build. */
function loadQuickChanges() {
  const q = state.quick?.quick;
  if (!q || q.state !== 'ready') return;
  const key = `${q.id}:${q.rev}`;
  if (state.qc && state.qc.key === key) return;
  const qc = state.qc = { key, data: null };
  api('api/quick/changes', { id: q.id })
    .then((d) => { qc.data = d; })
    .catch(() => { qc.data = { candidates: [], notes: ['failed'] }; })
    .finally(() => { if (state.qc === qc) rebuildCands(); });
}

/** A find moved onto the grid on screen (its own grid may be the other data set's), with the visits
 * it talks about expressed as epochs of the frames on screen. */
function onGrid(c, active) {
  const frames = state.data.frames;
  const move = (p) => {
    if (c.grid === active) return p;
    const [x, y] = skyToPix(...pixToSky(p.x, p.y, c.grid), active);
    return { ...p, x, y };
  };
  const epochAt = (mjd) => frames.reduce((b, f) => (Math.abs(f.mjd - mjd) < Math.abs(b.mjd - mjd) ? f : b), frames[0]).epoch;
  const out = { ...move(c), points: (c.points || []).map(move) };
  if (c.method === 'difference') {
    out.from = epochAt(c.mjd_a);
    out.to = epochAt(c.mjd_b);
    if (c.epoch_mjd) out.epoch = epochAt(c.epoch_mjd);
  } else if (c.grid !== active && c.type === 'transient' && c.points?.length) out.epoch = epochAt(c.points[0].mjd);
  return out;
}

function rebuildCands() {
  const active = state.data?.grid;
  state.selected = null;
  if (!active) { state.cands = []; renderCandidates(); return; }
  const withSky = (c, grid) => ({ ...c, grid, sky: (c.points?.length ? c.points : [c]).map(p => pixToSky(p.x, p.y, grid)) });
  const deep = state.deepData, qd = state.qc?.data, quick = state.quick;
  const tracking = deep?.grid ? (deep.candidates || []).map(c => withSky({ ...c, method: 'tracking' }, deep.grid)) : [];
  const difference = qd && quick?.grid ? qd.candidates.map(c => withSky(c, quick.grid)) : [];
  state.cands = mergeFinds(tracking, difference).map(c => onGrid(c, active));
  renderCandidates();
  drawOverlay();
}

// ------------------------------------------------------------------ load
async function run(opts) {
  document.dispatchEvent(new CustomEvent('radians:run'));       // ui.js: switch from the landing page to the viewer
  if (state.abort) state.abort.abort();
  if (state.qabort) state.qabort.abort();
  const ctl = new AbortController();
  state.abort = ctl;
  stop();
  els.empty.hidden = true;
  els.loadingBar.hidden = true;
  // a prepared challenge target opens on its fast band at once, whatever was chosen last time
  const prepared = TARGETS.some(x => x.q.toLowerCase() === String(opts.q || '').toLowerCase());
  state.src = (opts.src ?? (prepared ? null : saved('radians-src'))) === 'deep' ? 'deep' : 'quick';
  state.band = opts.band ?? null;
  state.quick = null;
  state.deepData = null;
  state.sharp = null;
  state.sharpBusy = false;
  state.qc = null;
  state.cands = [];
  state.deepBusy = false;
  els.srcStatus.textContent = els.deepStatus.textContent = '';
  try {
    let target;
    if (opts.ra !== null && opts.ra !== undefined && opts.dec !== null && opts.dec !== undefined) {
      target = { name: opts.name ?? opts.q ?? null, ra: opts.ra, dec: opts.dec, pmra: opts.pmra, pmdec: opts.pmdec };
    } else {
      setLoading(true, t('finding', { q: opts.q }));
      target = await api('api/resolve', { q: opts.q }, ctl.signal);
      if (target.matched === 'path') {
        // Typed coordinates that lie on a moving object's path are that object (WISE 0855's own name gives
        // where it was in 2010, two arcminutes from where it is now): say so, and follow the object.
        toast(t('onPath', { name: target.name, d: Math.round(target.moved_arcsec) }));
        const known = TARGETS.find(x => Math.hypot((x.ra - target.ra) * Math.cos(target.dec * Math.PI / 180), x.dec - target.dec) * 3600 < 3);
        const card = known && [...els.examples.querySelectorAll('button[data-q]')].find(b => b.dataset.q === known.q);
        if (card) { card.click(); return; }            // a challenge target: opened with its own settings (WISE 0855: D5 + D6)
      }
    }
    state.target = target;
    syncSrcUi();
    let shown = false;
    if (state.src === 'quick') {
      shown = await runQuick(target, opts, ctl.signal, true);
      if (!shown) { state.src = 'deep'; syncSrcUi(); }        // nothing in that band: the all-detector view still works
    }
    await runDeep(target, opts, ctl, shown);
  } catch (e) {
    if (e.name !== 'AbortError') {
      depthHide();
      toast(e.message, true);
      if (e.code === 'unavailable' && !state.data) showOutage();
      else if (!state.data) els.empty.hidden = false;
    }
  } finally {
    if (state.abort === ctl) { setLoading(false); els.loadingBar.hidden = true; }
  }
}

/** IRSA is down and this spot is not cached: say so, and offer the prepared targets, which open from
 * the data shipped with the app. (From Efe's PR #11.) */
function showOutage() {
  els.empty.replaceChildren(el('p', '', t('irsaOutageTitle')), el('p', 'muted', t('irsaOutageBody')));
  const row = el('div', 'outage-targets');
  for (const b of els.examples.querySelectorAll('button[data-q]')) {
    const c = el('button', 'chip outage-target', b.querySelector('.tname')?.textContent || b.dataset.q);
    c.type = 'button';
    c.onclick = () => b.click();          // same path as the home page's cards (bands, wavelength matching)
    row.append(c);
  }
  els.empty.append(row);
  els.empty.hidden = false;
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
  state.rgb = null;
  const matchedOpt = els.view.querySelector('option[value="diff_matched"]');
  matchedOpt.disabled = !data.quick;                     // only the engine pairs exposures by wavelength
  if (isMatched() && !data.quick) els.view.value = 'diff_first';
  if (isTimeColor() && data.frames.length < 2) els.view.value = 'images';
  document.dispatchEvent(new CustomEvent('radians:view'));
  applyView(startIdx);
  rebuildCands();
  onLoaded();
  syncRgb();
}

// ------------------------------------------------------------------ views
function applyView(startIdx = state.idx) {
  if (!state.data) return;
  const md = isMatched() ? matchedDiffs() : null;
  state.shown = md ? md.images : computeView(state.images, state.variances, isMatched() ? 'diff_first' : els.view.value);
  els.scrub.max = state.shown.length - 1;
  els.scrub.min = skipsFirst() ? 1 : 0;
  els.viewHelp.textContent = isMatched() ? '' : isDiffView(els.view.value) ? t('viewHelpDiff') + (!state.data.quick && els.wlMatch.checked ? ' ' + t('viewHelpDiffWl') : '')
    : isTimeColor() ? t('viewHelpTime') : isStack() ? t('viewHelpStack') : '';
  computeLevels();
  buildTimeline();
  show(isStack() ? 0 : startIdx);
}

/** The fast band's wavelength-matched differences (each later visit minus the first), asked from the
 * engine once per build. Returns null until they are in; the view then redraws itself. */
function matchedDiffs() {
  const q = state.data?.quick;
  if (!q) return null;
  const key = `${q.id}:${q.rev}`;
  if (state.md && state.md.key === key) return state.md.images ? state.md : null;
  const md = state.md = { key, images: null, how: [], limit: [] };
  api('api/quick/diffs', { id: q.id }).then((d) => {
    const n2 = d.n * d.n;
    md.images = [new Float32Array(n2), ...d.pairs.map(p => decodeB64(p.image, Float32Array))];
    md.how = [null, ...d.pairs];
    md.limit = [1, ...d.pairs.map(p => 10 * p.sigma)];
    if (state.md === md && isMatched() && state.data?.quick?.id === q.id) { const was = state.playing; applyView(); if (was) play(); }
  }).catch((e) => { if (state.md === md) state.md = null; toast(e.message, true); });
  return null;
}

function matchedHelp() {
  const md = state.md && state.md.images ? state.md : null;
  if (!md) return t('viewHelpMatchedWait');
  const how = md.how[state.idx];
  if (!how) return t('viewHelpMatchedFirst');
  return how.matched ? t('viewHelpMatched', { na: how.n_a, nb: how.n_b, lo: how.wave_um[0].toFixed(2), hi: how.wave_um[1].toFixed(2) })
    : t('viewHelpUnmatched');
}

function computeLevels() {
  if (!state.shown.length) return;
  if (isTimeColor()) state.tcLevels = percentiles(state.images, [Number(els.lo.value), Number(els.hi.value)]);
  if (isDiffView(els.view.value)) {
    // symmetric limit from the absolute differences; "white point" slider still applies
    const abs = (skipsFirst() ? state.shown.slice(1) : state.shown).map(a => a.map(Math.abs));
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
  if (isTimeColor()) { renderTimeColor(); return; }
  if (rgbReady()) { renderRgb(); return; }
  const n = data.grid.n;
  const cmp = compareOn();
  const img = state.shown[cmp ? compareB() : state.idx];
  const imgA = cmp ? state.shown[0] : img;
  const sx = cmp ? Math.round(state.split * n) : -1;            // columns left of this show the first visit
  const flg = frameFlags(state.idx);
  const ctx = els.sky.getContext('2d');
  const out = ctx.createImageData(n, n);
  const diffView = isDiffView(els.view.value);
  const md = isMatched() && state.md && state.md.images ? state.md : null;     // blue/orange, fixed 10-sigma scale
  const table = md ? lutBeforeNow() : diffView ? lutDiverging() : lut(els.cmap.value);
  const [lo, hi] = state.levels;
  const kind = els.stretch.value;
  const showFlags = els.flagView.checked;
  const limR = md ? md.limit[cmp ? compareB() : state.idx] : 0, limL = md ? md.limit[0] : 0;
  for (let y = 0; y < n; y++) {
    const row = n - 1 - y;                                   // FITS y is up, canvas y is down
    for (let x = 0; x < n; x++) {
      const i = y * n + x, o = (row * n + x) * 4;
      const v = x < sx ? imgA[i] : img[i];
      const tv = md ? matchedDiffValue(v, x < sx ? limL : limR)
        : diffView ? stretchSigned(v, hi, kind) : stretchValue(v, lo, hi, kind);
      if (Number.isNaN(tv)) { out.data[o] = 30; out.data[o + 1] = 12; out.data[o + 2] = 40; out.data[o + 3] = 255; continue; }
      const k = (diffView ? Math.round(128 + tv * 127) : Math.round(tv * 255)) * 3;
      out.data[o] = table[k]; out.data[o + 1] = table[k + 1]; out.data[o + 2] = table[k + 2]; out.data[o + 3] = 255;
      if (showFlags && (flg[i] & data.bad_mask)) { out.data[o] = 255; out.data[o + 1] *= 0.4; out.data[o + 2] *= 0.4; }
    }
  }
  ctx.putImageData(out, 0, 0);
  drawOverlay();
}

/** Colour by time: first visit blue, middle green, last red, all on one brightness scale. */
function renderTimeColor() {
  const { data } = state, n = data.grid.n;
  const ch = timeColorChannels(state.images);
  if (!ch) return;
  const [lo, hi] = state.tcLevels, kind = els.stretch.value;
  const showFlags = els.flagView.checked, flg = frameFlags(0);
  const ctx = els.sky.getContext('2d'), out = ctx.createImageData(n, n);
  for (let y = 0; y < n; y++) {
    const row = n - 1 - y;
    for (let x = 0; x < n; x++) {
      const i = y * n + x, o = (row * n + x) * 4;
      for (const [k, c] of [[0, ch.r], [1, ch.g], [2, ch.b]]) {
        const v = stretchValue(c[i], lo, hi, kind);
        out.data[o + k] = Number.isNaN(v) ? 0 : Math.round(v * 255);
      }
      out.data[o + 3] = 255;
      if (showFlags && (flg[i] & data.bad_mask)) { out.data[o] = 255; out.data[o + 1] *= 0.4; out.data[o + 2] *= 0.4; }
    }
  }
  ctx.putImageData(out, 0, 0);
  drawOverlay();
}

// ------------------------------------------------------------------ before / after
const compareOn = () => state.compare && !isStack() && state.shown.length > 1;
const compareB = () => (state.idx === 0 ? state.shown.length - 1 : state.idx);
/** "2026-08", or "2026-08 → 09" for a visit that runs into the next month. */
const monthSpan = (f) => {
  const a = f.date_start.slice(0, 7), b = f.date_end.slice(0, 7);
  return a === b ? a : `${a} → ${a.slice(0, 4) === b.slice(0, 4) ? b.slice(5) : b}`;
};
const frameLabel = (i) => { const f = state.data.frames[i]; return `E${f.epoch} · ${monthSpan(f)}`; };

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
  // third value: canvas pixels per SPHEREx detector pixel, so rings and labels keep their size on the sky
  return [(x + 0.5) * k, (n - 1 - y + 0.5) * k, k * NATIVE_PX / state.data.grid.pixel_scale];
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
  if (els.showCands.checked) for (const [i, c] of state.cands.entries()) drawCandidate(ctx, c, i === state.selected);
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
    } else if (f.target_px) {                   // fast band: the engine's predicted spot (picture pixels, y down)
      x = f.target_px[0];
      y = n - 1 - f.target_px[1];
    } else if ((state.data.quick || state.data.sharp) && !state.target.pmra) {
      [x, y] = skyToPix(state.target.ra, state.target.dec, state.data.grid);   // its grid centre is snapped to ~7"
    }
  } else if ((state.data.quick || state.data.sharp) && !state.target.pmra) {
    [x, y] = skyToPix(state.target.ra, state.target.dec, state.data.grid);
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
  if (c.method === 'difference') {
    if (c.type === 'moving') return t('movingDescDiff', { rate: c.rate_arcsec_yr, err: c.rate_err, pa: c.pa_deg, sig: c.significance });
    if (c.type === 'variable') return t('variableDescDiff', { ratio: c.ratio ? c.ratio.toFixed(2) : '?', sig: c.significance });
    return t('transientDescDiff', { sig: c.significance });
  }
  if (c.type === 'moving') return t('movingDesc', { rate: c.rate_arcsec_yr, pa: c.pa_deg, sig: c.significance, n: c.points.length });
  if (c.type === 'variable') return t('variableDesc', { ratio: c.ratio, dets: c.detectors.map(d => 'D' + d.detector).join(', '), sig: c.significance });
  return t('transientDesc', { epoch: c.epoch, sig: c.significance });
}

function monthLabel(iso) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? String(iso).slice(0, 7)
    : d.toLocaleDateString(getLang() === 'tr' ? 'tr-TR' : 'en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function epochMonth(e, c = null) {
  // a tracker's find shown on the fast band still counts its visits in the all-detector frames
  const foreign = c && c.method === 'tracking' && c.grid !== state.data.grid && state.deepData?.frames;
  const f = (foreign ? state.deepData.frames : state.data.frames).find(fr => fr.epoch === e);
  return f ? monthLabel(f.date_start) : `E${e}`;
}

// Gaia DR3, SIMBAD and CatWISE2020 for one candidate: which could be asked, and what they list here
function catalogueHits(c) {
  const mjd = c.mjd ?? (c.points?.length ? c.points[0].mjd : currentMjd());
  const xm = (k) => (!ex.xm[k] ? 'wait' : ex.xm[k].ok ? 'ok' : 'fail');
  const g = catalogMatch(c);
  const states = { gaia: ex.gaiaState, simbad: xm('simbad'), catwise: xm('catwise') };
  const hits = { gaia: g && g !== 'unchecked' ? g : null };
  for (const k of ['simbad', 'catwise']) hits[k] = states[k] === 'ok' ? nearestAt(ex.xm[k].rows, c, mjd) : null;
  return { states, hits };
}

// The two visits a variable's card shows side by side: is the later one the brighter?
function candPair(c) {
  const fs = state.data.frames;
  if (c.type !== 'variable' || c.method === 'difference' || !state.images.length || fs.length > 60) return null;
  if (c.grid !== state.data.grid) return null;       // found in other data than the frames on screen: use its own numbers
  try {
    const { a, b } = candFrames(c);                              // a: fainter frame, b: brighter frame
    if (a === b) return null;
    const brighter = fs[b].mjd > fs[a].mjd;
    return { brighter, from: (brighter ? fs[a] : fs[b]).epoch, to: (brighter ? fs[b] : fs[a]).epoch };
  } catch { return null; }
}

function measureCand(c) {
  if (c.type !== 'moving') ex.tab = 'lightcurve';
  photAt(c.x, c.y).then(() => e4.analysis.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function renderCandidates() {
  const cands = state.data ? state.cands : [];
  const qd = state.qc?.data, band = state.quick?.quick.band;
  const NOTES = { few_movers: 'noteFewMovers', few_single: 'noteFewSingle', unmatched: 'noteUnmatched', one_pass: 'noteOnePass', failed: 'noteFailed' };
  const footnotes = (qd?.notes || []).filter(k => NOTES[k]).map(k => el('li', 'candnote small', t(NOTES[k])));
  // one of the two finders may still be at work (the all-detector read takes minutes)
  const waiting = state.deepBusy || Boolean(state.qc && !qd);
  els.candCount.textContent = state.data ? `(${cands.length})` : '';
  els.candRange.textContent = '';
  if (!state.data) { els.cands.replaceChildren(); return; }
  const fs = state.data.frames;
  const epochs = [...new Set(fs.map(f => f.epoch))].sort((a, b) => a - b);
  if (epochs.length > 1) els.candRange.textContent = t('fBetween', { a: monthLabel(fs[0].date_start), b: monthLabel(fs[fs.length - 1].date_start) });
  if (!cands.length) {
    els.cands.replaceChildren(el('li', 'muted small', t(waiting ? 'candsWait' : 'noCands')), ...footnotes);
    return;
  }
  if (waiting) footnotes.unshift(el('li', 'candnote small', t('candsWait')));
  els.cands.replaceChildren(...cands.map((c, i) => {
    const li = el('li', 'cand' + (i === state.selected ? ' on' : ''));
    const head = el('button', 'candhead');
    head.type = 'button';
    head.title = `${t(c.type)}: ${candText(c)}`;                 // the exact numbers stay one hover away
    const dot = el('span', 'dot');
    dot.style.background = COLORS[c.type];
    const hl = headline(c, epochs, candPair(c));
    const title = t(hl.key, { ...hl.vars, dir: hl.vars.dir ? t('dir_' + hl.vars.dir) : '' });
    const when = hl.from && hl.to && hl.from !== hl.to ? t('fBetween', { a: epochMonth(hl.from, c), b: epochMonth(hl.to, c) })
      : hl.from || hl.to ? epochMonth(hl.from || hl.to, c) : t('fPasses', { n: c.points?.length ?? epochs.length });
    const cl = clarity(c.significance);
    head.append(dot, el('b', '', title),
      el('span', 'candsub small', `${t(c.type)} · ${when}`),
      el('span', 'candsub small', t(cl.key, cl.vars)));
    head.onclick = () => { state.selected = state.selected === i ? null : i; renderCandidates(); drawOverlay(); };
    li.append(head);
    const known = catalogMatch(c);
    const { states, hits } = catalogueHits(c);
    const cat = catalogueStatus(c, states, hits);
    const notes = el('div', 'candnotes small');
    if (c.is_target) notes.append(el('span', 'tag', t('isTarget')));
    // which finder saw it: both agreeing is the strongest case
    notes.append(el('p', 'candhow', t(c.methods.length > 1 ? 'fBoth' : c.methods[0] === 'difference' ? 'fByDifference' : 'fByTracking', { b: band ?? '' })));
    if (c.also && c.type === 'moving' && c.also.rate_arcsec_yr) {
      notes.append(el('p', 'candhow mono', t('fAlsoDiff', { b: band ?? '', rate: c.also.rate_arcsec_yr.toFixed(2), err: (c.also.rate_err ?? 0).toFixed(2) })));
    } else if (c.also && c.type !== 'moving') {
      // the two finders look at different wavelengths, so they may see different changes: say both
      const ah = headline(onGrid({ ...c.also, grid: state.data.grid }, state.data.grid), epochs);
      notes.append(el('p', 'candhow', t('fAlsoDiffSays', { b: band ?? '', what: t(ah.key, ah.vars) })));
    }
    // the all-detector difference pictures (each visit minus the others) saw the tracker's find too
    if (c.found_by?.includes('difference') && c.methods.length < 2) { const tw = el('span', 'tag new', '✓✓ ' + t('twoWays')); tw.title = t('twoWaysTip'); notes.append(tw); }
    if (cat) {
      const line = el('p', 'candcat ' + cat.kind, t(cat.key, cat.vars));
      if (hits.gaia) line.title = t('knownGaia', { g: hits.gaia.g?.toFixed(1) ?? '?', pm: (Math.hypot(hits.gaia.pmra || 0, hits.gaia.pmdec || 0) / 1000).toFixed(2) });
      notes.append(line);
    }
    if (tooFast(c) || c.implausible) notes.append(el('p', 'candwarn', t('fTooFast')));
    if (c.low_confidence) notes.append(el('p', 'candwarn', t('fSaturated')));
    if (notes.childElementCount) li.append(notes);
    try { li.append(candVisual(c, known)); } catch (err) { console.warn('candidate visual', err); }
    const measure = el('button', 'btn sm', t('fMeasure'));
    measure.type = 'button';
    measure.onclick = () => measureCand(c);
    const rep = el('button', 'btn sm', t('copyReport'));
    rep.type = 'button';
    rep.onclick = async () => {
      try { await navigator.clipboard.writeText(candReport(c, known)); toast(t('copied')); }
      catch { toast(t('copyFail'), true); }
    };
    const btns = el('div', 'candbtns');
    btns.append(measure, rep);
    li.append(btns);
    if (i === state.selected) {
      const d = el('div', 'canddetail small');
      d.append(el('div', '', `${formatRA(c.ra)} ${formatDec(c.dec)}`));
      const a = el('a', '', t('simbad'));
      a.href = `https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${c.ra.toFixed(5)}+${c.dec >= 0 ? '%2B' : ''}${c.dec.toFixed(5)}&Radius=15&Radius.unit=arcsec`;
      a.target = '_blank';
      a.rel = 'noopener';
      const png = el('button', 'linkbtn', t('saveFinding'));
      png.type = 'button';
      png.onclick = () => saveFinding(c, known);
      const acts = el('div', 'candacts');
      acts.append(a, png);
      d.append(acts);
      li.append(d);
    }
    return li;
  }), ...footnotes);
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
  if (ex.gaiaState !== 'ok' || !state.data) return 'unchecked';
  const mjd = c.mjd ?? (c.points?.length ? c.points[0].mjd : currentMjd());
  return nearestAt(ex.gaia, c, mjd);                       // ~1 SPHEREx pixel; movers must move alike
}

function candReport(c, known) {
  const g = state.data.grid, fs = state.data.frames;
  const lines = [
    'Radians candidate report (NASA SPHEREx)',
    `Type: ${t(c.type)}: ${candText(c)}`,
    `Found by: ${(c.methods || ['tracking']).map(m => (m === 'tracking' ? 'following sources across visits (all detectors)' : `the wavelength-matched difference picture (band ${state.quick?.quick.band ?? '?'})`)).join(' and ')}`,
    ...(c.also && c.also.rate_arcsec_yr ? [`Difference picture: ${c.also.rate_arcsec_yr.toFixed(2)} +/- ${(c.also.rate_err ?? 0).toFixed(2)} "/yr towards PA ${c.also.pa_deg} deg`] : []),
    `Position (ICRS): ${formatRA(c.ra)} ${formatDec(c.dec)} = ${c.ra.toFixed(5)} ${c.dec.toFixed(5)} deg`,
    `Visits: ${fs.length}, ${fs[0].date_start.slice(0, 10)} to ${fs[fs.length - 1].date_end.slice(0, 10)}; detectors ${[...state.dets].sort().map(d => 'D' + d).join(' ')}`,
    `Field: ${formatRA(g.ra)} ${formatDec(g.dec)}, ${(g.fov / 60).toFixed(1)}' wide`,
    `Gaia DR3: ${known === 'unchecked' ? 'not checked' : known ? `source ${known.id}, G ${known.g?.toFixed(2)}, pm ${(Math.hypot(known.pmra || 0, known.pmdec || 0) / 1000).toFixed(3)}"/yr` : 'no match within 7" (G < 19)'}`,
    ...['simbad', 'catwise'].map((k) => {
      const { states, hits } = catalogueHits(c);
      return `${CAT_NAMES[k]}: ${states[k] !== 'ok' ? 'not checked' : hits[k] ? cleanId(hits[k].id) + (hits[k].type ? ` (${hits[k].type})` : '') : 'no match within 7"'}`;
    }),
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
  let k = ((i % N) + N) % N;
  if (k === 0 && skipsFirst()) k = i < state.idx ? N - 1 : 1;      // the reference visit has no picture of its own
  state.idx = k;
  els.scrub.value = state.idx;
  render();
  const tgt = state.target;
  let rows;
  if (isStack()) {
    const fs = data.frames;
    els.hudDate.textContent = `${fs[0].date_start.slice(0, 10)} → ${fs[fs.length - 1].date_end.slice(0, 10)}`;
    els.hudIdx.textContent = t(isTimeColor() ? 'timeLabel' : 'stackLabel', { n: fs.length });
    rows = [
      [t('kTarget'), tgt.name ? tgt.name.replace(/^NAME /, '') : t('coordinates')],
      [t('kExposures'), String(fs.reduce((s, f) => s + f.n_exposures, 0))],
    ];
    renderExposures(fs.flatMap(f => f.exposures || []));
  } else {
    const f = data.frames[state.idx];
    const sameDay = f.date_start.slice(0, 10) === f.date_end.slice(0, 10);
    els.hudDate.textContent = sameDay ? f.date_start.slice(0, 10) : `${f.date_start.slice(0, 10)} → ${f.date_end.slice(0, 10)}`;
    els.hudIdx.textContent = skipsFirst() ? t('minusFirst', { e: f.epoch, first: data.frames[0].epoch }) : `${state.idx + 1} / ${N}`;
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
  if (isMatched()) els.viewHelp.textContent = matchedHelp();
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
      : `E${f.epoch} · ${monthSpan(f)}${f.detectors.length === 1 ? ' D' + f.detectors[0] : ''}`);
    b.type = 'button';
    b.title = `${f.date_start} → ${f.date_end}`;
    b.onclick = () => { stop(); show(i); };
    if (i === 0 && skipsFirst()) { b.disabled = true; b.classList.add('ref'); b.title = t('refChip'); }
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
for (const e of [els.stretch, els.cmap, els.cross, els.flagView]) e.onchange = () => { syncRgb(); render(); syncUrl(true); };

// Pixels are drawn as hard squares by default: that is what was measured. "Smooth" lets the browser
// blend neighbouring pixels, which looks better when zoomed in and adds no information.
function setSmooth(on) {
  els.sky.classList.toggle('smooth', on);
  els.smooth.checked = on;
  save('radians-smooth', on ? '1' : '0');
}
els.smooth.onchange = () => setSmooth(els.smooth.checked);
setSmooth(saved('radians-smooth') === '1');
// one palette for the map, the blink and the sharpening view ('rgb' = the three-detector colour composite here)
els.cmap.addEventListener('change', () => setPalette(els.cmap.value));
document.addEventListener('radians:palette', () => {
  if (els.cmap.value !== viewerCmap()) { els.cmap.value = viewerCmap(); syncRgb(); render(); syncUrl(true); }
});
els.cmap.value = viewerCmap(getPalette());
for (const e of [els.lo, els.hi]) e.oninput = () => { computeLevels(); render(); };
els.view.onchange = () => {
  const was = state.playing;
  syncRgb();
  // the matched difference compares with the first visit: open on the last one, where the change is largest
  applyView(isMatched() && state.data ? state.data.frames.length - 1 : state.idx);
  if (was) play();
  syncUrl(true);
};

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
  const cands = state.cands;
  const rect = els.overlay.getBoundingClientRect();
  const n = state.data.grid.n;
  const x = (e.clientX - rect.left) / rect.width * n - 0.5;
  const y = n - 1 - ((e.clientY - rect.top) / rect.height * n - 0.5);
  let best = null, bd = 3 * NATIVE_PX / state.data.grid.pixel_scale;       // 3 detector pixels
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
  if (state.src === 'deep' || state.src === 'sharp') p.set('src', 'deep');
  else if (state.quick?.quick.band ?? state.band) p.set('band', state.quick?.quick.band ?? state.band);   // the band on screen
  if (els.view.value !== 'images') p.set('view', els.view.value);
  if (els.fps.value !== '2') p.set('fps', els.fps.value);
  if (els.stretch.value !== 'asinh') p.set('stretch', els.stretch.value);
  if (els.cmap.value !== 'gray') p.set('cmap', els.cmap.value);
  if (!els.wlMatch.checked) p.set('wl', '0');
  if (els.wlWin.value) { p.set('wlc', els.wlC.value); p.set('wlw', els.wlW.value); }
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
  if (state.data) { applyView(state.idx); renderCandidates(); renderAnalysis(); syncUrl(true); }
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
  if (s.wlc !== null) {
    const preset = [...els.wlWin.options].find(o => o.value && o.value !== 'custom' && Math.abs(Number(o.value) - s.wlc) < 1e-6);
    els.wlWin.value = preset ? preset.value : 'custom';
    els.wlC.value = s.wlc;
    if (s.wlw !== null) setSelect(els.wlW, s.wlw);
  }
  syncWlBox();
  setDets(s.det ? s.det.split(',').map(Number) : ALL_DETS);
  // links made before the fast band existed, and settings only the all-detector data has, open on it
  const deepOnly = s.src === 'deep' || (!s.src && s.band === null && Boolean(s.det || (s.mode && s.mode !== 'epoch') || s.wlc !== null || s.cmap === 'rgb'));
  const common = { fov: els.fov.value, mode: els.mode.value, frame: s.frame, autoplay: s.frame === null,
    src: deepOnly ? 'deep' : 'quick', band: s.band };
  if (s.ra !== null && s.dec !== null) run({ q: s.q, ra: s.ra, dec: s.dec, pmra: s.pmra, pmdec: s.pmdec, ...common });
  else if (s.q) run({ q: s.q, ...common });
}

els.search.onsubmit = (e) => {
  e.preventDefault();
  const q = els.q.value.trim();
  if (q) run({ q, fov: els.fov.value, mode: els.mode.value });
};
els.fov.onchange = () => requery();
els.mode.onchange = requeryDeep;
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
// a curated object chosen in the search suggestions: opened by its catalogue position and motion
document.addEventListener('radians:open', (e) => {
  const d = e.detail || {};
  if (!Number.isFinite(d.ra) || !Number.isFinite(d.dec)) return;
  setDets(ALL_DETS);
  run({ q: d.q, name: d.q, ra: d.ra, dec: d.dec, pmra: d.pmra || undefined, pmdec: d.pmdec || undefined, fov: els.fov.value, mode: els.mode.value });
});


// ================================================================== phase 4
// spectra and light curves, Gaia / SkyBoT overlays, Aladin Lite context
const ex = { phot: null, click: null, tab: 'spectrum', gaia: [], gaiaState: 'wait', xm: {}, sso: [], deep: null, photAbort: null, aladin: null };
const e4 = Object.fromEntries(['analysis', 'photSource', 'photMode', 'photFlagged', 'chart', 'chartNote', 'ovGaia', 'ovSso',
  'ovStatus', 'ctx', 'ctxGaia', 'ctxCatwise', 'aladin'].map(id => [id, $(id)]));
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
  // targets that change brightness instead of moving (R Dra): open on the light curve and say why
  const cur = state.target ? curated(state.target.ra, state.target.dec) : null;
  $('lookNote').hidden = cur?.look !== 'brightness';
  if (cur?.look === 'brightness') ex.tab = 'lightcurve';
  setPhot((state.deepData || state.data).exposures || [], null, (state.deepData || state.data).spot);
  loadCatalogues();
  if (e4.ctx.open) updateAladin();
}

// ------------------------------------------------------------------ photometry
function setPhot(points, click, spot = null) {
  ex.phot = points;
  ex.click = click;
  ex.spot = spot || null;                 // is a star there? ({state: 'star' | 'empty' | 'wing'}, from the server)
  const sat = points.filter(p => p.saturated).length;
  e4.photMode.value = sat > points.length / 2 && points.some(p => Number.isFinite(p.wing_ujy)) ? 'wings' : 'aperture';
  renderAnalysis();
  loadType();
}

// ------------------------------------------------------------------ spectral type box (under the spectrum)
const typeState = { seq: 0, res: null };

function drawType() {
  const box = $('typeBox');
  const show = !!typeState.res && ex.tab === 'spectrum' && !!ex.phot?.length;
  box.hidden = !show;
  if (show) renderTypeBox(box, typeState.res, t);
  curious.redraw();
}

// ------------------------------------------------------------------ "for the curious" tools (under the Type box)
const COMPASS = ['north', 'north_east', 'east', 'south_east', 'south', 'south_west', 'west', 'north_west'];

// what the tools work on: the spot being measured, its Gaia star, the SPHEREx mover there, its light curve
function curiousCtx() {
  if (!state.data || !state.target || ex.tab !== 'spectrum' || !(ex.phot?.length >= 12)) return null;
  const spot = typeSpot(), tg = state.target;
  const mjd = spot.mjd ?? currentMjd();
  const g = ex.gaia.find(s => String(s.id) === gaiaIdAt(spot));
  const reach = 2.5 * NATIVE_PX / state.data.grid.pixel_scale;                  // 2.5 detector pixels
  const near = (c) => (ex.click ? Math.hypot(c.x - ex.click.x, c.y - ex.click.y) < reach : c.is_target);
  const mover = state.cands.find(c => c.type === 'moving' && near(c));
  // motion to carry the star back to older surveys: Gaia's if it has one, else the target's own
  const pm = g ? [g.pmra || 0, g.pmdec || 0] : ex.click ? [0, 0] : [tg.pmra || 0, tg.pmdec || 0];
  // a line through the star's position in each pass of the fast band (the target, or the clicked star)
  const q = state.quick?.quick;
  let fitAt = null;
  if (q && q.state === 'ready') {
    fitAt = { id: q.id };
    if (ex.click) { const [gx, gy] = skyToPix(ex.click.ra, ex.click.dec, state.quick.grid); fitAt = { id: q.id, x: gx.toFixed(2), y: gy.toFixed(2) }; }
  }
  return { ra: spot.ra, dec: spot.dec, mjd, pmra: pm[0], pmdec: pm[1], gaiaId: g ? String(g.id) : null, fitAt,
    cand: mover ? { ...mover, dir: COMPASS[Math.round((((mover.pa_deg % 360) + 360) % 360) / 45) % 8] } : null,
    spot: ex.spot, wings: e4.photMode.value === 'wings',
    gaiaDown: ex.gaiaState !== 'ok',          // the field's Gaia list did not load: 'no Gaia star here' is then not known
    points: ex.phot.map(p => ({ mjd: p.mjd, wavelength: p.wavelength, value: valueOf(p),
      err: e4.photMode.value === 'wings' ? null : p.err_ujy, flagged: !!p.flagged, saturated: !!p.saturated })) };
}
const curious = createCurious($('curiousBox'), { t, ctx: curiousCtx });

// where the measured spectrum sits on the sky (a moving target: where it is at the middle of the visits)
function typeSpot() {
  if (ex.click) return { ra: ex.click.ra, dec: ex.click.dec, name: null };
  const tg = state.target, mjd = currentMjd();
  const dt = (mjd - 51544.5) / 365.25;
  return { ra: tg.ra + (tg.pmra || 0) * dt / 3.6e6 / Math.cos(tg.dec * Math.PI / 180), dec: tg.dec + (tg.pmdec || 0) * dt / 3.6e6,
    name: tg.name || null, mjd };
}

// the Gaia star at that spot (Gaia stars are moved to the date of the image); null if none within a pixel
function gaiaIdAt(spot) {
  const mjd = spot.mjd ?? currentMjd(), cosd = Math.cos(spot.dec * Math.PI / 180);
  let best = null, bd = 7;
  for (const s of ex.gaia) {
    const [ra, dec] = gaiaAt(s, mjd);
    const d = Math.hypot((ra - spot.ra) * cosd, dec - spot.dec) * 3600;
    if (d < bd) { bd = d; best = s; }
  }
  return best ? String(best.id) : null;
}

const gaiaReady = () => (ex.gaia.length ? Promise.resolve() : new Promise((res) => {
  const done = () => { document.removeEventListener('radians:catalogues', done); res(); };
  document.addEventListener('radians:catalogues', done);
  setTimeout(done, 8000);
}));

async function loadType() {
  const seq = ++typeState.seq;
  typeState.res = null;
  drawType();
  curious.reset();
  const pts = ex.phot || [];
  if (pts.length < 12 || !state.target) return;
  const data = state.data, spot = typeSpot();
  const body = { ra: spot.ra, dec: spot.dec, name: spot.name,
    points: pts.map(p => ({ wavelength: p.wavelength, flux_ujy: p.flux_ujy, err_ujy: p.err_ujy, saturated: !!p.saturated })) };
  const ask = async (extra) => {
    const r = await fetch(new URL('api/spectype', location.href), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, ...extra }) });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  };
  const live = () => seq === typeState.seq && state.data === data;
  try {
    const r = await ask({});                               // our own fit first: it does not wait for the catalogues
    if (!live()) return;
    typeState.res = { ...r, spot: ex.spot, pending: true };
    renderAnalysis();                                      // the box, and the matched curve on the spectrum
  } catch { return; }
  await gaiaReady();
  if (!live()) return;
  try {
    const r = await ask({ catalogues: true, gaia_id: gaiaIdAt(spot) });
    // the field's Gaia list did not load: 'no Gaia star here' is then not known, and the box says so
    if (ex.gaiaState !== 'ok' && r.catalogue?.gaia && !r.catalogue.gaia.found) r.catalogue.gaia = { ok: false };
    if (live()) { typeState.res = { ...r, spot: ex.spot }; renderAnalysis(); }
  } catch {
    if (live()) { typeState.res = { ...typeState.res, pending: false, catFail: true }; drawType(); }
  }
}

const SNAP_TO_STAR_PX = 3;      // all-detector pixels (18"): a click this close to a brighter star goes to it

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
  let px = bx, py = by;
  if (state.data !== state.deepData) {              // the fast band or the sharpened pictures: another grid
    if (!state.deepData?.grid) {
      const [ra, dec] = pixToSky(bx, by, state.data.grid);
      ex.click = { x: bx, y: by, ra, dec };
      renderAnalysis();
      drawOverlay();
      toast(t('needDeep'));
      return;
    }
    [px, py] = skyToPix(...pixToSky(bx, by, state.data.grid), state.deepData.grid).map(Math.round);
  }
  if (ex.photAbort) ex.photAbort.abort();
  const ctl = new AbortController();
  ex.photAbort = ctl;
  e4.analysis.hidden = false;
  e4.photSource.textContent = t('photLoading');
  try {
    let r = await api('api/photometry', { ...gridParams(), x: px, y: py }, ctl.signal);
    // a click on the slope of a star a few pixels away was meant for that star: measure it instead
    const off = r.spot?.state === 'wing' ? r.spot.offset : null;
    if (off && Math.hypot(off[0], off[1]) <= SNAP_TO_STAR_PX) {
      r = await api('api/photometry', { ...gridParams(), x: px + off[0], y: py + off[1] }, ctl.signal);
      [bx, by] = skyToPix(r.ra, r.dec, state.data.grid).map(Math.round);
    }
    setPhot(r.points, { x: bx, y: by, ra: r.ra, dec: r.dec }, r.spot);
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

/** The fast band's light curve at the spot being measured (the target, or the clicked star), from the
 * engine: a 5x5 box, or a halo ring when the star is saturated, each picture divided by the usual
 * brightness at its own wavelength. null while it is being measured. */
function engineLc() {
  const q = state.quick?.quick;
  if (!q || q.state !== 'ready') return { error: 'none' };
  let params = {};
  if (ex.click) {
    const [gx, gy] = skyToPix(ex.click.ra, ex.click.dec, state.quick.grid);
    params = { x: gx.toFixed(2), y: (state.quick.grid.n - 1 - gy).toFixed(2) };       // the engine counts rows from the top
  }
  const key = `${q.id}:${q.rev}:${params.x ?? 'target'}:${params.y ?? ''}`;
  if (ex.elc && ex.elc.key === key) return ex.elc.data;
  const elc = ex.elc = { key, data: null };
  api(`api/views/${q.id}/lightcurve`, params)
    .then((d) => { elc.data = d; })
    .catch((e) => { elc.data = { error: e.message }; })
    .finally(() => { if (ex.elc === elc) renderAnalysis(); });
  return null;
}

function drawEngineLc() {
  const lc = engineLc(), band = state.quick?.quick.band;
  if (!lc) { e4.chart.replaceChildren(el('p', 'muted small', t('elcLoading'))); e4.chartNote.textContent = ''; return; }
  const pts = (lc.points || []).filter(p => Number.isFinite(lc.mode === 'delta' ? p.delta : p.ratio));
  if (lc.error || !pts.length) { e4.chart.replaceChildren(el('p', 'muted small', t('elcNone'))); e4.chartNote.textContent = lc.message || ''; return; }
  const ratio = lc.mode !== 'delta';
  const byPass = new Map();
  for (const p of pts) { if (!byPass.has(p.pass)) byPass.set(p.pass, []); byPass.get(p.pass).push(p); }
  const dates = new Map((lc.dates || []).map(d => [d.index, d.start]));
  scatterChart(e4.chart, {
    series: [...byPass.keys()].sort((a, b) => a - b).map(k => ({
      name: `${t('epochN', { n: k + 1 })} · ${(dates.get(k) || '').slice(0, 7)}`, color: SERIES[k % SERIES.length],
      points: byPass.get(k).map(p => ({
        x: p.mjd, y: ratio ? p.ratio : p.delta, hollow: p.saturated,
        err: ratio && p.err && p.typical ? p.err / Math.abs(p.typical) : (ratio ? null : p.err),
        tip: [`${mjdDate(p.mjd)} · ${p.wave_um.toFixed(3)} µm`, ratio ? `× ${p.ratio.toFixed(3)}` : `${p.delta.toFixed(3)} ${lc.units}`],
      })),
    })),
    bands: state.data.quick ? visitBands() : undefined,
    xLabel: t('lcX'), yLabel: ratio ? t('elcYRatio') : t('elcYDelta', { u: lc.units }), refLine: ratio ? 1 : 0,
    xFmt: v => mjdDate(v).slice(0, 7), yFmt: v => v.toFixed(2),
  });
  e4.chartNote.textContent = t(lc.estimator === 'halo' ? 'elcNoteHalo' : 'elcNoteBox', { b: band });
}

function typeCurves() {
  const fit = typeState.res?.fit;
  if (!fit || ['empty', 'wing'].includes(typeState.res.spot?.state)) return [];      // no star there: nothing to match
  const pts = (c) => c.wave.map((w, i) => ({ x: w, y: c.flux[i] }));
  const out = [];
  if (fit.standards?.curve) out.push({ name: t('tyCurveStd', { type: fit.standards.type }), color: '#FFB347', points: pts(fit.standards.curve) });
  if (fit.model?.curve) out.push({ name: t('tyCurveModel', { teff: fit.model.teff }), color: '#6fc3ff', dash: '5 4', points: pts(fit.model.curve) });
  return out;
}

function renderAnalysis() {
  const havePhot = Boolean(ex.phot && ex.phot.length);
  const haveQuick = state.quick?.quick.state === 'ready';
  if (!state.data || (!havePhot && !haveQuick)) { e4.analysis.hidden = true; return; }
  e4.analysis.hidden = false;
  if (!havePhot) {
    // all six bands are still being read: the fast band's light curve is already there
    const tg0 = state.target;
    e4.photSource.textContent = ex.click
      ? t('photClicked', { pos: `${formatRA(ex.click.ra)} ${formatDec(ex.click.dec)}` })
      : `${t('photTarget', { name: tg0.name ? tg0.name.replace(/^NAME /, '') : t('coordinates') })} · ${t('clickHint')}`;
    for (const b of e4.analysis.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === 'lightcurve'));
    drawType();
    drawEngineLc();
    e4.chartNote.textContent = `${e4.chartNote.textContent} ${t('elcNeedDeep')}`.trim();
    return;
  }
  drawType();
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
      // what the Type box matched: the standard star (or brown-dwarf model) that fits best, scaled to the data
      lines: wings ? [] : typeCurves(),
      xLabel: t('specX'), yLabel: wings ? t('wingY') : t('specY'), xFmt: v => v.toFixed(1), yFmt,
    });
    e4.chartNote.textContent = (wings ? t('chartNoteWings') + ' ' : '') + t('chartNoteSpec');
  } else if (ex.tab === 'lightcurve' && e4.photMode.value === 'engine') {
    drawEngineLc();
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
$('lookLc').onclick = () => { ex.tab = 'lightcurve'; renderAnalysis(); e4.analysis.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
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
  ex.gaia = []; ex.sso = []; ex.gaiaState = 'wait'; ex.xm = {};
  e4.ovStatus.textContent = t('ovLoading');
  const rDeg = d.grid.fov / 3600 / Math.SQRT2;
  const centre = { ra: d.grid.ra.toFixed(6), dec: d.grid.dec.toFixed(6) };
  const live = () => state.data === d;
  api('api/gaia', { ...centre, radius: rDeg.toFixed(4) })
    .then(r => { if (live()) { ex.gaia = r.sources || []; ex.gaiaState = 'ok'; drawOverlay(); renderCandidates(); if (ex.aladin) setAladinCats(); document.dispatchEvent(new CustomEvent('radians:catalogues')); } })
    .catch(() => { if (live()) { ex.gaiaState = 'fail'; renderCandidates(); } });
  // SIMBAD and CatWISE2020 for the candidate cards, asked one by one so a slow one does not hold the other
  const xm = ex.xm;
  for (const k of ['simbad', 'catwise']) {
    const done = (v) => { if (live()) { xm[k] = v && Array.isArray(v.rows) ? v : { ok: false, rows: [] }; renderCandidates(); } };
    api('api/crossmatch', { ...centre, radius: rDeg.toFixed(4), cat: k }).then(r => done(r[k]), () => done(null));
  }
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

// ------------------------------------------------------------------ Aladin Lite context view

async function updateAladin() {
  if (!state.data || !state.data.grid) return;
  try {
    await loadAladin();
    const g = state.data.grid;
    if (!ex.aladin) {
      // the SPHEREx all-sky cube as its own first survey: nothing is asked from CDS
      ex.aladin = window.A.aladin('#aladin', { ...QUIET, survey: window.A.imageHiPS(CUBE_URL, { name: CUBE_NAME }),
        fov: g.fov / 3600 * 3, target: `${g.ra} ${g.dec}`,
        cooFrame: 'ICRS', showReticle: false, showFullscreenControl: true, showLayersControl: false });
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

// the wider view shows SPHEREx only: its all-sky cube, at the wavelength of the frame on screen
function setSurvey() {
  try {
    ex.hips = window.A.imageHiPS(CUBE_URL, { name: CUBE_NAME, successCallback: () => { ex.hipsSlice = null; syncCube(); } });
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
e4.ctxGaia.onchange = e4.ctxCatwise.onchange = () => ex.aladin && setAladinCats();

// ------------------------------------------------------------------ start
buildDetChips();
buildBandChips();
let startLang = parseState(location.search).lang;
try { startLang = startLang || localStorage.getItem('radians-lang'); } catch { /* private mode */ }
applyLang(startLang || 'en');
fromUrl();
window.radians = { state, ex };   // handle for debugging in the console


// ------------------------------------------------------------------ wavelength matching, zoom, GIF
els.wlMatch.onchange = () => { requeryDeep(); };

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
  const md = isMatched() && state.md && state.md.images ? state.md : null;
  const [lo, hi] = state.levels, kind = els.stretch.value;
  const px = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    const row = n - 1 - y;
    for (let x = 0; x < n; x++) {
      const tv = md ? matchedDiffValue(img[y * n + x], md.limit[i])
        : diffView ? stretchSigned(img[y * n + x], hi, kind) : stretchValue(img[y * n + x], lo, hi, kind);
      px[row * n + x] = Number.isNaN(tv) ? (md ? 128 : 0) : (diffView ? Math.round(128 + tv * 127) : Math.round(tv * 255));
    }
  }
  return px;
}

els.gif.onclick = () => {
  if (!state.data) return;
  const fileName = (state.target && (state.target.name || els.q.value) || 'radians').toString().replace(/[^\w.-]+/g, '-');
  if (isTimeColor()) {                              // one colour picture: a PNG, not a GIF
    els.sky.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${fileName}-colour-by-time.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(t('pngDone'));
    });
    return;
  }
  toast(t('gifMaking'));
  setTimeout(() => {
    const n = state.data.grid.n, k = Math.max(1, Math.floor(480 / n)), W = n * k;
    const table = isMatched() && state.md?.images ? lutBeforeNow() : isDiffView(els.view.value) ? lutDiverging() : lut(els.cmap.value);
    const count = isStack() ? 1 : state.shown.length;
    const frames = [];
    for (let i = skipsFirst() ? 1 : 0; i < count; i++) {
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
  if (!ex.hips || !ex.aladin || !state.data) return;
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


// ------------------------------------------------------------------ wavelength slice of the 102-band spectrum
function wlParams() {
  if (!els.wlWin.value) return {};
  const c = Number(els.wlC.value), w = Number(els.wlW.value);
  return { wl_min: (c - w / 2).toFixed(3), wl_max: (c + w / 2).toFixed(3) };
}
function syncWlBox() {
  els.wlBox.hidden = !els.wlWin.value;
  const p = wlParams();
  els.wlLab.textContent = p.wl_min ? t('wlLab', { lo: Number(p.wl_min).toFixed(2), hi: Number(p.wl_max).toFixed(2) }) : '';
}
els.wlWin.onchange = () => {
  if (els.wlWin.value && els.wlWin.value !== 'custom') els.wlC.value = els.wlWin.value;
  syncWlBox();
  requeryDeep();
};
els.wlC.oninput = () => { if (els.wlWin.value !== 'custom') els.wlWin.value = 'custom'; syncWlBox(); };
els.wlC.onchange = els.wlW.onchange = () => { syncWlBox(); requeryDeep(); };
syncWlBox();

// ------------------------------------------------------------------ colour composite (blue D1–D2, green D3–D4, red D5–D6)
const rgbWanted = () => els.cmap.value === 'rgb';
const rgbPossible = () => !isDiffView(els.view.value) && els.mode.value === 'epoch' && !state.data?.quick;
const rgbKey = () => JSON.stringify(state.params);
const rgbReady = () => rgbWanted() && rgbPossible() && state.rgb && state.rgb.key === rgbKey() && state.rgb.ch;

async function syncRgb() {
  els.rgbNote.hidden = !rgbWanted();
  if (rgbWanted() && state.data?.quick) { els.rgbNote.textContent = t('rgbNeedsDeep'); return; }
  if (!rgbWanted() || !state.data || !state.params) return;
  if (!rgbPossible()) { els.rgbNote.textContent = t(state.data.quick ? 'rgbNeedsDeep' : 'rgbNeeds'); return; }
  const key = rgbKey();
  if (state.rgb && state.rgb.key === key) { noteRgb(); return; }
  state.rgb = { key, ch: null };
  els.rgbNote.textContent = t('rgbLoading');
  try {
    // the per-visit, per-detector co-adds the server already makes (no extra IRSA reads)
    const d = await api('api/frames', { ...state.params, mode: 'epoch_detector', candidates: false });
    if (!state.rgb || state.rgb.key !== key) return;                   // the view changed meanwhile
    const frames = (d.frames || []).map(f => ({ epoch: f.epoch, detector: f.detector,
      image: decodeB64(f.image, Float32Array), variance: decodeB64(f.variance, Float32Array) }));
    state.rgb.ch = rgbChannels(frames);
    noteRgb();
    render();
  } catch (e) {
    if (e.name !== 'AbortError') { els.rgbNote.textContent = e.message; state.rgb = null; }
  }
}
function noteRgb() {
  const all = state.rgb && state.rgb.ch && state.rgb.ch.all;
  const missing = all ? Object.entries({ b: 'D1–D2', g: 'D3–D4', r: 'D5–D6' }).filter(([c]) => !all[c]).map(([, d]) => d) : [];
  els.rgbNote.textContent = missing.length ? `${t('rgbHelp')} ${t('rgbMissing', { c: missing.join(', ') })}` : t('rgbHelp');
}

function renderRgb() {
  const { data } = state, n = data.grid.n, ch = state.rgb.ch;
  const epochOf = (i) => (isStack() ? 'all' : (data.frames[i] || {}).epoch);
  const cmp = compareOn();
  const right = ch[epochOf(cmp ? compareB() : state.idx)] || ch.all;
  const left = cmp ? (ch[epochOf(0)] || ch.all) : right;
  const sx = cmp ? Math.round(state.split * n) : -1;
  // one set of levels per colour across every visit, so a colour change between visits is real
  const lv = {};
  for (const c of ['r', 'g', 'b']) {
    const arrs = Object.entries(ch).filter(([k, v]) => k !== 'all' && v[c]).map(([, v]) => v[c]);
    lv[c] = arrs.length ? percentiles(arrs, [Number(els.lo.value), Number(els.hi.value)]) : [0, 1];
  }
  const kind = els.stretch.value, showFlags = els.flagView.checked, flg = frameFlags(state.idx);
  const ctx = els.sky.getContext('2d'), out = ctx.createImageData(n, n);
  for (let y = 0; y < n; y++) {
    const row = n - 1 - y;
    for (let x = 0; x < n; x++) {
      const i = y * n + x, o = (row * n + x) * 4, src = x < sx ? left : right;
      for (const [k, c] of [[0, 'r'], [1, 'g'], [2, 'b']]) {
        const v = src[c] ? stretchValue(src[c][i], lv[c][0], lv[c][1], kind) : 0;
        out.data[o + k] = Number.isNaN(v) ? 0 : Math.round(v * 255);
      }
      out.data[o + 3] = 255;
      if (showFlags && flg && (flg[i] & data.bad_mask)) { out.data[o] = 255; out.data[o + 1] *= 0.4; out.data[o + 2] *= 0.4; }
    }
  }
  ctx.putImageData(out, 0, 0);
  drawOverlay();
}
// FITS of the visit on screen (or the stack): float32, MJy/sr, with the sky grid's WCS and the visit dates
$('fitsDl').onclick = () => {
  if (!state.data) return;
  const d = state.data, n = d.grid.n, i = isStack() ? 0 : state.idx;
  const img = isStack() ? stackImage(state.images, state.variances) : state.images[i];
  const f = isStack() ? null : d.frames[i];
  const cards = [];
  for (const [k, v] of Object.entries(d.grid.wcs || {})) {
    if (/^(NAXIS|SIMPLE|BITPIX|END)/.test(k) || v === null || typeof v === 'object') continue;
    cards.push([k.slice(0, 8), typeof v === 'number' ? v : String(v)]);
  }
  cards.push(['BUNIT', 'MJy/sr', 'surface brightness'], ['TELESCOP', 'SPHEREx'], ['ORIGIN', 'Radians (NASA/IPAC IRSA data)'],
    d.quick ? ['DETECTOR', 'D' + d.quick.band, 'fast band: median stack of one sky pass']
      : ['DETECTOR', [...state.dets].sort().map(x => 'D' + x).join(' ')]);
  if (f) cards.push(['EPOCH', f.epoch, 'visit number'], ['DATE-BEG', String(f.date_start || '').slice(0, 19)], ['DATE-END', String(f.date_end || '').slice(0, 19)]);
  else cards.push(['COMMENT', 'stack of all visits']);
  const bytes = fitsBytes(img, n, cards);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/fits' }));
  const nm = (els.q.value.trim() || 'spot').replace(/[^\w.-]+/g, '-');
  a.download = `radians-${nm}-${f ? 'E' + f.epoch : 'stack'}.fits`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(t('fitsDone'));
};
