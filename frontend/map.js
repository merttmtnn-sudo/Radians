// "Map": the whole sky as SPHEREx sees it (the DR1 all-sky cube from NASA/IPAC IRSA) in Aladin Lite,
// tinted in the colour of the chosen wavelength, with a 0.75-5 µm slider, an automatic wavelength tour,
// highlight wavelengths, the challenge and Explore targets marked and listed, and click-anywhere-to-blink.
import { t, getLang } from './i18n.js';
import { wlColor } from './charts.js';
import { CUBE_URL, CUBE_WL, BLANK, bandOf, nearestSlice, nextSlice } from './cube.js';
import { TARGETS, EXPLORE } from './facts.js';

const ALADIN_JS = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.6.5/dist/aladin.js';
const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const HOME = { ra: 266.4, dec: -28.9, fov: 200 };          // the Galactic centre, Milky Way across the middle
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
  root.classList.remove('in-app');
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
    });
    map.aladin.gotoRaDec(HOME.ra, HOME.dec);
    // a slice set before the layer is added is stored but not applied: set it again once the layer is ready
    map.hips = window.A.imageHiPS(CUBE_URL, { name: 'SPHEREx DR1', successCallback: () => setSlice(map.slice) });
    map.aladin.setImageSurvey(map.hips);
    // tint layer between the sky image and the markers, in the colour of the wavelength
    const div = $('skymapAladin');
    map.tint = document.createElement('div');
    map.tint.className = 'maptint';
    (div.querySelector('.aladin-imageCanvas') || div.firstChild).after(map.tint);
    setSlice(map.slice);
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
  for (const b of $('mapPresets').children) b.classList.toggle('on', Number(b.dataset.slice) === i);
  try { map.hips?.setSliceNumber(i); } catch { /* older Aladin: one plane only */ }
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

// ---------------------------------------------------------------- start
buildPresets();
buildChips();
if (new URLSearchParams(location.search).get('map') === '1') openMap(false);
document.addEventListener('radians:lang', () => { buildPresets(); buildChips(); hidePop(); setSlice(map.slice); stopTour(); });
