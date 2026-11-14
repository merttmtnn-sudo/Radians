// Application shell: tabs, global search, shared target, planetarium UI, URL state, keyboard shortcuts.
import { $, $$, el, esc, toast, bus, state, fmtRA, fmtDec, fmtDeg, fmtHours, parseCoordPair, readUrl, writeUrl, api, download,
  TEST_TARGETS, clamp, D2R, R2D, mod } from './util.js';
import * as A from './astro.js';
import { Sky, GREEK, DSO_TYPES } from './sky.js';
import { Blink } from './blink.js';
import { Spectro } from './spectro.js';
import { aboutHtml } from './about.js';
import { lut } from './imaging.js';
import { spherexSource, urlSource } from './hips.js';
import { pageLang } from './tr.js';

const sky = new Sky($('#skyCanvas'), $('#skyGL'));
const blink = new Blink();
const spectro = new Spectro();
window.spx = { sky, blink, spectro, state }; // handy for debugging from the console
// embed=1: shown inside the Radians page, which draws its own simple controls (see bottom of this file)
const EMBED = new URLSearchParams(location.search).get('embed') === '1';
if (EMBED) document.body.classList.add('embed');

// ------------------------------------------------------------------ tabs
let view = 'sky';
function show(v) {
  if (v === 'spectro') { v = 'blink'; openDock('spec'); } // old links
  if (v === 'survey') v = 'sky';
  view = v;
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  sky.visible = v === 'sky';
  if (v === 'sky') { sky.resize(); sky.dirty = true; sky.fieldBox = blink.center ? { ...blink.center, size: blink.size } : null; }
  if (v === 'blink') { blink.layout(); spectro.plot.draw(); spectro.lc.draw(); }
  const p = readUrl(); p.set('view', v); writeUrl(Object.fromEntries(p));
}
$$('.tab').forEach(b => (b.onclick = () => show(b.dataset.view)));

// ------------------------------------------------------------------ spectrum dock (inside Time-Lapse)
const dock = $('#dock');
function openDock(tab) {
  dock.classList.remove('collapsed'); $('#dockToggle').textContent = '▾';
  if (tab) { $$('.dock-tab').forEach(b => b.classList.toggle('on', b.dataset.dock === tab)); $$('.dock-pane').forEach(p => p.classList.toggle('on', p.dataset.pane === tab)); }
  requestAnimationFrame(() => { blink.layout(); spectro.plot.draw(); spectro.lc.draw(); });
}
$$('.dock-tab').forEach(b => (b.onclick = () => openDock(b.dataset.dock)));
$('#dockToggle').onclick = () => { const c = dock.classList.toggle('collapsed'); $('#dockToggle').textContent = c ? '▴' : '▾'; requestAnimationFrame(() => blink.layout()); };
{
  let drag = null;
  $('#dockHandle').addEventListener('pointerdown', e => { drag = { y: e.clientY, h: dock.getBoundingClientRect().height }; e.target.setPointerCapture(e.pointerId); });
  $('#dockHandle').addEventListener('pointermove', e => {
    if (!drag) return;
    const stage = $('#blinkStage').getBoundingClientRect();
    const h = clamp(drag.h - (e.clientY - drag.y), 40, stage.height - 240);
    dock.style.height = h + 'px'; dock.classList.toggle('collapsed', h <= 42);
    blink.layout();
  });
  $('#dockHandle').addEventListener('pointerup', () => { drag = null; spectro.plot.draw(); spectro.lc.draw(); });
}
bus.on('spectrum-start', () => openDock('spec'));

