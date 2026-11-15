// "Map": the whole sky as SPHEREx sees it (the DR1 all-sky cube from NASA/IPAC IRSA) in Aladin Lite.
// Four themes (core/palette.js). Regular and inverted show one wavelength in black and white: a 0.75-5 µm
// slider picks it and a button confirms it (the map loads a new plane only then). Colour shows the whole
// range squeezed onto visible colours; scientific shows one feature against the light beside it. The challenge and Explore targets are marked and
// listed, and a click anywhere blinks that spot.
import { rainbowTint, rgbToHex, scaleRgb, hexToRgb } from './colour.js';
import { FRAME_GAIN, PRESETS as SCI_PRESETS, NOTES } from './colourdata.js';
import { t, getLang } from '../core/i18n.js';
import { CUBE_URL, CUBE_WL, BLANK, bandOf, nearestSlice } from '../core/cube.js';
import { TARGETS, EXPLORE } from '../content/facts.js';
import { decodeB64, percentiles, stretchValue } from '../blink/sky.js';

import { THEMES, getPalette, setPalette } from '../core/palette.js';
import { loadAladin, QUIET } from '../core/aladin.js';
const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const HOME = { ra: 266.4, dec: -28.9, fov: 200 };          // the Galactic centre, Milky Way across the middle
const DEEP_FOV = 0.7;        // degrees: closer than this the all-sky map's 13″ pixels are only being magnified
const P = new URLSearchParams(location.search);

const map = { aladin: null, hips: null, slice: nearestSlice(2.2), pick: null, objectHit: false, down: null, coords: new Map() };

// Wavelengths worth a look: hydrogen lines, dust and the ices SPHEREx was built to map.
const PRESETS = [
  { um: 1.10, en: 'Starlight', tr: 'Yıldız ışığı',
    tipEn: 'Near 1 µm the sky is dominated by the light of stars.', tipTr: '1 µm civarında gökyüzüne yıldızların ışığı hâkimdir.' },
  { um: 1.875, en: 'Paschen-α', tr: 'Paschen-α',
    tipEn: 'A hydrogen emission line: glowing gas around young, hot stars.', tipTr: 'Bir hidrojen salma çizgisi: genç, sıcak yıldızların çevresindeki parlayan gaz.' },
  { um: 3.05, en: 'Water ice', tr: 'Su buzu',
    tipEn: 'The absorption band of water ice frozen onto dust grains in cold clouds.', tipTr: 'Soğuk bulutlarda toz tanelerinin üzerinde donmuş su buzunun soğurma bandı.' },
  { um: 3.29, en: 'PAH dust', tr: 'PAH tozu',
    tipEn: 'Emission from tiny carbon-rich dust grains (PAHs) warmed by starlight.', tipTr: 'Yıldız ışığıyla ısınan, karbonca zengin minik toz tanelerinin (PAH) salması.' },
  { um: 4.05, en: 'Brackett-α', tr: 'Brackett-α',
    tipEn: 'Another hydrogen line, which passes through dust better than visible light.', tipTr: 'Tozun içinden görünür ışıktan daha iyi geçen bir başka hidrojen çizgisi.' },
  { um: 2.166, en: 'Brackett-γ', tr: 'Brackett-γ',
    tipEn: 'A hydrogen line astronomers use to see star-forming gas through dust.', tipTr: 'Gökbilimcilerin tozun ardındaki yıldız oluşturan gazı görmek için kullandığı bir hidrojen çizgisi.' },
  { um: 4.27, en: 'CO₂ ice', tr: 'CO₂ buzu',
    tipEn: 'The absorption band of frozen carbon dioxide.', tipTr: 'Donmuş karbondioksitin soğurma bandı.' },
];


// The famous-object markers can be switched off in the legend; the choice is remembered.
const famousOn = () => { try { return localStorage.getItem('radians-famous') !== '0'; } catch { return true; } };

const L = () => (getLang() === 'tr' ? 'tr' : 'en');
// the names the landing page's cards use
const NAMES = { 'eps Indi B': 'ε Indi B', 'WISE J085510.83-071442.5': 'WISE 0855−0714', 'RW Aur': 'RW Aurigae', 'R Dra': 'R Draconis' };
const nice = (q) => NAMES[q] || q;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- open / close
function openMap(push = true) {
  root.classList.add('in-map');
  if (push) {
    const u = new URL(location.href);
    u.search = '?map=1';
    u.hash = '';
    history.pushState(null, '', u);
  }
  for (const a of document.querySelectorAll('.navmap')) a.setAttribute('aria-current', 'page');
  window.scrollTo(0, 0);
  initMap();
}
function closeMap() {
  root.classList.remove('in-map');
  for (const a of document.querySelectorAll('.navmap')) a.removeAttribute('aria-current');
  hidePop();
}
for (const b of document.querySelectorAll('[data-map]')) b.onclick = (e) => { e.preventDefault(); openMap(); };
// the landing's own section links also lead back from the map
for (const a of document.querySelectorAll('.nav .navl')) {
  a.addEventListener('click', (e) => {
    if (!root.classList.contains('in-map')) return;
    e.preventDefault();
    closeMap();
    history.pushState(null, '', location.pathname + a.getAttribute('href'));
    requestAnimationFrame(() => document.querySelector(a.getAttribute('href'))?.scrollIntoView());
  });
}
document.addEventListener('radians:run', closeMap);
addEventListener('popstate', () => { if (new URLSearchParams(location.search).get('map') === '1') openMap(false); else closeMap(); });

