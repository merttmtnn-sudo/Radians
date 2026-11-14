// "Map": the whole sky as SPHEREx sees it (the DR1 all-sky cube from NASA/IPAC IRSA) in Aladin Lite,
// with a 0.75-5 µm wavelength slider, an automatic wavelength tour, the challenge and Explore
// targets marked, and click-anywhere-to-blink.
import { t, getLang } from './i18n.js';
import { wlColor } from './charts.js';
import { CUBE_URL, CUBE_WL, BLANK, bandOf, nearestSlice, nextSlice } from './cube.js';
import { TARGETS, EXPLORE } from './facts.js';

const ALADIN_JS = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.6.5/dist/aladin.js';
const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const map = { aladin: null, hips: null, slice: nearestSlice(2.2), timer: null, objectHit: false, down: null };

// ---------------------------------------------------------------- open / close
function openMap(push = true) {
  root.classList.remove('in-app');
  root.classList.add('in-map');
  if (push) {
    const u = new URL(location.href);
    u.search = '?map=1';
    history.pushState(null, '', u);
  }
  window.scrollTo(0, 0);
  initMap();
}
function closeMap() { root.classList.remove('in-map'); stopTour(); hidePop(); }
for (const b of document.querySelectorAll('[data-map]')) b.onclick = (e) => { e.preventDefault(); openMap(); };
document.addEventListener('radians:run', closeMap);
addEventListener('popstate', () => { if (new URLSearchParams(location.search).get('map') === '1') openMap(false); else closeMap(); });

// ---------------------------------------------------------------- the map
async function initMap() {
  if (map.aladin) return;
  try {
    if (!window.A) window.A = (await import(ALADIN_JS)).default;
    await window.A.init;
    map.aladin = window.A.aladin('#skymapAladin', {
      fov: 200, cooFrame: 'galactic', projection: 'AIT', showReticle: false,
      showLayersControl: false, showFullscreenControl: true, showCooGridControl: true, showSimbadPointerControl: false,
      showProjectionControl: false, showFrame: true, showZoomControl: true,
    });
    map.aladin.gotoRaDec(266.4, -28.9);                // the Galactic centre, Milky Way across the middle
    map.hips = window.A.imageHiPS(CUBE_URL, { name: 'SPHEREx DR1', successCallback: () => setSlice(map.slice) });
    map.aladin.setImageSurvey(map.hips);
    setSlice(map.slice);
    addMarkers();
    const div = $('skymapAladin');
    div.addEventListener('pointerdown', (e) => { map.down = [e.clientX, e.clientY]; map.objectHit = false; });
    div.addEventListener('pointerup', (e) => {
      const d = map.down;
      map.down = null;
      if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4) return;      // a drag, not a click
      setTimeout(() => { if (!map.objectHit) clickAt(e); }, 30);
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
  try { map.hips?.setSliceNumber(i); } catch { /* older Aladin: one plane only */ }
}

// coloured strip under the slider, same colours as the spectrum chart
$('mapTicks').replaceChildren(...[0.75, 1, 2, 3, 4, 5].map((w) => {
  const s = document.createElement('span');
  s.textContent = w === 5 ? '5 µm' : String(w);
  s.style.left = `${nearestSlice(w) / 101 * 100}%`;
  return s;
}));
$('mapStrip').style.background = `linear-gradient(90deg, ${CUBE_WL.filter((_, i) => i % 3 === 0).map(wlColor).join(', ')})`;
$('mapWl').oninput = () => { stopTour(); let i = Number($('mapWl').value); if (BLANK.has(i)) i = 52; setSlice(i); };

// automatic wavelength tour: 0.75 -> 5 µm and round again
function stopTour() { clearInterval(map.timer); map.timer = null; $('mapPlay').textContent = '▶'; $('mapPlay').setAttribute('aria-label', t('mapPlay')); }
$('mapPlay').onclick = () => {
  if (map.timer) { stopTour(); return; }
  $('mapPlay').textContent = '⏸';
  $('mapPlay').setAttribute('aria-label', t('mapPause'));
  map.timer = setInterval(() => setSlice(nextSlice(map.slice)), 260);
};

// ---------------------------------------------------------------- markers
function addMarkers() {
  const A = window.A;
  const mk = (name, color, size, list) => {
    const c = A.catalog({ name, color, sourceSize: size, shape: 'circle' });
    c.addSources(list.map(x => A.source(x.ra, x.dec, { name: x.label, q: x.q })));
    map.aladin.addCatalog(c);
    return c;
  };
  mk(t('mapChallenge'), '#ffb347', 16, TARGETS.map(x => ({ ra: x.ra, dec: x.dec, q: x.q, label: x.q })));
  // Explore stars: positions come from the resolver, cached by the server
  Promise.all(EXPLORE.map(x => fetch(new URL(`api/resolve?q=${encodeURIComponent(x.q)}`, location.href)).then(r => (r.ok ? r.json() : null)).catch(() => null)))
    .then(rs => {
      const ok = rs.map((r, k) => (r ? { ra: r.ra, dec: r.dec, q: EXPLORE[k].q, label: EXPLORE[k].q } : null)).filter(Boolean);
      if (ok.length) mk(t('mapExplore'), '#ffffff', 11, ok);
    });
  map.aladin.on('objectClicked', (obj) => {
    if (!obj || !obj.data || !obj.data.q) return;
    map.objectHit = true;
    showPop(obj.ra, obj.dec, obj.data.q, labelOf(obj.data.q));
  });
}

// ---------------------------------------------------------------- click -> blink here
function clickAt(e) {
  const r = $('skymapAladin').getBoundingClientRect();
  let radec = null;
  try { radec = map.aladin.pix2world(e.clientX - r.left, e.clientY - r.top, 'icrs'); } catch { /* outside the sky */ }
  if (!radec || !Number.isFinite(radec[0])) { hidePop(); return; }
  showPop(radec[0], radec[1], null, null, [e.clientX - r.left, e.clientY - r.top]);
}

function showPop(ra, dec, q, name, at) {
  const pop = $('mapPop');
  const r = $('skymapAladin').getBoundingClientRect();
  const [x, y] = at || (() => { try { return map.aladin.world2pix(ra, dec); } catch { return [r.width / 2, r.height / 2]; } })();
  const nice = q ? q.replace('eps Indi B', 'ε Indi B') : '';
  $('mapPopTitle').textContent = q ? (name && name !== nice ? (TARGETS.some(x => x.q === q) ? `${nice} · ${name}` : name) : nice) : t('mapHere');
  $('mapPopPos').textContent = `RA ${(+ra).toFixed(4)}°  Dec ${(+dec).toFixed(4)}°`;
  pop.dataset.q = q || `${(+ra).toFixed(5)} ${(+dec).toFixed(5)}`;
  pop.hidden = false;
  pop.style.left = `${Math.min(r.width - pop.offsetWidth - 8, Math.max(8, x + 12))}px`;
  pop.style.top = `${Math.min(r.height - pop.offsetHeight - 8, Math.max(8, y + 12))}px`;
}
function labelOf(q) {
  const l = getLang() === 'tr' ? 'tr' : 'en';
  const tg = TARGETS.find(x => x.q === q);
  if (tg) return tg[l].kind;
  const ex = EXPLORE.find(x => x.q === q);
  return ex ? ex[l].split(':')[0] : null;
}
function hidePop() { $('mapPop').hidden = true; }
$('mapPopClose').onclick = hidePop;
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
if (new URLSearchParams(location.search).get('map') === '1') openMap(false);
document.addEventListener('radians:lang', () => setSlice(map.slice));
