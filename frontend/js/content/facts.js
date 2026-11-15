// Hand-written background for the five challenge targets, object-type names, the glossary and the
// guided story. Numbers are from SIMBAD / Gaia DR3 and the papers named in docs/VALIDATION.md.

export const TARGETS = [
  {
    key: 'barnard', ra: 269.4521, dec: 4.6934, q: "Barnard's Star", temp: '≈ 3,200 K', distLy: 5.96,
    en: {
      kind: 'Red dwarf',
      summary: 'The fastest-moving star in our sky and the closest single star to the Sun. A small, cool and very old red dwarf, about 16% of the Sun’s mass and far too faint to see without a telescope.',
      facts: [
        'E. E. Barnard measured its record motion in 1916: 10.4″ a year, enough to cross the full Moon’s width in about 180 years.',
        'It is coming towards us at 110 km/s. Around the year 11,800 it will pass about 3.8 light-years from the Sun, closer than any star is today.',
        'Four small rocky planets were confirmed around it in 2024–2025. All of them orbit closer to it than Mercury does to the Sun.',
        'It is thought to be 7–10 billion years old: about twice the age of the Sun.',
        'In SPHEREx you can watch it creep north between visits. Radians measures 10.38″/yr from the images alone.',
      ],
    },
    tr: {
      kind: 'Kırmızı cüce',
      summary: 'Gökyüzümüzde en hızlı hareket eden yıldız ve Güneş’e en yakın tekil yıldız. Güneş kütlesinin yaklaşık %16’sı kadar, küçük, soğuk ve çok yaşlı bir kırmızı cüce; teleskopsuz görülemeyecek kadar sönük.',
      facts: [
        'E. E. Barnard rekor hareketini 1916’da ölçtü: yılda 10,4″. Bu hızla dolunayın çapını yaklaşık 180 yılda geçer.',
        'Bize saniyede 110 km hızla yaklaşıyor. 11.800 yılı civarında Güneş’e yaklaşık 3,8 ışık yılı mesafeden geçecek; bugün hiçbir yıldız bu kadar yakın değil.',
        '2024–2025’te çevresinde dört küçük kayalık gezegen doğrulandı. Hepsi yıldızına, Merkür’ün Güneş’e olduğundan daha yakın.',
        'Yaşının 7–10 milyar yıl olduğu düşünülüyor: Güneş’in yaklaşık iki katı.',
        'SPHEREx ziyaretleri arasında kuzeye kaydığını izleyebilirsiniz. Radians yalnızca görüntülerden yılda 10,38″ ölçüyor.',
      ],
    },
  },
  {
    key: 'epsindi', ra: 331.0441, dec: -56.7828, q: 'eps Indi B', temp: '≈ 1,300 K + 900 K', distLy: 12.0,
    en: {
      kind: 'Brown-dwarf pair',
      summary: 'Two brown dwarfs — too heavy to be planets, too light to burn hydrogen like stars — orbiting each other. They are distant companions of ε Indi A, a Sun-like orange star 12 light-years away.',
      facts: [
        'Found in 2003; a year later the “single” brown dwarf turned out to be two, now called Ba and Bb.',
        'Ba and Bb circle each other every 11 years, about 2.4 AU apart: a bit farther than Mars is from the Sun.',
        'Each is roughly 50–75 times the mass of Jupiter.',
        'In 2024 the James Webb Space Telescope photographed a cold giant planet, ε Indi Ab, around the main star.',
        'The pair sits about 1,500 AU from ε Indi A; light takes over a week to cross that gap.',
      ],
    },
    tr: {
      kind: 'Kahverengi cüce çifti',
      summary: 'Birbirinin etrafında dolanan iki kahverengi cüce: gezegen olamayacak kadar ağır, yıldız gibi hidrojen yakamayacak kadar hafif. 12 ışık yılı uzaklıktaki Güneş benzeri turuncu yıldız ε Indi A’nın uzak eşleri.',
      facts: [
        '2003’te bulundu; bir yıl sonra “tek” kahverengi cücenin aslında iki tane olduğu anlaşıldı: Ba ve Bb.',
        'Ba ve Bb birbirinin etrafını 11 yılda bir dolanıyor, aralarında yaklaşık 2,4 AB var: Mars’ın Güneş’e uzaklığından biraz fazla.',
        'Her biri Jüpiter’in yaklaşık 50–75 katı kütlede.',
        '2024’te James Webb Uzay Teleskobu ana yıldızın çevresindeki soğuk dev gezegen ε Indi Ab’yi doğrudan görüntüledi.',
        'Çift, ε Indi A’dan yaklaşık 1.500 AB uzakta; ışık bu mesafeyi bir haftadan uzun sürede aşıyor.',
      ],
    },
  },
  {
    key: 'wise0855', ra: 133.8189, dec: -7.2470, q: 'WISE J085510.83-071442.5', temp: '≈ 285 K (≈ +10 °C)', distLy: 7.4,
    en: {
      kind: 'Coldest known brown dwarf',
      summary: 'A lone object only a few times heavier than Jupiter and about as cold as a spring day on Earth. At 7.4 light-years it is the fourth-closest system to the Sun, yet nobody saw it until 2014.',
      facts: [
        'Kevin Luhman found it in 2014 in images from NASA’s WISE infrared satellite.',
        'It is practically invisible in visible light and glows mostly at 4–5 µm. That is why Radians follows it only in SPHEREx detectors 5 and 6.',
        'JWST spectra show water vapour, methane, ammonia, carbon monoxide and carbon dioxide in its atmosphere.',
        'Its mass is estimated at 3–10 Jupiter masses: a “rogue” world with no star of its own.',
        'It moves 8.15″ a year across the sky; Radians measures 8.16″/yr.',
      ],
    },
    tr: {
      kind: 'Bilinen en soğuk kahverengi cüce',
      summary: 'Jüpiter’den yalnızca birkaç kat ağır, Dünya’da bir bahar günü kadar soğuk, yalnız bir cisim. 7,4 ışık yılı ile Güneş’e en yakın dördüncü sistem; yine de 2014’e kadar kimse görmemişti.',
      facts: [
        'Kevin Luhman 2014’te NASA’nın kızılötesi uydusu WISE’ın görüntülerinde buldu.',
        'Görünür ışıkta neredeyse görünmez, çoğunlukla 4–5 µm’de parlar. Radians’ın onu yalnızca SPHEREx dedektör 5 ve 6’da izlemesinin nedeni bu.',
        'JWST tayfları atmosferinde su buharı, metan, amonyak, karbon monoksit ve karbon dioksit gösteriyor.',
        'Kütlesi 3–10 Jüpiter kütlesi olarak tahmin ediliyor: kendine ait yıldızı olmayan “başıboş” bir dünya.',
        'Gökyüzünde yılda 8,15″ yol alıyor; Radians 8,16″ ölçüyor.',
      ],
    },
  },
  {
    key: 'rwaur', ra: 76.9565, dec: 30.4014, q: 'RW Aur', temp: '≈ 4,500 K', distLy: 500, distNote: true,
    en: {
      kind: 'Young T Tauri star (binary)',
      summary: 'A star system only a few million years old in the Taurus–Auriga star-forming clouds, about 500 light-years away. It is still wrapped in the gas and dust it formed from, so its light flickers unpredictably.',
      facts: [
        'Since 2010 it has repeatedly faded for months at a time, when clumps of dust drift in front of the star.',
        'Its disk looks torn: a long arm of gas, probably pulled out when its companion RW Aur B passed close by.',
        'It shoots out a narrow two-sided jet of gas at more than 100 km/s.',
        'Our Sun probably looked like this 4.6 billion years ago.',
        'Between SPHEREx visits Radians sees it change brightness by a factor of 1.7.',
      ],
    },
    tr: {
      kind: 'Genç T Tauri yıldızı (çift)',
      summary: 'Yaklaşık 500 ışık yılı uzaklıkta, Boğa–Arabacı yıldız oluşum bulutlarında yalnızca birkaç milyon yaşında bir yıldız sistemi. Oluştuğu gaz ve toza hâlâ sarılı olduğundan ışığı öngörülemez biçimde titriyor.',
      facts: [
        '2010’dan beri toz kümeleri önünden geçtikçe aylarca sönükleşiyor.',
        'Diski yırtılmış görünüyor: büyük olasılıkla eşi RW Aur B yakından geçerken çekip çıkardığı uzun bir gaz kolu.',
        'Saniyede 100 km’den hızlı, ince ve iki yönlü bir gaz jeti fışkırtıyor.',
        'Güneş’imiz 4,6 milyar yıl önce büyük olasılıkla buna benziyordu.',
        'Radians, SPHEREx ziyaretleri arasında parlaklığının 1,7 kat değiştiğini görüyor.',
      ],
    },
  },
  {
    key: 'rdra', ra: 248.1676, dec: 66.7550, q: 'R Dra', temp: '≈ 2,500–3,000 K', distLy: 2600,
    look: 'brightness',   // does not move: the viewer opens on its light curve and says so
    en: {
      kind: 'Mira variable (pulsating red giant)',
      summary: 'An old red giant that swells and shrinks every 245 days or so. In visible light its brightness swings by hundreds of times; in the infrared the swing is far smaller, because the star mostly changes temperature, not total power.',
      facts: [
        'Mira variables are named after Mira (ο Ceti), the first one found, by David Fabricius in 1596.',
        'Stars like this are near the end of their lives. Our Sun will become one in about 7 billion years.',
        'It is so bright for SPHEREx that the centre of its image saturates. Radians measures it from the ring of light around it (the PSF wings).',
        'Each pulsation puffs out dust that will one day help build new stars and planets.',
      ],
    },
    tr: {
      kind: 'Mira değişeni (zonklayan kırmızı dev)',
      summary: 'Yaklaşık 245 günde bir şişip büzülen yaşlı bir kırmızı dev. Görünür ışıkta parlaklığı yüzlerce kat değişir; kızılötesinde değişim çok daha küçüktür, çünkü yıldız toplam gücünü değil çoğunlukla sıcaklığını değiştirir.',
      facts: [
        'Mira değişenleri, ilk bulunan örnek olan Mira’nın (ο Ceti) adını taşır; 1596’da David Fabricius keşfetti.',
        'Bu tür yıldızlar ömürlerinin sonuna yakındır. Güneş’imiz yaklaşık 7 milyar yıl sonra böyle bir yıldıza dönüşecek.',
        'SPHEREx için o kadar parlak ki görüntüsünün merkezi doyuyor. Radians onu çevresindeki ışık halkasından (PSF kanatları) ölçüyor.',
        'Her zonklamada saçtığı toz, bir gün yeni yıldızların ve gezegenlerin yapımına katılacak.',
      ],
    },
  },
];

