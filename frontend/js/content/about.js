// "About this target" panel (hand-written notes for the challenge targets, SIMBAD details via Sesame,
// facts computed from the data), the mini sky map, glossary tooltips and the guided story.
import { t, getLang } from '../core/i18n.js';
import { curated, OTYPES, teffFromSp, TERMS, TERM_PATTERNS, STORY, TARGETS, EXPLORE } from './facts.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const R = () => window.radians;                 // { state, ex } from app.js
const L = () => (getLang() === 'tr' ? 1 : 0);
const nf = (v, d = 0) => v.toLocaleString(getLang() === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const YEAR = new Date().getFullYear();
const MOON_ARCSEC = 1865;

// ---------------------------------------------------------------- about panel
const about = { key: null, info: null, fact: 0 };

async function loadAbout() {
  const { state } = R();
  const tg = state.target;
  if (!tg) return;
  const key = `${tg.ra.toFixed(4)},${tg.dec.toFixed(4)}`;
  if (about.key !== key) {
    about.key = key; about.info = null; about.fact = 0;
    renderAbout();
    const url = new URL('api/about', location.href);
    url.searchParams.set('ra', tg.ra.toFixed(6));
    url.searchParams.set('dec', tg.dec.toFixed(6));
    const q = ($('q').value || '').trim();
    if (q) url.searchParams.set('q', q);
    try {
      const r = await fetch(url);
      if (r.ok && about.key === key) about.info = await r.json();
    } catch { /* the panel still shows what the data says */ }
  }
  renderAbout();
}

function distanceLy(obj, cur) {
  if (cur) return { ly: cur.distLy, approx: !!cur.distNote };
  if (obj && obj.plx_mas > 0 && (!obj.plx_err || obj.plx_err / obj.plx_mas < 0.2)) return { ly: 3261.56 / obj.plx_mas, approx: false };
  return null;
}

function computedFacts(obj, cur, sky) {
  const { state, ex } = R();
  const out = [], d = distanceLy(obj, cur), tg = state.target, tr = L();
  if (d) {
    const ly = d.ly;
    if (ly < YEAR - 100) out.push(tr ? `Bugün gördüğünüz ışık yola yaklaşık ${Math.round(YEAR - ly)} yılında çıktı.` : `The light you see left it around the year ${Math.round(YEAR - ly)}.`);
    else out.push(tr ? `Işığı bize yaklaşık ${nf(ly, 0)} yılda ulaşıyor.` : `Its light takes about ${nf(ly, 0)} years to reach us.`);
  }
  const pmMas = obj?.pm_mas ?? (tg && Number.isFinite(tg.pmra) ? Math.hypot(tg.pmra, tg.pmdec) : null);
  if (pmMas && pmMas > 50) {
    const yrs = MOON_ARCSEC / (pmMas / 1000);
    out.push(tr ? `Bu hızla dolunayın çapı kadar yolu yaklaşık ${nf(yrs < 1000 ? Math.round(yrs / 10) * 10 : Math.round(yrs / 100) * 100)} yılda alır.`
      : `At this rate it crosses the width of the full Moon in about ${nf(yrs < 1000 ? Math.round(yrs / 10) * 10 : Math.round(yrs / 100) * 100)} years.`);
    if (d) {
      const vt = 4.74 * (pmMas / 1000) * (d.ly / 3.2616);
      out.push(tr ? `Gökyüzü düzleminde saniyede yaklaşık ${nf(vt, 0)} km hızla ilerliyor.` : `Across our line of sight it moves at about ${nf(vt, 0)} km/s.`);
    }
  }
  if (obj && Number.isFinite(obj.rv_kms) && Math.abs(obj.rv_kms) > 5) {
    const v = Math.abs(obj.rv_kms);
    out.push(obj.rv_kms < 0 ? (tr ? `Bize saniyede ${nf(v, 0)} km hızla yaklaşıyor.` : `It is approaching us at ${nf(v, 0)} km/s.`)
      : (tr ? `Bizden saniyede ${nf(v, 0)} km hızla uzaklaşıyor.` : `It is moving away from us at ${nf(v, 0)} km/s.`));
  }
  if (sky) {
    if (Math.abs(sky.b) < 8) out.push(tr ? 'Samanyolu’nun diskinde: alan yıldızlarla dolu.' : 'It lies in the disk of the Milky Way, so the field is crowded with stars.');
    else if (Math.abs(sky.b) > 50) out.push(tr ? 'Samanyolu düzleminden uzakta, galaksimizin “tepesine” doğru bakıyorsunuz.' : 'You are looking far out of the Milky Way’s plane, towards the galaxy’s “roof”.');
    if (Math.abs(sky.elat) < 8) out.push(tr ? 'Ekliptiğe yakın: asteroitler buradan sık geçer, onları Gaia ile birlikte işaretliyoruz.' : 'It is close to the ecliptic, where asteroids pass often; Radians marks the known ones.');
  }
  if (state.data) {
    const fs = state.data.frames, nexp = fs.reduce((s, f) => s + (f.n_exposures || 0), 0);
    const eps = new Set(fs.map(f => f.epoch)).size;
    out.push(tr ? `SPHEREx bu alanı ${nf(eps)} ziyarette ${nf(nexp)} kez çekti (${fs[0].date_start.slice(0, 7)} – ${fs[fs.length - 1].date_end.slice(0, 7)}).`
      : `SPHEREx imaged this field ${nf(nexp)} times over ${eps} visits (${fs[0].date_start.slice(0, 7)} – ${fs[fs.length - 1].date_end.slice(0, 7)}).`);
  }
  if (ex.gaia && ex.gaia.length) out.push(tr ? `Bu ${nf(state.data.grid.fov / 60, 0)}′’lık karede Gaia’nın bildiği ${nf(ex.gaia.length)} yıldız var.` : `Gaia knows ${nf(ex.gaia.length)} stars in this ${nf(state.data.grid.fov / 60, 0)}′ frame.`);
  return out;
}

function stat(k, v, term) {
  const d = el('div', 'stat');
  const kk = el('span', 'k', k);
  if (term) { kk.classList.add('term'); kk.dataset.term = term; kk.tabIndex = 0; }
  d.append(kk, el('span', 'v', v));
  return d;
}

function renderAbout() {
  const panel = $('aboutPanel'), body = $('aboutBody');
  const { state } = R();
  const tg = state.target;
  if (!tg) { panel.hidden = true; return; }
  panel.hidden = false;
  const tr = L();
  const cur = curated(tg.ra, tg.dec);
  const c = cur ? cur[tr ? 'tr' : 'en'] : null;
  const info = about.info, obj = info?.object, sky = info?.sky;
  const name = (obj?.name || tg.name || '').replace(/^(NAME|V\*|\*)\s+/, '') || ($('q').value || t('coordinates'));
  const kind = c?.kind || (obj?.otype && OTYPES[obj.otype] ? OTYPES[obj.otype][tr] : null);
  body.replaceChildren();

  const head = el('div', 'abouthead');
  head.append(el('b', 'aname', cur ? cur.q.replace('eps Indi B', 'ε Indi B').replace('WISE J085510.83-071442.5', 'WISE 0855−0714').replace('RW Aur', 'RW Aurigae').replace('R Dra', 'R Draconis') : name));
  if (kind) head.append(el('span', 'tag', kind));
  body.append(head);
  const pick = explore.pick && ($('q').value || '').trim() === explore.pick.q ? explore.pick : null;
  if (pick) body.append(el('p', 'explorenote', pick[tr ? 'tr' : 'en']));
  if (c) body.append(el('p', 'asum', c.summary));
  else if (!obj && info) body.append(el('p', 'asum dim', t('aboutField')));
  else if (!info) body.append(el('p', 'asum dim', t('aboutLoading')));

  // key numbers
  const grid = el('div', 'stats');
  const d = distanceLy(obj, cur);
  if (d) grid.append(stat(t('aDist'), `${d.approx ? '≈ ' : ''}${nf(d.ly, d.ly < 10 ? 2 : d.ly < 100 ? 1 : 0)} ${t('aLy')}`, 'ly'));
  if (sky) grid.append(stat(t('aCon'), sky.constellation));
  const teff = cur?.temp || (obj?.sptype && teffFromSp(obj.sptype) ? `≈ ${nf(teffFromSp(obj.sptype))} K` : null);
  if (teff) grid.append(stat(t('aTemp'), teff));
  if (obj?.sptype) grid.append(stat(t('aSpt'), obj.sptype, 'spt'));
  const pm = obj?.pm_mas ?? (Number.isFinite(tg.pmra) ? Math.hypot(tg.pmra, tg.pmdec) : null);
  if (pm && pm > 20) grid.append(stat(t('aPm'), `${(pm / 1000).toFixed(pm > 1000 ? 2 : 3)}″/${tr ? 'yıl' : 'yr'}`, 'pm'));
  if (grid.childElementCount) body.append(grid);

  // did you know? (one at a time)
  const facts = [...(c?.facts || []), ...computedFacts(obj, cur, sky)];
  if (facts.length) {
    about.fact = ((about.fact % facts.length) + facts.length) % facts.length;
    const box = el('div', 'fun');
    const top = el('div', 'funtop');
    top.append(el('span', 'eyebrow', t('aDidYouKnow')));
    const nav = el('span', 'funnav');
    const prev = el('button', 'btn icon xs', '‹'), next = el('button', 'btn icon xs', '›');
    prev.type = next.type = 'button';
    prev.setAttribute('aria-label', t('aPrevFact')); next.setAttribute('aria-label', t('aNextFact'));
    prev.onclick = () => { about.fact--; renderAbout(); };
    next.onclick = () => { about.fact++; renderAbout(); };
    nav.append(prev, el('span', 'mono small', `${about.fact + 1}/${facts.length}`), next);
    top.append(nav);
    box.append(top, el('p', '', facts[about.fact]));
    body.append(box);
  }

  // where in the sky
  if (sky) {
    const fig = el('figure', 'skymap');
    fig.append(skyMap(tg.ra, tg.dec), el('figcaption', 'small dim', t('aMapCap', { con: sky.constellation, b: Math.abs(sky.b).toFixed(0) })));
    body.append(fig);
  }

  // technical details
  const det = el('details', 'atech');
  det.append(el('summary', '', t('aTech')));
  const dl = el('dl', 'kv mono');
  const row = (k, v, term) => { const dt = el('dt', term ? 'term' : '', k); if (term) { dt.dataset.term = term; dt.tabIndex = 0; } dl.append(dt, el('dd', '', v)); };
  if (obj?.otype) row(t('aType'), `${obj.otype}${OTYPES[obj.otype] ? ' · ' + OTYPES[obj.otype][tr] : ''}`);
  if (obj?.plx_mas) row(t('aPlx'), `${obj.plx_mas.toFixed(2)} ± ${(obj.plx_err ?? 0).toFixed(2)} mas`, 'plx');
  if (obj?.pm_mas) row(t('aPm'), `${obj.pm_mas.toFixed(1)} mas/${tr ? 'yıl' : 'yr'} · PA ${obj.pm_pa?.toFixed(1)}°`, 'pm');
  if (Number.isFinite(obj?.rv_kms)) row(t('aRv'), `${obj.rv_kms.toFixed(1)} km/s`);
  if (sky) {
    row(t('aGal'), `l ${sky.l.toFixed(2)}°, b ${sky.b.toFixed(2)}°`);
    row(t('aEcl'), `β ${sky.elat.toFixed(2)}°`);
  }
  if (obj?.aliases?.length) row(t('aAka'), obj.aliases.join(' · '));
  det.append(dl);
  const links = el('p', 'small');
  const a = el('a', '', 'SIMBAD');
  a.href = `https://simbad.cds.unistra.fr/simbad/sim-coo?Coord=${tg.ra.toFixed(5)}+${tg.dec >= 0 ? '%2B' : ''}${tg.dec.toFixed(5)}&Radius=10&Radius.unit=arcsec`;
  a.target = '_blank'; a.rel = 'noopener';
  links.append(a, document.createTextNode(` · ${t('aSource')}`));
  det.append(links);
  body.append(det);
}

// ---------------------------------------------------------------- mini all-sky map (Hammer projection, RA increasing to the left)
const DEG = Math.PI / 180;
const GAL2ICRS = [[-0.0548755604162154, 0.4941094278755837, -0.8676661490190047],
  [-0.8734370902348850, -0.4448296299600112, -0.1980763734312015],
  [-0.4838350155487132, 0.7469822444972189, 0.4559837761750669]];
function galToEq(l, b) {
  const v = [Math.cos(b * DEG) * Math.cos(l * DEG), Math.cos(b * DEG) * Math.sin(l * DEG), Math.sin(b * DEG)];
  const e = GAL2ICRS.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  return [((Math.atan2(e[1], e[0]) / DEG) + 360) % 360, Math.asin(e[2]) / DEG];
}
function eclToEq(lon) {
  const eps = 23.4393 * DEG, l = lon * DEG;
  return [((Math.atan2(Math.cos(eps) * Math.sin(l), Math.cos(l)) / DEG) + 360) % 360, Math.asin(Math.sin(eps) * Math.sin(l)) / DEG];
}
const W = 280, H = 140;
function hammer(ra, dec) {
  const lam = ((180 - ra) % 360 + 540) % 360 - 180, l = lam * DEG, p = dec * DEG;
  const z = Math.sqrt(1 + Math.cos(p) * Math.cos(l / 2));
  return [W / 2 + (W / 2 - 4) * (Math.cos(p) * Math.sin(l / 2)) / z, H / 2 - (H / 2 - 4) * Math.sin(p) / z];
}
function pathFor(pts) {
  // break the line where it wraps around the edge of the map
  let d = '', prev = null;
  for (const [ra, dec] of pts) {
    const [x, y] = hammer(ra, dec);
    d += (prev && Math.abs(x - prev) < W / 3 ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
    prev = x;
  }
  return d;
}
function skyMap(ra, dec) {
  const NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', `0 0 ${W} ${H}`);
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', t('aMapAlt'));
  const mk = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text) e.textContent = text; s.append(e); return e; };
  mk('ellipse', { cx: W / 2, cy: H / 2, rx: W / 2 - 4, ry: H / 2 - 4, class: 'sm-bg' });
  for (const dd of [-60, -30, 0, 30, 60]) mk('path', { d: pathFor(Array.from({ length: 73 }, (_, i) => [i * 5 + 0.001, dd])), class: 'sm-grid' });
  for (const rr of [0, 60, 120, 240, 300]) mk('path', { d: pathFor(Array.from({ length: 37 }, (_, i) => [rr + 0.001, -90 + i * 5])), class: 'sm-grid' });
  // Milky Way as a band (b = ±10°) plus its centre line, and the ecliptic
  for (const bb of [-10, 10]) mk('path', { d: pathFor(Array.from({ length: 181 }, (_, i) => galToEq(i * 2, bb))), class: 'sm-mwedge' });
  mk('path', { d: pathFor(Array.from({ length: 181 }, (_, i) => galToEq(i * 2, 0))), class: 'sm-mw' });
  mk('path', { d: pathFor(Array.from({ length: 181 }, (_, i) => eclToEq(i * 2))), class: 'sm-ecl' });
  const [gx, gy] = hammer(...galToEq(0, 0));
  mk('text', { x: gx, y: gy - 5, 'text-anchor': 'middle', class: 'sm-lbl' }, t('aGc'));
  // the five challenge targets, then this one
  for (const x of TARGETS) { const [px, py] = hammer(x.ra, x.dec); mk('circle', { cx: px, cy: py, r: 1.8, class: 'sm-other' }); }
  const [tx, ty] = hammer(ra, dec);
  mk('circle', { cx: tx, cy: ty, r: 7, class: 'sm-halo' });
  mk('circle', { cx: tx, cy: ty, r: 3.2, class: 'sm-here' });
  return s;
}