// ------------------------------------------------------------------ SPHEREx sky panel
let WAVES = [];
const wl = f => (WAVES[f] ? WAVES[f].toFixed(3) + ' µm' : 'frame ' + f) + (f === 50 || f === 51 ? ' (blank)' : '');
api('/api/sx/hips-properties').then(p => { WAVES = (p.data_cube_crval3_arr || '').split(/\s+/).map(Number); updateSpxLabels(); }).catch(() => {});
function spxFrames() { return $('#hxMode').value === 'mono' ? [+$('#hxFrame').value] : [+$('#hxR').value, +$('#hxG').value, +$('#hxB').value]; }
function updateSpxLabels() {
  $('#hxWave').textContent = wl(+$('#hxFrame').value);
  $('#hxWaveR').textContent = wl(+$('#hxR').value); $('#hxWaveG').textContent = wl(+$('#hxG').value); $('#hxWaveB').textContent = wl(+$('#hxB').value);
  $('#hxWaveC').textContent = wl(+$('#hxCmpFrame').value);
  const mono = $('#hxMode').value === 'mono';
  $('#hxMonoBox').classList.toggle('hidden', !mono); $('#hxRgbBox').classList.toggle('hidden', mono);
  const f = spxFrames();
  $('#hudSpherex').textContent = sky.layers.spherex ? `SPHEREx DR1 infrared sky · ${mono ? wl(f[0]) : `R ${wl(f[0])} · G ${wl(f[1])} · B ${wl(f[2])}`}` +
    (sky.hips.cmp ? `  ⇄ ${$('#hxCmp').selectedOptions[0].textContent}` : '') : '';
}
let spxTimer;
function applySpx(debounce = 0) {
  updateSpxLabels();
  clearTimeout(spxTimer);
  spxTimer = setTimeout(() => {
    if (!sky.hips.ok) return;
    sky.hips.setBase(spherexSource(spxFrames()));
    sky.hips.setLut(lut($('#hxCmap').value));
    Object.assign(sky.hips.opts, { gain: +$('#hxGain').value, gamma: +$('#hxGamma').value, black: +$('#hxBlack').value });
    const c = $('#hxCmp').value;
    $('#hxCmpBox').classList.toggle('hidden', !c);
    $('#hxCmpFrameL').classList.toggle('hidden', c !== 'spx');
    const fade = $('#hxCmpMode').value === 'fade';
    $('#hxMixL').classList.toggle('hidden', !fade); $('#hxBlinkL').classList.toggle('hidden', fade);
    if (!c) sky.hips.setCompare(null);
    else if (c === 'spx') sky.hips.setCompare(spherexSource([+$('#hxCmpFrame').value]));
    else { const [path, order, ext] = c.split('|'); sky.hips.setCompare(urlSource('https://irsa.ipac.caltech.edu/data/hips/' + path, +order, ext)); }
    sky.blinkCmp = c && !fade ? +$('#hxBlinkP').value : 0;
    if (c && fade) sky.hips.opts.mix = +$('#hxMix').value;
    if (!c) sky.hips.opts.mix = 0;
    updateSpxLabels();
    sky.dirty = true;
    saveSpx();
  }, debounce);
}
const SPX_IDS = ['hxMode', 'hxFrame', 'hxCmap', 'hxR', 'hxG', 'hxB', 'hxGain', 'hxGamma', 'hxBlack', 'hxCmp', 'hxCmpFrame', 'hxCmpMode', 'hxMix', 'hxBlinkP'];
function saveSpx() { try { localStorage.setItem('spx.hips2', JSON.stringify(Object.fromEntries(SPX_IDS.map(id => [id, $('#' + id).value])))); } catch (_) { /* ignore */ } }
const SPX_DEFAULTS = Object.fromEntries(SPX_IDS.map(id => [id, $('#' + id).value]));
try { const s = JSON.parse(localStorage.getItem('spx.hips2') || 'null'); if (s) for (const id of SPX_IDS) if (s[id] !== undefined) $('#' + id).value = s[id]; } catch (_) { /* ignore */ }
$('#hxReset').onclick = () => { for (const id of ['hxGain', 'hxGamma', 'hxBlack']) $('#' + id).value = SPX_DEFAULTS[id]; applySpx(); };
for (const id of SPX_IDS) $('#' + id).addEventListener(id.match(/hx(Frame|R|G|B|CmpFrame)$/) ? 'input' : 'change', () => applySpx(id.match(/hx(Frame|R|G|B|CmpFrame)$/) ? 250 : 0));
for (const id of ['hxGain', 'hxGamma', 'hxBlack', 'hxMix']) $('#' + id).addEventListener('input', () => {
  Object.assign(sky.hips.opts, { gain: +$('#hxGain').value, gamma: +$('#hxGamma').value, black: +$('#hxBlack').value });
  if (id === 'hxMix' && $('#hxCmpMode').value === 'fade') sky.hips.opts.mix = +$('#hxMix').value;
  sky.dirty = true;
});
$$('[data-rgb]').forEach(b => (b.onclick = () => { const [r, g, bl] = b.dataset.rgb.split(','); $('#hxMode').value = 'rgb'; $('#hxR').value = r; $('#hxG').value = g; $('#hxB').value = bl; applySpx(); }));
function stepWave(d) {
  const id = $('#hxMode').value === 'mono' ? 'hxFrame' : 'hxG';
  let f = +$('#' + id).value + d; if (f === 50 || f === 51) f += d;
  $('#' + id).value = clamp(f, 0, 101); applySpx(150);
}
if (!sky.hips.ok) toast('WebGL2 is not available in this browser — showing the planetarium without SPHEREx imagery', true, 8000);
applySpx();

// catalog overlays (loaded around the view centre when zoomed in)
const CAT_IDS = { hxGaia: 'gaia', hxAllwise: 'allwise', hx2mass: '2mass', hxSimbad: 'simbad' };
for (const [id, cat] of Object.entries(CAT_IDS)) $('#' + id).addEventListener('change', e => { sky.catOn[cat] = e.target.checked; lastCat = null; sky.dirty = true; });
for (const [id, cat] of Object.entries(CAT_IDS)) sky.catOn[cat] = $('#' + id).checked;
let lastCat = null, catBusy = false;
async function updateCatalogs() {
  if (catBusy || sky.view.fov > 3 || !Object.values(sky.catOn).some(Boolean)) return;
  const c = sky.screenToSky(sky.cv.clientWidth / 2, sky.cv.clientHeight / 2);
  if (!c) return;
  const rad = Math.min(0.5, Math.max(0.05, sky.view.fov * 0.75));
  if (lastCat && Math.hypot((c.ra - lastCat.ra) * Math.cos(c.dec * D2R), c.dec - lastCat.dec) < lastCat.rad / 3 && rad <= lastCat.rad * 1.3) return;
  catBusy = true;
  lastCat = { ra: c.ra, dec: c.dec, rad };
  try {
    await Promise.all(Object.entries(sky.catOn).filter(([, on]) => on).map(async ([cat]) => {
      const url = cat === 'simbad' ? `/api/sx/simbad?ra=${c.ra.toFixed(5)}&dec=${c.dec.toFixed(5)}&sr=${rad.toFixed(3)}`
        : `/api/sx/catalog?cat=${cat}&ra=${c.ra.toFixed(5)}&dec=${c.dec.toFixed(5)}&radius=${rad.toFixed(3)}`;
      try { sky.catalogs[cat] = (await api(url)).rows; } catch (e) { toast(`${cat} catalog unavailable: ${e.message}`, true); }
    }));
  } finally { catBusy = false; sky.dirty = true; }
}
let lastCatCheck = 0;
bus.on('skyframe', () => { const n = performance.now(); if (n - lastCatCheck > 700) { lastCatCheck = n; updateCatalogs(); } });

