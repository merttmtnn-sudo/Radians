// "Map": the whole sky as SPHEREx sees it (the DR1 all-sky cube from NASA/IPAC IRSA) in Aladin Lite,
// tinted in the colour of the chosen wavelength, with a 0.75-5 µm slider, an automatic wavelength tour,
// highlight wavelengths, the challenge and Explore targets marked and listed, and click-anywhere-to-blink.
import { t, getLang } from '../core/i18n.js';
import { wlColor } from '../core/charts.js';
import { CUBE_URL, CUBE_WL, BLANK, bandOf, nearestSlice, nextSlice } from '../core/cube.js';
import { TARGETS, EXPLORE } from '../content/facts.js';
import { decodeB64, percentiles, stretchValue } from '../blink/sky.js';
import { MAP_PALETTES, getPalette, setPalette, gradient, paletteFilters } from '../core/palette.js';

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


// Famous sights for anyone who just wants to look around: fixed J2000 positions, one line each.
const FAMOUS = [
  { q: 'M42', ra: 83.822, dec: -5.391, en: ['Orion Nebula', 'A star nursery 1,300 light-years away; in the infrared you see through its dust.'], tr: ['Orion Bulutsusu', '1.300 ışık yılı ötede bir yıldız doğumevi; kızılötesinde tozunun içini görürsünüz.'] },
  { q: 'Betelgeuse', ra: 88.793, dec: 7.407, en: ['Betelgeuse', 'A red supergiant so large it would swallow Jupiter’s orbit; it will one day explode.'], tr: ['Betelgeuse', 'Jüpiter’in yörüngesini yutacak kadar büyük bir kızıl süperdev; bir gün patlayacak.'] },
  { q: 'Rigel', ra: 78.634, dec: -8.202, en: ['Rigel', 'A blue supergiant tens of thousands of times brighter than the Sun.'], tr: ['Rigel', 'Güneş’ten on binlerce kat parlak mavi bir süperdev.'] },
  { q: 'Sirius', ra: 101.287, dec: -16.716, en: ['Sirius', 'The brightest star in the night sky, 8.6 light-years away, with a white-dwarf companion.'], tr: ['Sirius', 'Gece gökyüzünün en parlak yıldızı, 8,6 ışık yılı ötede, beyaz cüce bir eşi var.'] },
  { q: 'Vega', ra: 279.235, dec: 38.784, en: ['Vega', 'The star that once defined magnitude zero; a dusty disc circles it.'], tr: ['Vega', 'Bir zamanlar sıfır kadiri tanımlayan yıldız; çevresinde tozlu bir disk var.'] },
  { q: 'Polaris', ra: 37.955, dec: 89.264, en: ['Polaris', 'The North Star: the sky turns around this point.'], tr: ['Kutup Yıldızı', 'Gökyüzü bu noktanın çevresinde döner.'] },
  { q: 'M45', ra: 56.75, dec: 24.117, en: ['Pleiades', 'The Seven Sisters: a young cluster drifting through a dust cloud.'], tr: ['Ülker', 'Yedi Kız Kardeş: bir toz bulutunun içinden geçen genç bir küme.'] },
  { q: 'M31', ra: 10.685, dec: 41.269, en: ['Andromeda Galaxy', 'Our big neighbour, 2.5 million light-years away; it will merge with the Milky Way.'], tr: ['Andromeda Gökadası', '2,5 milyon ışık yılı ötedeki büyük komşumuz; Samanyolu ile birleşecek.'] },
  { q: 'M1', ra: 83.633, dec: 22.015, en: ['Crab Nebula', 'What is left of a star that exploded in 1054, seen by astronomers in China.'], tr: ['Yengeç Bulutsusu', '1054’te patlayan, Çinli gökbilimcilerin gördüğü bir yıldızın kalıntısı.'] },
  { q: 'eta Car', ra: 161.265, dec: -59.685, en: ['Eta Carinae', 'A giant star that brightened hugely in the 1840s and hides in its own dust.'], tr: ['Eta Carinae', '1840’larda çok parlayan ve kendi tozunun içine gizlenen dev bir yıldız.'] },
  { q: 'Sgr A*', ra: 266.417, dec: -29.008, en: ['Galactic centre', 'A black hole of four million Suns sits here, behind dust that infrared light gets through.'], tr: ['Gökada merkezi', 'Burada dört milyon Güneş kütleli bir kara delik var; kızılötesi ışık önündeki tozu aşar.'] },
  { q: 'LMC', ra: 80.894, dec: -69.756, en: ['Large Magellanic Cloud', 'A small galaxy circling ours, 160,000 light-years away.'], tr: ['Büyük Macellan Bulutu', 'Gökadamızın çevresinde dönen küçük bir gökada, 160.000 ışık yılı ötede.'] },
  { q: 'SMC', ra: 13.187, dec: -72.829, en: ['Small Magellanic Cloud', 'The Large Cloud’s little sibling, stretched by its pull.'], tr: ['Küçük Macellan Bulutu', 'Büyük Bulut’un küçük kardeşi, onun çekimiyle uzamış.'] },
  { q: 'M57', ra: 283.396, dec: 33.029, en: ['Ring Nebula', 'A dying Sun-like star blowing off its outer layers.'], tr: ['Halka Bulutsusu', 'Dış katmanlarını savuran, ölmekte olan Güneş benzeri bir yıldız.'] },
  { q: 'M16', ra: 274.7, dec: -13.807, en: ['Eagle Nebula', 'Home of the Pillars of Creation, columns of gas where stars form.'], tr: ['Kartal Bulutsusu', 'Yıldızların doğduğu gaz sütunları, Yaratılış Sütunları burada.'] },
  { q: 'M8', ra: 270.904, dec: -24.387, en: ['Lagoon Nebula', 'A glowing cloud of hydrogen lit by hot young stars.'], tr: ['Lagün Bulutsusu', 'Sıcak genç yıldızların aydınlattığı parlak bir hidrojen bulutu.'] },
  { q: 'Antares', ra: 247.352, dec: -26.432, en: ['Antares', 'The red heart of the Scorpion, a supergiant in a dusty neighbourhood.'], tr: ['Antares', 'Akrep’in kızıl kalbi; tozlu bir mahallede bir süperdev.'] },
  { q: 'Aldebaran', ra: 68.98, dec: 16.509, en: ['Aldebaran', 'The orange eye of the Bull, a giant star 65 light-years away.'], tr: ['Aldebaran', 'Boğa’nın turuncu gözü, 65 ışık yılı ötede dev bir yıldız.'] },
  { q: 'Proxima Cen', ra: 217.429, dec: -62.68, en: ['Proxima Centauri', 'The nearest star to the Sun, 4.2 light-years away, with a planet.'], tr: ['Proxima Centauri', 'Güneş’e en yakın yıldız, 4,2 ışık yılı ötede; bir gezegeni var.'] },
  { q: 'rho Oph', ra: 246.396, dec: -23.447, en: ['Rho Ophiuchi cloud', 'One of the nearest star-forming clouds, full of baby stars only infrared shows.'], tr: ['Rho Ophiuchi bulutu', 'En yakın yıldız doğum bulutlarından; yalnızca kızılötesinin gösterdiği bebek yıldızlarla dolu.'] },
  { q: 'Horsehead Nebula', ra: 85.245, dec: -2.458, en: ['Horsehead Nebula', 'A dark cloud shaped like a horse’s head against glowing gas.'], tr: ['Atbaşı Bulutsusu', 'Parlayan gazın önünde at başı biçiminde karanlık bir bulut.'] },
  { q: 'M51', ra: 202.47, dec: 47.195, en: ['Whirlpool Galaxy', 'A spiral galaxy pulling on a smaller companion.'], tr: ['Girdap Gökadası', 'Küçük bir eşini çeken sarmal bir gökada.'] },
];
const famousOn = () => { try { return localStorage.getItem('radians-famous') !== '0'; } catch { return true; } };

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
      survey: TWOMASS_URL,                            // placeholder until the SPHEREx layer is up: IRSA, not CDS (whose DSS answered 404)
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
    map.aladin.on('zoomChanged', () => { deepChip(); twoMass(); });
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
  map.famous = A.catalog({ name: 'Famous', color: '#8cc8ff', sourceSize: 12, shape: 'circle' });
  map.famous.addSources(FAMOUS.map(x => A.source(x.ra, x.dec, { q: x.q })));
  map.aladin.addCatalog(map.famous);
  if (!famousOn()) map.famous.hide();
  syncFamous();
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

