// "Sharpening": how the image of a patch of sky gets cleaner as more SPHEREx exposures are piled up.
// Live while the exposures are read (co-add of what has arrived, from /api/progress), then a slider over
// co-adds of the first 1, 2, 4 ... all exposures in time order (/api/depth), with four companion views:
// noise vs exposures, stars above 5 sigma, what is left to clean up (this step minus the final image) and
// how many exposures cover each pixel.
import { decodeB64, percentiles, stretchValue, stretchSigned, lutDiverging, lut } from './sky.js';
import { viewerCmap } from './palette.js';
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);
const el = Object.fromEntries(['depth', 'depthSky', 'depthHud', 'depthScrub', 'depthPlay', 'depthN', 'depthStatus',
  'depthNoise', 'depthNoiseNote', 'depthStars', 'depthStarsNote', 'depthDiff', 'depthDiffNote', 'depthCov', 'depthCovNote']
  .map(id => [id, $(id)]));
const NS = 'http://www.w3.org/2000/svg';
const D = { live: [], liveImg: null, steps: null, imgs: [], n: 0, idx: 0, timer: null, ctl: null, levels: [0, 1], cov: null, maxCov: 0 };
const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : Number(v.toPrecision(d + 1)).toString());

// ------------------------------------------------------------------ drawing
function drawImage(cv, img, n, lo, hi) {
  cv.width = cv.height = n;
  const ctx = cv.getContext('2d');
  const out = ctx.createImageData(n, n);
  const table = lut(viewerCmap());
  for (let y = 0; y < n; y++) {
    const row = n - 1 - y;                                   // FITS y is up, canvas y is down
    for (let x = 0; x < n; x++) {
      const o = (row * n + x) * 4, v = stretchValue(img[y * n + x], lo, hi, 'asinh');
      if (Number.isNaN(v)) { out.data[o] = 30; out.data[o + 1] = 12; out.data[o + 2] = 40; out.data[o + 3] = 255; continue; }
      const k = Math.round(v * 255) * 3;
      out.data[o] = table[k]; out.data[o + 1] = table[k + 1]; out.data[o + 2] = table[k + 2];
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
}

function drawDiff(cv, a, b, n, lim) {
  cv.width = cv.height = n;
  const ctx = cv.getContext('2d');
  const out = ctx.createImageData(n, n);
  const table = lutDiverging();
  for (let y = 0; y < n; y++) {
    const row = n - 1 - y;
    for (let x = 0; x < n; x++) {
      const i = y * n + x, o = (row * n + x) * 4, v = stretchSigned(a[i] - b[i], lim, 'linear');
      if (Number.isNaN(v)) { out.data[o] = 30; out.data[o + 1] = 12; out.data[o + 2] = 40; out.data[o + 3] = 255; continue; }
      const k = Math.round(128 + v * 127) * 3;
      out.data[o] = table[k]; out.data[o + 1] = table[k + 1]; out.data[o + 2] = table[k + 2]; out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
}

function drawCoverage(cv, cov, n, max) {
  cv.width = cv.height = n;
  const ctx = cv.getContext('2d');
  const out = ctx.createImageData(n, n);
  let min = max;
  for (const c of cov) if (c > 0 && c < min) min = c;
  const span = Math.max(1, max - min * 0.8);              // stretch the range actually present, keep 0 dark
  for (let y = 0; y < n; y++) {
    const row = n - 1 - y;
    for (let x = 0; x < n; x++) {
      const c = cov[y * n + x], o = (row * n + x) * 4, f = c ? Math.min(1, (c - min * 0.8) / span) : 0;
      // one hue, dark -> light: the site's amber accent
      out.data[o] = 14 + f * (255 - 14); out.data[o + 1] = 12 + f * (179 - 12); out.data[o + 2] = 10 + f * (71 - 10);
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
}

function svg(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

/** Small chart against the number of exposures (log axis). pts: [{x, y}], cur: x of the highlighted point. */
function miniChart(host, { pts, cur, logY, ideal, yFmt, tip }) {
  host.replaceChildren();
  const ok = pts.filter(p => p.y != null && Number.isFinite(p.y) && p.y > (logY ? 0 : -Infinity));
  if (ok.length < 1) return;
  const W = 260, H = 120, m = { l: 34, r: 8, t: 8, b: 20 };
  const xMax = Math.max(2, ...ok.map(p => p.x));
  const ys = ok.map(p => p.y).concat(ideal ? ok.map(p => ideal(p.x)) : []);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (!logY) y0 = 0;
  if (y0 === y1) { y1 = y0 + 1; }
  const ly = v => (logY ? Math.log10(v) : v);
  const X = x => m.l + Math.log10(x) / Math.log10(xMax) * (W - m.l - m.r);
  const Y = v => H - m.b - (ly(v) - ly(y0)) / (ly(y1) - ly(y0) || 1) * (H - m.t - m.b);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': tip }, host);
  const ax = svg('g', { class: 'dax' }, root);
  svg('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }, ax);
  for (const x of [1, 10, 100, 1000].filter(x => x <= xMax)) {
    svg('line', { x1: X(x), x2: X(x), y1: m.t, y2: H - m.b, class: 'grid' }, ax);
    svg('text', { x: X(x), y: H - 6, 'text-anchor': 'middle' }, ax).textContent = x;
  }
  for (const v of [y0, y1]) svg('text', { x: m.l - 5, y: Y(v) + 3, 'text-anchor': 'end' }, ax).textContent = yFmt(v);
  if (ideal) {
    const d = [];
    for (let k = 0; k <= 30; k++) { const x = xMax ** (k / 30); d.push(`${k ? 'L' : 'M'}${X(x).toFixed(1)},${Y(ideal(x)).toFixed(1)}`); }
    svg('path', { d: d.join(''), class: 'ideal' }, root);
  }
  svg('path', { d: ok.map((p, k) => `${k ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(''), class: 'meas' }, root);
  for (const p of ok) {
    const c = svg('circle', { cx: X(p.x), cy: Y(p.y), r: p.x === cur ? 5 : 3, class: p.x === cur ? 'cur' : 'pt' }, root);
    svg('title', {}, c).textContent = `${p.x} ${t('depthExp')}: ${yFmt(p.y)}`;
  }
}

// ------------------------------------------------------------------ live (while reading)
export function depthStart() {
  stopPlay();
  D.ctl?.abort();
  D.live = []; D.steps = null; D.imgs = []; D.liveImg = null;
  el.depth.hidden = false;
  el.depth.classList.add('live');
  el.depthScrub.disabled = true; el.depthPlay.disabled = true;
  el.depthScrub.value = 0;
  el.depthN.textContent = '';
  el.depthStatus.textContent = t('depthWaiting');
  el.depthHud.textContent = '';
  for (const k of ['depthNoise', 'depthStars', 'depthNoiseNote', 'depthStarsNote', 'depthDiffNote', 'depthCovNote']) el[k].replaceChildren();
  for (const k of ['depthSky', 'depthDiff', 'depthCov']) { el[k].width = el[k].height = 1; }
}

export function depthLive(p) {
  if (!p || !p.image || D.steps || D.live.at(-1)?.count === p.count) return;
  const n = p.n, img = decodeB64(p.image, Float32Array);
  D.live.push({ count: p.count, noise: p.noise, stars: p.stars });
  const [lo, hi] = percentiles([img], [5, 99.7]);
  drawImage(el.depthSky, img, n, lo, hi);
  el.depthHud.textContent = t('depthLiveHud', { n: p.count });
  el.depthStatus.textContent = t('depthLive');
  const first = D.live[0];
  miniChart(el.depthNoise, { pts: D.live.map(s => ({ x: s.count, y: s.noise })), cur: p.count, logY: true,
    ideal: first.noise ? x => first.noise * Math.sqrt(first.count / x) : null, yFmt: v => fmt(v), tip: t('depthNoise') });
  miniChart(el.depthStars, { pts: D.live.map(s => ({ x: s.count, y: s.stars })), cur: p.count, logY: false,
    yFmt: v => String(Math.round(v)), tip: t('depthStars') });
  el.depthStarsNote.textContent = t('depthStarsNow', { a: first.stars, b: p.stars });
}

export function depthHide() {
  stopPlay();
  D.ctl?.abort();
  el.depth.hidden = true;
}

// ------------------------------------------------------------------ steps (after reading)
export async function depthLoad(params, api) {
  D.ctl?.abort();
  const ctl = new AbortController();
  D.ctl = ctl;
  el.depthStatus.textContent = t('depthBuilding');
  try {
    const r = await api('api/depth', params, ctl.signal);
    if (ctl.signal.aborted) return;
    if (!r.steps || !r.steps.length) { depthHide(); return; }
    D.steps = r.steps; D.n = r.n;
    D.imgs = r.steps.map(s => {
      const q = decodeB64(s.image, Int16Array), f = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) f[i] = q[i] === -32768 ? NaN : q[i] * r.scale;
      return f;
    });
    D.cov = decodeB64(r.coverage, Uint16Array);
    D.maxCov = r.max_coverage;
    D.total = r.total;
    const fin = D.imgs.at(-1);
    D.levels = percentiles([fin], [5, 99.7]);
    el.depth.classList.remove('live');
    el.depthScrub.disabled = false; el.depthPlay.disabled = false;
    el.depthScrub.max = D.steps.length - 1;
    el.depthStatus.textContent = t('depthReady', { first: r.first_date.slice(0, 10), last: r.last_date.slice(0, 10) });
    drawCoverage(el.depthCov, D.cov, D.n, D.maxCov);
    let edge = Infinity;
    for (let y = 0; y < D.n; y += D.n - 1) for (let x = 0; x < D.n; x++) edge = Math.min(edge, D.cov[y * D.n + x]);
    el.depthCovNote.textContent = t('depthCovNote', { max: D.maxCov, min: Number.isFinite(edge) ? edge : 0 });
    const s0 = D.steps[0], sN = D.steps.at(-1);
    document.dispatchEvent(new CustomEvent('radians:depth', { detail: {
      total: r.total, stars1: s0.stars, starsN: sN.stars,
      gain: s0.noise && sN.noise ? s0.noise / sN.noise : null, ideal: Math.sqrt(sN.n_exposures / s0.n_exposures),
    } }));
    showStep(0);
    play();
  } catch (e) {
    if (e.name !== 'AbortError') el.depthStatus.textContent = t('depthError');
  }
}

function showStep(i) {
  if (!D.steps) return;
  D.idx = i;
  el.depthScrub.value = i;
  const s = D.steps[i], s0 = D.steps[0], sN = D.steps.at(-1), n = D.n;
  drawImage(el.depthSky, D.imgs[i], n, D.levels[0], D.levels[1]);
  el.depthHud.textContent = t('depthHud', { n: s.n_exposures, date: s.date.slice(0, 10) });
  const gain = s0.noise && s.noise ? s0.noise / s.noise : null;
  el.depthN.textContent = t('depthCount', { n: s.n_exposures, total: D.total, gain: gain ? gain.toFixed(1) : '—' });
  const pts = D.steps.map(st => ({ x: st.n_exposures, y: st.noise }));
  miniChart(el.depthNoise, { pts, cur: s.n_exposures, logY: true,
    ideal: s0.noise ? x => s0.noise * Math.sqrt(s0.n_exposures / x) : null, yFmt: v => fmt(v), tip: t('depthNoise') });
  el.depthNoiseNote.textContent = t('depthNoiseNote', { gain: gain ? gain.toFixed(1) : '—',
    ideal: Math.sqrt(s.n_exposures / s0.n_exposures).toFixed(1) });
  miniChart(el.depthStars, { pts: D.steps.map(st => ({ x: st.n_exposures, y: st.stars })), cur: s.n_exposures,
    logY: false, yFmt: v => String(Math.round(v)), tip: t('depthStars') });
  el.depthStarsNote.textContent = t('depthStarsNow', { a: s0.stars, b: s.stars });
  // what this step still has that the final image does not: the noise that more exposures will average out
  drawDiff(el.depthDiff, D.imgs[i], D.imgs.at(-1), n, 3 * (s0.noise || 1));
  el.depthDiffNote.textContent = i === D.steps.length - 1 ? t('depthDiffLast')
    : t('depthDiffNote', { x: s.noise && sN.noise ? (s.noise / sN.noise).toFixed(1) : '—' });
}

function play() {
  stopPlay();
  if (!D.steps) return;
  el.depthPlay.textContent = '❚❚';
  el.depthPlay.setAttribute('aria-label', t('depthPause'));
  if (D.idx >= D.steps.length - 1) showStep(0);
  D.timer = setInterval(() => {
    if (D.idx >= D.steps.length - 1) { stopPlay(); return; }
    showStep(D.idx + 1);
  }, 900);
}
function stopPlay() {
  clearInterval(D.timer);
  D.timer = null;
  el.depthPlay.textContent = '▶';
  el.depthPlay.setAttribute('aria-label', t('depthPlay'));
}

el.depthPlay.onclick = () => (D.timer ? stopPlay() : play());
el.depthScrub.oninput = () => { stopPlay(); showStep(Number(el.depthScrub.value)); };
document.addEventListener('radians:lang', () => { if (D.steps) showStep(D.idx); });
document.addEventListener('radians:palette', () => { if (D.steps) showStep(D.idx); });
