// Click a star, planet or nebula in the embedded planetarium: a small card appears next to it (and follows
// it while the sky turns); "Details" opens a side panel (a bottom sheet on phones) with catalogue data from
// SIMBAD, a short description (our own words for the challenge targets and the planets, else Wikipedia),
// where it is in tonight's sky and what SPHEREx has of it. Each part loads on its own and may fail alone.
import { esc } from './util.js';
import * as A from './astro.js';
import { DSO_TYPES } from './sky.js';
import { pageLang } from './tr.js';
import { curated } from '/static/js/content/facts.js';

const TR = pageLang() === 'tr';
const T = TR ? {
  star: 'Yıldız', planet: 'Gezegen', dwarf: 'Cüce gezegen', moon: 'Doğal uydu', sunk: 'Yıldız (Güneş)', dso: 'Derin gök nesnesi',
  target: 'SPHEREx hedefi', point: 'Gökte bir nokta', pointName: 'Seçilen konum',
  up: d => `Şu an ${d}° yüksekte`, low: d => `Ufka yakın: ${d}°`, below: 'Şu an ufkun altında',
  details: 'Ayrıntılar', blink: 'Blink’le', science: 'Bilim aracı ↗', close: 'Kapat',
  data: 'Veriler', names: 'Diğer adları', more: n => `+${n} ad daha`, about: 'Hakkında', skyNow: 'Gökyüzünde şimdi', spx: 'SPHEREx’te',
  mag: 'Parlaklık (V kadir)', mags: 'Kadirler', dist: 'Uzaklık', ly: 'ışık yılı', sp: 'Tayf türü', temp: 'Sıcaklık (tahmini)',
  otype: 'Türü (SIMBAD)', radec: 'RA / Dec (J2000)', gal: 'Galaktik l / b', rv: 'Radyal hız', pm: 'Öz hareket',
  altaz: 'Yükseklik / Azimut', con: 'Takımyıldız', rts: 'Doğuş · Tepe · Batış', circ: 'Hiç batmaz', never: 'Bugün doğmuyor', maxAlt: 'En yüksek',
  loading: 'Yükleniyor…', failed: 'Şu an ulaşılamadı. Biraz sonra yeniden deneyin.', noWiki: 'Bu nesne için kısa bir açıklama bulunamadı.',
  wikiEn: 'Türkçe madde yok; İngilizce Vikipedi özeti:', source: 'Kaynak', readMore: 'Devamını oku ↗',
  cov: (n, p) => `${n} SPHEREx pozu, ${p} gök taramasında`, covNone: 'SPHEREx bu noktayı henüz görüntülememiş.', covDates: (a, b) => `${a} – ${b}`,
  tonight: 'Bu gece', illum: 'Aydınlık', phase: 'Evre', diam: 'Görünür çap', distAu: (au, m) => `${au} AU · ışık ${m} dakikada gelir`,
  phys: 'Fiziksel özellikler', pD: 'Çap', pM: 'Kütle', pS: 'Güneş’e uzaklık', pY: 'Yılı', pDay: 'Günü', pMoons: 'Uyduları', ir: 'Kızılötesinde', fun: 'Biliyor musunuz?',
  earth: 'Dünya', ownText: 'Radians ekibinin notu', bodyNoBlink: 'Gezegenler gökte hızla yer değiştirir; SPHEREx blink’i sabit noktalar içindir.',
} : {
  star: 'Star', planet: 'Planet', dwarf: 'Dwarf planet', moon: 'Natural satellite', sunk: 'Star (the Sun)', dso: 'Deep-sky object',
  target: 'SPHEREx target', point: 'Point in the sky', pointName: 'Selected position',
  up: d => `${d}° above the horizon now`, low: d => `Low in the sky: ${d}°`, below: 'Below the horizon right now',
  details: 'Details', blink: 'Blink this', science: 'Science tool ↗', close: 'Close',
  data: 'Data', names: 'Other names', more: n => `+${n} more`, about: 'About', skyNow: 'In the sky now', spx: 'In SPHEREx',
  mag: 'Brightness (V mag)', mags: 'Magnitudes', dist: 'Distance', ly: 'light-years', sp: 'Spectral type', temp: 'Temperature (est.)',
  otype: 'Type (SIMBAD)', radec: 'RA / Dec (J2000)', gal: 'Galactic l / b', rv: 'Radial velocity', pm: 'Proper motion',
  altaz: 'Altitude / Azimuth', con: 'Constellation', rts: 'Rise · Transit · Set', circ: 'Never sets', never: 'Does not rise today', maxAlt: 'Highest',
  loading: 'Loading…', failed: 'Not reachable right now. Try again in a moment.', noWiki: 'No short description found for this object.',
  wikiEn: '', source: 'Source', readMore: 'Read more ↗',
  cov: (n, p) => `${n} SPHEREx exposures in ${p} sky pass${p === 1 ? '' : 'es'}`, covNone: 'SPHEREx has not imaged this spot yet.', covDates: (a, b) => `${a} – ${b}`,
  tonight: 'Tonight', illum: 'Lit', phase: 'Phase', diam: 'Apparent size', distAu: (au, m) => `${au} AU · light takes ${m} min`,
  phys: 'Physical facts', pD: 'Diameter', pM: 'Mass', pS: 'Distance from the Sun', pY: 'Year', pDay: 'Day', pMoons: 'Moons', ir: 'In the infrared', fun: 'Did you know?',
  earth: 'Earth', ownText: 'Note from the Radians team', bodyNoBlink: 'Planets move across the sky quickly; the SPHEREx blink is for fixed spots.',
};
const PHASE_TR = { 'New Moon': 'Yeni Ay', 'Full Moon': 'Dolunay', 'First Quarter': 'İlk dördün', 'Last Quarter': 'Son dördün',
  'Waxing Crescent': 'Büyüyen hilal', 'Waning Crescent': 'Küçülen hilal', 'Waxing Gibbous': 'Büyüyen şişkin Ay', 'Waning Gibbous': 'Küçülen şişkin Ay' };