export function curated(ra, dec) {
  const cosd = Math.cos(dec * Math.PI / 180);
  return TARGETS.find(x => Math.hypot((x.ra - ra) * cosd, x.dec - dec) < 0.05) || null;
}

// SIMBAD object types (the common ones)
export const OTYPES = {
  '*': ['Star', 'Yıldız'], '**': ['Double or multiple star', 'Çift veya çoklu yıldız'],
  'BY*': ['Spotted, flaring red dwarf (BY Draconis variable)', 'Lekeli, parlayan kırmızı cüce (BY Draconis değişeni)'],
  'BD*': ['Brown dwarf', 'Kahverengi cüce'], 'TT*': ['T Tauri star (very young star)', 'T Tauri yıldızı (çok genç yıldız)'],
  'Mi*': ['Mira variable (pulsating red giant)', 'Mira değişeni (zonklayan kırmızı dev)'],
  'PM*': ['High proper-motion star', 'Yüksek öz hareketli yıldız'], 'LM*': ['Low-mass star', 'Düşük kütleli yıldız'],
  'RG*': ['Red giant', 'Kırmızı dev'], 'AB*': ['Asymptotic giant branch star', 'Asimptotik dev kolu yıldızı'],
  'C*': ['Carbon star', 'Karbon yıldızı'], 'V*': ['Variable star', 'Değişen yıldız'], 'Er*': ['Eruptive variable', 'Patlamalı değişen'],
  'Ro*': ['Rotating variable', 'Dönen değişen'], 'EB*': ['Eclipsing binary', 'Örten çift'], 'SB*': ['Spectroscopic binary', 'Tayfsal çift'],
  'WD*': ['White dwarf', 'Beyaz cüce'], 'Y*O': ['Young stellar object', 'Genç yıldız cismi'], 'Or*': ['Orion variable (young star)', 'Orion değişeni (genç yıldız)'],
  'Ae*': ['Herbig Ae/Be star (young, massive)', 'Herbig Ae/Be yıldızı (genç, kütleli)'], 'cC*': ['Cepheid', 'Sefeid'],
  'RR*': ['RR Lyrae variable', 'RR Lyrae değişeni'], 'dS*': ['Delta Scuti variable', 'Delta Scuti değişeni'],
  'LP*': ['Long-period variable', 'Uzun dönemli değişen'], 'sr*': ['Semi-regular variable', 'Yarı düzenli değişen'],
  'Be*': ['Be star', 'Be yıldızı'], 'WR*': ['Wolf-Rayet star', 'Wolf-Rayet yıldızı'], 'pA*': ['Post-AGB star', 'AGB sonrası yıldız'],
  's*r': ['Red supergiant', 'Kırmızı süperdev'], 'Em*': ['Emission-line star', 'Salma çizgili yıldız'], 'Fl*': ['Flare star', 'Parlama yıldızı'],
  'CV*': ['Cataclysmic variable', 'Kataklismik değişen'], 'No*': ['Nova', 'Nova'], 'XB*': ['X-ray binary', 'X ışını çifti'],
  'Psr': ['Pulsar', 'Atarca'], 'HS*': ['Hot subdwarf', 'Sıcak altcüce'], 'HB*': ['Horizontal-branch star', 'Yatay kol yıldızı'],
  'G': ['Galaxy', 'Gökada'], 'GiG': ['Galaxy in a group', 'Grupta gökada'], 'AGN': ['Active galactic nucleus', 'Etkin gökada çekirdeği'],
  'QSO': ['Quasar', 'Kuasar'], 'Sy1': ['Seyfert 1 galaxy', 'Seyfert 1 gökadası'], 'Sy2': ['Seyfert 2 galaxy', 'Seyfert 2 gökadası'],
  'Cl*': ['Star cluster', 'Yıldız kümesi'], 'OpC': ['Open cluster', 'Açık küme'], 'GlC': ['Globular cluster', 'Küresel küme'],
  'PN': ['Planetary nebula', 'Gezegenimsi bulutsu'], 'HII': ['HII region (ionised gas)', 'HII bölgesi (iyonlaşmış gaz)'],
  'RNe': ['Reflection nebula', 'Yansıma bulutsusu'], 'MoC': ['Molecular cloud', 'Moleküler bulut'], 'DNe': ['Dark cloud', 'Karanlık bulut'],
  'SNR': ['Supernova remnant', 'Süpernova kalıntısı'], 'SN*': ['Supernova', 'Süpernova'],
};