// ---------------------------------------------------------------- the map
async function initMap() {
  if (map.aladin) return;
  fetch(new URL('hips/warm', location.href)).catch(() => {});      // the colour tiles' connections, ahead of time
  try {
    await loadAladin();
    $('mapStatus').replaceChildren();
    // Aladin needs a bottom layer, and it cannot change the wavelength of a cube there (only of a layer above).
    // So the bottom layer is an empty sky from our own server: Aladin never asks CDS for its default survey
    // (blocked on some networks), nothing is fetched twice from the archive, and where SPHEREx has no data at
    // the chosen wavelength (a masked part of a detector) the map stays empty. Nothing from another
    // wavelength is put there.
    map.base = window.A.imageHiPS('radians-blank', { url: new URL('/hips/blank', location.href).href, name: 'Empty sky' });
    map.aladin = window.A.aladin('#skymapAladin', {
      ...QUIET, survey: map.base,
      fov: HOME.fov, cooFrame: 'galactic', projection: 'AIT', showReticle: false,
      showLayersControl: false, showFullscreenControl: true, showCooGridControl: true, showSimbadPointerControl: false,
      showProjectionControl: false, showFrame: true, showZoomControl: true,
      pixelateCanvas: false,                          // smooth magnified pixels instead of hard blocks
    });
    // ?c=ra,dec&z=fov&wl=µm open the map on a given view (shareable)
    const c = (P.get('c') || '').split(',').map(Number);
    if (c.length === 2 && c.every(Number.isFinite)) map.aladin.gotoRaDec(c[0], c[1]); else map.aladin.gotoRaDec(HOME.ra, HOME.dec);
    if (Number(P.get('z')) > 0) map.aladin.setFoV(Number(P.get('z')));
    if (Number(P.get('wl')) > 0) map.slice = nearestSlice(Number(P.get('wl')));
    // the chosen wavelength: one plane of the cube, above the empty bottom layer
    // (a slice set before the layer is ready is stored but not applied: it is set again once it is)
    map.hips = window.A.imageHiPS('radians-spherex', { url: CUBE_URL, name: 'SPHEREx DR1', successCallback: () => setSlice(map.slice) });
    map.aladin.setOverlayImageLayer(map.hips, 'spherex');
    map.aladin.on('zoomChanged', deepChip);
    const div = $('skymapAladin');
    setSlice(map.slice);
    addMarkers();
    initExtras();
    div.addEventListener('pointerdown', (e) => { map.down = [e.clientX, e.clientY]; map.objectHit = false; });
    div.addEventListener('pointerup', (e) => {
      const d = map.down;
      map.down = null;
      if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4) return;      // a drag, not a click
      setTimeout(() => {
        if (map.objectHit) return;
        if (!$('mapPop').hidden) { hidePop(); return; }                         // empty sky closes the card first
        clickAt(e);
      }, 30);
    });
  } catch (err) {
    // the sky viewer could not be loaded (both CDNs down or blocked): say so, and offer another try
    map.aladin = null;
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn sm';
    again.textContent = t('mapRetry');
    again.onclick = () => { $('mapStatus').textContent = t('mapRetrying'); initMap(); };
    $('mapStatus').replaceChildren(`${t('mapFail')} (${err.message}) `, again);
  }
}

/** Show plane i of the cube: the confirmed choice. */
function setSlice(i) {
  map.slice = i;
  showPick(i);
  for (const b of $('mapPresets').children) b.classList.toggle('on', Number(b.dataset.slice) === i);
  try { map.hips?.setSliceNumber(i); } catch { /* older Aladin: one plane only */ }
  deepChip();
}

/** The wavelength the slider points at. It is only picked: the map changes when it is confirmed. */
function showPick(i) {
  map.pick = i;
  $('mapWl').value = i;
  $('mapWlVal').textContent = `${CUBE_WL[i].toFixed(3)} µm`;
  $('mapWlBand').textContent = `D${bandOf(i)} · ${i + 1}/102`;
  const waiting = i !== map.slice;
  $('mapWlGo').disabled = !waiting;
  $('mapOne').classList.toggle('picked', waiting);
  $('mapWlNote').textContent = waiting ? t('mapWlPicked', { shown: CUBE_WL[map.slice].toFixed(3) }) : t('mapWlShown');
}