const DSO_TR = { 'Galaxy': 'Galaksi', 'Spiral galaxy': 'Sarmal galaksi', 'Lenticular galaxy': 'Mercek galaksi', 'Dwarf spheroidal galaxy': 'Cüce küresel galaksi',
  'Elliptical galaxy': 'Eliptik galaksi', 'Irregular galaxy': 'Düzensiz galaksi', 'Open cluster': 'Açık yıldız kümesi', 'Globular cluster': 'Küresel yıldız kümesi',
  'Emission nebula': 'Salma bulutsusu', 'Bright nebula': 'Parlak bulutsu', 'Star-forming region': 'Yıldız oluşum bölgesi', 'Reflection nebula': 'Yansıma bulutsusu',
  'Planetary nebula': 'Gezegenimsi bulutsu', 'Supernova remnant': 'Süpernova kalıntısı', 'Dark nebula': 'Karanlık bulutsu', 'Asterism': 'Yıldız dizisi',
  'Double star': 'Çift yıldız', 'Nebula': 'Bulutsu', 'Star': 'Yıldız' };

// diameter km, mass (Earth = 1), distance from the Sun AU, year, day, moons; then infrared note and a fun fact
const BODIES = {
  sun: { d: 1392700, m: 333000, s: null, y: null, day: ['25–35 days', '25–35 gün'], moons: '—',
    en: ['The Sun is far too bright for SPHEREx, which never looks near it: its view is always at right angles to the Sun.', 'About 1.3 million Earths would fit inside it; light from its surface reaches us in 8 min 20 s.'],
    tr: ['Güneş SPHEREx için fazlasıyla parlak; teleskop hiçbir zaman ona yakın bakmaz, hep Güneş’e dik yönde gözler.', 'İçine yaklaşık 1,3 milyon Dünya sığar; yüzeyinden çıkan ışık bize 8 dakika 20 saniyede ulaşır.'] },
  moon: { d: 3474, m: 0.0123, s: null, y: ['27.3 days around Earth', 'Dünya çevresinde 27,3 gün'], day: ['29.5 days', '29,5 gün'], moons: '—',
    en: ['In the infrared the Moon’s dayside glows from its own heat: its surface reaches about 120 °C at lunar noon.', 'It drifts 3.8 cm farther from Earth every year, measured with lasers bounced off mirrors left by Apollo.'],
    tr: ['Kızılötesinde Ay’ın gündüz yüzü kendi ısısıyla parlar: öğle vakti yüzeyi yaklaşık 120 °C’ye çıkar.', 'Her yıl Dünya’dan 3,8 cm uzaklaşıyor; bu, Apollo’nun bıraktığı aynalara lazer gönderilerek ölçülüyor.'] },
  mercury: { d: 4879, m: 0.055, s: 0.39, y: ['88 days', '88 gün'], day: ['176 days (sunrise to sunrise)', '176 gün (gün doğumundan gün doğumuna)'], moons: '0',
    en: ['Its sunlit side reaches 430 °C and shines brightly in thermal infrared; the night side drops to −180 °C.', 'A year on Mercury is shorter than its day: it goes round the Sun twice between two sunrises.'],
    tr: ['Güneş gören yüzü 430 °C’ye çıkar ve ısıl kızılötesinde parlar; gece yüzü −180 °C’ye düşer.', 'Merkür’de yıl, günden kısadır: iki gün doğumu arasında Güneş’in çevresini iki kez dolanır.'] },
  venus: { d: 12104, m: 0.815, s: 0.72, y: ['225 days', '225 gün'], day: ['117 days, spinning backwards', '117 gün, ters yönde döner'], moons: '0',
    en: ['Its clouds hide the surface in visible light, but some near-infrared light at 1.0–2.3 µm leaks out from the hot ground below.', 'At 465 °C, Venus is hotter than Mercury even though it is twice as far from the Sun.'],
    tr: ['Bulutları yüzeyi görünür ışıkta gizler, ama 1,0–2,3 µm’de bir miktar yakın kızılötesi ışık sıcak zeminden dışarı sızar.', '465 °C ile Venüs, Güneş’e iki kat daha uzak olmasına rağmen Merkür’den sıcaktır.'] },
  mars: { d: 6779, m: 0.107, s: 1.52, y: ['687 days', '687 gün'], day: ['24 h 40 min', '24 sa 40 dk'], moons: '2',
    en: ['Infrared spectra show water ice and carbon-dioxide ice at its poles: the same ices SPHEREx maps in cold clouds between stars.', 'Olympus Mons is about 22 km high, two and a half times the height of Mount Everest.'],
    tr: ['Kızılötesi tayflar kutuplarında su buzu ve karbondioksit buzu gösterir: SPHEREx’in yıldızlar arası soğuk bulutlarda haritaladığı buzların aynısı.', 'Olympus Dağı yaklaşık 22 km yüksekliğinde; Everest’in iki buçuk katı.'] },
  jupiter: { d: 139820, m: 317.8, s: 5.2, y: ['11.9 years', '11,9 yıl'], day: ['9 h 56 min', '9 sa 56 dk'], moons: '95+',
    en: ['Methane in its atmosphere absorbs strongly near 2.3 µm, so in SPHEREx-like infrared bands Jupiter looks dark with bright high clouds.', 'It gives off more heat than it gets from the Sun: it is still slowly shrinking and cooling since it formed.'],
    tr: ['Atmosferindeki metan 2,3 µm civarında güçlü soğurur; bu yüzden SPHEREx’inkine benzer kızılötesi bantlarda Jüpiter karanlık, yüksek bulutları parlak görünür.', 'Güneş’ten aldığından daha fazla ısı yayar: oluştuğundan beri hâlâ yavaşça büzülüp soğuyor.'] },
  saturn: { d: 116460, m: 95.2, s: 9.58, y: ['29.4 years', '29,4 yıl'], day: ['10 h 34 min', '10 sa 34 dk'], moons: '270+',
    en: ['Its rings are almost pure water ice, which has deep absorption bands at 1.5, 2.0 and 3.0 µm: right in SPHEREx’s range.', 'Saturn is less dense than water: in a big enough bathtub it would float.'],
    tr: ['Halkaları neredeyse saf su buzudur; su buzunun 1,5, 2,0 ve 3,0 µm’de derin soğurma bantları vardır: tam SPHEREx’in aralığı.', 'Satürn sudan daha az yoğundur: yeterince büyük bir küvette yüzerdi.'] },
  uranus: { d: 50724, m: 14.5, s: 19.2, y: ['84 years', '84 yıl'], day: ['17 h 14 min', '17 sa 14 dk'], moons: '28+',
    en: ['Methane gas gives it the blue-green colour and makes it very dark beyond 1.5 µm in the infrared.', 'It spins on its side: each pole gets 42 years of daylight followed by 42 years of night.'],
    tr: ['Metan gazı ona mavi-yeşil rengini verir ve 1,5 µm’nin ötesinde kızılötesinde çok karanlık görünmesine yol açar.', 'Yan yatmış döner: her kutup 42 yıl gündüz, ardından 42 yıl gece yaşar.'] },
  neptune: { d: 49244, m: 17.1, s: 30.1, y: ['165 years', '165 yıl'], day: ['16 h 6 min', '16 sa 6 dk'], moons: '16',
    en: ['Like Uranus it is dark in methane bands; its bright infrared spots are high clouds of methane ice.', 'It was found by mathematics before anyone saw it: in 1846, from the pull it had on Uranus.'],
    tr: ['Uranüs gibi metan bantlarında karanlıktır; kızılötesindeki parlak lekeleri yüksek metan buzu bulutlarıdır.', 'Görülmeden önce matematikle bulundu: 1846’da Uranüs’e yaptığı çekimden.'] },
  pluto: { d: 2377, m: 0.0022, s: 39.5, y: ['248 years', '248 yıl'], day: ['6.4 days', '6,4 gün'], moons: '5',
    en: ['Infrared spectra show ices of nitrogen, methane and carbon monoxide on its surface.', 'Since its discovery in 1930 it has not yet completed one orbit of the Sun: that takes until 2178.'],
    tr: ['Kızılötesi tayflar yüzeyinde azot, metan ve karbon monoksit buzları gösterir.', '1930’daki keşfinden bu yana Güneş çevresinde tek bir turu bile tamamlamadı: bu 2178’e kadar sürecek.'] },
};

