import {
  decodeB64, percentiles, stretchValue, lut, pixToSky, skyToPix, formatRA, formatDec, flagNames, parseState,
} from './sky.js';

const $ = (id) => document.getElementById(id);
const els = {
  form: $('search'), q: $('q'), fov: $('fov'), mode: $('mode'), go: $('go'),
  sky: $('sky'), overlay: $('overlay'), stage: $('stage'), empty: $('empty'),
  loading: $('loading'), loadingMsg: $('loadingMsg'), loadingSub: $('loadingSub'),
  play: $('play'), prev: $('prev'), next: $('next'), scrub: $('scrub'), fps: $('fps'), fpsVal: $('fpsVal'),
  timeline: $('timeline'), frameInfo: $('frameInfo'), cursor: $('cursor'),
  stretch: $('stretch'), cmap: $('cmap'), lo: $('lo'), hi: $('hi'), cross: $('cross'), flagView: $('flagView'),
  link: $('link'), copy: $('copy'), toast: $('toast'),
  hudDate: $('hudDate'), hudIdx: $('hudIdx'), hudScale: $('hudScale'),
};

const state = {
  data: null,        // /api/frames response
  target: null,      // {name, ra, dec, pmra, pmdec}
  images: [], flags: [],
  idx: 0, playing: false, timer: null,
  levels: [0, 1],
  abort: null,
};

// ------------------------------------------------------------------ API
async function api(path, params, signal) {
  const url = new URL(path, location.href);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) url.searchParams.set(k, v);
  const r = await fetch(url, { signal });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || `${r.status} ${r.statusText}`);
  return body;
}

// ------------------------------------------------------------------ loading
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
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { els.toast.hidden = true; }, isErr ? 7000 : 2500);
}

async function run(opts) {
  if (state.abort) state.abort.abort();
  const ctl = new AbortController();
  state.abort = ctl;
  stop();
  els.empty.hidden = true;
  const t0 = performance.now();
  const tick = setInterval(() => {
    const s = Math.round((performance.now() - t0) / 1000);
    els.loadingSub.textContent = s < 8 ? '' :
      `${s} s — the first look at a new patch of sky reads hundreds of SPHEREx exposures; after that it is cached.`;
  }, 1000);
  try {
    let target;
    if (opts.ra !== null && opts.dec !== null && opts.ra !== undefined) {
      target = { name: opts.q || null, ra: opts.ra, dec: opts.dec, pmra: opts.pmra, pmdec: opts.pmdec };
    } else {
      setLoading(true, `Finding “${opts.q}”…`);
      target = await api('api/resolve', { q: opts.q }, ctl.signal);
    }
    state.target = target;
    setLoading(true, 'Reading SPHEREx images from NASA IRSA…');
    const data = await api('api/frames', {
      ra: target.ra.toFixed(6), dec: target.dec.toFixed(6), fov: opts.fov, mode: opts.mode,
      pmra: target.pmra, pmdec: target.pmdec,
    }, ctl.signal);
    if (!data.frames || !data.frames.length) {
      els.empty.hidden = false;
      els.empty.innerHTML = `<p>${data.message || 'No SPHEREx images here yet.'}</p>`;
      return;
    }
    load(data, opts.frame ?? 0);
    syncUrl();
    if (opts.autoplay !== false) play();
  } catch (e) {
    if (e.name !== 'AbortError') {
      toast(e.message, true);
      if (!state.data) els.empty.hidden = false;
    }
  } finally {
    clearInterval(tick);
    if (state.abort === ctl) setLoading(false);
  }
}

// ------------------------------------------------------------------ frames
function load(data, startIdx) {
  state.data = data;
  const n = data.grid.n;
  state.images = data.frames.map(f => decodeB64(f.image, Float32Array));
  state.flags = data.frames.map(f => decodeB64(f.flags, Uint32Array));
  for (const c of [els.sky, els.overlay]) { c.width = n; c.height = n; }
  els.overlay.width = els.overlay.height = n * 8;          // sharper markers
  els.scrub.max = data.frames.length - 1;
  computeLevels();
  buildTimeline();
  els.hudScale.textContent = `${(data.grid.fov / 60).toFixed(1)}′ × ${(data.grid.fov / 60).toFixed(1)}′`;
  show(Math.min(Math.max(0, startIdx), data.frames.length - 1));
}

function computeLevels() {
  if (!state.images.length) return;
  // one set of levels for every frame, so brightness changes are real, not display artefacts
  state.levels = percentiles(state.images, [Number(els.lo.value), Number(els.hi.value)]);
}

