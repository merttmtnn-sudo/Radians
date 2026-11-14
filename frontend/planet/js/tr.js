// Turkish for the planetarium page. The page is written in English; when Radians is set to Turkish
// (?lang=tr or the saved choice) every text node, placeholder and tooltip that matches an entry below is
// swapped, also for text the scripts add later (MutationObserver).
const TR = {
  'Planetarium': 'Planetaryum', 'Time-Lapse & Spectra': 'Zaman atlamalı & Tayf', 'About': 'Hakkında',
  'Search: name, M31, HIP 87937, 08h55m10.8s -07d14m42s …': 'Ara: ad, M31, HIP 87937, 08h55m10.8s -07d14m42s …',
  'Current target (shared by all tools)': 'Geçerli hedef (tüm araçlarda ortak)', 'No target': 'Hedef yok',
  'SPHEREx sky': 'SPHEREx göğü', 'Display': 'Görünüm', 'Single wavelength': 'Tek dalga boyu',
  'RGB composite of 3 wavelengths': '3 dalga boyundan RGB', 'Wavelength': 'Dalga boyu', 'Colormap': 'Renk haritası',
  'Red': 'Kırmızı', 'Green': 'Yeşil', 'Blue': 'Mavi', 'Stars & dust': 'Yıldızlar & toz',
  'Ices: CO / CO₂ / H₂O': 'Buzlar: CO / CO₂ / H₂O', 'Brightness': 'Parlaklık', 'Contrast (gamma)': 'Kontrast (gama)',
  'Black point': 'Siyah noktası', 'Reset display': 'Görünümü sıfırla', 'Compare with another survey': 'Başka bir taramayla karşılaştır',
  '— none —': '— yok —', 'SPHEREx at another wavelength': 'Başka dalga boyunda SPHEREx', '2MASS color (J, H, Ks)': '2MASS renkli (J, H, Ks)',
  'AllWISE color (W1, W2, W4)': 'AllWISE renkli (W1, W2, W4)', 'DSS2 optical color': 'DSS2 optik renkli',
  'SDSS DR9 color': 'SDSS DR9 renkli', 'GALEX ultraviolet': 'GALEX morötesi', 'Other wavelength': 'Diğer dalga boyu',
  'Mode': 'Kip', 'Blink': 'Yanıp sönme', 'Cross-fade': 'Geçişli', 'Blink period (s)': 'Yanıp sönme süresi (sn)',
  'Catalog overlays': 'Katalog katmanları', '(field of view < 3°)': '(görüş alanı < 3°)', 'SIMBAD objects': 'SIMBAD nesneleri',
  'Location': 'Konum', 'Preset': 'Hazır konum', 'Latitude°': 'Enlem°', 'Longitude°': 'Boylam°', 'Elevation (m)': 'Yükseklik (m)',
  'Apply': 'Uygula', 'Use my location': 'Konumumu kullan', 'Date & Time': 'Tarih & Saat', 'Local date/time': 'Yerel tarih/saat',
  'Set': 'Ayarla', 'Now': 'Şimdi', 'Slower / reverse (J)': 'Yavaş / geri (J)', 'Pause / real-time (K)': 'Duraklat / gerçek zaman (K)',
  'Real time': 'Gerçek zaman', 'real time': 'gerçek zaman', 'Faster (L)': 'Hızlı (L)', '−1 day': '−1 gün', '+1 day': '+1 gün',
  '+1 sid. day': '+1 yıldız günü', '+1 year': '+1 yıl', 'Sky & View': 'Gök & Görünüm', 'Projection': 'İzdüşüm',
  'Stereographic': 'Stereografik', 'Fisheye (equidistant)': 'Balıkgözü (eşit uzaklık)', 'Orthographic': 'Ortografik',
  'Perspective (gnomonic)': 'Perspektif (gnomonik)', 'Equal-area (Lambert)': 'Eşit alan (Lambert)', 'Mount': 'Kundak',
  'Alt-azimuth': 'Alt-azimut', 'Equatorial (J2000)': 'Ekvatoral (J2000)', 'Light pollution (Bortle)': 'Işık kirliliği (Bortle)',
  'Star brightness': 'Yıldız parlaklığı', 'Extra magnitude limit': 'Ek kadir sınırı', 'Constellation names': 'Takımyıldız adları',
  'English': 'İngilizce', 'Atmospheric refraction': 'Atmosferik kırılma', 'Star twinkling (scintillation)': 'Yıldız titreşmesi',
  'Star names': 'Yıldız adları', 'Deep-sky labels': 'Derin gök etiketleri', 'SPHEREx challenge targets': 'SPHEREx yarışma hedefleri',
  'Track selected object': 'Seçili nesneyi izle',
  'SPHEREx sky: wavelengths, colours, survey comparison, catalogs (F7)': 'SPHEREx göğü: dalga boyları, renkler, karşılaştırma, kataloglar (F7)',
  'Location window (F6)': 'Konum penceresi (F6)', 'Date/time window (F5)': 'Tarih/saat penceresi (F5)', 'Time': 'Zaman',
  'Sky and view options (F4)': 'Gök ve görünüm seçenekleri (F4)', 'View': 'Görünüm',
  'SPHEREx infrared sky images (I)': 'SPHEREx kızılötesi gök görüntüleri (I)', 'Catalogue star dots on top of the images (S)': 'Görüntülerin üstünde katalog yıldızları (S)',
  'Stars': 'Yıldızlar', 'Constellation lines (C)': 'Takımyıldız çizgileri (C)', 'Lines': 'Çizgiler', 'Constellation names (V)': 'Takımyıldız adları (V)',
  'Names': 'Adlar', 'Constellation boundaries (B)': 'Takımyıldız sınırları (B)', 'Bounds': 'Sınırlar',
  'Atmosphere: daylight hides the sky as in reality (A)': 'Atmosfer: gündüz gök gerçekteki gibi gizlenir (A)', 'Atmos.': 'Atmosfer',
  'Ground / landscape (G)': 'Zemin / manzara (G)', 'Ground': 'Zemin', 'Cardinal points (Q)': 'Ana yönler (Q)',
  'Equatorial grid (E)': 'Ekvatoral ızgara (E)', 'Eq. grid': 'Ekv. ızgara', 'Azimuthal grid (Z)': 'Azimut ızgarası (Z)', 'Az. grid': 'Az. ızgara',
  'Ecliptic line (,)': 'Tutulum çizgisi (,)', 'Ecliptic': 'Tutulum', 'Galactic equator (.)': 'Galaktik ekvator (.)', 'Galactic': 'Galaktik',
  'Meridian (;)': 'Meridyen (;)', 'Meridian': 'Meridyen', 'Deep-sky objects (D)': 'Derin gök nesneleri (D)', 'DSOs': 'Derin gök',
  'Solar-system objects / labels (P)': 'Güneş sistemi nesneleri (P)', 'Planets': 'Gezegenler',
  'Decrease time speed (J)': 'Zamanı yavaşlat (J)', 'Pause / real time (K)': 'Duraklat / gerçek zaman (K)', 'Increase time speed (L)': 'Zamanı hızlandır (L)',
  'Set time to now (8)': 'Zamanı şimdiye al (8)', 'Zoom in (Page Up / wheel)': 'Yakınlaş (Page Up / tekerlek)', 'Zoom out (Page Down / wheel)': 'Uzaklaş (Page Down / tekerlek)',
  'Center on selected object (Space)': 'Seçili nesneyi ortala (Boşluk)', 'Night vision mode (Ctrl+N)': 'Gece görüşü (Ctrl+N)', 'Night': 'Gece',
  'Full screen (F11)': 'Tam ekran (F11)', 'Save screenshot (Ctrl+S)': 'Ekran görüntüsü kaydet (Ctrl+S)',
  '1 · Sky position': '1 · Gökteki konum', 'Challenge test targets': 'Yarışma test hedefleri', '— choose —': '— seçin —',
  'Name': 'Ad', "e.g. Barnard's star": 'ör. Barnard yıldızı', 'Resolve': 'Bul', 'Coordinate epoch (yr)': 'Koordinat dönemi (yıl)',
  'Center on proper-motion position at SPHEREx epoch': 'SPHEREx dönemindeki öz hareketli konuma ortala', '2 · Data': '2 · Veri',
  'Field of view': 'Görüş alanı', 'Exposures to load': 'Yüklenecek pozlar', 'Quick look: ≤4 per detector per epoch': 'Hızlı bakış: dönem ve dedektör başına ≤4',
  'Balanced: ≤10 per detector per epoch': 'Dengeli: dönem ve dedektör başına ≤10', 'Everything (deepest, slowest first time)': 'Hepsi (en derin, ilk sefer en yavaş)',
  'Search SPHEREx & load': 'SPHEREx’te ara & yükle', '3 · Frames': '3 · Kareler', 'Frame mode': 'Kare kipi',
  'Epoch stacks (6-month surveys)': 'Dönem yığınları (6 aylık taramalar)', 'Visit stacks (same day)': 'Ziyaret yığınları (aynı gün)',
  'Individual exposures': 'Tek tek pozlar', 'Band': 'Bant', 'All detectors co-added (broadband)': 'Tüm dedektörler toplanmış (geniş bant)',
  'Compare': 'Karşılaştır', 'Blink (no subtraction)': 'Yanıp sönme (çıkarma yok)', 'Difference: frame − first': 'Fark: kare − ilk',
  'Difference: frame − previous': 'Fark: kare − önceki', 'Difference: frame − median of all': 'Fark: kare − tümünün medyanı',
  'Co-add all frames (deep)': 'Tüm kareleri topla (derin)', 'Subtract zodiacal light model': 'Zodyak ışığı modelini çıkar',
  'Subtract median background': 'Medyan arka planı çıkar', 'Mask bad-pixel flags': 'Kötü pikselleri maskele', 'Smoothing': 'Yumuşatma',
  'none': 'yok', 'Resampling': 'Yeniden örnekleme', '4 · Display': '4 · Görünüm', 'Stretch': 'Germe', 'linear': 'doğrusal',
  'Low %': 'Alt %', 'High %': 'Üst %', 'Same scaling for all frames': 'Tüm karelerde aynı ölçek', 'Invert': 'Negatif',
  '5 · Overlays': '5 · Katmanlar', 'Crosshair at center': 'Merkezde artı işareti', 'Predicted target position (pm + parallax)': 'Hedefin beklenen konumu (öz hareket + paralaks)',
  'Gaia DR3 (moved to frame epoch)': 'Gaia DR3 (kare dönemine taşınmış)', 'CatWISE2020 (moved to frame epoch)': 'CatWISE2020 (kare dönemine taşınmış)',
  'Flagged pixels (contamination)': 'İşaretli pikseller (kirlilik)', 'Compass & scale bar': 'Pusula & ölçek çubuğu',
  '6 · Spectrophotometry': '6 · Tayf fotometrisi',
  'Forced photometry of one source in every SPHEREx exposure (all 102 channels, every epoch) → spectrum and light curve in the panel below the image.':
    'Bir kaynağın her SPHEREx pozunda zorlamalı fotometrisi (102 kanalın hepsi, her dönem) → görüntünün altındaki panelde tayf ve ışık eğrisi.',
  'Follow proper motion of current target': 'Geçerli hedefin öz hareketini izle', 'Method': 'Yöntem',
  'PSF fit (pixel-integrated Gaussian)': 'PSF uydurma (piksel integralli Gauss)', 'Aperture + background annulus': 'Açıklık + arka plan halkası',
  'Aperture r (px)': 'Açıklık r (px)', 'Annulus (px)': 'Halka (px)', 'Subtract zodiacal light model first': 'Önce zodyak ışığı modelini çıkar',
  'Re-centroid (allow ≤1 px shift)': 'Merkezi yeniden bul (≤1 px kayma)', 'Reject pixels with flags…': 'İşaretli pikselleri dışla…',
  'Exposures': 'Pozlar', 'Up to 400 (fast)': '400’e kadar (hızlı)', 'Up to 1200': '1200’e kadar', 'All (deep fields: thousands)': 'Hepsi (derin alanlar: binlerce)',
  'Measure spectrum': 'Tayfı ölç', '7 · Spectrum plot': '7 · Tayf grafiği', 'Y axis': 'Y ekseni', 'Flux density (µJy)': 'Akı yoğunluğu (µJy)',
  'Flux density (mJy)': 'Akı yoğunluğu (mJy)', 'AB magnitude': 'AB kadir', 'Color by': 'Renklendirme', 'Survey epoch': 'Tarama dönemi',
  'Detector': 'Dedektör', 'Log Y axis': 'Logaritmik Y ekseni', 'Binned spectrum (per channel, per epoch)': 'Gruplanmış tayf (kanal ve dönem başına)',
  'Mark molecular features (H₂O, CH₄, CO₂, CO…)': 'Molekül izlerini işaretle (H₂O, CH₄, CO₂, CO…)', 'Overlay 2MASS + WISE photometry': '2MASS + WISE fotometrisini ekle',
  'Hide measurements flagged at source': 'Kaynakta işaretli ölçümleri gizle', 'Download CSV': 'CSV indir', 'Save plot PNG': 'Grafiği PNG kaydet',
  'SPHEREx Time-Lapse': 'SPHEREx zaman atlamalı', 'Pick a test target or type coordinates, then': 'Bir test hedefi seçin ya da koordinat yazın, sonra',
  'SPHEREx maps the whole sky every six months: blink the surveys to catch moving objects such as brown dwarfs, asteroids and comets.':
    'SPHEREx tüm gökyüzünü altı ayda bir haritalar: taramaları art arda göstererek kahverengi cüceler, asteroitler ve kuyruklu yıldızlar gibi hareket edenleri yakalayın.',
  'Previous frame (←)': 'Önceki kare (←)', 'Play/pause (Space)': 'Oynat/duraklat (Boşluk)', 'Next frame (→)': 'Sonraki kare (→)',
  'bounce': 'ileri-geri', 'Save current frame as PNG': 'Bu kareyi PNG kaydet', 'Record a WebM video of the loop': 'Döngünün WebM videosunu kaydet',
  'Copy a shareable link / embed code': 'Paylaşım bağlantısını / gömme kodunu kopyala', 'Share': 'Paylaş', 'Frame': 'Kare', 'Cursor': 'İmleç',
  'Move over the image. Click to measure a spectrum at that position.': 'Görüntünün üzerinde gezinin. Tıklayınca o noktanın tayfı ölçülür.',
  'Spectrum at clicked position ↓': 'Tıklanan noktanın tayfı ↓', 'Drag to resize': 'Boyutlandırmak için sürükleyin', 'Spectrum': 'Tayf',
  'Light curve': 'Işık eğrisi', 'Measurements': 'Ölçümler', 'Collapse / expand': 'Daralt / genişlet',
  'variability across epochs (e.g. RW Aur, R Dra)': 'dönemler arası değişkenlik (ör. RW Aur, R Dra)',
  'Center': 'Ortala', 'Set as target': 'Hedef yap', 'SPHEREx time-lapse': 'SPHEREx zaman atlamalı', 'SPHEREx spectrum': 'SPHEREx tayfı',
  'Zoom in': 'Yakınlaş', 'Radians blink ↗': 'Radians blink ↗', 'Hour angle': 'Saat açısı', 'Constellation': 'Takımyıldız',
  'Rise · Transit · Set': 'Doğuş · Geçiş · Batış', 'Max altitude': 'En yüksek irtifa', 'No data yet': 'Henüz veri yok',
  'Az/Alt (apparent)': 'Az/Yük (görünür)', 'RA/Dec (of date)': 'RA/Dec (tarihin)', 'Does not rise today': 'Bugün doğmuyor',
  'Survey epoch': 'Tarama dönemi', 'Date': 'Tarih', 'Detectors': 'Dedektörler', 'λ range': 'λ aralığı',
  'Flagged at target': 'Hedefte işaretli', 'Predicted pos.': 'Beklenen konum',
  'Blink this': 'Bunu blink’le', 'Science tool ↗': 'Bilimsel araç ↗', 'Star': 'Yıldız', 'Planet': 'Gezegen',
  'Dwarf planet': 'Cüce gezegen', 'Natural satellite': 'Doğal uydu', 'Sky position': 'Gökte bir nokta', 'Selected point': 'Seçilen nokta',
  'Deep-sky object': 'Derin gök nesnesi', 'SPHEREx target': 'SPHEREx hedefi', 'Galaxy': 'Gökada', 'Spiral galaxy': 'Sarmal gökada',
  'Lenticular galaxy': 'Mercek gökada', 'Dwarf spheroidal galaxy': 'Cüce küresel gökada', 'Elliptical galaxy': 'Eliptik gökada',
  'Irregular galaxy': 'Düzensiz gökada', 'Open cluster': 'Açık yıldız kümesi', 'Globular cluster': 'Küresel yıldız kümesi',
  'Emission nebula': 'Salma bulutsusu', 'Bright nebula': 'Parlak bulutsu', 'Star-forming region': 'Yıldız oluşum bölgesi',
  'Reflection nebula': 'Yansıma bulutsusu', 'Planetary nebula': 'Gezegenimsi bulutsu', 'Supernova remnant': 'Süpernova kalıntısı',
  'Dark nebula': 'Karanlık bulutsu', 'Asterism': 'Yıldız dizilimi', 'Double star': 'Çift yıldız', 'Nebula': 'Bulutsu',
  'Nearby M dwarf · fastest proper motion': 'Yakın M cücesi · en hızlı öz hareket', 'Binary brown dwarf': 'Çift kahverengi cüce',
  'Coldest known brown dwarf (Y dwarf)': 'Bilinen en soğuk kahverengi cüce (Y cücesi)', 'Variable young star (T Tauri)': 'Değişken genç yıldız (T Tauri)',
  'Mira variable (red giant)': 'Mira değişkeni (kırmızı dev)', 'Below the horizon right now': 'Şu an ufkun altında', 'Low above the horizon': 'Ufka çok yakın', 'Galactic centre': 'Samanyolu’nun merkezi',
};

export function pageLang() {
  try {
    const q = new URLSearchParams(location.search).get('lang');
    return (q || localStorage.getItem('radians-lang') || (navigator.language || '').slice(0, 2)) === 'tr' ? 'tr' : 'en';
  } catch { return 'en'; }
}

function swap(node) {
  if (node.nodeType === 3) {
    const k = node.nodeValue.trim();
    if (k && TR[k]) node.nodeValue = node.nodeValue.replace(k, TR[k]);
    return;
  }
  if (node.nodeType !== 1 || node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
  for (const a of ['title', 'placeholder', 'aria-label']) {
    const v = node.getAttribute(a);
    if (v && TR[v.trim()]) node.setAttribute(a, TR[v.trim()]);
  }
  for (const c of node.childNodes) swap(c);
}

export function translatePage() {
  if (pageLang() !== 'tr') return;
  document.documentElement.lang = 'tr';
  swap(document.body);
  new MutationObserver(ms => {
    for (const m of ms) {
      if (m.type === 'characterData') swap(m.target);
      else for (const n of m.addedNodes) swap(n);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