// ------------------------------------------------------------------ location / time panels
const LOCATIONS = [
  ['Istanbul, Türkiye', 41.0082, 28.9784, 40], ['Ankara, Türkiye', 39.9334, 32.8597, 938], ['İzmir, Türkiye', 38.4237, 27.1428, 20],
  ['TÜBİTAK National Observatory (Antalya)', 36.8244, 30.3353, 2500], ['Eastern Anatolia Observatory (Erzurum)', 39.7808, 41.2328, 3170],
  ['Caltech / IPAC, Pasadena', 34.1377, -118.1253, 240], ['Mauna Kea, Hawaiʻi', 19.8207, -155.4681, 4205], ['Cerro Paranal, Chile', -24.6272, -70.4042, 2635],
  ['Roque de los Muchachos, La Palma', 28.7606, -17.8816, 2396], ['Greenwich, UK', 51.4769, -0.0005, 46], ['Sydney, Australia', -33.8688, 151.2093, 30],
  ['North Pole', 90, 0, 0], ['Equator (0°, 0°)', 0, 0, 0],
];
const locSel = $('#locPreset');
LOCATIONS.forEach((l, i) => locSel.append(el('option', { value: i }, l[0])));
locSel.append(el('option', { value: 'custom' }, 'Custom…'));
function setLocation(name, lat, lon, elev) {
  sky.loc = { name, lat: +lat, lon: +lon, elev: +elev || 0 };
  $('#locLat').value = lat; $('#locLon').value = lon; $('#locElev').value = elev;
  sky.dirty = true;
  try { localStorage.setItem('spx.loc', JSON.stringify(sky.loc)); } catch (_) { /* storage blocked */ }
}
locSel.onchange = () => { const l = LOCATIONS[+locSel.value]; if (l) setLocation(...l); };
$('#locApply').onclick = () => { setLocation('Custom location', clamp(+$('#locLat').value, -90, 90), mod(+$('#locLon').value + 180, 360) - 180, +$('#locElev').value); locSel.value = 'custom'; };
$('#locGeo').onclick = () => {
  if (!navigator.geolocation) return toast('Geolocation not available', true);
  navigator.geolocation.getCurrentPosition(p => { setLocation('My location', +p.coords.latitude.toFixed(4), +p.coords.longitude.toFixed(4), Math.round(p.coords.altitude || 0)); locSel.value = 'custom'; toast('Location set'); },
    e => toast('Could not get location: ' + e.message, true));
};
try { const l = JSON.parse(localStorage.getItem('spx.loc') || 'null'); if (l) setLocation(l.name, l.lat, l.lon, l.elev); else setLocation(...LOCATIONS[0]); } catch (_) { setLocation(...LOCATIONS[0]); }
{ const i = LOCATIONS.findIndex(l => l[0] === sky.loc.name); locSel.value = i >= 0 ? i : 'custom'; }

const toLocalInput = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
$('#timeApply').onclick = () => { const v = $('#timeInput').value; if (v) sky.setDate(new Date(v)); };
$('#timeNow').onclick = () => { sky.setDate(new Date()); sky.setRate(1); };
$$('[data-speed]').forEach(b => (b.onclick = () => { const s = b.dataset.speed; if (s === 'slower') sky.slower(); else if (s === 'faster') sky.faster(); else if (s === 'pause') sky.togglePause(); else sky.setRate(1); }));
$$('[data-jump]').forEach(b => (b.onclick = () => {
  const j = b.dataset.jump;
  const sec = j === 'sidereal' ? 86164.0905 : j === 'year' ? 365.25 * 86400 : +j;
  sky.setDate(new Date(sky.simMs + sec * 1000));
}));
function rateText(r) {
  if (r === 0) return 'paused';
  if (r === 1) return 'real time';
  const a = Math.abs(r), dir = r < 0 ? '◀ ' : '';
  const s = a >= 86400 ? (a / 86400).toFixed(a >= 864000 ? 0 : 1) + ' days/s' : a >= 3600 ? (a / 3600).toFixed(1) + ' h/s' : a >= 60 ? (a / 60).toFixed(1) + ' min/s' : a + '×';
  return dir + s;
}
bus.on('skytime', () => { $('#speedLabel').textContent = 'Speed: ' + rateText(sky.rate); $('#timeInput').value = toLocalInput(sky.date); });

// ------------------------------------------------------------------ view options
const bindOpt = (id, key, conv = v => v, ev = 'change') => {
  const e = $('#' + id);
  e.addEventListener(ev, () => { sky.opt[key] = conv(e.type === 'checkbox' ? e.checked : e.value); sky.dirty = true; saveOpts(); if (key === 'bortle') $('#optBortleV').textContent = e.value; });
};
bindOpt('optBortle', 'bortle', Number, 'input'); bindOpt('optStarScale', 'starScale', Number, 'input'); bindOpt('optMagBoost', 'magBoost', Number, 'input');
bindOpt('optLang', 'lang'); bindOpt('optRefraction', 'refraction'); bindOpt('optTwinkle', 'twinkle'); bindOpt('optStarLabels', 'starLabels');
bindOpt('optDsoLabels', 'dsoLabels'); bindOpt('optTargets', 'targets'); bindOpt('optTrack', 'track');
$('#optProj').onchange = e => { sky.view.proj = e.target.value; sky.dirty = true; saveOpts(); };
$('#optMount').onchange = e => { sky.setMount(e.target.value); saveOpts(); };
bus.on('trackoff', () => { $('#optTrack').checked = false; });
function saveOpts() { try { localStorage.setItem('spx.sky2', JSON.stringify({ opt: sky.opt, layers: sky.layers, proj: sky.view.proj })); } catch (_) { /* ignore */ } }
try {
  const s = JSON.parse(localStorage.getItem('spx.sky2') || 'null');
  if (s) { Object.assign(sky.opt, s.opt, { track: false }); Object.assign(sky.layers, s.layers); sky.view.proj = s.proj || 'stereo'; }
} catch (_) { /* ignore */ }
$('#optBortle').value = sky.opt.bortle; $('#optBortleV').textContent = sky.opt.bortle; $('#optStarScale').value = sky.opt.starScale; $('#optMagBoost').value = sky.opt.magBoost;
$('#optLang').value = sky.opt.lang; $('#optProj').value = sky.view.proj;
for (const [id, k] of [['optRefraction', 'refraction'], ['optTwinkle', 'twinkle'], ['optStarLabels', 'starLabels'], ['optDsoLabels', 'dsoLabels'], ['optTargets', 'targets']]) $('#' + id).checked = sky.opt[k];