function render() {
  const { data } = state;
  if (!data) return;
  const n = data.grid.n;
  const img = state.images[state.idx];
  const flg = state.flags[state.idx];
  const ctx = els.sky.getContext('2d');
  const out = ctx.createImageData(n, n);
  const table = lut(els.cmap.value);
  const [lo, hi] = state.levels;
  const kind = els.stretch.value;
  const showFlags = els.flagView.checked;
  for (let y = 0; y < n; y++) {
    const row = n - 1 - y;                                   // FITS y is up, canvas y is down
    for (let x = 0; x < n; x++) {
      const i = y * n + x, o = (row * n + x) * 4;
      const t = stretchValue(img[i], lo, hi, kind);
      if (Number.isNaN(t)) { out.data[o] = 30; out.data[o + 1] = 12; out.data[o + 2] = 40; out.data[o + 3] = 255; continue; }
      const k = Math.round(t * 255) * 3;
      out.data[o] = table[k]; out.data[o + 1] = table[k + 1]; out.data[o + 2] = table[k + 2]; out.data[o + 3] = 255;
      if (showFlags && (flg[i] & data.bad_mask)) { out.data[o] = 255; out.data[o + 1] *= 0.4; out.data[o + 2] *= 0.4; }
    }
  }
  ctx.putImageData(out, 0, 0);
  drawOverlay();
}

function drawOverlay() {
  const ctx = els.overlay.getContext('2d');
  const W = els.overlay.width, n = state.data.grid.n, k = W / n;
  ctx.clearRect(0, 0, W, W);
  if (!els.cross.checked || !state.target) return;
  // where the target should be at the mean time of this frame (proper motion included by the API)
  const f = state.data.frames[state.idx];
  const pts = state.data.exposures.filter(e => e.mjd >= f.mjd_start - 1e-6 && e.mjd <= f.mjd_end + 1e-6);
  let x = (n - 1) / 2, y = (n - 1) / 2;
  if (pts.length) {
    x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  }
  const cx = (x + 0.5) * k, cy = (n - 1 - y + 0.5) * k;
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

function show(i) {
  const { data } = state;
  if (!data) return;
  const N = data.frames.length;
  state.idx = ((i % N) + N) % N;
  els.scrub.value = state.idx;
  render();
  const f = data.frames[state.idx];
  const sameDay = f.date_start.slice(0, 10) === f.date_end.slice(0, 10);
  els.hudDate.textContent = sameDay ? f.date_start.slice(0, 10) : `${f.date_start.slice(0, 10)} → ${f.date_end.slice(0, 10)}`;
  els.hudIdx.textContent = `${state.idx + 1} / ${N}`;
  for (const [j, li] of [...els.timeline.children].entries()) li.firstChild.classList.toggle('on', j === state.idx);
  const wl = f.wavelength_min ? (f.wavelength_min === f.wavelength_max ? `${f.wavelength_min.toFixed(3)} µm`
    : `${f.wavelength_min.toFixed(2)}–${f.wavelength_max.toFixed(2)} µm`) : '—';
  const t = state.target;
  info(els.frameInfo, [
    ['Target', t.name ? t.name.replace(/^NAME /, '') : 'coordinates'],
    ['Centre', `${formatRA(data.grid.ra)} ${formatDec(data.grid.dec)}`],
    ['Epoch', `${f.epoch}`],
    ['Dates', `${f.date_start} → ${f.date_end} UTC`],
    ['Exposures', `${f.n_exposures}`],
    ['Detectors', f.detectors.map(d => 'D' + d).join(' ')],
    ['Wavelength', wl],
    ...(t.pmra ? [['Proper motion', `${(Math.hypot(t.pmra, t.pmdec) / 1000).toFixed(2)}″/yr (centre follows it)`]] : []),
  ]);
  syncUrl(true);
}

function info(dl, rows) {
  dl.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    if (v instanceof Node) dd.append(v); else dd.textContent = v;
    return [dt, dd];
  }));
}

function buildTimeline() {
  els.timeline.replaceChildren(...state.data.frames.map((f, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = state.data.frames.length > 12 ? `${i + 1}` : `E${f.epoch} · ${f.date_start.slice(0, 7)}${f.detectors.length === 1 ? ' D' + f.detectors[0] : ''}`;
    b.title = `${f.date_start} → ${f.date_end}`;
    b.onclick = () => { stop(); show(i); };
    li.append(b);
    return li;
  }));
}