// rough surface temperature from a spectral type such as "M4V" or "T1V+T6V" (first component)
const TEFF0 = { O: 42000, B: 30000, A: 9700, F: 7200, G: 5900, K: 5250, M: 3850, L: 2400, T: 1300, Y: 450 };
const NEXT = { O: 'B', B: 'A', A: 'F', F: 'G', G: 'K', K: 'M', M: 'L', L: 'T', T: 'Y' };
export function teffFromSp(sp) {
  const m = /^([OBAFGKMLTY])(\d(?:\.\d)?)?/.exec((sp || '').trim());
  if (!m) return null;
  const a = TEFF0[m[1]], b = NEXT[m[1]] ? TEFF0[NEXT[m[1]]] : 250, sub = m[2] ? Number(m[2]) : 5;
  const v = a + (b - a) * sub / 10;
  return v > 5000 ? Math.round(v / 500) * 500 : Math.round(v / 100) * 100;
}

// glossary: words that get a dotted underline and an explanation on hover / tap
export const TERMS = {
  sigma: ['σ (sigma)', 'How far a signal stands above the noise. Above about 5σ it is very unlikely to be a random fluctuation.',
    'σ (sigma)', 'Bir sinyalin gürültünün ne kadar üstünde olduğu. Yaklaşık 5σ üstü rastgele bir dalgalanma olma olasılığı çok düşüktür.'],
  pa: ['PA (position angle)', 'Direction on the sky, measured from north towards east: 0° = north, 90° = east, 180° = south.',
    'PA (konum açısı)', 'Gökyüzünde yön; kuzeyden doğuya doğru ölçülür: 0° = kuzey, 90° = doğu, 180° = güney.'],
  arcsec: ['″ (arcsecond)', '1/3600 of a degree. The full Moon is about 1,865″ wide; one SPHEREx pixel is 6.2″.',
    '″ (yay saniyesi)', 'Bir derecenin 1/3600’ü. Dolunay yaklaşık 1.865″ genişliğinde; bir SPHEREx pikseli 6,2″.'],
  um: ['µm (micrometre)', 'A millionth of a metre. Our eyes see 0.4–0.7 µm; SPHEREx sees infrared light from 0.75 to 5 µm.',
    'µm (mikrometre)', 'Metrenin milyonda biri. Gözümüz 0,4–0,7 µm’yi görür; SPHEREx 0,75–5 µm kızılötesi ışığı görür.'],
  psf: ['PSF wings', 'The faint halo around a star’s image. When the centre is saturated, the halo still follows the star’s brightness.',
    'PSF kanatları', 'Bir yıldız görüntüsünün çevresindeki sönük hale. Merkez doyduğunda hale yıldızın parlaklığını izlemeye devam eder.'],
  pm: ['Proper motion', 'How fast a star drifts across the sky, usually in arcseconds per year. Nearby, fast stars have the largest.',
    'Öz hareket', 'Bir yıldızın gökyüzünde ne hızla kaydığı; genellikle yılda yay saniyesi. Yakın ve hızlı yıldızlarda en büyüktür.'],
  epoch: ['Epoch (visit)', 'SPHEREx scans each patch of sky over a few days, then usually comes back about six months later (near the ecliptic poles much more often). One visit = one frame here.',
    'Epok (ziyaret)', 'SPHEREx her bölgeyi birkaç gün içinde tarar, genellikle yaklaşık altı ay sonra geri gelir (ekliptik kutuplarına yakın yerlerde çok daha sık). Burada bir ziyaret = bir kare.'],
  ujy: ['µJy (microjansky)', 'A unit of brightness (flux density) used in astronomy. 1 Jy = 10⁻²⁶ W m⁻² Hz⁻¹.',
    'µJy (mikrojansky)', 'Astronomide kullanılan parlaklık (akı yoğunluğu) birimi. 1 Jy = 10⁻²⁶ W m⁻² Hz⁻¹.'],
  mjy: ['MJy/sr', 'Surface brightness: brightness per patch of sky (megajansky per steradian). The unit of SPHEREx images.',
    'MJy/sr', 'Yüzey parlaklığı: gökyüzünün birim alanı başına parlaklık (steradyan başına megajansky). SPHEREx görüntülerinin birimi.'],
  ly: ['Light-year', 'The distance light travels in a year: 9.46 trillion km. The nearest star system is 4.2 light-years away.',
    'Işık yılı', 'Işığın bir yılda aldığı yol: 9,46 trilyon km. En yakın yıldız sistemi 4,2 ışık yılı uzakta.'],
  saturated: ['Saturated', 'The pixel got more light than it can measure, so the brightest part is clipped.',
    'Doymuş', 'Piksel ölçebileceğinden fazla ışık aldı; en parlak kısım kırpılmış olur.'],
  flagged: ['Quality flags', 'Per-pixel warnings from the SPHEREx pipeline (cosmic ray, saturation, halo…). Flagged points are drawn hollow.',
    'Kalite işaretleri', 'SPHEREx işlem hattının piksel başına uyarıları (kozmik ışın, doyma, hale…). İşaretli noktalar içi boş çizilir.'],
  spt: ['Spectral type', 'A star’s class by temperature, hottest to coolest: O B A F G K M, then the brown dwarfs L T Y. The Sun is G2.',
    'Tayf türü', 'Yıldızın sıcaklığa göre sınıfı, en sıcaktan en soğuğa: O B A F G K M, ardından kahverengi cüceler L T Y. Güneş G2’dir.'],
  plx: ['Parallax', 'The small yearly wobble of a nearby star as Earth orbits the Sun. Distance in parsecs = 1000 / parallax in mas.',
    'Paralaks', 'Dünya Güneş’in etrafında dönerken yakın bir yıldızın yaptığı küçük yıllık salınım. Parsek cinsinden uzaklık = 1000 / mas cinsinden paralaks.'],
};

