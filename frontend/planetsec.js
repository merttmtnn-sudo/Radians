// Planetarium section (?sky=1): Emre Bozkaya's planetarium (frontend/planet/) in an iframe in "embed" mode,
// with a few simple controls drawn here in the style of the map page: time of night, constellations,
// colour, place and ready-made targets. Everything else sits behind one "Advanced" button.
import { t, getLang } from './i18n.js';
import { gradient } from './palette.js';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const sky = { frame: null, api: null, state: null, pal: 'rgb', cons: true, fast: false, adv: false, dragging: false };
try { sky.pal = localStorage.getItem('radians-skypal') || 'rgb'; } catch { /* private mode */ }

const PALS = { rgb: 'palRgb', gray: 'palGray', inferno: 'palInferno', viridis: 'palViridis' };
const PLACES = [[0, 'İstanbul'], [1, 'Ankara'], [2, 'İzmir'], ['geo', null]];
const FAMOUS = [
  { k: 'name', x: 'M42', en: 'Orion Nebula', tr: 'Orion Bulutsusu' },
  { k: 'name', x: 'M31', en: 'Andromeda Galaxy', tr: 'Andromeda Gökadası' },
  { k: 'name', x: 'M45', en: 'Pleiades', tr: 'Ülker' },
  { k: 'point', x: { name: 'Sgr A*', type: 'Galactic centre', ra: 266.41683, dec: -29.00781 }, en: 'Centre of the Milky Way', tr: 'Samanyolu’nun merkezi' },
];
const CHALLENGE = [['barnard', "Barnard's Star"], ['epsindb', 'Epsilon Indi B'], ['wise0855', 'WISE 0855−0714'], ['rwaur', 'RW Aurigae'], ['rdra', 'R Draconis']];
const PLANETS = [['moon', 'Moon', 'Ay'], ['venus', 'Venus', 'Venüs'], ['mars', 'Mars', 'Mars'], ['jupiter', 'Jupiter', 'Jüpiter'], ['saturn', 'Saturn', 'Satürn']];

// ---------------------------------------------------------------- open / close (like the map)
function openSky(push = true) {
  root.classList.remove('in-app', 'in-map');
  root.classList.add('in-sky');
  document.dispatchEvent(new Event('radians:sky'));
  if (push) history.pushState(null, '', location.pathname + '?sky=1');
  for (const a of document.querySelectorAll('.navsky')) a.setAttribute('aria-current', 'page');
  window.scrollTo(0, 0);
  if (!sky.frame) load();
}
function closeSky() {
  root.classList.remove('in-sky');
  for (const a of document.querySelectorAll('.navsky')) a.removeAttribute('aria-current');
}
for (const b of document.querySelectorAll('[data-sky]')) b.onclick = (e) => { e.preventDefault(); openSky(); };
for (const a of document.querySelectorAll('.nav .navl, [data-map]')) a.addEventListener('click', () => closeSky());
document.addEventListener('radians:run', closeSky);
addEventListener('popstate', () => { if (new URLSearchParams(location.search).get('sky') === '1') openSky(false); else closeSky(); });

function load() {
  sky.frame = document.createElement('iframe');
  sky.frame.title = 'Planetarium';
  sky.frame.allow = 'fullscreen; geolocation';
  sky.frame.src = `planet/?embed=1&lang=${getLang()}`;
  sky.frame.onload = () => {
    sky.api = null;
    const ready = () => {
      const api = sky.frame.contentWindow?.radiansSky;
      if (!api) return setTimeout(ready, 200);
      sky.api = api;
      api.setPalette(sky.pal);
      api.setCons(sky.cons);
      if (sky.fast) api.setRate(900);
    };
    ready();
  };
  $('skyFrame').replaceChildren(sky.frame);
}

addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.type === 'sky-state') { sky.state = e.data; showState(); }
  if (e.data.type === 'sky-blink') {
    const l = getLang() === 'tr' ? '&lang=tr' : '';
    location.href = `${location.pathname}?ra=${e.data.ra.toFixed(5)}&dec=${e.data.dec.toFixed(5)}${l}`;
  }
});

