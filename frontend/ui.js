// Page chrome: landing <-> viewer, light/dark, the "Advanced" drawer, the view switch and the
// three-step first-visit guide. The viewer itself lives in app.js.
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------- landing <-> viewer
function placeSearch() {
  const form = $('search');
  const slot = root.classList.contains('in-app') ? $('appSearchSlot') : $('heroSearchSlot');
  if (form.parentElement !== slot) slot.appendChild(form);
}
document.addEventListener('radians:run', () => { root.classList.add('in-app'); placeSearch(); window.scrollTo(0, 0); });
placeSearch();

// ---------------------------------------------------------------- light / dark
$('themeBtn').onclick = () => {
  const next = root.dataset.theme === 'light' ? 'dark' : 'light';
  root.dataset.theme = next;
  store.set('radians-theme', next);
  document.dispatchEvent(new CustomEvent('radians:theme'));
};

// ---------------------------------------------------------------- advanced drawer
function drawer(open) {
  $('adv').hidden = !open;
  $('scrim').hidden = !open;
  $('advBtn').setAttribute('aria-expanded', String(open));
  if (open) $('advClose').focus();
}
$('advBtn').onclick = () => drawer(true);
$('advClose').onclick = $('scrim').onclick = () => drawer(false);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('adv').hidden) drawer(false); });

// ---------------------------------------------------------------- view switch (mirrors the full <select>)
const view = $('view');
function syncSeg() {
  for (const b of $('viewSeg').querySelectorAll('button')) {
    const on = b.dataset.view === view.value || (b.dataset.view === 'diff_median' && view.value.startsWith('diff_'));
    b.setAttribute('aria-pressed', String(on));
  }
}
$('viewSeg').onclick = (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  view.value = b.dataset.view;
  view.dispatchEvent(new Event('change'));
  syncSeg();
};
view.addEventListener('change', syncSeg);
document.addEventListener('radians:loaded', syncSeg);
syncSeg();

// ---------------------------------------------------------------- first-visit guide
const STEPS = [
  { el: 'stage', key: 'tour1', at: 'inside' },
  { el: 'controls', key: 'tour2', at: 'above' },
  { el: 'candPanel', key: 'tour3', at: 'left' },
];
let step = -1;
function placeTour() {
  const s = STEPS[step];
  const target = $(s.el);
  for (const x of document.querySelectorAll('.tour-focus')) x.classList.remove('tour-focus');
  target.classList.add('tour-focus');
  target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('tourStep').textContent = `${step + 1} / ${STEPS.length}`;
  $('tourText').textContent = t(s.key);
  $('tourNext').textContent = step === STEPS.length - 1 ? t('tourDone') : t('tourNext');
  const tour = $('tour');
  tour.hidden = false;
  requestAnimationFrame(() => {
    const r = target.getBoundingClientRect(), w = tour.offsetWidth, h = tour.offsetHeight;
    // stage: inside its lower-left corner; controls: just above; side panel: to its left
    let left, top;
    if (s.at === 'inside') { left = r.left + 16; top = Math.min(r.bottom, innerHeight) - h - 16; }
    else if (s.at === 'above') { left = r.left + 16; top = r.top - h - 12; }
    else { left = r.left - w - 14; top = r.top + 12; }
    if (left < 12 || left + w > innerWidth - 12) { left = Math.max(12, Math.min(innerWidth - w - 12, r.left)); top = r.bottom + 12; }
    top = Math.max(12, Math.min(innerHeight - h - 12, top));
    tour.style.left = `${left}px`;
    tour.style.top = `${top}px`;
  });
}
function endTour() {
  step = -1;
  $('tour').hidden = true;
  for (const x of document.querySelectorAll('.tour-focus')) x.classList.remove('tour-focus');
  store.set('radians-tour', 'done');
}
function startTour() { step = 0; placeTour(); }
$('tourNext').onclick = () => { if (++step >= STEPS.length) endTour(); else placeTour(); };
$('tourSkip').onclick = endTour;
$('tourBtn').onclick = startTour;
addEventListener('resize', () => { if (step >= 0) placeTour(); });
document.addEventListener('radians:loaded', () => {
  if (store.get('radians-tour') !== 'done' && !document.body.classList.contains('embed')) setTimeout(startTour, 600);
});