// ticks under the slider, at the plane of each wavelength
$('mapTicks').replaceChildren(...[0.75, 1, 2, 3, 4, 5].map((w) => {
  const s = document.createElement('span');
  s.textContent = w === 5 ? '5 µm' : String(w);
  s.style.left = `${nearestSlice(w) / 101 * 100}%`;
  return s;
}));
// Pick, then confirm: moving the slider only chooses a wavelength (and fetches its tiles in the
// background); the map changes when the button, or Enter, confirms it.
$('mapWl').oninput = () => { let i = Number($('mapWl').value); if (BLANK.has(i)) i = 52; showPick(i); prefetchPick(); };
const confirmPick = () => { if (map.pick != null && map.pick !== map.slice) setSlice(map.pick); };
$('mapWlGo').onclick = confirmPick;
$('mapWl').addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmPick(); });

// ---------------------------------------------------------------- brightness and contrast
function setLevels(b, c) {
  $('mapWrap').style.setProperty('--mapbright', b);
  $('mapWrap').style.setProperty('--mapcontrast', c);
  $('mapBright').value = b;
  $('mapContrast').value = c;
  try { localStorage.setItem('radians-maplevels', `${b},${c}`); } catch { /* private mode */ }
}
$('mapBright').oninput = () => setLevels($('mapBright').value, $('mapContrast').value);
$('mapContrast').oninput = () => setLevels($('mapBright').value, $('mapContrast').value);
$('mapPalReset').onclick = () => setLevels(0.95, 1.3);
try {
  const [b, c] = (localStorage.getItem('radians-maplevels') || '').split(',').map(Number);
  if (b > 0 && c > 0) setLevels(b, c);
} catch { /* private mode */ }

// ---------------------------------------------------------------- highlight wavelengths
function buildPresets() {
  const l = L();
  $('mapPresets').replaceChildren(...PRESETS.map((p) => {
    const i = nearestSlice(p.um);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mapchip';
    b.dataset.slice = i;
    b.title = l === 'tr' ? p.tipTr : p.tipEn;
    const um = document.createElement('span');
    um.className = 'mono';
    um.textContent = `${CUBE_WL[i].toFixed(2)} µm`;
    b.append(p[l], um);
    b.classList.toggle('on', i === map.slice);
    b.onclick = () => setSlice(i);                       // a named wavelength: picked and confirmed in one click
    return b;
  }));
}

// ---------------------------------------------------------------- markers and target list
function addMarkers() {
  const A = window.A;
  const mk = (name, color, size, list) => {
    const c = A.catalog({ name, color, sourceSize: size, shape: 'circle' });
    c.addSources(list.map(x => A.source(x.ra, x.dec, { q: x.q })));
    map.aladin.addCatalog(c);
  };
  mk('Challenge', '#ffb347', 16, TARGETS);
  // Explore stars: positions come from the resolver, cached by the server
  Promise.all(EXPLORE.map(x => fetch(new URL(`api/resolve?q=${encodeURIComponent(x.q)}`, location.href)).then(r => (r.ok ? r.json() : null)).catch(() => null)))
    .then((rs) => {
      rs.forEach((r, k) => { if (r && Number.isFinite(r.ra)) map.coords.set(EXPLORE[k].q, { ra: r.ra, dec: r.dec }); });
      const ok = EXPLORE.filter(x => map.coords.has(x.q)).map(x => ({ ...map.coords.get(x.q), q: x.q }));
      if (ok.length) mk('Explore', '#ffffff', 11, ok);
      buildChips();
    });
  map.aladin.on('objectClicked', (obj) => {
    if (!obj || !obj.data || !obj.data.q) return;
    map.objectHit = true;
    showPop(obj.ra, obj.dec, obj.data.q);
  });
}

function syncFamous() {
  const on = famousOn();
  $('mapFamousT').setAttribute('aria-pressed', String(on));
}
$('mapFamousT').onclick = () => {
  const on = !famousOn();
  try { localStorage.setItem('radians-famous', on ? '1' : '0'); } catch { /* private window */ }
  try { on ? extra.catalog?.show() : extra.catalog?.hide(); } catch { /* older Aladin */ }
  if (!on && $('mapPop').dataset.kind === 'f') hidePop();
  syncFamous();
};

function buildChips() {
  const l = L();
  const chip = (label, kind, ra, dec, q) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `mapchip ${kind}`;
    const dot = document.createElement('i');
    b.append(dot, label);
    b.onclick = () => flyTo(ra, dec, q);
    return b;
  };
  $('mapChipsC').replaceChildren(...TARGETS.map(x => chip(nice(x.q), 'c', x.ra, x.dec, x.q)));
  $('mapChipsE').replaceChildren(...EXPLORE.filter(x => map.coords.has(x.q))
    .map((x) => { const c = map.coords.get(x.q); return chip(x[l].split(':')[0], 'e', c.ra, c.dec, x.q); }));
}

function flyTo(ra, dec, q) {
  if (!map.aladin) return;
  hidePop();
  map.aladin.gotoRaDec(ra, dec);
  map.aladin.setFoV(45);
  $('skymapAladin').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  setTimeout(() => showPop(ra, dec, q), 80);
}
$('mapHome').onclick = () => {
  if (!map.aladin) return;
  hidePop();
  map.aladin.gotoRaDec(HOME.ra, HOME.dec);
  map.aladin.setFoV(HOME.fov);
};