// ---------------------------------------------------------------- glossary tooltips
const tip = el('div', 'termtip');
tip.setAttribute('role', 'tooltip');
tip.hidden = true;
document.body.append(tip);
function showTip(target) {
  const g = TERMS[target.dataset.term];
  if (!g) return;
  const tr = L();
  tip.replaceChildren(el('b', '', g[tr ? 2 : 0]), el('span', '', g[tr ? 3 : 1]));
  tip.hidden = false;
  const r = target.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  let left = Math.min(innerWidth - w - 10, Math.max(10, r.left + r.width / 2 - w / 2));
  let top = r.top - h - 8;
  if (top < 8) top = r.bottom + 8;
  tip.style.left = `${left}px`; tip.style.top = `${top}px`;
}
const hideTip = () => { tip.hidden = true; };
document.addEventListener('mouseover', (e) => { const x = e.target.closest?.('.term'); if (x) showTip(x); });
document.addEventListener('mouseout', (e) => { if (e.target.closest?.('.term')) hideTip(); });
document.addEventListener('focusin', (e) => { const x = e.target.closest?.('.term'); if (x) showTip(x); else hideTip(); });
document.addEventListener('click', (e) => { const x = e.target.closest?.('.term'); if (x) { e.stopPropagation(); showTip(x); } else hideTip(); }, true);
addEventListener('scroll', hideTip, { passive: true });

