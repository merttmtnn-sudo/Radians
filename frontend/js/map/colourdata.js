// Skyshift colour data: which SPHEREx wavelength layers to mix, and how.
//
// NUMBERS (BLANK_FRAMES, FRAME_GAIN, and the checks behind NATURAL_UM and the
// PRESETS wavelengths and pins) come from backend/scripts/measure_hips_frames.py,
// which measures the PNG tiles of the SPHEREx DR1 all-sky HiPS cube. Rerun that
// script and paste its output here if the cube changes. The measurements are
// stored in frontend/data/frame_levels.json and explained in docs/COLOUR_DATA.md.
//
// TEXTS (REGIONS, PRESETS names and blurbs, NOTES) are hand-written science
// notes in English and Turkish, written to be read by a 10-year-old.
//
// Every wavelength below is the centre of a real channel of the cube, in
// microns, exactly as listed in the HiPS "properties" file
// (data_cube_crval3_arr). frame = 17 * (band - 1) + (channel - 1).

// Frames never to show: the server has no tiles for them (HTTP 404 at every
// order). They are the two channels next to the dichroic beam splitter:
// 2.399 um (band 3 channel 17) and 2.445 um (band 4 channel 1).
export const BLANK_FRAMES = [50, 51];

// White balance: multiply the displayed (already stretched) values of frame i
// by FRAME_GAIN[i] and an ordinary star comes out white when layers are mixed.
// Derived from the brightest 1 % of pixels in four high-latitude star fields,
// smoothed over wavelength, 1.00 at 2.089 um. Blank frames have gain 1.
export const FRAME_GAIN = [
  0.93, 0.93, 0.92, 0.92, 0.92, 0.91, 0.91, 0.90, 0.90, 0.89, 0.89, 0.88, 0.88, 0.88, 0.88, 0.88, 0.89, // band 1: 0.753-1.102 um
  0.89, 0.89, 0.90, 0.90, 0.90, 0.90, 0.90, 0.90, 0.90, 0.90, 0.90, 0.89, 0.89, 0.89, 0.89, 0.89, 0.89, // band 2: 1.113-1.631 um
  0.90, 0.90, 0.91, 0.92, 0.93, 0.95, 0.96, 0.97, 0.98, 0.99, 1.00, 1.01, 1.03, 1.04, 1.06, 1.08, 1.00, // band 3: 1.656-2.399 um
  1.00, 1.14, 1.16, 1.17, 1.19, 1.21, 1.23, 1.25, 1.26, 1.29, 1.31, 1.34, 1.36, 1.39, 1.41, 1.43, 1.45, // band 4: 2.445-3.768 um
  1.46, 1.47, 1.49, 1.49, 1.50, 1.51, 1.52, 1.52, 1.53, 1.53, 1.54, 1.54, 1.55, 1.55, 1.56, 1.56, 1.56, // band 5: 3.833-4.405 um
  1.55, 1.55, 1.55, 1.55, 1.55, 1.56, 1.56, 1.56, 1.56, 1.56, 1.56, 1.55, 1.55, 1.55, 1.55, 1.55, 1.55, // band 6: 4.435-4.988 um
];

// The default "natural infrared colour": one clean channel per colour group
// (0.75-1.6 um blue, 1.6-2.4 um green, 2.4-5.0 um red).
//   blue  1.254 um: far from the helium airglow line (1.083 um), no strong
//                   line inside the channel, no gaps in the tiles we checked.
//   green 2.089 um: between Paschen-alpha (1.875) and Brackett-gamma (2.166),
//                   outside the water (1.9) and CO (2.3) bands of cool stars.
//   red   3.570 um: past the 3.3 um dust feature and its 3.4-3.5 um shoulder
//                   (3.476 um still shows it in Orion), before Brackett-alpha
//                   (4.05) and the CO2 ice band (4.27).
export const NATURAL_UM = { blue: 1.254, green: 2.089, red: 3.570 };