// ---------------------------------------------------------------- the card: click -> blink here
function clickAt(e) {
  const r = $('skymapAladin').getBoundingClientRect();
  let radec = null;
  try { radec = map.aladin.pix2world(e.clientX - r.left, e.clientY - r.top, 'icrs'); } catch { /* outside the sky */ }
  if (!radec || !Number.isFinite(radec[0])) return;
  showPop(radec[0], radec[1], null, [e.clientX - r.left, e.clientY - r.top]);
}

function showPop(ra, dec, q, at) {
  const pop = $('mapPop');
  const l = L();
  const tg = q && TARGETS.find(x => x.q === q);
  const ex = q && EXPLORE.find(x => x.q === q);
  const pin = q && String(q).startsWith('pin:') ? extra.pins.find(p => `pin:${p.id}` === q) : null;   // a famous object
  pop.dataset.kind = tg ? 'c' : ex ? 'e' : pin ? 'f' : 'p';
  $('mapPopKind').textContent = t(tg ? 'mapKindChallenge' : ex ? 'mapKindExplore' : pin ? 'mapKindFamous' : 'mapKindPoint');
  $('mapPopTitle').textContent = tg ? nice(q) : ex ? ex[l].split(':')[0] : pin ? pin[`name_${l}`] : t('mapHere');
  const sub = tg ? tg[l].kind : ex ? cap(ex[l].split(':').slice(1).join(':').trim()) : pin ? pin[`blurb_${l}`] : '';
  $('mapPopSub').textContent = sub;
  $('mapPopSub').hidden = !sub;
  const d = +dec;
  $('mapPopPos').textContent = `RA ${(+ra).toFixed(4)}°   Dec ${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(4)}°`;
  pop.dataset.q = q && !pin ? q : `${(+ra).toFixed(5)} ${d.toFixed(5)}`;       // famous objects blink by position
  pop.hidden = false;
  showCoverage(+ra, d);
  const r = $('skymapAladin').getBoundingClientRect();
  const [x, y] = at || (() => { try { return map.aladin.world2pix(ra, dec) || [r.width / 2, r.height / 2]; } catch { return [r.width / 2, r.height / 2]; } })();
  map.popAt = [x, y];
  placePop();
}
// keep the card inside the map (again once the coverage answer has made it taller)
function placePop() {
  const pop = $('mapPop');
  if (pop.hidden || !map.popAt) return;
  const r = $('skymapAladin').getBoundingClientRect();
  const [x, y] = map.popAt;
  pop.style.left = `${Math.min(r.width - pop.offsetWidth - 12, Math.max(12, x + 16))}px`;
  pop.style.top = `${Math.min(r.height - pop.offsetHeight - 12, Math.max(12, y + 16))}px`;
}
// ---------------------------------------------------------------- the card: has SPHEREx seen this spot?
const DET_UM = { 1: [0.75, 1.09], 2: [1.10, 1.62], 3: [1.63, 2.42], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.00] };
const cov = { seq: 0, ctl: null, seen: new Map() };