// wrap glossary words inside these containers as they are (re)rendered
let glossing = false;
function glossify(root) {
  if (glossing) return;
  glossing = true;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('.term, script, style, select, option, svg, canvas, input, [role=tab]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const text = n.nodeValue;
    const hits = [];
    for (const [re, key] of TERM_PATTERNS) { re.lastIndex = 0; let m; while ((m = re.exec(text))) hits.push([m.index, m[0], key]); }
    if (!hits.length) continue;
    hits.sort((a, b) => a[0] - b[0]);
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const [i, s, key] of hits) {
      if (i < pos) continue;
      frag.append(text.slice(pos, i));
      const sp = el('span', 'term', s);
      sp.dataset.term = key; sp.tabIndex = 0;
      frag.append(sp);
      pos = i + s.length;
    }
    frag.append(text.slice(pos));
    n.replaceWith(frag);
  }
  glossing = false;
}
const GLOSS_ROOTS = ['cands', 'chartNote', 'aboutBody', 'cursor', 'frameInfo', 'photSource'];
const obs = new MutationObserver((muts) => {
  if (glossing) return;
  const roots = new Set(muts.map(m => GLOSS_ROOTS.map($).find(r => r && r.contains(m.target))).filter(Boolean));
  for (const r of roots) glossify(r);
});
for (const id of GLOSS_ROOTS) { const r = $(id); if (r) { obs.observe(r, { childList: true, subtree: true, characterData: true }); glossify(r); } }