// toolbar
function syncLayerButtons() { $$('[data-layer]').forEach(b => b.classList.toggle('on', !!sky.layers[b.dataset.layer])); }
function toggleLayer(k) { sky.layers[k] = !sky.layers[k]; sky.dirty = true; syncLayerButtons(); saveOpts(); if (k === 'spherex') updateSpxLabels(); }
$$('[data-layer]').forEach(b => (b.onclick = () => toggleLayer(b.dataset.layer)));
syncLayerButtons();
$$('[data-panel]').forEach(b => (b.onclick = () => { const p = $('#' + b.dataset.panel); p.classList.toggle('hidden'); if (b.dataset.panel === 'panelTime') bus.emit('skytime'); }));
$$('[data-close]').forEach(b => (b.onclick = () => b.closest('.panel').classList.add('hidden')));
const actions = {
  slower: () => sky.slower(), faster: () => sky.faster(), pause: () => sky.togglePause(), now: () => { sky.setDate(new Date()); sky.setRate(1); },
  zoomIn: () => sky.zoom(1 / 1.4), zoomOut: () => sky.zoom(1.4), center: () => sky.selection && sky.centerOn(sky.selection),
  night: () => { document.body.classList.toggle('night'); $('[data-act=night]').classList.toggle('on', document.body.classList.contains('night')); },
  fullscreen: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()),
  shot: () => {
    sky.render(performance.now());
    const c = document.createElement('canvas'); c.width = sky.W; c.height = sky.H;
    const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
    if (sky.imageryOn()) x.drawImage($('#skyGL'), 0, 0);
    x.drawImage(sky.cv, 0, 0);
    c.toBlob(b => download(`spherex_sky_${sky.date.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`, b));
  },
};
$$('[data-act]').forEach(b => (b.onclick = () => actions[b.dataset.act]()));