function syncFamous() {
  const on = famousOn();
  $('mapFamousT').setAttribute('aria-pressed', String(on));
}
$('mapFamousT').onclick = () => {
  const on = !famousOn();
  try { localStorage.setItem('radians-famous', on ? '1' : '0'); } catch { /* private window */ }
  try { on ? map.famous?.show() : map.famous?.hide(); } catch { /* older Aladin */ }
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
  const fm = !tg && !ex && q && FAMOUS.find(x => x.q === q);
  pop.dataset.kind = tg ? 'c' : ex ? 'e' : fm ? 'f' : 'p';
  $('mapPopKind').textContent = t(tg ? 'mapKindChallenge' : ex ? 'mapKindExplore' : fm ? 'mapKindFamous' : 'mapKindPoint');
  $('mapPopTitle').textContent = tg ? nice(q) : ex ? ex[l].split(':')[0] : fm ? fm[l][0] : t('mapHere');
  const sub = tg ? tg[l].kind : ex ? cap(ex[l].split(':').slice(1).join(':').trim()) : fm ? fm[l][1] : '';
  $('mapPopSub').textContent = sub;
  $('mapPopSub').hidden = !sub;
  const d = +dec;
  $('mapPopPos').textContent = `RA ${(+ra).toFixed(4)}°   Dec ${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(4)}°`;
  pop.dataset.q = q || `${(+ra).toFixed(5)} ${d.toFixed(5)}`;
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
  twoMass();
}
$('mapDeepGo').onclick = loadDeep;

