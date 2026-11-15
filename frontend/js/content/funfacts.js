// "Did you know?" card in the side column: SPHEREx facts and facts about the patch of sky being looked at
// (from the loaded data). Turns every 8 s, stops while the
// pointer or focus is on it; arrows step by hand.
import { t } from '../core/i18n.js';

const $ = (id) => document.getElementById(id);
const el = { card: $('facts'), body: $('factBody'), tag: $('factTag'), text: $('factText'), idx: $('factIdx'),
  prev: $('factPrev'), next: $('factNext') };
const GENERAL = 14;
const F = { region: [], list: [], i: 0, timer: null, hold: false };

function build() {
  // facts about what is on screen first, then SPHEREx facts
  const out = F.region.map(r => ({ tag: 'factTagReg', ...r }));
  for (let k = 0; k < GENERAL; k++) out.push({ tag: 'factTagGen', key: `factG${k + 1}` });
  F.list = out;
}

function show(i) {
  if (!F.list.length) build();
  F.i = (i + F.list.length) % F.list.length;
  const f = F.list[F.i];
  el.body.classList.remove('in');
  void el.body.offsetWidth;                                  // restart the fade
  el.body.classList.add('in');
  el.tag.textContent = t(f.tag);
  el.tag.dataset.kind = f.tag;
  el.text.textContent = t(f.key, f.vars || {});
  el.idx.textContent = `${F.i + 1} / ${F.list.length}`;
}

function start() {
  clearInterval(F.timer);
  F.timer = setInterval(() => { if (!F.hold && !document.hidden) show(F.i + 1); }, 8000);
}

document.addEventListener('radians:loaded', (e) => {
  const d = e.detail;
  F.region = [];
  if (d && d.exposures && d.exposures.length) {
    const ex = d.exposures, mjd = ex.map(p => p.mjd), wl = ex.map(p => p.wavelength).filter(Number.isFinite);
    F.region.push({ key: 'factRegExp', vars: { n: ex.length } });
    F.region.push({ key: 'factRegDates', vars: { first: ex[0].date.slice(0, 10), last: ex.at(-1).date.slice(0, 10),
      days: Math.round(Math.max(...mjd) - Math.min(...mjd)) } });
    const visits = new Set(d.frames.map(f => f.epoch)).size;
    if (visits > 1) F.region.push({ key: 'factRegVisits', vars: { k: visits } });
    if (wl.length) F.region.push({ key: 'factRegWl', vars: { min: Math.min(...wl).toFixed(2), max: Math.max(...wl).toFixed(2) } });
  }
  build();
  show(0);
  start();
});
document.addEventListener('radians:lang', () => show(F.i));

el.prev.onclick = () => { show(F.i - 1); start(); };
el.next.onclick = () => { show(F.i + 1); start(); };
for (const [ev, v] of [['mouseenter', true], ['mouseleave', false], ['focusin', true], ['focusout', false]]) {
  el.card.addEventListener(ev, () => { F.hold = v; });
}
build();
show(Math.floor(Math.random() * F.list.length));
start();