// patterns found in rendered text -> glossary key
export const TERM_PATTERNS = [
  [/\d+(?:[.,]\d+)?σ/g, 'sigma'], [/\bPA\b/g, 'pa'], [/″\/(?:yr|yıl)/g, 'arcsec'], [/µm/g, 'um'],
  [/\bPSF\b/g, 'psf'], [/µJy/g, 'ujy'], [/MJy\/sr/g, 'mjy'],
];

// the guided story: one stop per challenge target
export const STORY = [
  { q: "Barnard's Star", en: ['The fastest star in the sky', 'Barnard’s Star crosses a full Moon’s width every 180 years. Watch the blue marker: between SPHEREx visits the star creeps north. Radians found it on its own and measured 10.38″/yr, against 10.39″/yr in the catalogue.'],
    tr: ['Gökyüzünün en hızlı yıldızı', 'Barnard Yıldızı dolunayın çapını 180 yılda geçer. Mavi işarete bakın: SPHEREx ziyaretleri arasında yıldız kuzeye kayıyor. Radians onu kendi başına buldu ve yılda 10,38″ ölçtü; katalog değeri 10,39″.'] },
  { q: 'eps Indi B', en: ['Two failed stars, 12 light-years away', 'ε Indi B is a pair of brown dwarfs. They are dim in visible light but glow in the infrared, and SPHEREx catches their motion across four visits: 4.65″/yr, south-east.'],
    tr: ['12 ışık yılı ötede iki “başarısız yıldız”', 'ε Indi B bir kahverengi cüce çifti. Görünür ışıkta sönükler ama kızılötesinde parlıyorlar; SPHEREx dört ziyarette hareketlerini yakalıyor: yılda 4,65″, güneydoğuya.'] },
  { q: 'WISE J085510.83-071442.5', det: '5,6', wl: false, en: ['A world as cold as a spring day', 'WISE 0855 is invisible in visible light and shows up only at 4–5 µm, so Radians uses SPHEREx detectors 5 and 6. This is exactly what a distant Planet X would look like: a faint dot that is somewhere else at the next visit.'],
    tr: ['Bir bahar günü kadar soğuk bir dünya', 'WISE 0855 görünür ışıkta görünmez, yalnızca 4–5 µm’de belirir; bu yüzden Radians SPHEREx dedektör 5 ve 6’yı kullanır. Uzak bir Planet X tam olarak böyle görünürdü: bir sonraki ziyarette başka yerde olan sönük bir nokta.'] },
  { q: 'RW Aur', tab: 'lightcurve', en: ['A newborn star that flickers', 'RW Aurigae is only a few million years old and still wrapped in dust. The light curve below shows every detector agreeing: the star itself changed brightness, by a factor of 1.7.'],
    tr: ['Titreyen yeni doğmuş bir yıldız', 'RW Aurigae yalnızca birkaç milyon yaşında ve hâlâ toza sarılı. Aşağıdaki ışık eğrisinde tüm dedektörler aynı şeyi söylüyor: yıldızın kendisi parlaklık değiştirdi, 1,7 kat.'] },
  { q: 'R Dra', tab: 'spectrum', en: ['A giant that breathes', 'R Draconis is a pulsating red giant, so bright that its centre saturates. Radians measures it from the halo around it. Every point in the spectrum is one SPHEREx exposure at its own wavelength.'],
    tr: ['Nefes alan bir dev', 'R Draconis zonklayan bir kırmızı dev; o kadar parlak ki merkezi doyuyor. Radians onu çevresindeki haleden ölçüyor. Tayftaki her nokta, kendi dalga boyundaki bir SPHEREx pozu.'] },
];

