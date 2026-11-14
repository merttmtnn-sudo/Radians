// "Map": the whole sky as SPHEREx sees it (the DR1 all-sky cube from NASA/IPAC IRSA) in Aladin Lite,
// tinted in the colour of the chosen wavelength, with a 0.75-5 µm slider, an automatic wavelength tour,
// highlight wavelengths, the challenge and Explore targets marked and listed, and click-anywhere-to-blink.
import { t, getLang } from './i18n.js';
import { wlColor } from './charts.js';
import { CUBE_URL, CUBE_WL, BLANK, bandOf, nearestSlice, nextSlice } from './cube.js';
import { TARGETS, EXPLORE } from './facts.js';
import { decodeB64, percentiles, stretchValue } from './sky.js';
import { MAP_PALETTES, getPalette, setPalette, gradient, paletteFilters } from './palette.js';

const ALADIN_JS = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.6.5/dist/aladin.js';
const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const HOME = { ra: 266.4, dec: -28.9, fov: 200 };          // the Galactic centre, Milky Way across the middle
const DEEP_FOV = 0.7;        // degrees: closer than this the all-sky map's 13″ pixels are only being magnified
const P = new URLSearchParams(location.search);

const map = { aladin: null, hips: null, tint: null, slice: nearestSlice(2.2), timer: null, objectHit: false, down: null, coords: new Map() };

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
  { um: 4.27, en: 'CO₂ ice', tr: 'CO₂ buzu',
    tipEn: 'The absorption band of frozen carbon dioxide.', tipTr: 'Donmuş karbondioksitin soğurma bandı.' },
];

