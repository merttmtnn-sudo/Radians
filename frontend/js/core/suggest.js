// The search box helps while you type: curated objects by name (with their one-line story), and
// coordinates in every common format with a line that says how they were read.
//   17h57m48.5s +04d41m36s · 17:57:48.5 +04:41:36 · 269.45 4.69 · 269,45 4,69 · RA 269.45 Dec 4.69
// Choosing an object opens it by its catalogue position and proper motion, so names the name
// resolver does not know ("Taurus Molecular Cloud") work too.
import { t, getLang } from './i18n.js';
import { parseCoords, formatBoth } from './coords.js';

const form = document.getElementById('search');
const input = document.getElementById('q');
const list = document.createElement('ul');
list.className = 'suggest';
list.id = 'suggest';
list.setAttribute('role', 'listbox');
list.hidden = true;
form.append(list);
input.setAttribute('aria-controls', 'suggest');
input.setAttribute('aria-autocomplete', 'list');

const s = { rows: [], on: -1, seq: 0, timer: null };
const L = () => (getLang() === 'tr' ? 'tr' : 'en');
const ERR = { unreadable: 'coordErrUnreadable', minutes: 'coordErrMinutes', count: 'coordErrCount', ra: 'coordErrRa', dec: 'coordErrDec' };

/** "269.45210 +4.69330": the form every part of the site reads. */
export const plainCoords = (c) => `${c.ra.toFixed(5)} ${c.dec >= 0 ? '+' : ''}${c.dec.toFixed(5)}`;

// While the visitor is still choosing, the server already asks NASA's archive which exposures cover
// the spot (one request, no pixels). Pressing Enter then starts with that list in hand. It waits for
// a pause in the typing, and asks once per spot.
const warmed = new Set();
let warmTimer = null;
function warm(ra, dec) {
  clearTimeout(warmTimer);
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return;
  const key = `${ra.toFixed(3)},${dec.toFixed(3)}`;
  if (warmed.has(key) || warmed.size >= 30) return;
  warmTimer = setTimeout(() => {
    warmed.add(key);
    let band = null;
    try { band = localStorage.getItem('radians-band'); } catch { /* private window */ }
    const u = new URL('api/quick/warm', location.href);
    u.searchParams.set('ra', ra.toFixed(5));
    u.searchParams.set('dec', dec.toFixed(5));
    if (band) u.searchParams.set('prefer', band);
    fetch(u).catch(() => {});
  }, 700);
}
const warmPin = (p) => p && warm(p.ra_now ?? p.ra, p.dec_now ?? p.dec);

function close() {
  clearTimeout(warmTimer);
  list.hidden = true;
  list.replaceChildren();
  s.rows = [];
  s.on = -1;
  input.setAttribute('aria-expanded', 'false');
}

function draw() {
  list.replaceChildren(...s.rows.map((r, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === s.on));
    if (r.disabled) li.classList.add('off');
    const a = document.createElement('span');
    a.className = 'main';
    a.textContent = r.title;
    li.append(a);
    if (r.sub) { const b = document.createElement('span'); b.className = 'sub'; b.textContent = r.sub; li.append(b); }
    li.onmousedown = (e) => { e.preventDefault(); choose(i); };          // before the input loses focus
    return li;
  }));
  list.hidden = !s.rows.length;
  input.setAttribute('aria-expanded', String(!list.hidden));
}

function choose(i) {
  const r = s.rows[i];
  if (!r || r.disabled) return;
  close();
  if (r.pin) {
    const p = r.pin;
    input.value = p[`name_${L()}`] || p.name_en;
    document.dispatchEvent(new CustomEvent('radians:open', { detail: { q: p.name_en, ra: p.ra, dec: p.dec, pmra: p.pmra, pmdec: p.pmdec } }));
  } else if (r.coords) {
    input.value = plainCoords(r.coords);
    form.requestSubmit();
  }
}

async function update() {
  const text = input.value.trim();
  const seq = ++s.seq;
  if (!text) { close(); return; }
  const c = parseCoords(text);
  if (c) {
    s.rows = c.error ? [{ title: t(ERR[c.error] || 'coordErrUnreadable'), disabled: true }]
      : [{ title: `${t('coordReadAs')}: ${formatBoth(c.ra, c.dec)}`, sub: t('coordGo'), coords: c }];
    s.on = c.error ? -1 : 0;
    draw();
    if (!c.error) warm(c.ra, c.dec);
    return;
  }
  if (text.length < 2) { close(); return; }
  try {
    const r = await fetch(new URL(`api/search?q=${encodeURIComponent(text)}&limit=6`, location.href));
    const pins = r.ok ? await r.json() : [];
    if (seq !== s.seq) return;                                   // an older answer: the text has moved on
    s.rows = pins.map(p => ({ title: p[`name_${L()}`] || p.name_en, sub: p[`blurb_${L()}`] || '', pin: p }));
    s.on = -1;
    draw();
    if (pins.length === 1) warmPin(pins[0]);                     // one match left: that is where this is going
  } catch { if (seq === s.seq) close(); }
}

input.addEventListener('input', () => { clearTimeout(s.timer); s.timer = setTimeout(update, 160); });
input.addEventListener('focus', () => { if (input.value.trim() && list.hidden) update(); });
input.addEventListener('blur', () => setTimeout(close, 120));
input.addEventListener('keydown', (e) => {
  if (list.hidden) return;
  const pick = s.rows.map((r, i) => (r.disabled ? -1 : i)).filter(i => i >= 0);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!pick.length) return;
    e.preventDefault();
    const at = pick.indexOf(s.on);
    s.on = pick[(at + (e.key === 'ArrowDown' ? 1 : -1) + pick.length) % pick.length];
    draw();
    warmPin(s.rows[s.on]?.pin);
  } else if (e.key === 'Escape') close();
  else if (e.key === 'Enter' && s.on >= 0 && s.rows[s.on]?.pin) { e.preventDefault(); choose(s.on); }
});

// Coordinates go on in one plain form, whatever format they were typed in (decimal commas,
// "RA ... Dec ...", a typographic minus), so every reader downstream understands them.
form.addEventListener('submit', () => {
  const c = parseCoords(input.value);
  if (c && !c.error) input.value = plainCoords(c);
  close();
}, true);
document.addEventListener('radians:run', close);
