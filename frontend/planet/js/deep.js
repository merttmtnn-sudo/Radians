// Closer than the all-sky map's own 13″ pixels, the planetarium can drape a sharper picture of the spot in
// the middle of the view: SPHEREx's exposures of it, drizzled onto 3″ pixels by the server (/api/sharp, see
// backend/app/sharp.py), with the ordinary 6″ stack one tap away for comparison.
import { lut } from './imaging.js';
import { pageLang } from './tr.js';
import { bandOf } from '/static/js/core/cube.js';
import { decodeB64, percentiles, stretchValue } from '/static/js/blink/sky.js';

const TR = pageLang() === 'tr';
const T = TR ? {
  offer: 'Bu yakınlıkta gök haritası yalnızca 13″ piksellerini büyütüyor.',
  go: d => `Süper çözünürlük yükle (D${d}, 3″)`,
  wait: d => `D${d} pozları IRSA’dan okunuyor… ilk kez bakılan bir yer 1–2 dakika sürer.`,
  load: (d, a, b) => `D${d} pozları okunuyor… ${a}/${b}`,
  shown: (n, f) => `Süper çözünürlük: ${n} SPHEREx pozu 3″ ızgarada birleştirildi (drizzle).`,
  native: n => `Normal yığın: ${n} poz, SPHEREx’in kendi 6″ pikselleri.`,
  before: 'Önce (6″)', after: 'Sonra (3″)', off: 'Kaldır', none: 'SPHEREx bu bantta burayı hiç çekmemiş.', fail: 'Okunamadı. Tekrar deneyin.',
  retry: 'Tekrar dene',
} : {
  offer: 'This close, the sky map only magnifies its 13″ pixels.',
  go: d => `Load super-resolution (D${d}, 3″)`,
  wait: d => `Reading D${d} exposures from IRSA… a spot nobody has read yet takes 1–2 minutes.`,
  load: (d, a, b) => `Reading D${d} exposures… ${a}/${b}`,
  shown: (n) => `Super-resolution: ${n} SPHEREx exposures combined on a 3″ grid (drizzle).`,
  native: n => `Ordinary stack: ${n} exposures on SPHEREx’s own 6″ pixels.`,
  before: 'Before (6″)', after: 'After (3″)', off: 'Remove', none: 'SPHEREx has no exposures of this spot in that band.', fail: 'Could not read it. Try again.',
  retry: 'Try again',
};
const DEEP_FOV = 0.8;   // degrees

export function createDeep({ sky, plane, cmap }) {
  const box = document.createElement('div');
  box.className = 'deepchip'; box.hidden = true; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite');
  box.innerHTML = `<span class="dtext"></span><span class="dbtns"><button type="button" class="btn small primary" data-a="go"></button>
    <span class="dseg" hidden><button type="button" class="btn small" data-a="before"></button><button type="button" class="btn small" data-a="after"></button></span>
    <button type="button" class="btn small ghost" data-a="off" hidden></button></span>`;
  document.getElementById('skyInfo').parentNode.appendChild(box);
  const st = { busy: false, data: null, view: 'after', det: null, done: 0, total: 0, err: '' };

  function fovDeg() { return sky.view.fov; }
  function render() {
    const show = fovDeg() < DEEP_FOV || st.busy || st.data || st.err;
    box.hidden = !show;
    if (!show) return;
    const det = bandOf(plane());
    const txt = st.busy ? (st.total ? T.load(st.det, st.done, st.total) : T.wait(st.det)) : st.err ? st.err
      : st.data ? (st.view === 'after' ? T.shown(st.data.count) : T.native(st.data.count)) : T.offer;
    box.querySelector('.dtext').textContent = txt;
    const go = box.querySelector('[data-a=go]');
    go.hidden = st.busy || (!!st.data && !st.err);
    go.textContent = st.err ? T.retry : T.go(det);
    box.querySelector('.dseg').hidden = !st.data || st.busy;
    box.querySelector('[data-a=before]').textContent = T.before;
    box.querySelector('[data-a=after]').textContent = T.after;
    box.querySelector('[data-a=before]').classList.toggle('primary', st.view === 'before');
    box.querySelector('[data-a=after]').classList.toggle('primary', st.view === 'after');
    const off = box.querySelector('[data-a=off]');
    off.hidden = !st.data || st.busy; off.textContent = T.off;
    box.classList.toggle('busy', st.busy);
  }
  // float image -> RGBA in the current palette, north up, transparent where there is no data
  function paint() {
    const d = st.data;
    if (!d) { sky.hips.setMosaic(null); sky.dirty = true; return; }
    const after = st.view === 'after';
    const n = after ? d.n : d.n_native, img = after ? d.img : d.nat;
    const [lo, hi] = d.range;
    const L = lut(cmap() === 'rgb' ? 'gray' : cmap());
    const rgba = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
      const row = n - 1 - y;
      for (let x = 0; x < n; x++) {
        const v = stretchValue(img[y * n + x], lo, hi, 'asinh');
        if (Number.isNaN(v)) continue;
        const k = Math.max(0, Math.min(255, Math.round(v * 255))) * 3, o = (row * n + x) * 4;
        rgba[o] = L[k]; rgba[o + 1] = L[k + 1]; rgba[o + 2] = L[k + 2]; rgba[o + 3] = 255;
      }
    }
    sky.hips.setMosaic({ rgba, n, ra0: d.ra, dec0: d.dec, scale: (after ? d.scale : d.native_scale) / 3600 });
    sky.dirty = true;
  }
  async function load() {
    if (st.busy) return;
    const W = sky.cv.clientWidth, H = sky.cv.clientHeight;
    const c = sky.screenToSky(W / 2, H / 2);
    if (!c) return;
    const fov = Math.round(Math.min(900, Math.max(180, fovDeg() * 3600 * 0.9)));
    Object.assign(st, { busy: true, det: bandOf(plane()), err: '', done: 0, total: 0 });
    render();
    const job = Math.random().toString(36).slice(2, 12);
    const poll = setInterval(async () => {
      try {
        const p = await (await fetch(`/api/progress?job=${job}`)).json();
        if (p.stage === 'read' && p.total) { st.done = p.done; st.total = p.total; render(); }
      } catch { /* cosmetic */ }
    }, 1500);
    try {
      const q = new URLSearchParams({ ra: c.ra.toFixed(5), dec: c.dec.toFixed(5), fov, det: st.det, factor: 2, job });
      const r = await fetch(`/api/sharp?${q}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(T.fail);
      if (!d.count) throw new Error(T.none);
      d.img = decodeB64(d.image, Float32Array); d.nat = decodeB64(d.native, Float32Array);
      d.range = percentiles([d.nat], [2, 99.8]);   // one stretch for both, so before/after compare fairly
      st.data = d; st.view = 'after';
      paint();
    } catch (e) {
      st.err = e.message || T.fail;
    } finally {
      clearInterval(poll);
      st.busy = false;
      render();
    }
  }
  box.addEventListener('click', e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'go') load();
    if (a === 'before' || a === 'after') { st.view = a; paint(); render(); }
    if (a === 'off') { st.data = null; st.err = ''; paint(); render(); }
  });
  let last = 0;
  return {
    tick() { const n = performance.now(); if (n - last > 300) { last = n; render(); } },
    recolor() { if (st.data) paint(); },
  };
}
