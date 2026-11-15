"""Build app/data/pins.json: the map's curated objects, with positions looked up by name (Sesame).

Run from backend/:  ..\\.venv\\Scripts\\python -X utf8 scripts/build_pins.py
The blurbs are written for children (EN + TR); a Turkish speaker on the team reviews the TR text.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.engine import sky  # noqa: E402
from app.engine.http import Http  # noqa: E402

# id, lookup name, display name (EN), display name (TR), kind, best band, moving?, blurb EN, blurb TR, aliases
PINS = [
    ("barnard", "Barnard's star", "Barnard's Star", "Barnard Yıldızı", "target", 5, True,
     "The fastest-moving star in our sky. It crosses the width of the Moon in about 180 years.",
     "Gökyüzümüzde en hızlı hareket eden yıldız. Ay'ın genişliği kadar yolu yaklaşık 180 yılda gider.",
     ["barnard", "barnards star", "gj 699"]),
    ("eps-indi-b", "eps Indi B", "Epsilon Indi B", "Epsilon Indi B", "target", 5, True,
     "A pair of brown dwarfs: 'failed stars' too small to shine like the Sun. They glow in infrared.",
     "Bir çift kahverengi cüce: Güneş gibi parlayamayacak kadar küçük 'yıldız olamamış' cisimler. Kızılötesinde parlarlar.",
     ["epsilon indi b", "eps ind b", "eps indi ba"]),
    ("wise-0855", "WISE J085510.83-071442.5", "WISE 0855−0714", "WISE 0855−0714", "target", 5, True,
     "The coldest brown dwarf known, about as cold as the North Pole. Only infrared eyes can see it.",
     "Bilinen en soğuk kahverengi cüce, neredeyse Kuzey Kutbu kadar soğuk. Onu yalnızca kızılötesi gözler görebilir.",
     ["wise 0855", "wise0855", "wise j0855"]),
    ("rw-aur", "RW Aur", "RW Aurigae", "RW Arabacı", "target", 6, False,
     "A baby star still wrapped in dust. Its brightness changes as clouds of dust pass in front of it.",
     "Hâlâ toza sarılı bir bebek yıldız. Önünden toz bulutları geçtikçe parlaklığı değişir.",
     ["rw aurigae", "rw aur"]),
    ("r-dra", "R Dra", "R Draconis", "R Ejderha", "target", 6, False,
     "A giant old star that slowly swells and shrinks, getting brighter and fainter every 8 months.",
     "Yavaşça şişip küçülen yaşlı dev bir yıldız. Her 8 ayda bir parlaklaşıp sönükleşir.",
     ["r draconis", "r dra"]),
    ("m42", "M42", "Orion Nebula", "Orion Bulutsusu", "nebula", 3, False,
     "A huge cloud of gas where new stars are being born right now.",
     "Şu anda yeni yıldızların doğduğu kocaman bir gaz bulutu.",
     ["orion nebula", "m42", "orion bulutsusu"]),
    ("horsehead", "Barnard 33", "Horsehead Nebula", "Atbaşı Bulutsusu", "nebula", 3, False,
     "A dark cloud of dust shaped like a horse's head. Infrared light sees through some of the dust.",
     "At başına benzeyen karanlık bir toz bulutu. Kızılötesi ışık tozun bir kısmının içini görebilir.",
     ["horsehead", "b33", "atbaşı"]),
    ("m45", "M45", "Pleiades", "Ülker", "cluster", 2, False,
     "The Seven Sisters: a family of young, hot blue stars that were born together.",
     "Yedi Kız Kardeş: birlikte doğmuş genç, sıcak, mavi yıldızlardan oluşan bir aile.",
     ["pleiades", "seven sisters", "m45", "ülker"]),
    ("m31", "M31", "Andromeda Galaxy", "Andromeda Gökadası", "galaxy", 2, False,
     "Our giant neighbour galaxy, with about a trillion stars. Its light left it 2.5 million years ago.",
     "Yaklaşık bir trilyon yıldızlı dev komşu gökadamız. Işığı oradan 2,5 milyon yıl önce yola çıktı.",
     ["andromeda", "m31", "andromeda galaxy"]),
    ("m1", "M1", "Crab Nebula", "Yengeç Bulutsusu", "nebula", 3, False,
     "What is left of a star that exploded. People saw the explosion in the year 1054.",
     "Patlamış bir yıldızdan geriye kalanlar. İnsanlar bu patlamayı 1054 yılında gördü.",
     ["crab nebula", "m1", "yengeç"]),
    ("m57", "M57", "Ring Nebula", "Halka Bulutsusu", "nebula", 3, False,
     "A dying star puffed off its outer layers into a glowing smoke ring.",
     "Ölmekte olan bir yıldız dış katmanlarını parlayan bir duman halkası gibi dışarı üflemiş.",
     ["ring nebula", "m57"]),
    ("m16", "M16", "Eagle Nebula", "Kartal Bulutsusu", "nebula", 3, False,
     "Home of the 'Pillars of Creation', tall towers of gas where stars form.",
     "Yıldızların oluştuğu uzun gaz kuleleri olan 'Yaratılış Sütunları'nın evi.",
     ["eagle nebula", "m16", "pillars of creation"]),
    ("m51", "M51", "Whirlpool Galaxy", "Girdap Gökadası", "galaxy", 2, False,
     "A spiral galaxy dancing with a smaller galaxy, seen face-on like a pinwheel.",
     "Daha küçük bir gökadayla dans eden, rüzgârgülü gibi tam karşıdan görünen sarmal bir gökada.",
     ["whirlpool", "m51"]),
    ("betelgeuse", "Betelgeuse", "Betelgeuse", "Betelgeuse", "star", 3, False,
     "A red supergiant in Orion's shoulder. If it sat where the Sun is, it would swallow Jupiter's orbit.",
     "Avcı'nın omzundaki kırmızı süperdev. Güneş'in yerinde olsaydı Jüpiter'in yörüngesini yutardı.",
     ["alpha orionis", "betelgeuse", "alf ori"]),
    ("sirius", "Sirius", "Sirius", "Sirius (Akyıldız)", "star", 3, True,
     "The brightest star in the night sky, only 8.6 light-years away. It has a tiny white-dwarf partner.",
     "Gece gökyüzündeki en parlak yıldız, yalnızca 8,6 ışık yılı uzakta. Küçük bir beyaz cüce eşi var.",
     ["sirius", "alpha canis majoris", "akyıldız"]),
    ("vega", "Vega", "Vega", "Vega", "star", 3, False,
     "A bright blue-white star surrounded by a disk of dust that glows in infrared.",
     "Kızılötesinde parlayan bir toz diskiyle çevrili, parlak mavi-beyaz bir yıldız.",
     ["vega", "alpha lyrae"]),
    ("polaris", "Polaris", "Polaris (North Star)", "Kutup Yıldızı", "star", 3, False,
     "The North Star: it stays almost still while the whole sky turns around it.",
     "Kutup Yıldızı: tüm gökyüzü etrafında dönerken neredeyse hiç kıpırdamaz.",
     ["polaris", "north star", "kutup yıldızı"]),
    ("alpha-cen", "alf Cen A", "Alpha Centauri", "Alfa Erboğa", "star", 3, True,
     "The nearest star system you can see with your eyes: two Sun-like stars, 4.4 light-years away.",
     "Gözle görülebilen en yakın yıldız sistemi: 4,4 ışık yılı uzakta, Güneş benzeri iki yıldız.",
     ["alpha centauri", "rigil kentaurus", "alfa erboğa"]),
    ("proxima", "Proxima Centauri", "Proxima Centauri", "Proxima Erboğa", "star", 5, True,
     "The closest star to the Sun, a small red dwarf. It has at least one planet.",
     "Güneş'e en yakın yıldız, küçük bir kırmızı cüce. En az bir gezegeni var.",
     ["proxima", "proxima centauri", "proxima cen"]),
    ("luhman-16", "WISE J104915.57-531906.1", "Luhman 16", "Luhman 16", "star", 5, True,
     "The nearest pair of brown dwarfs, only 6.5 light-years away. Found in 2013 in infrared images.",
     "Yalnızca 6,5 ışık yılı uzaktaki en yakın kahverengi cüce çifti. 2013'te kızılötesi görüntülerde bulundu.",
     ["luhman 16", "luhman16", "wise 1049"]),
    ("wolf-359", "Wolf 359", "Wolf 359", "Wolf 359", "star", 5, True,
     "One of the nearest stars: a faint red dwarf you can't see without a telescope.",
     "En yakın yıldızlardan biri: teleskopsuz göremeyeceğin sönük bir kırmızı cüce.",
     ["wolf 359", "cn leo"]),
    ("kapteyn", "Kapteyn's star", "Kapteyn's Star", "Kapteyn Yıldızı", "star", 5, True,
     "A very old star from the edge of our galaxy, racing past the Sun in the 'wrong' direction.",
     "Gökadamızın kenarından gelen çok yaşlı bir yıldız; Güneş'in yanından 'ters' yönde hızla geçiyor.",
     ["kapteyn", "kapteyns star", "gj 191"]),
    ("van-maanen", "GJ 35", "Van Maanen's Star", "Van Maanen Yıldızı", "star", 3, True,
     "A white dwarf: the hot, Earth-sized core left over when a Sun-like star dies.",
     "Bir beyaz cüce: Güneş benzeri bir yıldız ölünce geriye kalan, Dünya büyüklüğünde sıcak çekirdek.",
     ["van maanen", "van maanens star", "vma 2"]),
    ("sgr-a", "Sgr A*", "Galactic Centre", "Gökada Merkezi", "galaxy", 4, False,
     "The heart of our Milky Way, where a giant black hole hides behind thick clouds of dust.",
     "Samanyolu'muzun kalbi; dev bir kara delik kalın toz bulutlarının ardında saklanıyor.",
     ["galactic center", "galactic centre", "sgr a*", "milky way centre", "gökada merkezi"]),
    ("rho-oph", "rho Oph", "Rho Ophiuchi Cloud", "Rho Yılancı Bulutu", "nebula", 3, False,
     "A colourful cloud of gas and dust, one of the closest places where stars are being born.",
     "Renkli bir gaz ve toz bulutu; yıldızların doğduğu en yakın yerlerden biri.",
     ["rho ophiuchi", "rho oph"]),
    ("tmc-1", "TMC-1", "Taurus Molecular Cloud", "Boğa Molekül Bulutu", "nebula", 4, False,
     "A cold, dark cloud full of icy dust. SPHEREx looks for frozen water there, the stuff of future planets.",
     "Buzlu tozla dolu soğuk, karanlık bir bulut. SPHEREx orada donmuş su arıyor: gelecekteki gezegenlerin malzemesi.",
     ["tmc-1", "taurus molecular cloud", "taurus dark cloud"]),
    ("lmc", "LMC", "Large Magellanic Cloud", "Büyük Macellan Bulutu", "galaxy", 3, False,
     "A small galaxy that orbits our Milky Way. You can see it with your eyes from the southern hemisphere.",
     "Samanyolu'muzun çevresinde dolanan küçük bir gökada. Güney yarımküreden çıplak gözle görülebilir.",
     ["lmc", "large magellanic cloud", "büyük macellan"]),
    # from the team's map list (Radians main, Nov 2026)
    ("rigel", "Rigel", "Rigel", "Rigel", "star", 3, False,
     "A blue supergiant tens of thousands of times brighter than the Sun.",
     "Güneş'ten on binlerce kat parlak mavi bir süperdev.",
     ["rigel", "beta orionis", "bet ori"]),
    ("aldebaran", "Aldebaran", "Aldebaran", "Aldebaran", "star", 3, False,
     "The orange eye of the Bull, a giant star 65 light-years away.",
     "Boğa'nın turuncu gözü, 65 ışık yılı ötede dev bir yıldız.",
     ["aldebaran", "alpha tauri", "alf tau"]),
    ("antares", "Antares", "Antares", "Antares", "star", 3, False,
     "The red heart of the Scorpion, a supergiant in a dusty neighbourhood.",
     "Akrep'in kızıl kalbi; tozlu bir mahallede bir süperdev.",
     ["antares", "alpha scorpii", "alf sco"]),
    ("eta-car", "eta Car", "Eta Carinae", "Eta Carinae", "star", 3, False,
     "A giant star that brightened hugely in the 1840s and hides in its own dust.",
     "1840'larda çok parlayan ve kendi tozunun içine gizlenen dev bir yıldız.",
     ["eta carinae", "eta car"]),
    ("m8", "M8", "Lagoon Nebula", "Lagün Bulutsusu", "nebula", 3, False,
     "A glowing cloud of hydrogen lit by hot young stars.",
     "Sıcak genç yıldızların aydınlattığı parlak bir hidrojen bulutu.",
     ["lagoon nebula", "m8", "lagün bulutsusu"]),
    ("smc", "SMC", "Small Magellanic Cloud", "Küçük Macellan Bulutu", "galaxy", 3, False,
     "The Large Cloud's little sibling, stretched by its pull.",
     "Büyük Bulut'un küçük kardeşi, onun çekimiyle uzamış.",
     ["small magellanic cloud", "smc", "küçük macellan bulutu"]),
]


def main():
    http = Http()
    out = []
    for pid, look, en, tr, kind, band, moving, b_en, b_tr, aliases in PINS:
        r = sky.resolve(look, http)
        ra_now, dec_now = sky.position_now(r)
        out.append(dict(id=pid, name_en=en, name_tr=tr, kind=kind, band=band, moving=moving,
                        lookup=look, main_id=r["main_id"], otype=r["otype"],
                        ra=r["ra"], dec=r["dec"], pmra=r["pmra"], pmdec=r["pmdec"], plx=r["plx"], epoch=r["epoch"],
                        blurb_en=b_en, blurb_tr=b_tr, aliases=aliases))
        shift = ((ra_now - r["ra"]) * __import__("math").cos(__import__("math").radians(r["dec"])) * 3600, (dec_now - r["dec"]) * 3600)
        print(f"{pid:12s} {r['main_id']:28s} {r['ra']:10.5f} {r['dec']:+10.5f}  pm {r['pmra']:9.1f} {r['pmdec']:9.1f}  "
              f"shift since 2000: {shift[0]:7.1f}\" {shift[1]:7.1f}\"")
    path = Path(__file__).resolve().parents[2] / "app" / "engine" / "data" / "pins.json"
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {len(out)} pins to {path}")


if __name__ == "__main__":
    main()