const L = () => (getLang() === 'tr' ? 'tr' : 'en');
// the names the landing page's cards use
const NAMES = { 'eps Indi B': 'ε Indi B', 'WISE J085510.83-071442.5': 'WISE 0855−0714', 'RW Aur': 'RW Aurigae', 'R Dra': 'R Draconis' };
const nice = (q) => NAMES[q] || q;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- open / close
function openMap(push = true) {
  root.classList.remove('in-app', 'in-sky');
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
  stopTour();
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
document.addEventListener('radians:sky', closeMap);
addEventListener('popstate', () => { if (new URLSearchParams(location.search).get('map') === '1') openMap(false); else closeMap(); });

// ---------------------------------------------------------------- the map
async function initMap() {
  if (map.aladin) return;
  try {
    if (!window.A) window.A = (await import(ALADIN_JS)).default;
    await window.A.init;
    map.aladin = window.A.aladin('#skymapAladin', {
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
    // a slice set before the layer is added is stored but not applied: set it again once the layer is ready
    // Pixels with no data are transparent in IRSA's tiles, and they sit where one detector is masked. Underneath
    // the chosen plane sits the same channel from a neighbouring band (another detector, see fillOf), so a hole
    // shows SPHEREx sky at a nearby wavelength instead of black.
    // (A second id for the same cube keeps Aladin from treating the two layers as one.)
    map.base = window.A.imageHiPS('radians-spherex-fill', { url: CUBE_URL, name: 'SPHEREx DR1 (fill)', successCallback: () => setFill(true) });
    map.aladin.setImageSurvey(map.base);
    map.hips = window.A.imageHiPS('radians-spherex', { url: CUBE_URL, name: 'SPHEREx DR1', successCallback: () => setSlice(map.slice) });
    map.aladin.setOverlayImageLayer(map.hips, 'spherex');
    map.aladin.on('zoomChanged', () => deepChip());
    // tint layer between the sky image and the markers, in the colour of the wavelength
    const div = $('skymapAladin');
    map.tint = document.createElement('div');
    map.tint.className = 'maptint';
    (div.querySelector('.aladin-imageCanvas') || div.firstChild).after(map.tint);
    setSlice(map.slice);
    setRgb(getPalette() === 'rgb');
    addMarkers();
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
    $('mapStatus').textContent = 'Aladin Lite: ' + err.message;
  }
}

function setSlice(i) {
  map.slice = i;
  $('mapWl').value = i;
  const w = CUBE_WL[i];
  $('mapWlVal').textContent = `${w.toFixed(3)} µm`;
  $('mapWlBand').textContent = `D${bandOf(i)} · ${i + 1}/102`;
  $('mapSwatch').style.background = wlColor(w);
  if (map.tint) map.tint.style.background = `color-mix(in srgb, ${wlColor(w)} 72%, #fff)`;
  if (getPalette() === 'tint') $('mapCbar').style.background = `linear-gradient(90deg, #000, ${wlColor(w)})`;
  for (const b of $('mapPresets').children) b.classList.toggle('on', Number(b.dataset.slice) === i);
  try { map.hips?.setSliceNumber(i); } catch { /* older Aladin: one plane only */ }
  setFill();
  prefetchSoon();
  deepChip();
}

// The fill plane: the same channel on the neighbouring band whose detector has (almost) no holes.
// Measured over all 12 order-0 tiles: D1, D3, D4 and D6 each have ~2,100 empty pixels, D2 and D5 ~50;
// D2 fills every hole of D1 and D3, D5 every hole of D4 and D6, and D3 / D4 fill D2 / D5.
const FILL_BAND = { 1: 2, 2: 3, 3: 2, 4: 5, 5: 4, 6: 5 };
function fillOf(i) {
  const band = FILL_BAND[bandOf(i)];
  let j = (band - 1) * 17 + (i % 17);
  if (BLANK.has(j)) j = band === 3 ? 49 : 52;            // the two dichroic channels are empty
  return j;
}
function setFill(now = false) {
  clearTimeout(map.fillTimer);
  map.fillTimer = setTimeout(() => {
    try { map.base?.setSliceNumber(fillOf(map.slice)); } catch { /* single plane */ }
  }, now ? 0 : (map.timer ? 1500 : 300));
}

// coloured strip under the slider, same colours as the spectrum chart; ticks at the plane of each wavelength
$('mapTicks').replaceChildren(...[0.75, 1, 2, 3, 4, 5].map((w) => {
  const s = document.createElement('span');
  s.textContent = w === 5 ? '5 µm' : String(w);
  s.style.left = `${nearestSlice(w) / 101 * 100}%`;
  return s;
}));
$('mapStrip').style.background = `linear-gradient(90deg, ${CUBE_WL.filter((_, i) => i % 3 === 0).map(wlColor).join(', ')})`;
$('mapWl').oninput = () => { stopTour(); let i = Number($('mapWl').value); if (BLANK.has(i)) i = 52; setSlice(i); };

// automatic wavelength tour: 0.75 -> 5 µm and round again
function stopTour() {
  clearInterval(map.timer);
  map.timer = null;
  $('mapPlay').classList.remove('on');
  $('mapPlay').setAttribute('aria-label', t('mapPlay'));
}
$('mapPlay').onclick = () => {
  if (map.timer) { stopTour(); return; }
  $('mapPlay').classList.add('on');
  $('mapPlay').setAttribute('aria-label', t('mapPause'));
  map.timer = setInterval(() => setSlice(nextSlice(map.slice)), 260);
};

// ---------------------------------------------------------------- colour palette
const PAL_KEYS = { gray: 'palGray', invert: 'palInvert', inferno: 'palInferno', viridis: 'palViridis', tint: 'palTint', rgb: 'palRgb' };
const PAL_TIPS = { gray: 'palTipGray', invert: 'palTipInvert', inferno: 'palTipInferno', viridis: 'palTipViridis', tint: 'palTipTint', rgb: 'palTipRgb' };
document.body.append(paletteFilters());
function buildPals() {
  $('mapPals').replaceChildren(...MAP_PALETTES.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.pal = p;
    b.title = t(PAL_TIPS[p]);
    const sw = document.createElement('i');
    sw.style.background = p === 'tint' ? `linear-gradient(90deg, ${[0.8, 1.5, 2.5, 3.5, 4.8].map(wlColor).join(', ')})` : gradient(p);
    b.append(sw, document.createTextNode(t(PAL_KEYS[p])));
    b.onclick = () => setPalette(p);
    return b;
  }));
  showPal();
}
function showPal() {
  const p = MAP_PALETTES.includes(getPalette()) ? getPalette() : 'gray';
  $('mapWrap').dataset.pal = p;
  for (const b of $('mapPals').children) b.setAttribute('aria-pressed', String(b.dataset.pal === p));
  $('mapCbar').style.background = p === 'tint' ? `linear-gradient(90deg, #000, ${wlColor(CUBE_WL[map.slice])})` : gradient(p);
  $('mapCbarName').textContent = p === 'rgb' ? `${t(PAL_KEYS[p])} · ${t('rgbBands')}` : t(PAL_KEYS[p]);
  setRgb(p === 'rgb');
}
// Infrared RGB: a colour HiPS the server builds from 12 planes of the cube (backend/app/explorer.py),
// laid over the single-wavelength layers only while it is chosen (so nobody else loads its tiles).
function setRgb(on) {
  if (!map.aladin || !window.A) return;
  try {
    if (on && !map.rgbOn) {
      map.rgb = map.rgb || window.A.imageHiPS('radians-spherex-rgb', { url: new URL('/hips/spherex-color', location.href).href, name: 'SPHEREx infrared RGB' });
      map.aladin.setOverlayImageLayer(map.rgb, 'rgb');
      map.rgbOn = true;
    } else if (!on && map.rgbOn) {
      map.aladin.removeImageLayer('rgb');
      map.rgbOn = false;
    }
  } catch (e) { console.warn('rgb layer', e); }
}
function setLevels(b, c) {
  $('mapWrap').style.setProperty('--mapbright', b);
  $('mapWrap').style.setProperty('--mapcontrast', c);
  $('mapBright').value = b;
  $('mapContrast').value = c;
  try { localStorage.setItem('radians-maplevels', `${b},${c}`); } catch { /* private mode */ }
}
$('mapBright').oninput = () => setLevels($('mapBright').value, $('mapContrast').value);
$('mapContrast').oninput = () => setLevels($('mapBright').value, $('mapContrast').value);
$('mapPalReset').onclick = () => { setLevels(0.95, 1.3); setPalette('gray'); };
try {
  const [b, c] = (localStorage.getItem('radians-maplevels') || '').split(',').map(Number);
  if (b > 0 && c > 0) setLevels(b, c);
} catch { /* private mode */ }
document.addEventListener('radians:palette', showPal);

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
    const dot = document.createElement('i');
    dot.style.background = wlColor(CUBE_WL[i]);
    const um = document.createElement('span');
    um.className = 'mono';
    um.textContent = `${CUBE_WL[i].toFixed(2)} µm`;
    b.append(dot, p[l], um);
    b.classList.toggle('on', i === map.slice);
    b.onclick = () => { stopTour(); setSlice(i); };
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
    stopTour();
    showPop(obj.ra, obj.dec, obj.data.q);
  });
}

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
  stopTour();
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
  stopTour();
  showPop(radec[0], radec[1], null, [e.clientX - r.left, e.clientY - r.top]);
}