function covMonth(iso) {
  const dt = new Date(iso + 'T00:00:00Z');
  return Number.isNaN(dt.getTime()) ? iso
    : dt.toLocaleDateString(getLang() === 'tr' ? 'tr-TR' : 'en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** The sentence for a coverage answer: [i18n key, vars]. */
function coverageWords(c) {
  if (!c || !c.count) return ['covNone', {}];
  const n = c.count.toLocaleString(getLang() === 'tr' ? 'tr-TR' : 'en-GB');
  const p = c.passes?.length || 1;
  if (p > 1) return ['covMany', { n, p, first: covMonth(c.first) }];
  // one unbroken run that lasts for months is a deep field, not a single visit
  return [c.span_days > 60 ? 'covDeep' : 'covOne', { n, first: covMonth(c.first) }];
}

function drawCoverage(c) {
  const box = $('mapPopCov');
  const [key, vars] = coverageWords(c);
  box.className = 'mappopcov';
  box.replaceChildren(document.createTextNode(t(key, vars)));
  if (!c.count) { placePop(); return; }
  const max = Math.max(1, ...Object.values(c.detectors));
  const bands = document.createElement('div');
  bands.className = 'covbands';
  for (const d of Object.keys(DET_UM)) {
    const n = c.detectors[d] || 0;
    const fig = document.createElement('figure');
    if (!n) fig.className = 'none';
    fig.title = t('covBand', { d, lo: DET_UM[d][0], hi: DET_UM[d][1], n });
    const bar = document.createElement('span');
    bar.className = 'cb';
    const fill = document.createElement('i');
    fill.style.height = `${Math.round(n / max * 100)}%`;
    bar.append(fill);
    const num = document.createElement('b');
    num.textContent = n;
    fig.append(bar, num, document.createTextNode(d));
    bands.append(fig);
  }
  const cap = document.createElement('span');
  cap.className = 'covcap';
  cap.textContent = t('covBands');
  box.append(cap, bands);
  placePop();
}

async function showCoverage(ra, dec) {
  const box = $('mapPopCov');
  const key = `${ra.toFixed(5)},${dec.toFixed(5)}`;       // the card's own coordinates, as the blink will ask for them
  const seq = ++cov.seq;
  cov.ctl?.abort();
  if (cov.seen.has(key)) { drawCoverage(cov.seen.get(key)); return; }
  box.className = 'mappopcov wait';
  box.textContent = t('covAsking');
  cov.ctl = new AbortController();
  try {
    const r = await fetch(new URL(`api/coverage?ra=${ra.toFixed(5)}&dec=${dec.toFixed(5)}`, location.href), { signal: cov.ctl.signal });
    if (!r.ok) throw new Error(String(r.status));
    const c = await r.json();
    cov.seen.set(key, c);
    if (seq === cov.seq) drawCoverage(c);
  } catch (err) {
    if (seq !== cov.seq || err.name === 'AbortError') return;
    box.className = 'mappopcov down';
    box.textContent = t('covDown');
  }
}

function hidePop() {
  cov.seq++;
  cov.ctl?.abort();
  $('mapPop').hidden = true;
  try { map.aladin?.unselectObjects?.(); } catch { /* older Aladin */ }
}
$('mapPopClose').onclick = hidePop;
addEventListener('keydown', (e) => { if (e.key === 'Escape' && root.classList.contains('in-map')) hidePop(); });
$('mapPopGo').onclick = () => {
  const q = $('mapPop').dataset.q;
  hidePop();
  history.replaceState(null, '', location.pathname);
  $('q').value = q;
  // challenge targets keep their tuned settings (e.g. WISE 0855 on D5+D6)
  const card = [...document.querySelectorAll('#examples button[data-q]')].find(b => b.dataset.q === q);
  if (card) card.click(); else $('search').requestSubmit();
};

// ---------------------------------------------------------------- faster: fetch the picked plane ahead of time
// Every tile the map shows is remembered. While a wavelength is picked but not confirmed yet, the same tiles
// of that plane are fetched into the browser cache, so confirming finds them there.
const seen = new Map();                                  // 'Norder3/Dir0/Npix100' -> last time on screen
const fetched = new Set();
const queue = [];
let active = 0;
try { performance.setResourceTimingBufferSize(4000); } catch { /* old browser */ }
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const m = e.name.match(/spherex_allsky_cube\/+(Norder\d+\/Dir\d+\/Npix\d+)(?:_\d+)?\.png/);
      if (m) { seen.set(m[1], performance.now()); fetched.add(e.name.replace(/cube\/\//, 'cube/')); }
    }
    if (performance.getEntriesByType('resource').length > 3000) performance.clearResourceTimings();
  }).observe({ type: 'resource' });
} catch { /* no PerformanceObserver: no prefetch */ }

const tileUrl = (path, slice) => `${CUBE_URL}/${path}${slice ? `_${slice}` : ''}.png`;
function pump() {
  while (active < 6 && queue.length) {
    const u = queue.shift();
    if (fetched.has(u)) continue;
    fetched.add(u);
    active++;
    fetch(u, { mode: 'cors' }).then(r => r.arrayBuffer()).catch(() => {}).finally(() => { active--; pump(); });
  }
}
function prefetchPick() {
  clearTimeout(map.preTimer);
  map.preTimer = setTimeout(() => {
    const j = map.pick;
    if (j == null || j === map.slice) return;
    const paths = [...seen].sort((x, y) => y[1] - x[1]).slice(0, 48).map(([k]) => k);   // what is on screen now
    queue.length = 0;                                     // only what is useful now
    for (const path of paths) queue.push(tileUrl(path, j));
    pump();
  }, 400);
}

// ---------------------------------------------------------------- deeper zoom: sharper than one SPHEREx pixel
// Closer than DEEP_FOV the all-sky map only magnifies its 13″ pixels. The visitor can then load the real
// exposures of that spot (one detector: the band of the chosen wavelength). The server drizzles them onto 3″
// pixels (backend/app/sharp.py: many dithered exposures sample the sky at sub-pixel offsets) and also
// stacks them on SPHEREx's own 6.15″ grid, so "Before / After" compares the two with one stretch.
const deep = { layer: false, busy: false, det: null, n: 0, err: '', data: null, view: 'after' };
function deepChip() {
  const box = $('mapDeep');
  if (!map.aladin) return;
  let fov = 180;
  try { fov = map.aladin.getFov()[0]; } catch { /* keep default */ }
  box.hidden = !(fov < DEEP_FOV || deep.layer || deep.busy);
  if (box.hidden) return;
  const det = bandOf(map.slice);
  let text;
  if (deep.busy) text = deep.total ? t('mapDeepLoading', { det: deep.det, done: deep.done, total: deep.total }) : t('mapDeepWait', { det: deep.det });
  else if (deep.err) text = deep.err;
  else if (deep.layer) text = t(deep.view === 'after' ? 'mapDeepShown' : 'mapDeepNative', { det: deep.det, n: deep.n });
  else text = t('mapDeepOffer');
  $('mapDeepText').textContent = text;
  $('mapDeepGo').hidden = deep.busy || (deep.layer && deep.det === det && !deep.err);
  $('mapDeepGo').textContent = t(deep.err ? 'mapDeepRetry' : 'mapDeepGo', { det });
  $('mapDeepOff').hidden = !deep.layer || deep.busy;
  $('mapDeepSeg').hidden = !deep.layer || deep.busy;
  for (const b of $('mapDeepSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === deep.view);
  box.classList.toggle('busy', deep.busy);
}
async function loadDeep() {
  if (deep.busy || !map.aladin) return;
  const [ra, dec] = map.aladin.getRaDec();
  let fovDeg = 0.3;
  try { fovDeg = map.aladin.getFov()[0]; } catch { /* default */ }
  const fov = Math.round(Math.min(900, Math.max(180, fovDeg * 3600 * 0.75)));
  Object.assign(deep, { busy: true, det: bandOf(map.slice), err: '', done: 0, total: 0 });
  deepChip();
  const job = Math.random().toString(36).slice(2, 12);
  const poll = setInterval(async () => {
    try {
      const p = await (await fetch(new URL(`api/progress?job=${job}`, location.href))).json();
      if (p.stage === 'read' && p.total) { deep.done = p.done; deep.total = p.total; deepChip(); }
    } catch { /* cosmetic */ }
  }, 1500);
  try {
    const q = new URLSearchParams({ ra: ra.toFixed(5), dec: dec.toFixed(5), fov, det: String(deep.det), factor: 2, job });
    const r = await fetch(new URL(`api/sharp?${q}`, location.href));
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail === 'IRSA_UNAVAILABLE' || r.status >= 502 ? t('irsaDown') : data.detail === 'IRSA_FAILED' ? t('irsaFailed') : `HTTP ${r.status}`);
    if (!data.count) throw new Error(t('mapDeepNone'));
    data.img = decodeB64(data.image, Float32Array);
    data.nat = decodeB64(data.native, Float32Array);
    data.range = percentiles([data.nat], [2, 99.8]);   // one stretch for both, so before / after compare fairly
    deep.data = data; deep.view = 'after';
    showDeep();
  } catch (e) {
    deep.err = e.message;
  } finally {
    clearInterval(poll);
    deep.busy = false;
    deepChip();
  }
}
function showDeep() {
  const d = deep.data, after = deep.view === 'after';
  const n = after ? d.n : d.n_native, st = after ? d.img : d.nat, scale = after ? d.scale : d.native_scale;
  const [lo, hi] = d.range;
  const cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const ctx = cv.getContext('2d');
  const out = ctx.createImageData(n, n);
  for (let y = 0; y < n; y++) {
    const row = n - 1 - y;                                 // FITS y is up, image y is down
    for (let x = 0; x < n; x++) {
      const v = stretchValue(st[y * n + x], lo, hi, 'asinh'), o = (row * n + x) * 4;
      if (Number.isNaN(v)) continue;                       // no data: transparent, the all-sky map shows through
      out.data[o] = out.data[o + 1] = out.data[o + 2] = Math.round(v * 255);
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  // Aladin draws image layers with hard pixel edges: hand it a smoothly 3x enlarged copy instead
  const U = 3, big = document.createElement('canvas');
  big.width = big.height = n * U;
  const bx = big.getContext('2d');
  bx.imageSmoothingEnabled = true; bx.imageSmoothingQuality = 'high';
  bx.drawImage(cv, 0, 0, n * U, n * U);
  const s = scale / U / 3600;
  try { map.aladin.removeImageLayer('native'); } catch { /* none yet */ }
  const img = window.A.image(big.toDataURL('image/png'), {
    name: `SPHEREx D${deep.det} ${after ? '3″ drizzle' : '6″'}`, imgFormat: 'png',
    wcs: { NAXIS: 2, NAXIS1: n * U, NAXIS2: n * U, CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: d.ra, CRVAL2: d.dec,
      CRPIX1: (n * U + 1) / 2, CRPIX2: (n * U + 1) / 2, CDELT1: -s, CDELT2: s, RADESYS: 'ICRS', EQUINOX: 2000 },
  });
  map.aladin.setOverlayImageLayer(img, 'native');
  deep.layer = true;
  deep.n = d.count;
}
$('mapDeepGo').onclick = loadDeep;

$('mapDeepSeg').onclick = e => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v || !deep.data || v === deep.view) return;
  deep.view = v; showDeep(); deepChip();
};
$('mapDeepOff').onclick = () => {
  try { map.aladin.removeImageLayer('native'); } catch { /* gone */ }
  deep.layer = false;
  deep.data = null;
  deep.err = '';
  deepChip();
};

// ---------------------------------------------------------------- start
buildPresets();
buildChips();
if (new URLSearchParams(location.search).get('map') === '1') openMap(false);
// ================================================================ merged in from Skyshift
// Famous-object pins with one-line stories, and the colour and scientific themes.
const extra = {
  pins: [], catalog: null,
  layer: null,
  mix: { preset: SCI_PRESETS[0].id },
};
const theme = () => (THEMES.includes(getPalette()) ? getPalette() : 'gray');
const THEME_KEYS = { gray: 'themeGray', invert: 'themeInvert', rgb: 'themeRgb', science: 'themeScience' };
// Three ready-made three-colour views (the team's "Science views"): red, green and blue are three planes of
// the cube, each stretched on its own sky level by the server (mixtiles.py, /hips/spherex-mix/R-G-B).
const RGB_VIEWS = [
  { id: 'rgb-ices', key: 'mixIces', um: [4.27, 3.05, 1.10] },
  { id: 'rgb-gas', key: 'mixGas', um: [4.05, 2.166, 1.875] },
  { id: 'rgb-dust', key: 'mixDust', um: [3.29, 2.2, 1.10] },
];
const rgbView = () => (theme() === 'science' ? RGB_VIEWS.find(x => x.id === extra.mix.preset) || null : null);
const um = (w) => `${w.toFixed(w < 1 ? 3 : 2)} µm`;

function initExtras() {
  applyTheme();
  loadPins();
}

// ---------------------------------------------------------------- one colour picture on top of the SPHEREx layers
function setTop(url, name) {
  if (!map.aladin || !window.A) return;
  try {
    if (extra.layer) { map.aladin.removeImageLayer('extra'); extra.layer = null; }
    if (url) {
      // (a new id for every picture keeps Aladin from re-using the previous one's tiles)
      const id = 'radians-top-' + [...url].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
      extra.layer = window.A.imageHiPS(id, { url, name });
      map.aladin.setOverlayImageLayer(extra.layer, 'extra');
      $('mapWrap').dataset.top = 'mix';
    } else delete $('mapWrap').dataset.top;
  } catch (e) { console.warn('map layer', e); }
}

// ---------------------------------------------------------------- colour mixes (tiles from /hips/spherex-mix)
const layerSpec = (frame, rgb, gain) =>
  `f${frame}c${rgbToHex(rgb).slice(1)}g${String(Math.round(Math.min(8, Math.max(0.1, gain)) * 100)).padStart(2, '0')}`;
const FEATURE_RGB = hexToRgb('#ff9f43'), CONTINUUM_RGB = hexToRgb('#4ea8ff');

/** The two tinted layers of a feature view: [{frame, rgb}], bottom first; null in the other themes. */
function mixLayers() {
  if (theme() !== 'science') return null;
  const p = SCI_PRESETS.find(x => x.id === extra.mix.preset) || SCI_PRESETS[0];
  const feature = p.feature_um.map(nearestSlice), continuum = p.continuum_um.map(nearestSlice);
  // feature in orange, the light beside it in blue: equal = white, absorbed = blue, glowing = orange
  return [...continuum.map(frame => ({ frame, rgb: scaleRgb(CONTINUUM_RGB, 1 / continuum.length), role: 'continuum' })),
    ...feature.map(frame => ({ frame, rgb: scaleRgb(FEATURE_RGB, 1 / feature.length), role: 'feature' }))];
}
function applyMix() {
  if (theme() === 'rgb') {                                  // the whole range squeezed onto blue, green and red
    setTop(new URL('/hips/spherex-color', location.href).href, 'SPHEREx infrared RGB');
    return;
  }
  const rv = rgbView();
  if (rv) {
    setTop(new URL(`/hips/spherex-mix/${rv.um.map(nearestSlice).join('-')}`, location.href).href, `SPHEREx ${t(rv.key)}`);
    return;
  }
  const layers = mixLayers();
  if (!layers) { setTop(null); return; }                    // one wavelength: regular or inverted
  // FRAME_GAIN is the measured white balance of each plane: an ordinary star comes out white
  const spec = layers.map(l => layerSpec(l.frame, l.rgb, FRAME_GAIN[l.frame] ?? 1)).join('_');
  setTop(new URL(`/hips/spherex-mix/${spec}`, location.href).href, 'SPHEREx false colour');
}

/** The theme just changed (here or in the blink viewer): colours of the map, then its controls. */
function applyTheme() {
  $('mapWrap').dataset.pal = theme() === 'invert' ? 'invert' : 'gray';
  buildMix();
  applyMix();
}
document.addEventListener('radians:palette', applyTheme);

function buildMix() {
  const m = extra.mix, l = L(), th = theme();
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  $('mixModes').replaceChildren(...THEMES.map((name) => {
    const b = el('button', 'mapchip' + (th === name ? ' on' : ''), t(THEME_KEYS[name]));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(th === name));
    b.onclick = () => setPalette(name);                    // announces 'radians:palette': applyTheme() follows
    return b;
  }));
  $('mapOne').hidden = th !== 'gray' && th !== 'invert';   // the wavelength slider belongs to one wavelength
  $('mixFalse').hidden = !$('mapOne').hidden;
  const body = $('mixBody');
  body.replaceChildren();
  if (th === 'rgb') {
    const legend = el('div', 'mixlegend');
    for (const [col, key] of [['#5aa2ff', 'mixRgbBlue'], ['#5fe07a', 'mixRgbGreen'], ['#ff5a4f', 'mixRgbRed']]) {
      const sp = el('span'), dot = el('i');
      dot.style.background = col;
      sp.append(dot, t(key));
      legend.append(sp);
    }
    body.append(el('p', 'mixtext', t('mixRgbHelp')), legend, el('p', 'small dim', t('mixUsesServer')));
  } else if (th === 'science') {
    // one chip per feature: a dot in the colour its wavelength gets in the colour theme, its name, its wavelength
    const row = el('div', 'chips');
    const chip = (id, name, dotCss, wave, tip) => {
      const b = el('button', 'mapchip' + (id === m.preset ? ' on' : ''));
      b.type = 'button';
      if (tip) b.title = tip;
      const dot = el('i');
      dot.style.background = dotCss;
      b.append(dot, name);
      if (wave) b.append(el('span', 'mono', wave));
      b.onclick = () => { m.preset = id; buildMix(); applyMix(); };
      return b;
    };
    for (const p of SCI_PRESETS) row.append(chip(p.id, p[`name_${l}`], rgbToHex(rainbowTint(p.um)), um(p.um)));
    for (const v of RGB_VIEWS) row.append(chip(v.id, t(v.key), 'conic-gradient(#ff5a4f 0 33%, #5fe07a 0 66%, #5aa2ff 0)', '', t('mixThree')));
    const head = el('div', 'maprow');
    head.append(el('span', 'maplabel mono', t('mixFeatures')), row);
    const rv = rgbView();
    if (rv) {                                             // red, green and blue: one wavelength each
      const three = el('div', 'mixlegend');
      ['#ff5a4f', '#5fe07a', '#5aa2ff'].forEach((col, k) => {
        const sp = el('span'), dot = el('i');
        dot.style.background = col;
        sp.append(dot, um(CUBE_WL[nearestSlice(rv.um[k])]));
        three.append(sp);
      });
      body.append(head, el('p', 'mixtext', t(rv.key + 'Tip')), three, el('p', 'small dim', t('mixThree')), el('p', 'small dim', t('mixUsesServer')));
      return;
    }
    const p = SCI_PRESETS.find(x => x.id === m.preset) || SCI_PRESETS[0];
    const legend = el('div', 'mixlegend');
    const item = (rgb, key, waves) => { const s = el('span'); const i = el('i'); i.style.background = rgbToHex(rgb); s.append(i, `${t(key)} (${waves.map(um).join(', ')})`); return s; };
    legend.append(item(FEATURE_RGB, 'mixFeature', p.feature_um), item(CONTINUUM_RGB, 'mixContinuum', p.continuum_um));
    body.append(head, el('p', 'mixtext', p[`blurb_${l}`]), legend, el('p', 'small dim', NOTES[`science_${l}`]));
    const pin = extra.pins.find(x => x.id === p.pin) || null;
    if (pin) {
      const go = el('button', 'btn sm', `${t('mixGoodSpot')}: ${pin[`name_${l}`]}`);
      go.type = 'button';
      go.onclick = () => { flyTo(pin.ra_now, pin.dec_now, `pin:${pin.id}`); map.aladin.setFoV(pin.kind === 'star' || pin.moving ? 3 : 8); };
      body.append(go);
    }
    body.append(el('p', 'small dim', t('mixUsesServer')));
  }
}

// ---------------------------------------------------------------- famous objects (the engine's curated pins)
async function loadPins() {
  let pins = [];
  try { pins = await fetch(new URL('api/pins', location.href)).then(r => (r.ok ? r.json() : [])); } catch { /* the map works without them */ }
  // the five challenge targets already have their own amber markers
  extra.pins = pins.filter(p => Number.isFinite(p.ra_now) && Number.isFinite(p.dec_now));
  const famous = extra.pins.filter(p => p.kind !== 'target');
  if (famous.length && window.A && map.aladin) {
    extra.catalog = window.A.catalog({ name: 'Famous', color: '#8cc8ff', sourceSize: 11, shape: 'circle' });
    extra.catalog.addSources(famous.map(p => window.A.source(p.ra_now, p.dec_now, { q: `pin:${p.id}` })));
    map.aladin.addCatalog(extra.catalog);
    if (!famousOn()) extra.catalog.hide();
  }
  syncFamous();
  buildFamous();
  if (theme() === 'science') buildMix();                  // the "good example" button needs the pins
}
function buildFamous() {
  const l = L();
  $('mapChipsF').replaceChildren(...extra.pins.filter(p => p.kind !== 'target').map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mapchip f';
    b.title = p[`blurb_${l}`] || '';
    b.append(document.createElement('i'), p[`name_${l}`]);
    b.onclick = () => flyTo(p.ra_now, p.dec_now, `pin:${p.id}`);
    return b;
  }));
}

document.addEventListener('radians:lang', () => {
  buildPresets(); buildChips(); hidePop(); showPick(map.pick ?? map.slice); deepChip();
  buildMix(); buildFamous();
});