// What each kind of infrared light shows. Contiguous, 0.75 to 5.0 um.
export const REGIONS = [
  { lo: 0.75, hi: 1.05,
    en: 'Almost visible light: ordinary stars shine brightly here.',
    tr: 'Neredeyse görünür ışık: sıradan yıldızlar burada parlak görünür.' },
  { lo: 1.05, hi: 1.11,
    en: "Helium high in Earth's air glows here and can leave faint stripes on the map.",
    tr: "Dünya'nın üst atmosferindeki helyum burada ışıldar; haritada soluk çizgiler bırakabilir." },
  { lo: 1.11, hi: 1.35,
    en: 'Small, cool red stars look much brighter here than in visible light.',
    tr: 'Küçük, soğuk kırmızı yıldızlar burada görünür ışıktakinden çok daha parlaktır.' },
  { lo: 1.35, hi: 1.5,
    en: 'Water vapour in cool stars and brown dwarfs soaks up some of this light.',
    tr: 'Soğuk yıldızlardaki ve kahverengi cücelerdeki su buharı bu ışığın bir kısmını yutar.' },
  { lo: 1.5, hi: 1.8,
    en: 'Cool giant stars glow strongest around here.',
    tr: 'Soğuk dev yıldızlar en güçlü bu dalga boylarında parlar.' },
  { lo: 1.8, hi: 1.95,
    en: 'Hydrogen gas lit up by hot young stars glows here (Paschen-alpha).',
    tr: 'Sıcak genç yıldızların aydınlattığı hidrojen gazı burada parlar (Paschen-alfa).' },
  { lo: 1.95, hi: 2.25,
    en: 'This light slips through dust, revealing stars hidden in dark clouds.',
    tr: 'Bu ışık tozun içinden geçer ve karanlık bulutlara gizlenmiş yıldızları gösterir.' },
  { lo: 2.25, hi: 2.45,
    en: 'Carbon monoxide gas in cool giant stars dims this light a little.',
    tr: 'Soğuk dev yıldızlardaki karbonmonoksit gazı bu ışığı biraz soluklaştırır.' },
  { lo: 2.45, hi: 2.85,
    en: "Earth's air blocks this light, so it takes a space telescope like SPHEREx to see it.",
    tr: "Dünya'nın havası bu ışığı engeller; görmek için SPHEREx gibi bir uzay teleskobu gerekir." },
  { lo: 2.85, hi: 3.2,
    en: 'Water ice on dust grains soaks up this light.',
    tr: 'Toz tanelerinin üzerindeki su buzu bu ışığı yutar.' },
  { lo: 3.2, hi: 3.4,
    en: 'Sooty dust glows here; methane in cold brown dwarfs soaks this light up.',
    tr: 'İsli toz burada parlar; soğuk kahverengi cücelerdeki metan ise bu ışığı yutar.' },
  { lo: 3.4, hi: 4.15,
    en: 'Warm dust and hydrogen gas near young stars glow in this light.',
    tr: 'Genç yıldızların yakınındaki ılık toz ve hidrojen gazı bu ışıkta parlar.' },
  { lo: 4.15, hi: 4.4,
    en: 'Frozen carbon dioxide (dry ice) on dust grains soaks up this light.',
    tr: 'Toz tanelerinin üzerindeki donmuş karbondioksit (kuru buz) bu ışığı yutar.' },
  { lo: 4.4, hi: 4.6,
    en: 'The coldest brown dwarfs glow brightest around here.',
    tr: 'En soğuk kahverengi cüceler en parlak bu dalga boylarında ışıldar.' },
  { lo: 4.6, hi: 4.75,
    en: 'Carbon monoxide, as gas or as ice, soaks up some of this light.',
    tr: 'Karbonmonoksit, gaz ya da buz hâlinde, bu ışığın bir kısmını yutar.' },
  { lo: 4.75, hi: 5.0,
    en: "The far end of SPHEREx's sight: cold brown dwarfs and warm dust still glow.",
    tr: "SPHEREx'in görüşünün uç noktası: soğuk kahverengi cüceler ve ılık toz hâlâ parlar." },
];