// ------------------------------------------------------------------ HUD
function hud() {
  const d = sky.date;
  const tz = -d.getTimezoneOffset() / 60;
  $('#hudTime').textContent = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 8)} (UTC${tz >= 0 ? '+' : ''}${tz})  ·  ${rateText(sky.rate)}`;
  $('#hudLoc').textContent = `${sky.loc.name} · ${fmtDeg(sky.loc.lat, 0)} ${fmtDeg(sky.loc.lon, 0)} · ${sky.loc.elev} m`;
  const ss = sky.ss;
  $('#hudFov').textContent = `FOV ${sky.view.fov < 1 ? (sky.view.fov * 60).toFixed(1) + '′' : sky.view.fov.toFixed(1) + '°'} · limiting mag ${sky.limMag?.toFixed(1)}` +
    (ss ? ` · Sun ${ss.sunAlt.toFixed(1)}°` : '');
}
let lastInfo = 0;
bus.on('skyframe', () => { hud(); const now = performance.now(); if (sky.selection && now - lastInfo > 500) { lastInfo = now; renderInfo(sky.selection); } });

// ------------------------------------------------------------------ info panel
const fmtLocal = jd => { if (!jd) return '—'; const d = new Date((jd - 2440587.5) * 86400000); return d.toTimeString().slice(0, 5); };
function bodyFn(id) { return jd => A.solarSystem(jd).find(b => b.id === id); }
function renderInfo(o) {
  if (EMBED) return renderCard(o);
  const box = $('#skyInfo');
  if (!o) { box.classList.add('hidden'); return; }
  const pos = sky.objectPos(o);
  if (!pos) return;
  let title = '', type = '', extra = [];
  if (o.type === 'star') {
    const names = sky.starName(o.i);
    title = names[0]; type = 'Star';
    if (names.length > 1) extra.push(['Designations', names.slice(1).join(' · ')]);
    extra.push(['Magnitude (V)', sky.smag[o.i].toFixed(2)], ['Color index B−V', sky.sbv[o.i].toFixed(2)]);
  } else if (o.type === 'body') {
    const b = pos;
    title = sky.opt.lang === 'tr' ? `${b.tr} (${b.name})` : b.name; type = b.kind === 'planet' ? (b.id === 'pluto' ? 'Dwarf planet' : 'Planet') : b.kind === 'moon' ? 'Natural satellite' : 'Star';
    extra.push(['Magnitude', b.mag.toFixed(2)], ['Apparent diameter', b.diam * 3600 < 120 ? (b.diam * 3600).toFixed(1) + '″' : (b.diam * 60).toFixed(2) + '′']);
    if (b.id === 'moon') extra.push(['Distance', Math.round(b.distKm).toLocaleString() + ' km'], ['Phase', `${A.moonPhaseName(b)} · ${(b.illum * 100).toFixed(0)}% lit`]);
    else extra.push(['Distance', `${b.dist.toFixed(4)} AU · light time ${(b.dist * 8.3167).toFixed(1)} min`]);
    if (b.kind === 'planet') extra.push(['Illuminated', (b.illum * 100).toFixed(1) + '%'], ['Phase angle', b.phaseAngle.toFixed(1) + '°'], ['Sun distance', b.rsun.toFixed(3) + ' AU']);
  } else if (o.type === 'dso') {
    const d = o.d;
    title = d.id + (d.alt ? ' — ' + d.alt : ''); type = DSO_TYPES[d.type] || 'Deep-sky object';
    if (d.desig) extra.push(['Designation', d.desig]);
    extra.push(['Magnitude', isFinite(d.mag) ? d.mag : '—'], ['Size', (d.dim || '—') + '′']);
  } else if (o.type === 'cat') {
    title = o.t.name; type = o.t.type;
    if (isFinite(o.t.mag)) extra.push([`Magnitude (${o.t.band})`, o.t.mag.toFixed(2)]);
    if (o.t.pmra || o.t.pmdec) extra.push(['Proper motion', `${o.t.pmra.toFixed(1)}, ${o.t.pmdec.toFixed(1)} mas/yr`]);
    if (o.t.plx) extra.push(['Parallax', o.t.plx.toFixed(2) + ' mas']);
  } else if (o.type === 'target') {
    title = o.t.name; type = o.t.type || 'SPHEREx target';
    if (o.t.pmra || o.t.pmdec) extra.push(['Proper motion', `${(o.t.pmra / 1000).toFixed(3)}″/yr, ${(o.t.pmdec / 1000).toFixed(3)}″/yr`]);
    if (o.t.plx) extra.push(['Parallax', `${o.t.plx.toFixed(1)} mas · ${(1000 / o.t.plx * 3.2616).toFixed(1)} ly`]);
    if (o.t.note) extra.push(['Note', o.t.note]);
  } else { title = 'Sky position'; type = 'Selected point'; }
  const v = A.radec2v(pos.ra, pos.dec);
  const [raD, decD] = A.v2radec(A.mulv(A.precessionMatrix(sky.jdNow), v));
  const h = sky.refract(A.mulv(sky.M, v));
  const [alt, az] = A.hor2altaz(h);
  const ha = mod(A.gmst(sky.jdNow) + sky.loc.lon - raD, 360) / 15;
  const con = sky.constellationAt(pos.ra, pos.dec);
  const h0 = o.type === 'body' ? (o.b.id === 'sun' ? -0.833 : o.b.id === 'moon' ? 0.125 : -0.5667) : -0.5667;
  const rts = A.riseTransitSet(o.type === 'body' ? bodyFn(o.b.id) : () => pos, sky.jdNow, sky.loc.lat, sky.loc.lon, h0);
  const rows = [
    ...extra,
    ['RA/Dec (J2000)', `${fmtRA(pos.ra, 2)} / ${fmtDec(pos.dec, 1)}`],
    ['RA/Dec (of date)', `${fmtRA(raD, 2)} / ${fmtDec(decD, 1)}`],
    ['Hour angle', fmtHours(ha) + ' h'],
    ['Az/Alt (apparent)', `${fmtDeg(az, 0)} / ${fmtDeg(alt, 0)}`],
    ['Constellation', con ? `${con.n[sky.opt.lang] || con.name} (${con.id})` : '—'],
    ['Rise · Transit · Set', rts.circumpolar ? `Circumpolar · transit ${fmtLocal(rts.transit)}` : rts.neverRises ? 'Does not rise today' : `${fmtLocal(rts.rise)} · ${fmtLocal(rts.transit)} · ${fmtLocal(rts.set)}`],
    ['Max altitude', rts.maxAlt.toFixed(1) + '°'],
  ];
  box.innerHTML = `<h2>${esc(title)}</h2><div class="type">${esc(type)}</div><table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${esc(b)}</td></tr>`).join('')}</table>
    <div class="actions"><button class="btn small" data-a="center">Center</button><button class="btn small" data-a="target">Set as target</button>
    <button class="btn small primary" data-a="blink">SPHEREx time-lapse</button><button class="btn small" data-a="spec">SPHEREx spectrum</button><button class="btn small" data-a="zoom">Zoom in</button>
    <button class="btn small" data-a="radians">Radians blink ↗</button>
    <button class="btn small ghost" data-a="close">✕</button></div>`;
  box.classList.remove('hidden');
  box.querySelectorAll('[data-a]').forEach(b => (b.onclick = () => infoAction(b.dataset.a, o, pos, title)));
}
function targetFrom(o, pos, title) {
  if (o.type === 'target') return o.t;
  if (o.type === 'cat') return { name: o.t.name, ra: o.t.ra, dec: o.t.dec, pmra: o.t.pmra || 0, pmdec: o.t.pmdec || 0, plx: o.t.plx || 0, epoch: o.t.epoch || 2000, type: o.t.type };
  return { name: o.type === 'point' ? 'Sky position' : title, ra: pos.ra, dec: pos.dec, type: o.type };
}
function infoAction(a, o, pos, title) {
  if (a === 'close') { sky.select(null); return renderInfo(null); }
  if (a === 'center') return sky.centerOn(o);
  if (a === 'radians') {
    const tr = document.documentElement.lang === 'tr' ? '&lang=tr' : '';
    window.open(`/?ra=${pos.ra.toFixed(5)}&dec=${pos.dec.toFixed(5)}${tr}`, '_blank', 'noopener');
    return;
  }
  if (a === 'zoom') { sky.lookAt(pos.ra, pos.dec, true, Math.max(0.15, sky.view.fov / 8)); return; }
  if (o.type === 'body' && a !== 'target') return toast('Solar-system objects move too fast for fixed-position SPHEREx stacks; use IRSA MOST for moving-object searches.', true, 6000);
  state.setTarget(targetFrom(o, pos, title), 'sky');
  if (a === 'blink') { show('blink'); blink.load(); }
  if (a === 'spec') { show('blink'); openDock('spec'); spectro.run(); }
  if (a === 'target') toast('Target set: ' + title);
}
bus.on('skyselect', o => renderInfo(o));
bus.on('skyhover', p => {
  const tip = $('#skyHover');
  if (!p) return tip.classList.add('hidden');
  const o = sky.pick(p.x, p.y);
  if (!o) return tip.classList.add('hidden');
  const name = o.type === 'star' ? sky.starName(o.i)[0] : o.type === 'body' ? (sky.opt.lang === 'tr' ? o.b.tr : o.b.name) : o.type === 'dso' ? o.d.id + (o.d.alt ? ' ' + o.d.alt : '') : o.t.name;
  tip.textContent = name; tip.style.left = p.x + 14 + 'px'; tip.style.top = p.y + 10 + 'px'; tip.classList.remove('hidden');
});