function showPop(ra, dec, q, at) {
  const pop = $('mapPop');
  const l = L();
  const tg = q && TARGETS.find(x => x.q === q);
  const ex = q && EXPLORE.find(x => x.q === q);
  pop.dataset.kind = tg ? 'c' : ex ? 'e' : 'p';
  $('mapPopKind').textContent = t(tg ? 'mapKindChallenge' : ex ? 'mapKindExplore' : 'mapKindPoint');
  $('mapPopTitle').textContent = tg ? nice(q) : ex ? ex[l].split(':')[0] : t('mapHere');
  const sub = tg ? tg[l].kind : ex ? cap(ex[l].split(':').slice(1).join(':').trim()) : '';
  $('mapPopSub').textContent = sub;
  $('mapPopSub').hidden = !sub;
  const d = +dec;
  $('mapPopPos').textContent = `RA ${(+ra).toFixed(4)}°   Dec ${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(4)}°`;
  pop.dataset.q = q || `${(+ra).toFixed(5)} ${d.toFixed(5)}`;
  pop.hidden = false;
  const r = $('skymapAladin').getBoundingClientRect();
  const [x, y] = at || (() => { try { return map.aladin.world2pix(ra, dec) || [r.width / 2, r.height / 2]; } catch { return [r.width / 2, r.height / 2]; } })();
  pop.style.left = `${Math.min(r.width - pop.offsetWidth - 12, Math.max(12, x + 16))}px`;
  pop.style.top = `${Math.min(r.height - pop.offsetHeight - 12, Math.max(12, y + 16))}px`;
}
function hidePop() {
  $('mapPop').hidden = true;
  try { map.aladin?.unselectObjects?.(); } catch { /* older Aladin */ }
}
$('mapPopClose').onclick = hidePop;
addEventListener('keydown', (e) => { if (e.key === 'Escape' && root.classList.contains('in-map')) hidePop(); });
$('mapPopGo').onclick = () => {
  const q = $('mapPop').dataset.q;
  hidePop();
  stopTour();
  history.replaceState(null, '', location.pathname);
  $('q').value = q;
  // challenge targets keep their tuned settings (e.g. WISE 0855 on D5+D6)
  const card = [...document.querySelectorAll('#examples button[data-q]')].find(b => b.dataset.q === q);
  if (card) card.click(); else $('search').requestSubmit();
};