// ---------------------------------------------------------------- time of night
// The slider covers one night, 18:00 to 06:00; before noon "tonight" is the night that is ending.
function nightStart() {
  const d = new Date();
  if (d.getHours() < 12) d.setDate(d.getDate() - 1);
  d.setHours(18, 0, 0, 0);
  return d.getTime();
}
const pad = (n) => String(n).padStart(2, '0');
function showState() {
  const s = sky.state;
  if (!s) return;
  const d = new Date(s.ms);
  $('skyClock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const live = Math.abs(s.ms - Date.now()) < 120000 && s.rate === 1;
  const tr = getLang() === 'tr';
  $('skyWhen').textContent = live ? t('skyLive') : d.toLocaleDateString(tr ? 'tr-TR' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  $('skyNow').classList.toggle('on', live);
  if (!sky.dragging) $('skyTime').value = Math.max(0, Math.min(720, (s.ms - nightStart()) / 60000));
  for (const b of $('skyPlaces').children) b.classList.toggle('on', b.dataset.name === s.loc || (b.dataset.i === 'geo' && s.loc === 'My location'));
  $('skyCons').setAttribute('aria-pressed', String(!!s.cons));
}
$('skyTime').addEventListener('pointerdown', () => { sky.dragging = true; });
addEventListener('pointerup', () => { sky.dragging = false; });
$('skyTime').oninput = () => {
  sky.api?.setTime(nightStart() + Number($('skyTime').value) * 60000);
  if (sky.state) { sky.state.ms = nightStart() + Number($('skyTime').value) * 60000; showState(); }
};
$('skyNow').onclick = () => { sky.fast = false; $('skyPlay').classList.remove('on'); sky.api?.now(); };
$('skyPlay').onclick = () => {
  sky.fast = !sky.fast;
  $('skyPlay').classList.toggle('on', sky.fast);
  sky.api?.setRate(sky.fast ? 900 : 1);          // 15 minutes of sky per second: watch it turn
};
$('skyTicks').replaceChildren(...['18:00', '21:00', '00:00', '03:00', '06:00'].map((h) => {
  const s = document.createElement('span');
  s.textContent = h;
  return s;
}));

// ---------------------------------------------------------------- chips
function chip(label, onclick, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mapchip ' + cls;
  b.textContent = label;
  b.onclick = onclick;
  return b;
}
function build() {
  const tr = getLang() === 'tr';
  $('skyPals').replaceChildren(...Object.entries(PALS).map(([p, key]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.pal = p;
    b.setAttribute('aria-pressed', String(p === sky.pal));
    const sw = document.createElement('i');
    sw.style.background = gradient(p);
    b.append(sw, document.createTextNode(t(key)));
    b.onclick = () => {
      sky.pal = p;
      try { localStorage.setItem('radians-skypal', p); } catch { /* private mode */ }
      for (const c of $('skyPals').children) c.setAttribute('aria-pressed', String(c.dataset.pal === p));
      sky.api?.setPalette(p);
    };
    return b;
  }));
  $('skyPlaces').replaceChildren(...PLACES.map(([i, name]) => {
    const b = chip(name || t('skyMyLoc'), () => sky.api?.setPlace(i));
    b.dataset.i = i;
    if (name) b.dataset.name = { 0: 'Istanbul, Türkiye', 1: 'Ankara, Türkiye', 2: 'İzmir, Türkiye' }[i];
    return b;
  }));
  $('skyFamous').replaceChildren(...FAMOUS.map((f) => chip(tr ? f.tr : f.en, () => sky.api?.goto(f.k, f.x))));
  $('skyChallenge').replaceChildren(...CHALLENGE.map(([id, n]) => chip(n, () => sky.api?.goto('test', id), 'c')));
  $('skyPlanets').replaceChildren(...PLANETS.map(([id, en, trn]) => chip(tr ? trn : en, () => sky.api?.goto('body', id))));
  for (const c of $('skyChallenge').children) c.prepend(document.createElement('i'));
  showState();
}
$('skyCons').onclick = () => {
  sky.cons = !sky.cons;
  $('skyCons').setAttribute('aria-pressed', String(sky.cons));
  sky.api?.setCons(sky.cons);
};
$('skyAdv').onclick = () => {
  sky.adv = !sky.adv;
  $('skyAdv').setAttribute('aria-pressed', String(sky.adv));
  sky.api?.advanced(sky.adv);
};
$('skyFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('skyWrap').requestFullscreen?.());

build();
document.addEventListener('radians:lang', () => {
  build();
  if (sky.frame) { sky.adv = false; $('skyAdv').setAttribute('aria-pressed', 'false'); load(); }
});
if (root.classList.contains('in-sky')) openSky(false);