// "Explore the sky": interesting fields, each checked to have 3+ SPHEREx visits
export const EXPLORE = [
  { q: 'Proxima Cen', en: 'Proxima Centauri: the closest star to the Sun, a flaring red dwarf.', tr: 'Proxima Centauri: Güneş’e en yakın yıldız, parlamalar yapan bir kırmızı cüce.' },
  { q: "Kapteyn's star", en: 'Kapteyn’s Star: the second-fastest star in the sky, a visitor from the Milky Way’s halo.', tr: 'Kapteyn Yıldızı: gökyüzünün en hızlı ikinci yıldızı, Samanyolu’nun halesinden gelen bir ziyaretçi.' },
  { q: 'Groombridge 1830', en: 'Groombridge 1830: an ancient halo star racing across the sky at 7″ a year.', tr: 'Groombridge 1830: gökyüzünde yılda 7″ hızla koşan çok yaşlı bir hale yıldızı.' },
  { q: 'Lacaille 9352', en: 'Lacaille 9352: a nearby red dwarf moving almost 7″ a year.', tr: 'Lacaille 9352: yılda yaklaşık 7″ hareket eden yakın bir kırmızı cüce.' },
  { q: '61 Cyg A', en: '61 Cygni: the first star whose distance was ever measured (Bessel, 1838).', tr: '61 Cygni: uzaklığı ilk kez ölçülen yıldız (Bessel, 1838).' },
  { q: 'Luhman 16', en: 'Luhman 16: the closest pair of brown dwarfs, 6.5 light-years away.', tr: 'Luhman 16: 6,5 ışık yılı uzaklıktaki en yakın kahverengi cüce çifti.' },
  { q: 'Wolf 359', en: 'Wolf 359: a small, flaring red dwarf just 7.9 light-years away.', tr: 'Wolf 359: yalnızca 7,9 ışık yılı uzaklıkta küçük, parlamalar yapan bir kırmızı cüce.' },
  { q: "Teegarden's star", en: 'Teegarden’s Star: a dim red dwarf with Earth-mass planets, moving 5″ a year.', tr: 'Teegarden Yıldızı: Dünya kütleli gezegenleri olan, yılda 5″ hareket eden sönük bir kırmızı cüce.' },
  { q: 'Ross 128', en: 'Ross 128: a quiet red dwarf 11 light-years away with a temperate planet.', tr: 'Ross 128: 11 ışık yılı uzaklıkta, ılıman bir gezegeni olan sakin bir kırmızı cüce.' },
  { q: 'Lalande 21185', en: 'Lalande 21185: one of the brightest red dwarfs in our sky, 8.3 light-years away.', tr: 'Lalande 21185: gökyüzümüzdeki en parlak kırmızı cücelerden biri, 8,3 ışık yılı uzakta.' },
  { q: 'omi Cet', en: 'Mira: the original pulsating red giant, found in 1596. Bright enough to saturate.', tr: 'Mira: 1596’da bulunan ilk zonklayan kırmızı dev. Doyacak kadar parlak.' },
  { q: 'chi Cyg', en: 'Chi Cygni: a Mira variable with one of the largest brightness swings known.', tr: 'Chi Cygni: bilinen en büyük parlaklık değişimlerinden birine sahip bir Mira değişeni.' },
  { q: 'T Tau', en: 'T Tauri: the prototype of all young stars, still wrapped in its own nebula.', tr: 'T Tauri: tüm genç yıldızların örneği, hâlâ kendi bulutsusuna sarılı.' },
  { q: 'FU Ori', en: 'FU Orionis: a young star that brightened hundreds of times in 1937 and stayed bright.', tr: 'FU Orionis: 1937’de yüzlerce kat parlayıp öyle kalan genç bir yıldız.' },
];