// SIMBAD spellings for people: "* alf CMa" -> "α CMa", "V* R Dra" -> "R Dra", "HD  48915" -> "HD 48915"
const GR = { alf: 'α', bet: 'β', gam: 'γ', del: 'δ', eps: 'ε', zet: 'ζ', eta: 'η', tet: 'θ', iot: 'ι', kap: 'κ', lam: 'λ', mu: 'μ', nu: 'ν',
  ksi: 'ξ', omi: 'ο', pi: 'π', rho: 'ρ', sig: 'σ', tau: 'τ', ups: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', ome: 'ω' };
const prettyName = n => n.replace(/\s+/g, ' ').replace(/^V?\* /, '').replace(/^(alf|bet|gam|del|eps|zet|eta|tet|iot|kap|lam|mu|nu|ksi|omi|pi|rho|sig|tau|ups|phi|chi|psi|ome)(\d*) /, (_, g, k) => GR[g] + (k ? k : '') + ' ');
const nf = (x, d = 0) => (x == null || !isFinite(x)) ? '—' : Number(x).toLocaleString(TR ? 'tr-TR' : 'en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtRA = ra => { const h = ra / 15, hh = Math.floor(h), m = (h - hh) * 60, mm = Math.floor(m); return `${hh}h ${String(mm).padStart(2, '0')}m ${((m - mm) * 60).toFixed(1).padStart(4, '0')}s`; };
const fmtDec = d => { const s = d < 0 ? '−' : '+', a = Math.abs(d), dd = Math.floor(a), m = (a - dd) * 60, mm = Math.floor(m); return `${s}${dd}° ${String(mm).padStart(2, '0')}′ ${Math.round((m - mm) * 60).toString().padStart(2, '0')}″`; };
function galactic(ra, dec) {
  const r = Math.PI / 180, a = ra * r, d = dec * r, aG = 192.85948 * r, dG = 27.12825 * r, l0 = 122.93192 * r;
  const sb = Math.sin(d) * Math.sin(dG) + Math.cos(d) * Math.cos(dG) * Math.cos(a - aG);
  const b = Math.asin(sb);
  const l = l0 - Math.atan2(Math.cos(d) * Math.sin(a - aG), Math.sin(d) * Math.cos(dG) - Math.cos(d) * Math.sin(dG) * Math.cos(a - aG));
  return [((l / r) % 360 + 360) % 360, b / r];
}
// rough effective temperature from B-V (Ballesteros 2012)
const teffBV = bv => (bv == null || !isFinite(bv)) ? null : 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));