// ------------------------------------------------------------------ playback
function play() {
  if (!state.data || state.data.frames.length < 2) return;
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
for (const el of [els.stretch, els.cmap, els.cross, els.flagView]) el.onchange = () => { render(); syncUrl(true); };
for (const el of [els.lo, els.hi]) el.oninput = () => { computeLevels(); render(); };

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input:not([type=range]), select, textarea')) return;
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
  const row = Math.floor((e.clientY - rect.top) / rect.height * n);
  const y = n - 1 - row;
  if (x < 0 || y < 0 || x >= n || y >= n) return;
  const [ra, dec] = pixToSky(x, y, data.grid);
  const i = y * n + x;
  const v = state.images[state.idx][i];
  const flags = flagNames(state.flags[state.idx][i], data.flag_bits, data.bad_mask);
  const fl = document.createElement('span');
  if (!flags.length) fl.textContent = 'none';
  for (const f of flags) {
    const s = document.createElement('span');
    s.className = 'flagname' + (f.bad ? ' bad' : '');
    s.textContent = f.name;
    fl.append(s);
  }
  info(els.cursor, [
    ['RA, Dec', `${formatRA(ra)} ${formatDec(dec)}`],
    ['Degrees', `${ra.toFixed(5)}, ${dec.toFixed(5)}`],
    ['Pixel', `${x}, ${y}`],
    ['Value', Number.isFinite(v) ? `${v.toFixed(4)} MJy/sr` : 'no data'],
    ['Flags', fl],
  ]);
});

// ------------------------------------------------------------------ URL state
function syncUrl(replace = false) {
  if (!state.target || !state.data) return;
  const p = new URLSearchParams();
  const t = state.target;
  if (els.q.value.trim()) p.set('q', els.q.value.trim());
  p.set('ra', t.ra.toFixed(6));
  p.set('dec', t.dec.toFixed(6));
  if (t.pmra) { p.set('pmra', t.pmra); p.set('pmdec', t.pmdec); }
  p.set('fov', els.fov.value);
  p.set('mode', els.mode.value);
  if (els.fps.value !== '2') p.set('fps', els.fps.value);
  if (els.stretch.value !== 'asinh') p.set('stretch', els.stretch.value);
  if (els.cmap.value !== 'gray') p.set('cmap', els.cmap.value);
  if (!state.playing && state.idx) p.set('frame', state.idx);
  if (document.body.classList.contains('embed')) p.set('embed', '1');
  const url = `${location.pathname}?${p}`;
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  els.link.value = location.origin + url;
}

els.copy.onclick = async () => {
  try { await navigator.clipboard.writeText(els.link.value); toast('Link copied'); }
  catch { els.link.select(); toast('Press Ctrl+C to copy'); }
};

function setSelect(sel, v) {
  if (v === null || v === undefined) return;
  const s = String(v);
  if (![...sel.options].some(o => o.value === s)) sel.add(new Option(s, s));
  sel.value = s;
}

function fromUrl() {
  const s = parseState(location.search);
  document.body.classList.toggle('embed', s.embed);
  if (s.q) els.q.value = s.q;
  else if (s.ra !== null && s.dec !== null) els.q.value = `${s.ra} ${s.dec}`;
  if (s.fov) setSelect(els.fov, s.fov);
  if (s.mode) setSelect(els.mode, s.mode);
  if (s.fps) { els.fps.value = s.fps; els.fpsVal.textContent = s.fps; }
  if (s.stretch) setSelect(els.stretch, s.stretch);
  if (s.cmap) setSelect(els.cmap, s.cmap);
  if (s.ra !== null && s.dec !== null) {
    run({ q: s.q, ra: s.ra, dec: s.dec, pmra: s.pmra, pmdec: s.pmdec, fov: els.fov.value, mode: els.mode.value,
      frame: s.frame, autoplay: s.frame === null });
  } else if (s.q) {
    run({ q: s.q, fov: els.fov.value, mode: els.mode.value, frame: s.frame, autoplay: s.frame === null });
  }
}

// ------------------------------------------------------------------ search
els.form.onsubmit = (e) => {
  e.preventDefault();
  const q = els.q.value.trim();
  if (q) run({ q, fov: els.fov.value, mode: els.mode.value });
};
// changing FOV or frame mode re-queries the same target
for (const el of [els.fov, els.mode]) el.onchange = () => {
  if (state.target) run({ q: els.q.value.trim(), ...state.target, fov: els.fov.value, mode: els.mode.value });
};
$('examples').onclick = (e) => {
  const b = e.target.closest('button[data-q]');
  if (!b) return;
  els.q.value = b.dataset.q;
  if (b.dataset.fov) setSelect(els.fov, b.dataset.fov);
  run({ q: b.dataset.q, fov: els.fov.value, mode: els.mode.value });
};
window.addEventListener('popstate', fromUrl);

fromUrl();
export { skyToPix };   // used by later overlays