// Closer still, past what any SPHEREx picture holds, the map fades to 2MASS (IRSA's copy of the CDS colour
// HiPS: J, H, Ks at 1″) and says so on screen. Not while a SPHEREx deep picture is shown: that one wins.
const TWOMASS_URL = 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color';
const TM_FROM = 0.25, TM_FULL = 0.08;   // degrees: start fading in / fully 2MASS
function twoMass() {
  if (!map.aladin) return;
  let fov = 180;
  try { fov = map.aladin.getFov()[0]; } catch { /* default */ }
  const a = deep.layer || deep.busy ? 0 : Math.max(0, Math.min(1, (TM_FROM - fov) / (TM_FROM - TM_FULL)));
  if (a > 0 && !map.tm) {
    try {
      map.tm = window.A.imageHiPS('radians-2mass', { url: TWOMASS_URL, name: '2MASS J H Ks', imgFormat: 'jpeg' });
      map.aladin.setOverlayImageLayer(map.tm, 'twomass');
    } catch { map.tm = null; }
  }
  try { map.tm?.setOpacity(a); } catch { /* older Aladin */ }
  $('mapTm').hidden = a < 0.05;
}
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
  twoMass();
};

// ---------------------------------------------------------------- start
buildPresets();
buildChips();
buildPals();
if (new URLSearchParams(location.search).get('map') === '1') openMap(false);
document.addEventListener('radians:lang', () => { buildPresets(); buildChips(); buildPals(); hidePop(); setSlice(map.slice); stopTour(); deepChip(); });