export function createInfo({ sky, bodyFn, fmtLocal, altOf, send }) {
  const card = document.getElementById('skyInfo');
  const panel = document.createElement('aside');
  panel.id = 'skyDetail'; panel.className = 'sdet'; panel.setAttribute('aria-hidden', 'true');
  card.parentNode.appendChild(panel);
  let cur = null, curInfo = null, reqId = 0;
  const cache = new Map();

  function describe(o) {
    const pos = sky.objectPos(o);
    if (!pos) return null;
    if (o.type === 'star') {
      const n = sky.starName(o.i), hip = sky.ship[o.i];
      return { o, pos, name: n[0], type: T.star, mag: sky.smag[o.i], bv: sky.sbv[o.i], id: hip > 0 ? 'HIP ' + hip : null, kind: 'star', blink: true, alias: n.slice(1) };
    }
    if (o.type === 'body') {
      const b = pos, k = b.kind === 'planet' ? (b.id === 'pluto' ? T.dwarf : T.planet) : b.kind === 'moon' ? T.moon : T.sunk;
      return { o, pos, name: TR ? b.tr : b.name, type: k, mag: b.mag, color: b.color, body: b.id, kind: 'body', blink: false };
    }
    if (o.type === 'dso') {
      const d = o.d, ty = DSO_TYPES[d.type] || 'Deep-sky object';
      return { o, pos, name: d.id + (d.alt ? ' — ' + d.alt : ''), type: TR ? (DSO_TR[ty] || T.dso) : ty, mag: isFinite(d.mag) ? +d.mag : null,
        id: d.id, kind: 'dso', blink: true, alias: d.desig ? [d.desig] : [] };
    }
    if (o.type === 'cat' || o.type === 'target') {
      return { o, pos, name: o.t.name, type: o.t.type || T.target, mag: isFinite(o.t.mag) ? o.t.mag : null, id: o.t.name, kind: 'target', blink: true };
    }
    return { o, pos, name: T.pointName, type: T.point, kind: 'point', blink: true };
  }
  const dot = inf => inf.bv != null && isFinite(inf.bv) ? `rgb(${A.bvToRgb(inf.bv).join(',')})` : (inf.color || '#cfd6e6');
  function altText(alt) {
    const d = Math.round(alt);
    return alt < 0 ? T.below : alt < 12 ? T.low(d) : T.up(d);
  }

  // ---------------------------------------------------------------- quick card
  function show(o) {
    if (!o) { hide(); return; }
    if (cur && cur.o === o) return;
    const inf = describe(o);
    if (!inf) return;
    cur = inf;
    const alt = altOf(inf.pos);
    card.className = 'panel info qcard';
    card.innerHTML = `<button class="x" data-a="close" aria-label="${T.close}">×</button>
      <div class="qhead"><span class="qdot" style="background:${dot(inf)}"></span><div><h2>${esc(inf.name)}</h2>
      <div class="type">${esc(inf.type)}${inf.mag != null && isFinite(inf.mag) ? ` · <span class="mono">V ${nf(inf.mag, 1)}</span>` : ''}</div></div></div>
      <p class="qalt" data-alt>${altText(alt)}</p>
      <div class="actions"><button class="btn small primary" data-a="details">${T.details}</button>${inf.blink ? `<button class="btn small" data-a="blink">${T.blink}</button>` : ''}</div>`;
    card.querySelectorAll('[data-a]').forEach(b => (b.onclick = () => act(b.dataset.a, inf)));
    card.classList.remove('hidden');
    place();
    if (panel.classList.contains('open')) openDetails(inf);
  }
  function hide() {
    cur = null; card.classList.add('hidden'); closeDetails();
  }
  function act(a, inf) {
    if (a === 'close') { sky.select(null); hide(); return; }
    if (a === 'details') { openDetails(inf); return; }
    if (a === 'blink') send({ type: 'sky-blink', ra: inf.pos.ra, dec: inf.pos.dec, name: inf.name });
    if (a === 'science') {
      const tr = TR ? '&lang=tr' : '';
      window.open(`/planet/?view=blink&ra=${inf.pos.ra.toFixed(6)}&dec=${inf.pos.dec.toFixed(6)}&name=${encodeURIComponent(inf.name)}&auto=1${tr}`, '_blank', 'noopener');
    }
  }
  // keep the card next to its object while the sky turns or the view moves; clamp it inside the sky
  function place() {
    if (!cur || card.classList.contains('hidden')) return;
    const pos = sky.objectPos(cur.o);
    if (!pos) return;
    const W = card.parentNode.clientWidth, H = card.parentNode.clientHeight;
    const phone = W < 620;
    const q = sky.project(sky.j2view(A.radec2v(pos.ra, pos.dec)));
    const cw = card.offsetWidth, ch = card.offsetHeight;
    if (phone || !q) { card.style.left = '10px'; card.style.top = Math.max(10, H - ch - 10) + 'px'; }
    else {
      const x = q[0] / sky.dpr, y = q[1] / sky.dpr;
      let L = x + 22, Tp = y - ch / 2;
      if (L + cw > W - 10) L = x - 22 - cw;
      L = Math.min(Math.max(10, L), W - cw - 10); Tp = Math.min(Math.max(10, Tp), H - ch - 10);
      card.style.left = L + 'px'; card.style.top = Tp + 'px';
    }
    const el = card.querySelector('[data-alt]');
    const t = altText(altOf(pos));
    if (el && el.textContent !== t) el.textContent = t;
  }

  // ---------------------------------------------------------------- details panel
  function closeDetails() {
    panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); curInfo = null;
  }
  function sec(title, body, cls = '') { return `<section class="sd-sec ${cls}"><h3>${title}</h3>${body}</section>`; }
  function rows(list) {
    const r = list.filter(x => x && x[1] != null && x[1] !== '' && x[1] !== '—');
    return r.length ? `<table class="sd-tab">${r.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>` : '';
  }
  function skyNow(inf) {
    const pos = sky.objectPos(inf.o) || inf.pos;
    const v = A.radec2v(pos.ra, pos.dec);
    const [alt, az] = A.hor2altaz(sky.refract(A.mulv(sky.M, v)));
    const con = sky.constellationAt(pos.ra, pos.dec);
    const id = inf.body;
    const h0 = id === 'sun' ? -0.833 : id === 'moon' ? 0.125 : -0.5667;
    const rts = A.riseTransitSet(id ? bodyFn(id) : () => pos, sky.jdNow, sky.loc.lat, sky.loc.lon, h0);
    return rows([
      [T.altaz, `${nf(alt, 0)}° / ${nf(az, 0)}°`],
      [T.con, con ? esc(con.n?.[TR ? 'tr' : 'en'] || con.name) : '—'],
      [T.rts, rts.circumpolar ? `${T.circ} · ${fmtLocal(rts.transit)}` : rts.neverRises ? T.never : `${fmtLocal(rts.rise)} · ${fmtLocal(rts.transit)} · ${fmtLocal(rts.set)}`],
      [T.maxAlt, nf(rts.maxAlt, 0) + '°'],
    ]);
  }
  function bodyHtml(inf) {
    const b = sky.objectPos(inf.o), P = BODIES[inf.body] || {}, L = TR ? 1 : 0;
    const diam = b.diam * 3600 < 120 ? nf(b.diam * 3600, 1) + '″' : nf(b.diam * 60, 1) + '′';
    const tonight = rows([
      [T.mag, nf(b.mag, 1)],
      b.id !== 'sun' ? [T.illum, nf((b.illum || 0) * 100, 0) + '%'] : null,
      b.id === 'moon' ? [T.phase, TR ? (PHASE_TR[A.moonPhaseName(b)] || A.moonPhaseName(b)) : A.moonPhaseName(b)] : null,
      [T.diam, diam],
      b.id === 'moon' ? [T.dist, nf(b.distKm, 0) + ' km'] : [T.dist, T.distAu(nf(b.dist, 3), nf(b.dist * 8.3167, 1))],
    ]);
    const mass = P.m == null ? null : P.m >= 1 ? `${nf(P.m, P.m < 20 ? 1 : 0)} × ${T.earth}` : `${nf(P.m, P.m < 0.01 ? 4 : 3)} × ${T.earth}`;
    const phys = rows([[T.pD, P.d ? nf(P.d, 0) + ' km' : null], [T.pM, mass], [T.pS, P.s ? nf(P.s, 2) + ' AU' : null],
      [T.pY, P.y ? P.y[L] : null], [T.pDay, P.day ? P.day[L] : null], [T.pMoons, P.moons]]);
    const txt = P[TR ? 'tr' : 'en'] || [];
    return sec(T.tonight, tonight) + sec(T.phys, phys) +
      (txt[0] ? sec(T.ir, `<p>${esc(txt[0])}</p>`) : '') + (txt[1] ? sec(T.fun, `<p>${esc(txt[1])}</p>`) : '') +
      sec(T.skyNow, skyNow(inf), 'sd-now') + `<p class="sd-note">${T.bodyNoBlink}</p>`;
  }
  function openDetails(inf) {
    curInfo = inf;
    const id = ++reqId;
    const pos = inf.pos;
    const head = `<div class="sd-head"><span class="qdot" style="background:${dot(inf)}"></span><div><h2>${esc(inf.name)}</h2><div class="type">${esc(inf.type)}</div></div>
      <button class="x" data-a="closeD" aria-label="${T.close}">×</button></div>`;
    let body;
    if (inf.kind === 'body') body = bodyHtml(inf);
    else {
      const cu = curated(pos.ra, pos.dec);
      const own = cu ? cu[TR ? 'tr' : 'en'] : null;
      body = sec(T.data, `<div data-sb><p class="sd-wait">${T.loading}</p></div>`) +
        sec(T.about, own ? `<p>${esc(own.summary)}</p><ul class="sd-facts">${own.facts.slice(0, 3).map(f => `<li>${esc(f)}</li>`).join('')}</ul><p class="sd-src">${T.ownText}</p>`
          : `<div data-wiki><p class="sd-wait">${T.loading}</p></div>`) +
        sec(T.skyNow, skyNow(inf), 'sd-now') +
        sec(T.spx, `<div data-cov><p class="sd-wait">${T.loading}</p></div><div class="actions"><button class="btn small primary" data-a="blink">${T.blink}</button><button class="btn small" data-a="science">${T.science}</button></div>`);
    }
    panel.innerHTML = head + `<div class="sd-body">${body}</div>`;
    panel.querySelectorAll('[data-a]').forEach(b => (b.onclick = () => (b.dataset.a === 'closeD' ? closeDetails() : act(b.dataset.a, inf))));
    panel.classList.add('open'); panel.setAttribute('aria-hidden', 'false');
    panel.querySelector('.sd-body').scrollTop = 0;
    if (inf.kind === 'body') return;
    const fill = (sel, html) => { if (id !== reqId) return; const el = panel.querySelector(sel); if (el) el.innerHTML = html; };
    const q = new URLSearchParams({ ra: pos.ra.toFixed(5), dec: pos.dec.toFixed(5), lang: TR ? 'tr' : 'en', kind: inf.kind });
    if (inf.id) q.set('id', inf.id);
    const key = q.toString();
    const job = cache.get(key) || fetch('/api/object?' + key).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
    cache.set(key, job);
    job.then(d => {
      fill('[data-sb]', simbadHtml(d.simbad, inf));
      const w = d.wiki || {};
      fill('[data-wiki]', !w.ok ? `<p class="sd-wait">${T.failed}</p>` : !w.found ? `<p class="sd-wait">${T.noWiki}</p>` :
        `${w.fallback && T.wikiEn ? `<p class="sd-src">${T.wikiEn}</p>` : ''}<p>${esc(w.text)}</p><p class="sd-src">${T.source}: Wikipedia (${esc(w.lang)}) · <a href="${esc(w.url || '#')}" target="_blank" rel="noopener">${T.readMore}</a></p>`);
    }).catch(() => { cache.delete(key); fill('[data-sb]', `<p class="sd-wait">${T.failed}</p>`); fill('[data-wiki]', `<p class="sd-wait">${T.failed}</p>`); });
    fetch(`/api/coverage?ra=${pos.ra.toFixed(5)}&dec=${pos.dec.toFixed(5)}`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(c => {
      fill('[data-cov]', c.count ? `<p><b>${T.cov(c.count, c.passes.length)}</b></p><p class="sd-src">${T.covDates(c.first, c.last)}</p>` : `<p>${T.covNone}</p>`);
    }).catch(() => fill('[data-cov]', `<p class="sd-wait">${T.failed}</p>`));
  }
  function simbadHtml(s, inf) {
    const pos = inf.pos, [l, b] = galactic(pos.ra, pos.dec);
    const base = [[T.radec, `<span class="mono">${fmtRA(pos.ra)} / ${fmtDec(pos.dec)}</span>`], [T.gal, `<span class="mono">${nf(l, 2)}° / ${nf(b, 2)}°</span>`]];
    if (!s || !s.ok || !s.found) {
      const local = inf.mag != null ? [[T.mag, nf(inf.mag, 2)]] : [];
      const t = teffBV(inf.bv);
      return rows([...local, t ? [T.temp, '≈ ' + nf(Math.round(t / 100) * 100, 0) + ' K'] : null, ...base]) +
        (s && !s.ok ? `<p class="sd-wait">SIMBAD: ${T.failed}</p>` : '') + aliasHtml(inf.alias || [], 0);
    }
    const m = s.mags || {};
    const mags = ['B', 'V', 'J', 'H', 'K'].filter(k => m[k] != null).map(k => `<span class="mono nw">${k} ${nf(m[k], 2)}</span>`).join(' ');
    const t = teffBV(m.B != null && m.V != null ? m.B - m.V : inf.bv);
    const pm = s.pmra != null && s.pmdec != null ? Math.hypot(s.pmra, s.pmdec) : null;
    const tab = rows([
      [T.otype, s.otype_txt ? esc(s.otype_txt) : null],
      [T.mags, mags || null],
      [T.dist, s.dist_ly ? `${nf(s.dist_ly, s.dist_ly < 100 ? 1 : 0)} ${T.ly}` : null],
      [T.sp, s.sptype ? `<span class="mono">${esc(s.sptype)}</span>` : null],
      [T.temp, t && inf.kind !== 'dso' ? '≈ ' + nf(Math.round(t / 100) * 100, 0) + ' K' : null],
      [T.rv, s.rv_kms != null ? nf(s.rv_kms, 1) + ' km/s' : null],
      [T.pm, pm != null && pm > 5 ? nf(pm, 0) + ' mas/yr' : null],
      ...base,
    ]);
    const seen = new Set([inf.name.replace(/\s/g, '')]);
    const names = [...(s.names || []), ...(inf.alias || [])].map(prettyName)
      .filter(n => { const k = n.replace(/\s/g, ''); if (!n || seen.has(k)) return false; seen.add(k); return true; });
    return tab + aliasHtml(names, Math.max(0, (s.n_names || 0) - names.length)) + `<p class="sd-src">${T.source}: SIMBAD (CDS) · ${esc(prettyName(s.id || ''))}</p>`;
  }
  function aliasHtml(names, extra) {
    if (!names.length) return '';
    return `<div class="sd-names"><span class="sd-lab">${T.names}</span>${names.slice(0, 10).map(n => `<span class="chip">${esc(n)}</span>`).join('')}${extra > 0 ? `<span class="chip more">${T.more(extra)}</span>` : ''}</div>`;
  }

  return {
    show, hide, place,
    tick() { place(); },
    refreshSky() { if (curInfo) { const el = panel.querySelector('.sd-now'); if (el) el.innerHTML = `<h3>${T.skyNow}</h3>` + skyNow(curInfo); } },
  };
}