// ---------------------------------------------------------------- guided story
const story = { i: -1 };
function storyCard() { return $('story'); }
function storyGo(i) {
  story.i = i;
  document.documentElement.classList.add('story-on');
  const s = STORY[i], tr = L();
  const card = storyCard();
  card.hidden = false;
  $('storyStep').textContent = `${i + 1} / ${STORY.length}`;
  $('storyTitle').textContent = s[tr ? 'tr' : 'en'][0];
  $('storyText').textContent = s[tr ? 'tr' : 'en'][1];
  $('storyPrev').disabled = i === 0;
  $('storyNext').textContent = i === STORY.length - 1 ? t('storyDone') : t('storyNext');
  $('storyDots').replaceChildren(...STORY.map((_, j) => el('i', j === i ? 'on' : '')));
  const btn = [...document.querySelectorAll('#examples button[data-q]')].find(b => b.dataset.q === s.q);
  if (btn) {
    if (s.tab) document.addEventListener('radians:loaded', () => {
      const tb = document.querySelector(`[data-tab="${s.tab}"]`);
      if (tb) setTimeout(() => tb.click(), 300);
    }, { once: true });
    btn.click();
  }
}
function storyEnd() {
  story.i = -1;
  storyCard().hidden = true;
  document.documentElement.classList.remove('story-on');
}
export function startStory() { storyGo(0); }
$('storyNext').onclick = () => (story.i >= STORY.length - 1 ? storyEnd() : storyGo(story.i + 1));
$('storyPrev').onclick = () => { if (story.i > 0) storyGo(story.i - 1); };
$('storyClose').onclick = storyEnd;
for (const b of document.querySelectorAll('[data-story]')) b.onclick = startStory;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && story.i >= 0) storyEnd(); });

// ---------------------------------------------------------------- wiring
document.addEventListener('radians:loaded', loadAbout);
document.addEventListener('radians:catalogues', renderAbout);
document.addEventListener('radians:lang', () => {
  if (R()?.state?.target) renderAbout();
  if (story.i >= 0) {
    const s = STORY[story.i], tr = L();
    $('storyTitle').textContent = s[tr ? 'tr' : 'en'][0];
    $('storyText').textContent = s[tr ? 'tr' : 'en'][1];
    $('storyNext').textContent = story.i === STORY.length - 1 ? t('storyDone') : t('storyNext');
  }
});

// ---------------------------------------------------------------- explore the sky
const explore = { pick: null };
function exploreGo() {
  const cur = ($('q').value || '').trim();
  const pool = EXPLORE.filter(x => x.q !== cur);
  explore.pick = pool[Math.floor(Math.random() * pool.length)];
  $('q').value = explore.pick.q;
  $('search').requestSubmit();
}
for (const b of document.querySelectorAll('[data-explore]')) b.onclick = exploreGo;