// ------------------------------------------------------------------ search
let index = [];
function buildIndex() {
  index = [];
  const add = (label, sub, kind, data, keys = []) => index.push({ label, sub, kind, data, keys: [label, ...keys].map(k => k.toLowerCase()) });
  for (const t of TEST_TARGETS) add(t.name, 'Challenge test target · ' + t.type, 'test', t, [t.id, 'wise 0855', 'wise j0855'].filter((_, i) => i === 0 || t.id === 'wise0855'));
  for (const b of A.solarSystem(sky.jd)) add(b.name, (b.tr !== b.name ? b.tr + ' · ' : '') + 'Solar system', 'body', b.id, [b.tr]);
  for (const c of sky.cons) add(c.name, `Constellation (${c.id})` + (c.n.tr && c.n.tr !== c.name ? ' · ' + c.n.tr : ''), 'cons', c, [c.id, ...Object.values(c.n)]);
  for (const d of sky.dsos) add(d.id + (d.alt ? ' — ' + d.alt : ''), DSO_TYPES[d.type] || 'Deep-sky object', 'dso', d, [d.desig, d.alt].filter(Boolean));
  for (const [hip, n] of Object.entries(sky.starNames)) {
    const i = sky.hipIndex.get(+hip);
    if (i === undefined) continue;
    const des = n[1] ? `${n[1]} ${n[3]}` : n[2] ? `${n[2]} ${n[3]}` : '';
    if (!n[0] && !des) continue;
    const keys = [des, 'hip ' + hip];
    if (n[1]) keys.push(`${GREEK[n[1][0]] || n[1]}${n[1].slice(1)} ${n[3]}`);
    const c = sky.consById[n[3]];
    if (n[1] && c) keys.push(`${GREEK[n[1][0]] || n[1]} ${c.gen}`);
    add(n[0] || des, `Star · ${des ? des + ' · ' : ''}HIP ${hip} · mag ${sky.smag[i].toFixed(1)}`, 'star', i, keys);
  }
}
function searchLocal(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  const coord = parseCoordPair(q);
  if (coord) out.push({ label: `${fmtRA(coord.ra, 1)} ${fmtDec(coord.dec, 0)}`, sub: 'Go to coordinates (J2000)', kind: 'coord', data: coord });
  const hm = q.match(/^hip\s*(\d+)$/);
  if (hm && sky.hipIndex.has(+hm[1])) { const i = sky.hipIndex.get(+hm[1]); out.push({ label: 'HIP ' + hm[1], sub: `Star · mag ${sky.smag[i].toFixed(1)}`, kind: 'star', data: i }); }
  const scored = [];
  for (const e of index) {
    let s = 99;
    for (const k of e.keys) { if (k === q) s = Math.min(s, 0); else if (k.startsWith(q)) s = Math.min(s, 1 + k.length / 100); else if (k.includes(q)) s = Math.min(s, 3); }
    if (s < 99) scored.push([s + (e.kind === 'star' ? 0.05 : 0), e]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  out.push(...scored.slice(0, 12).map(x => x[1]));
  out.push({ label: `Search SIMBAD/NED for “${q}”`, sub: 'CDS Sesame name resolver (online)', kind: 'sesame', data: q });
  return out;
}
const sIn = $('#globalSearch'), sRes = $('#searchResults');
let results = [], selIdx = 0;
function renderResults() {
  sRes.innerHTML = '';
  results.forEach((r, i) => {
    const it = el('div', { class: 'item' + (i === selIdx ? ' sel' : '') }, el('span', {}, r.label), el('span', { class: 'k' }, r.sub));
    it.onmousedown = e => { e.preventDefault(); choose(r); };
    sRes.append(it);
  });
  sRes.classList.toggle('hidden', !results.length);
}
sIn.addEventListener('input', () => { results = searchLocal(sIn.value); selIdx = 0; renderResults(); });
sIn.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { selIdx = Math.min(results.length - 1, selIdx + 1); renderResults(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { selIdx = Math.max(0, selIdx - 1); renderResults(); e.preventDefault(); }
  else if (e.key === 'Enter') { if (results[selIdx]) choose(results[selIdx]); }
  else if (e.key === 'Escape') { sRes.classList.add('hidden'); sIn.blur(); }
});
sIn.addEventListener('blur', () => setTimeout(() => sRes.classList.add('hidden'), 150));
async function choose(r) {
  sRes.classList.add('hidden');
  sIn.value = r.label;
  let pick = null, tgt = null;
  if (r.kind === 'star') { pick = { type: 'star', i: r.data }; tgt = { name: sky.starName(r.data)[0], ra: sky.sra[r.data], dec: sky.sdec[r.data] }; }
  else if (r.kind === 'body') { const b = A.solarSystem(sky.jd).find(x => x.id === r.data); pick = { type: 'body', b }; }
  else if (r.kind === 'dso') { pick = { type: 'dso', d: r.data }; tgt = { name: r.data.id + (r.data.alt ? ' ' + r.data.alt : ''), ra: r.data.ra, dec: r.data.dec }; }
  else if (r.kind === 'cons') { if (view !== 'sky') show('sky'); sky.lookAt(r.data.ra, r.data.dec, true, 50); return; }
  else if (r.kind === 'test') { tgt = r.data; pick = { type: 'target', t: r.data }; }
  else if (r.kind === 'coord') { tgt = { name: 'Sky position', ra: r.data.ra, dec: r.data.dec }; pick = { type: 'point', t: tgt }; }
  else if (r.kind === 'sesame') {
    try {
      toast('Resolving “' + r.data + '”…', false, 1500);
      const s = await api('/api/sx/resolve?name=' + encodeURIComponent(r.data));
      tgt = s; pick = { type: 'target', t: { ...s, type: s.type } };
      sIn.value = s.name;
    } catch (e) { return toast('Not found: ' + e.message, true); }
  }
  if (tgt) state.setTarget(tgt, 'search');
  if (view === 'sky' || r.kind === 'body') {
    if (view !== 'sky') show('sky');
    if (pick) { sky.select(pick); sky.centerOn(pick); if (sky.view.fov > 60) sky.lookAt(sky.objectPos(pick).ra, sky.objectPos(pick).dec, true, 40); }
  }
}

// ------------------------------------------------------------------ keyboard
const KEYS = { i: 'spherex', s: 'stars', c: 'constLines', v: 'constNames', b: 'constBounds', a: 'atmosphere', g: 'ground', q: 'cardinal', e: 'eqGrid', z: 'azGrid', ',': 'ecliptic', '.': 'galactic', ';': 'meridian', m: 'milkyway', d: 'dsos', p: 'planets' };
document.addEventListener('keydown', e => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  if (e.key === '/' ) { e.preventDefault(); sIn.focus(); return; }
  if (view === 'blink') {
    if (e.key === ' ') { e.preventDefault(); blink.togglePlay(); }
    if (e.key === 'ArrowRight') blink.step(1);
    if (e.key === 'ArrowLeft') blink.step(-1);
    return;
  }
  if (view !== 'sky') return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'n') { e.preventDefault(); actions.night(); return; }
  if (e.ctrlKey && k === 's') { e.preventDefault(); actions.shot(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (KEYS[k]) toggleLayer(KEYS[k]);
  else if (k === 'j') sky.slower(); else if (k === 'k') sky.togglePause(); else if (k === 'l') sky.faster();
  else if (k === '8') actions.now();
  else if (k === ' ') { e.preventDefault(); actions.center(); }
  else if (k === 't') { sky.opt.track = !sky.opt.track; $('#optTrack').checked = sky.opt.track; if (sky.opt.track && sky.selection) sky.centerOn(sky.selection); }
  else if (k === 'pageup' || k === '+' || k === '=') sky.zoom(1 / 1.3);
  else if (k === 'pagedown' || k === '-') sky.zoom(1.3);
  else if (k.startsWith('arrow')) {
    const st = sky.view.fov / 20, v = sky.view;
    if (v.mount === 'altaz') { if (k === 'arrowleft') v.az = mod(v.az - st, 360); if (k === 'arrowright') v.az = mod(v.az + st, 360); if (k === 'arrowup') v.alt = clamp(v.alt + st, -90, 90); if (k === 'arrowdown') v.alt = clamp(v.alt - st, -90, 90); }
    else { if (k === 'arrowleft') v.ra = mod(v.ra + st, 360); if (k === 'arrowright') v.ra = mod(v.ra - st, 360); if (k === 'arrowup') v.dec = clamp(v.dec + st, -90, 90); if (k === 'arrowdown') v.dec = clamp(v.dec - st, -90, 90); }
    sky.dirty = true; e.preventDefault();
  }
  else if (k === 'escape') { sky.select(null); renderInfo(null); $$('#sidePanels .panel').forEach(p => p.classList.add('hidden')); }
  else if (k === 'f4') { e.preventDefault(); $('#panelView').classList.toggle('hidden'); }
  else if (k === 'f5') { e.preventDefault(); $('#panelTime').classList.toggle('hidden'); bus.emit('skytime'); }
  else if (k === 'f6') { e.preventDefault(); $('#panelLocation').classList.toggle('hidden'); }
  else if (k === 'f7') { e.preventDefault(); $('#panelSpherex').classList.toggle('hidden'); }
  else if (k === '[') stepWave(-1);
  else if (k === ']') stepWave(1);
});

// ------------------------------------------------------------------ boot
$('#aboutContent').innerHTML = aboutHtml();
function loop(t) { sky.tick(t); requestAnimationFrame(loop); }
(async () => {
  try { await sky.load(); } catch (e) { toast('Could not load star catalogs: ' + e.message, true); }
  buildIndex();
  const p = readUrl();
  if (p.has('lat') && p.has('lon')) setLocation('URL location', +p.get('lat'), +p.get('lon'), +(p.get('elev') || 0));
  if (p.has('date')) { const d = new Date(p.get('date')); if (!isNaN(d)) sky.setDate(d); }
  if (p.has('fov')) sky.view.fov = clamp(+p.get('fov') || 90, 0.05, 200);
  const preset = TEST_TARGETS.find(t => t.id === p.get('target'));
  if (preset) state.setTarget(preset, 'url');
  else if (p.has('ra') && p.has('dec')) {
    const ra = +p.get('ra'), dec = +p.get('dec');
    if (isFinite(ra) && isFinite(dec)) state.setTarget({ name: p.get('name') || 'Sky position', ra, dec, pmra: +p.get('pmra') || 0, pmdec: +p.get('pmdec') || 0,
      epoch: +p.get('epoch') || 2000, plx: +p.get('plx') || 0 }, 'url');
  } else state.setTarget(TEST_TARGETS[2], 'default');
  blink.applyUrl(p);
  const v = p.get('view');
  const wantSpec = v === 'spectro';
  show(['sky', 'blink', 'spectro', 'survey', 'about'].includes(v) ? v : 'sky');
  if (view === 'sky') {
    sky.lookAt(state.target.ra, state.target.dec, false);
    if (!p.has('fov')) sky.view.fov = 100;
    if (sky.view.mount === 'altaz' && sky.view.alt < 5) {
      sky.view.alt = 25;
      toast(`${state.target.name} is below your horizon right now — press G to hide the ground, or drag the sky to explore.`, false, 7000);
    }
  }
  if (EMBED) embedBoot();
  if (p.get('auto') === '1' && state.target && view === 'blink') { if (wantSpec) spectro.run(); else blink.load(); }
  bus.emit('skytime');
  requestAnimationFrame(loop);
  api('/api/sx/status').catch(() => toast('Radians server not reachable', true, 8000));
})();

// ------------------------------------------------------------------ embedded in the Radians page
// The page around the iframe draws the controls (time, constellations, colour, place, targets) and calls
// window.radiansSky; the sky reports its time back with postMessage. A click shows a small card instead
// of the full info panel.
let cardFor = null;
function cardTitle(o) {
  if (o.type === 'star') return [sky.starName(o.i)[0], 'Star'];
  if (o.type === 'body') { const b = sky.objectPos(o) || o.b; return [document.documentElement.lang === 'tr' ? b.tr : b.name, b.kind === 'planet' ? (b.id === 'pluto' ? 'Dwarf planet' : 'Planet') : b.kind === 'moon' ? 'Natural satellite' : 'Star']; }
  if (o.type === 'dso') return [o.d.id + (o.d.alt ? ' — ' + o.d.alt : ''), DSO_TYPES[o.d.type] || 'Deep-sky object'];
  if (o.type === 'cat' || o.type === 'target') return [o.t.name, o.t.type || 'SPHEREx target'];
  return ['Sky position', 'Selected point'];
}
function renderCard(o) {
  const box = $('#skyInfo');
  if (!o) { cardFor = null; box.classList.add('hidden'); return; }
  if (o === cardFor) return;
  cardFor = o;
  const pos = sky.objectPos(o);
  if (!pos) return;
  const [title, type] = cardTitle(o);
  const moving = o.type === 'body';
  const alt = altOf(pos);
  const note = alt < 0 ? 'Below the horizon right now' : alt < 12 ? 'Low above the horizon' : '';
  box.className = 'panel info card';
  box.innerHTML = `<button class="x" data-a="close" aria-label="Close">×</button><div class="type">${esc(type)}</div><h2>${esc(title)}</h2>` +
    (note ? `<p class="note">${note}</p>` : '') +
    (moving ? '' : `<div class="actions"><button class="btn small primary" data-a="blink">Blink this</button><button class="btn small" data-a="science">Science tool ↗</button></div>`);
  box.querySelectorAll('[data-a]').forEach(b => (b.onclick = () => {
    const a = b.dataset.a;
    if (a === 'close') { sky.select(null); return renderCard(null); }
    const tr = document.documentElement.lang === 'tr' ? '&lang=tr' : '';
    if (a === 'blink') parent.postMessage({ type: 'sky-blink', ra: pos.ra, dec: pos.dec, name: title }, location.origin);
    if (a === 'science') window.open(`/planet/?view=blink&ra=${pos.ra.toFixed(6)}&dec=${pos.dec.toFixed(6)}&name=${encodeURIComponent(title)}&auto=1${tr}`, '_blank', 'noopener');
  }));
}
function altOf(pos) {
  const h = sky.refract(A.mulv(sky.M, A.radec2v(pos.ra, pos.dec)));
  return A.hor2altaz(h)[0];
}
function setPal(p) {
  if (p === 'rgb') { $('#hxMode').value = 'rgb'; $('#hxR').value = 96; $('#hxG').value = 60; $('#hxB').value = 20; }
  else { $('#hxMode').value = 'mono'; $('#hxFrame').value = 46; $('#hxCmap').value = p === 'gray' ? 'gray' : p; }
  sky.layers.spherex = true;
  applySpx();
}
function tonightAt21() { const d = new Date(); d.setHours(21, 0, 0, 0); return d; }
function report() {
  parent.postMessage({ type: 'sky-state', ms: sky.date.getTime(), rate: sky.rate, cons: !!sky.layers.constLines, loc: sky.loc.name,
    sunAlt: sky.ss ? sky.ss.sunAlt : null }, location.origin);
}
function embedBoot() {
  // look south-east, a little above the horizon, with a wide field
  sky.view.mount = 'altaz'; sky.view.proj = 'stereo';
  sky.view.az = 170; sky.view.alt = 40;
  sky.view.fov = 100;
  sky.opt.lang = pageLang() === 'tr' ? 'tr' : 'en';
  sky.layers.stars = true; sky.layers.atmosphere = false;
  sky.dirty = true;
  // daytime: jump to 21:00 tonight (the "Now" button still goes to the real time)
  let checked = false;
  bus.on('skyframe', () => {
    if (!checked && sky.ss) { checked = true; if (sky.ss.sunAlt > -8 && new Date().getHours() >= 6) sky.setDate(tonightAt21()); report(); }
  });
  bus.on('skytime', report);
  setInterval(report, 1000);
  const render = sky.render.bind(sky);
  sky.render = (now) => { holdHorizon(); return render(now); };
}
// Dome-shaped sky (stereographic) over a flat ground band of fixed height: the view never tilts so low
// that the horizon below the centre rises above the band, so stars right above the horizon stay in view
// and the ground keeps its shape. Looking up lets the band hide less sky; dragging down stops at it.
const BAND = 0.12;
function holdHorizon() {
  if (!sky.W || !sky.H) return;
  const v = sky.view;
  sky.flatBand = sky.layers.ground && v.mount === 'altaz' ? BAND : 0;
  sky.setupFrame();
  const P = sky.P;
  if (P.cyl) v.fov = Math.min(v.fov, sky.H / sky.W * 200, 110);
  else {
    // wide frames: at most ~150 degrees across, or the edges stretch
    const maxFov = 2 * P.gi(P.g(75 * D2R) * sky.H / sky.W) * R2D;
    if (isFinite(maxFov) && v.fov > maxFov) v.fov = maxFov;
  }
  if (!sky.flatBand) return;
  sky.setupFrame();
  const r = (sky.H * (0.5 - BAND)) / sky.k;              // centre -> top of the band, in projection units
  const low = (P.cyl ? r : P.gi(r)) * R2D;               // angle below the centre where the horizon must sit
  if (isFinite(low)) v.alt = clamp(v.alt, low, 90);
}
window.radiansSky = {
  setTime(ms) { sky.setDate(new Date(ms)); },
  now() { sky.setDate(new Date()); sky.setRate(1); },
  setRate(r) { sky.setRate(r); },
  setCons(on) { sky.layers.constLines = on; sky.layers.constNames = on; sky.dirty = true; saveOpts(); report(); },
  setPalette: setPal,
  setPlace(i) {
    if (i === 'geo') return $('#locGeo').click();
    const l = LOCATIONS[i]; if (l) { setLocation(...l); locSel.value = i; }
    report();
  },
  async goto(kind, x) {
    cardFor = null;
    if (kind === 'test') { const t = TEST_TARGETS.find(t => t.id === x); if (t) await choose({ kind: 'test', data: t }); }
    else if (kind === 'body') await choose({ kind: 'body', data: x });
    else if (kind === 'point') await choose({ kind: 'test', data: x });
    else { const r = searchLocal(x).find(r => r.kind !== 'coord' && r.kind !== 'sesame'); await choose(r || { kind: 'sesame', data: x }); }
    // below the horizon: hide the ground so the object can still be seen (the card says so)
    const pos = sky.selection && sky.objectPos(sky.selection);
    sky.layers.ground = !(pos && altOf(pos) < 3);
    sky.dirty = true;
  },
  advanced(on) {
    document.body.classList.toggle('adv', on);
    $$('#sidePanels .panel').forEach(p => p.classList.toggle('hidden', !on));
  },
};