// ---------------------------------------------------------------- faster: fetch the next planes ahead of time
// Every tile the map shows is remembered; the same tiles of the next planes (and their fill planes) are fetched
// into the browser cache in the background, so the slider and the tour find them already downloaded.
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
function prefetchSoon() {
  clearTimeout(map.preTimer);
  map.preTimer = setTimeout(() => {
    const now = performance.now();
    const paths = [...seen].filter(([, t0]) => now - t0 < 15000).sort((x, y) => y[1] - x[1]).slice(0, 48).map(([k]) => k);
    if (!paths.length) return;
    const ahead = map.timer ? [1, 2, 3].map(k => { let j = map.slice; for (let q = 0; q < k; q++) j = nextSlice(j); return j; })
      : [nextSlice(map.slice), nextSlice(map.slice, -1)];
    queue.length = 0;                                     // only what is useful now
    for (const j of ahead) for (const path of paths) queue.push(tileUrl(path, j));
    for (const path of paths) queue.push(tileUrl(path, fillOf(ahead[0])));
    pump();
  }, map.timer ? 60 : 250);
}

// ---------------------------------------------------------------- deeper zoom: SPHEREx's own 6″ pixels
// Closer than DEEP_FOV the all-sky map only magnifies its 13″ pixels. The visitor can then load the real
// exposures of that spot (the same reader as the blink, one detector: the band of the chosen wavelength),
// stacked and laid over the map at SPHEREx's native 6.15″ pixels.
const deep = { layer: false, busy: false, det: null, n: 0, err: '' };
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
  else if (deep.layer) text = t('mapDeepShown', { det: deep.det, n: deep.n });
  else text = t('mapDeepOffer');
  $('mapDeepText').textContent = text;
  $('mapDeepGo').hidden = deep.busy || (deep.layer && deep.det === det && !deep.err);
  $('mapDeepGo').textContent = t(deep.err ? 'mapDeepRetry' : 'mapDeepGo', { det });
  $('mapDeepOff').hidden = !deep.layer || deep.busy;
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
    const q = new URLSearchParams({ ra: ra.toFixed(6), dec: dec.toFixed(6), fov, mode: 'epoch', detectors: String(deep.det),
      matched: 'false', candidates: 'false', job });
    const r = await fetch(new URL(`api/frames?${q}`, location.href));
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail === 'IRSA_UNAVAILABLE' || r.status >= 502 ? t('irsaDown') : data.detail === 'IRSA_FAILED' ? t('irsaFailed') : `HTTP ${r.status}`);
    if (!data.frames || !data.frames.length) throw new Error(t('mapDeepNone'));
    showDeep(data);
  } catch (e) {
    deep.err = e.message;
  } finally {
    clearInterval(poll);
    deep.busy = false;
    deepChip();
  }
}
function showDeep(data) {
  const g = data.grid, n = g.n;
  const imgs = data.frames.map(f => decodeB64(f.image, Float32Array));
  const sum = new Float64Array(n * n), cnt = new Uint16Array(n * n);
  for (const a of imgs) for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) { sum[i] += a[i]; cnt[i]++; }
  const st = new Float32Array(n * n);
  for (let i = 0; i < st.length; i++) st[i] = cnt[i] ? sum[i] / cnt[i] : NaN;
  const [lo, hi] = percentiles([st], [2, 99.8]);
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
  const s = g.pixel_scale / 3600;
  try { map.aladin.removeImageLayer('native'); } catch { /* none yet */ }
  const img = window.A.image(cv.toDataURL('image/png'), {
    name: `SPHEREx D${deep.det} 6″`, imgFormat: 'png',
    wcs: { NAXIS: 2, NAXIS1: n, NAXIS2: n, CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: g.ra, CRVAL2: g.dec,
      CRPIX1: (n + 1) / 2, CRPIX2: (n + 1) / 2, CDELT1: -s, CDELT2: s, RADESYS: 'ICRS', EQUINOX: 2000 },
  });
  map.aladin.setOverlayImageLayer(img, 'native');
  deep.layer = true;
  deep.n = data.n_exposures_read;
}
$('mapDeepGo').onclick = loadDeep;
$('mapDeepOff').onclick = () => {
  try { map.aladin.removeImageLayer('native'); } catch { /* gone */ }
  deep.layer = false;
  deep.err = '';
  deepChip();
};

// ---------------------------------------------------------------- start
buildPresets();
buildChips();
buildPals();
if (new URLSearchParams(location.search).get('map') === '1') openMap(false);
document.addEventListener('radians:lang', () => { buildPresets(); buildChips(); buildPals(); hidePop(); setSlice(map.slice); stopTour(); deepChip(); });
