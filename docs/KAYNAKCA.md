# Kaynakça

Radians (NASA Space Apps Challenge 2026, “Planet X and SPHEREx”) yalnızca halka açık veri, açık servisler ve
açık kaynak yazılımla yapıldı. Bu sayfa, kullandığımız her veri setini, servisi, kütüphaneyi ve dayandığımız
bilimsel çalışmaları listeler. Sitede gösterilen her görüntü ve sayı bu kaynaklardan gelir.

## 1. Veri setleri ve servisler

| Kaynak | Radians’ta ne için | Bağlantı |
|---|---|---|
| **NASA SPHEREx** (Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer), NASA/JPL-Caltech | Blink karelerinin tamamı: tek tek spektral pozlar (0,75–5 µm, 6,15″ piksel), hata ve maske katmanları | https://spherex.caltech.edu |
| **NASA/IPAC Infrared Science Archive (IRSA)** | SPHEREx pozlarının arşivi ve arama servisi; haritadaki 102 düzlemli SPHEREx HiPS küpü; CatWISE2020 sorguları | https://irsa.ipac.caltech.edu |
| **ESA Gaia DR3** (Gaia Archive, TAP) | Bilinen yıldızlarla karşılaştırma, öz hareket ve paralaks | https://gea.esac.esa.int/archive/ |
| **CatWISE2020** (IRSA) | 3,4–4,6 µm kaynaklarıyla ve WISE öz hareketleriyle karşılaştırma | https://irsa.ipac.caltech.edu |
| **SIMBAD** (CDS, Strasbourg; Harvard aynası) | Nesne adları, türleri, öz hareketleri | https://simbad.cds.unistra.fr |
| **Sesame ad çözümleyici** (CDS) | Aramaya yazılan adın koordinata çevrilmesi | https://cds.unistra.fr/cgi-bin/Sesame |
| **VizieR** (CDS; Harvard aynası) | Yıldızların 2MASS ve AllWISE kataloglarındaki parlaklıkları (tayf karşılaştırması); değişen yıldız katalogları | https://vizier.cds.unistra.fr |
| **SkyBoT** (IMCCE, Paris Gözlemevi) | Görüntünün tarihinde o noktadan geçen bilinen asteroit ve kuyruklu yıldızlar | https://ssp.imcce.fr/webservices/skybot/ |

**Teşekkür.** Bu çalışma NASA/IPAC Infrared Science Archive’ın (California Institute of Technology’nin NASA ile
yaptığı sözleşme altında işletilir) verilerini ve servislerini; CDS’nin (Strasbourg Astronomical Data Center)
SIMBAD, VizieR, Sesame ve Aladin hizmetlerini; Avrupa Uzay Ajansı Gaia görevinin (https://www.cosmos.esa.int/gaia)
Gaia Data Processing and Analysis Consortium tarafından işlenen verilerini; 2MASS (University of Massachusetts ve
IPAC/Caltech ortak projesi, NASA ve NSF fonlu) katalog verilerini kullanır.

## 2. Yazılım

| Yazılım | Kullanım | Lisans |
|---|---|---|
| Aladin Lite v3.6.5 (CDS) | Tüm gökyüzü haritası | GPL-3.0 |
| Astropy 8 | FITS okuma, WCS, koordinatlar | BSD-3 |
| NumPy, SciPy | Görüntü birleştirme, kaynak bulma, istatistik | BSD-3 |
| PyVO | IVOA servis sorguları | BSD-3 |
| FastAPI, Uvicorn | Sunucu | MIT, BSD-3 |
| Requests, Pillow | HTTP istekleri, renkli HiPS karoları | Apache-2.0, MIT-CMU |
| Inter Tight, JetBrains Mono | Yazı tipleri | SIL OFL 1.1 |
| Kızılötesi RGB renk tarifi (Emre Bozkaya, SPHEREx Sky Explorer) | Haritadaki “Kızılötesi RGB” paleti | ekip içi |
| Coqui TTS / XTTS-v2 | Tanıtım videosundaki anlatım: ekip üyesinin kendi sesinden, onayıyla üretildi | MPL-2.0 (kod), Coqui Public Model License (model; ticari olmayan kullanım) |

Barındırma: Render.com. Sürekli test: GitHub Actions. Kaynak kod: https://github.com/merttmtnn-sudo/Radians

## 3. Bilimsel çalışmalar

**Görev ve veri**
- Doré, O. et al. 2014, *Cosmology with the SPHEREX All-Sky Spectral Survey*, arXiv:1412.4872.
- Skrutskie, M. F. et al. 2006, *The Two Micron All Sky Survey (2MASS)*, AJ 131, 1163.
- Gaia Collaboration, Prusti, T. et al. 2016, *The Gaia mission*, A&A 595, A1.
- Gaia Collaboration, Vallenari, A. et al. 2023, *Gaia Data Release 3: Summary of the content and survey properties*, A&A 674, A1.
- Wright, E. L. et al. 2010, *The Wide-field Infrared Survey Explorer (WISE)*, AJ 140, 1868.
- Marocco, F. et al. 2021, *The CatWISE2020 Catalog*, ApJS 253, 8.

**Servisler ve standartlar**
- Wenger, M. et al. 2000, *The SIMBAD astronomical database*, A&AS 143, 9.
- Ochsenbein, F., Bauer, P. & Marcout, J. 2000, *The VizieR database of astronomical catalogues*, A&AS 143, 23.
- Berthier, J. et al. 2006, *SkyBoT, a new VO service to identify Solar System objects*, ASP Conf. Ser. 351, 367.
- Fernique, P. et al. 2015, *Hierarchical progressive surveys (HiPS)*, A&A 578, A114.
- Boch, T. & Fernique, P. 2014, *Aladin Lite: Embed your Sky in the Browser*, ASP Conf. Ser. 485, 277.

**Yöntem**
- Fruchter, A. S. & Hook, R. N. 2002, *Drizzle: A Method for the Linear Reconstruction of Undersampled Images*, PASP 114, 144. (Haritadaki derin yakınlaştırma.)

**Hedefler ve bağlam**
- Batygin, K. & Brown, M. E. 2016, *Evidence for a Distant Giant Planet in the Solar System*, AJ 151, 22. (“Planet X” / Dokuzuncu Gezegen fikri.)
- Luhman, K. L. 2014, *Discovery of a ~250 K Brown Dwarf at 2 pc from the Sun*, ApJL 786, L18. (WISE 0855−0714.)
- Barnard, E. E. 1916, *A small star with large proper motion*, AJ 29, 181. (Barnard’s Star.)

**Yazılım atıfları**
- Astropy Collaboration 2013, A&A 558, A33; 2018, AJ 156, 123; 2022, ApJ 935, 167.
- Harris, C. R. et al. 2020, *Array programming with NumPy*, Nature 585, 357.
- Virtanen, P. et al. 2020, *SciPy 1.0*, Nature Methods 17, 261.

## 4. Ölçümler nerede belgelendi

Sunumdaki ve sitedeki sayıların (bulma oranları, yanlış alarm sayısı, WISE 0855 ve Barnard’s Star hızları)
yöntemi ve ham sonuçları: [docs/VALIDATION.md](VALIDATION.md).