// Two-colour "feature" pictures: feature layer(s) in orange, continuum
// layer(s) in blue. The continuum channels sit on both sides of the feature,
// one channel beyond the reach of the feature (a channel "sees" about
// wavelength / R to each side of its centre), and avoid other features.
// On ordinary stars all five presets come out neutral (checked by the script),
// so blue really means "absorbed" and orange really means "glowing".
export const PRESETS = [
  {
    id: 'water-ice',
    um: 3.05,
    feature_um: [3.033],
    continuum_um: [2.719, 3.667],
    look: 'dark',
    pin: 'tmc-1',
    name_en: 'Water ice',
    name_tr: 'Su buzu',
    blurb_en: 'Frozen water on tiny dust grains swallows light near 3.05 microns. Stars shining through cold, dark clouds like the Taurus cloud turn blue here: that is ice, the stuff comets are made of.',
    blurb_tr: "Minik toz tanelerindeki donmuş su, 3,05 mikron yakınındaki ışığı yutar. Boğa bulutu gibi soğuk, karanlık bulutların arkasındaki yıldızlar burada maviye döner. Kuyruklu yıldızlar da bu buzdan oluşur.",
  },
  {
    id: 'co2-ice',
    um: 4.27,
    feature_um: [4.257],
    continuum_um: [4.184, 4.368],
    look: 'dark',
    pin: 'tmc-1',
    name_en: 'CO₂ ice',
    name_tr: 'CO₂ buzu',
    blurb_en: "Frozen carbon dioxide, the 'dry ice' used for stage fog, swallows light near 4.27 microns. Stars behind icy dust clouds turn blue here. The Taurus cloud is a good place to look.",
    blurb_tr: "Sahne sisinde kullanılan 'kuru buz', yani donmuş karbondioksit, 4,27 mikron yakınındaki ışığı yutar. Buzlu toz bulutlarının arkasındaki yıldızlar burada maviye döner. Boğa bulutunda deneyin.",
  },
  {
    id: 'methane',
    um: 3.3,
    feature_um: [3.293],
    continuum_um: [3.118, 3.768],
    look: 'both',
    pin: 'eps-indi-b',
    name_en: 'Methane',
    name_tr: 'Metan',
    blurb_en: 'Methane gas in cool brown dwarfs swallows light near 3.3 microns, so the brown dwarf Epsilon Indi B turns blue. In nebulae like Orion, sooty dust glows at the same wavelength and turns orange.',
    blurb_tr: "Soğuk kahverengi cücelerdeki metan gazı 3,3 mikron yakınındaki ışığı yutar; bu yüzden Epsilon Indi B maviye döner. Orion gibi bulutsularda ise isli toz aynı dalga boyunda parlar ve turuncu görünür.",
  },
  {
    id: 'paschen-alpha',
    um: 1.875,
    feature_um: [1.861],
    continuum_um: [1.775, 1.949],
    look: 'bright',
    pin: 'm42',
    name_en: 'Paschen-α',
    name_tr: 'Paschen-α',
    blurb_en: "Hydrogen gas heated by hot young stars glows at 1.875 microns. Star nurseries like the Orion Nebula light up orange. Earth's air blocks this light, so it is best seen from space.",
    blurb_tr: "Sıcak genç yıldızların ısıttığı hidrojen gazı 1,875 mikronda parlar. Orion Bulutsusu gibi yıldız yuvaları turuncu ışıldar. Dünya'nın havası bu ışığı engellediği için en iyi uzaydan görülür.",
  },
  {
    id: 'brackett-gamma',
    um: 2.166,
    feature_um: [2.189],
    continuum_um: [2.089, 2.240],
    look: 'bright',
    pin: 'm16',
    name_en: 'Brackett-γ',
    name_tr: 'Brackett-γ',
    blurb_en: 'Another glow of hot hydrogen gas, at 2.166 microns. It is much fainter than Paschen-alpha but slips through dust more easily. Look for a soft orange tint in the Eagle Nebula.',
    blurb_tr: "Sıcak hidrojen gazının bir başka ışıltısı, 2,166 mikronda. Paschen-alfa'dan çok daha sönüktür ama tozun içinden daha kolay geçer. Kartal Bulutsusu'nda hafif bir turuncu ton arayın.",
  },
];

// Tooltips and footnotes.
export const NOTES = {
  helium_en: "Helium in Earth's upper atmosphere glows at 1.083 microns. SPHEREx looks out through it, so layers near that wavelength get a faint haze and stripes that follow the scan pattern. They are not in the sky.",
  helium_tr: "Dünya'nın üst atmosferindeki helyum 1,083 mikronda ışıldar. SPHEREx bu gazın içinden baktığı için, o dalga boyuna yakın katmanlarda soluk bir pus ve tarama düzenini izleyen çizgiler oluşur. Bunlar gökyüzünde değildir.",
  display_en: 'These map pictures are for looking, not measuring: brightness is squeezed into a fixed 0-40 MJy/sr range with an asinh stretch and only 8 bits. Use the SPHEREx FITS data for real measurements.',
  display_tr: 'Bu harita görüntüleri ölçmek için değil, bakmak içindir: parlaklık, asinh ölçeklemesiyle sabit 0-40 MJy/sr aralığına ve yalnızca 8 bite sıkıştırılmıştır. Gerçek ölçümler için SPHEREx FITS verilerini kullanın.',
  falsecolour_en: 'Infrared light is invisible to our eyes, so the colours here are painted on: shorter wavelengths are shown in blue, longer ones in red. This is called false colour.',
  falsecolour_tr: 'Kızılötesi ışığı gözümüz göremez; bu yüzden buradaki renkler sonradan boyanmıştır: kısa dalga boyları mavi, uzun dalga boyları kırmızı gösterilir. Buna yapay renk denir.',
  science_en: "The feature's wavelength is painted orange and the light just beside it blue, so whatever absorbs the feature looks blue, whatever glows in it looks orange, and everything else stays white or grey.",
  science_tr: 'Özelliğin dalga boyu turuncuya, hemen yanındaki ışık maviye boyanır; böylece o ışığı yutan şeyler mavi, o ışıkta parlayan şeyler turuncu, geri kalan her şey beyaz ya da gri görünür.',
};
