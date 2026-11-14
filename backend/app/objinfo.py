"""What the planetarium's info panel says about a star, nebula or galaxy: SIMBAD (type, spectral type,
parallax, magnitudes, other names) and a short Wikipedia summary in the page's language (English when that
language has no article). Each part has its own "ok", so one service being down never hides the other.

The Wikipedia article is found through Wikidata: search for one of the object's catalogue names
("HIP 33856", "M 42"), then keep the hit only if that name really is one of its catalogue codes (P528), so a
search hit about something else is never shown."""
from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor

from . import explorer

TTL = 30 * 86400
TIMEOUT = 20
SIMBAD_HOSTS = ("https://simbad.cfa.harvard.edu", "https://simbad.cds.unistra.fr")
WIKIDATA = "https://www.wikidata.org/w/api.php"
_pool = ThreadPoolExecutor(4)
_ID_RE = re.compile(r"^[A-Za-z0-9 +\-.*_']{1,40}$")
BANDS = ("B", "V", "G", "J", "H", "K")
# names worth showing as chips, in this order (the full list is long and mostly survey codes)
ALIAS_ORDER = ("NAME ", "* ", "V* ", "HD ", "HIP ", "HR ", "GJ ", "SAO ", "M ", "NGC ", "IC ", "2MASS ", "WISE", "Gaia DR3 ", "TYC ")


def variants(ident: str) -> list[str]:
    """SIMBAD spells catalogue names with padded spaces ("M  42", "NGC  1976"): try the usual spellings."""
    ident = " ".join(ident.split())
    m = re.match(r"^(M|NGC|IC|HD|HIP|HR|GJ|SAO)\s*(\d.*)$", ident, re.I)
    if not m:
        return [ident, "NAME " + ident]
    pre, num = m.group(1).upper(), m.group(2)
    return list(dict.fromkeys([f"{pre} {num}", f"{pre}  {num}", f"{pre}   {num}", f"{pre}{num}"]))


def _q(s: str) -> str:
    return s.replace("'", "''")


def _tap(adql: str):
    last = None
    for host in SIMBAD_HOSTS:
        try:
            r = explorer._get(host + "/simbad/sim-tap/sync",
                              {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql},
                              timeout=TIMEOUT, tries=1)
            head = r.text.split("\n", 1)[0] if r.ok else ""
            if not r.ok or r.text.lstrip().startswith("<") or "," not in head and head.strip() == "":
                raise explorer.Upstream(host + " unavailable")
            return explorer._csv(r.text)
        except Exception as e:  # noqa: BLE001  (try the mirror)
            last = e
    raise explorer.Upstream(str(last or "SIMBAD unavailable"))


def _clean(s):
    s = (s or "").strip().strip('"')
    return s or None


def simbad(ident: str | None, ra: float, dec: float, radius_deg: float = 0.01) -> dict:
    cols = "b.oid, b.main_id, b.otype, d.description AS otype_txt, b.sp_type, b.plx_value, b.rvz_radvel, b.pmra, b.pmdec, b.ra, b.dec, b.nbref AS refs"
    rows = []
    if ident and _ID_RE.match(ident):
        ids = ", ".join(f"'{_q(v)}'" for v in variants(ident))
        rows = _tap(f"SELECT TOP 1 {cols} FROM basic b JOIN ident i ON i.oidref = b.oid "
                    f"LEFT JOIN otypedef d ON d.otype = b.otype WHERE i.id IN ({ids})")
    if not rows:
        rows = _tap(f"SELECT TOP 1 {cols} FROM basic b LEFT JOIN otypedef d ON d.otype = b.otype WHERE "
                    f"CONTAINS(POINT('ICRS', b.ra, b.dec), CIRCLE('ICRS', {ra:.6f}, {dec:.6f}, {radius_deg:.5f})) = 1 "
                    "ORDER BY refs DESC")   # the best-studied object near the click is the one people mean
    if not rows:
        return {"found": False}
    b = rows[0]
    oid = int(float(b["oid"]))
    fl = _tap(f"SELECT filter, flux FROM flux WHERE oidref = {oid}")
    names = [_clean(x.get("id")) for x in _tap(f"SELECT id FROM ident WHERE oidref = {oid}")]
    names = [n for n in names if n]
    mags = {}
    for x in fl:
        f, v = _clean(x.get("filter")), explorer._num(x.get("flux"))
        if f in BANDS and v is not None:
            mags[f] = round(v, 2)
    picked = []
    for pre in ALIAS_ORDER:
        for n in names:
            if n.startswith(pre) and n not in picked:
                picked.append(n)
    plx = explorer._num(b.get("plx_value"))
    return {
        "found": True, "id": (_clean(b.get("main_id")) or "").replace("NAME ", "") or None, "otype": _clean(b.get("otype")), "otype_txt": _clean(b.get("otype_txt")),
        "sptype": _clean(b.get("sp_type")), "plx_mas": plx, "dist_ly": round(3261.56 / plx, 1) if plx and plx > 0.05 else None,
        "rv_kms": explorer._num(b.get("rvz_radvel")), "pmra": explorer._num(b.get("pmra")), "pmdec": explorer._num(b.get("pmdec")),
        "mags": mags, "names": [n.replace("NAME ", "") for n in picked][:14], "n_names": len(names),
        "ra": explorer._num(b.get("ra")), "dec": explorer._num(b.get("dec")),
    }


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", (s or "").lower())


def wikidata_item(names: list[str]) -> str | None:
    """Q-id whose catalogue codes (P528) include one of these names."""
    for name in names[:4]:
        try:
            r = explorer._get(WIKIDATA, {"action": "query", "list": "search", "srsearch": name, "srlimit": 3, "format": "json"},
                              timeout=TIMEOUT, tries=1)
            hits = [h["title"] for h in r.json().get("query", {}).get("search", [])]
            if not hits:
                continue
            r = explorer._get(WIKIDATA, {"action": "wbgetentities", "ids": "|".join(hits), "props": "claims", "format": "json"},
                              timeout=TIMEOUT, tries=1)
            ents = r.json().get("entities", {})
            want = _norm(name)
            for q in hits:
                codes = [c.get("mainsnak", {}).get("datavalue", {}).get("value") for c in ents.get(q, {}).get("claims", {}).get("P528", [])]
                if any(isinstance(c, str) and _norm(c) == want for c in codes):
                    return q
        except Exception:  # noqa: BLE001
            continue
    return None


SPARQL = "https://query.wikidata.org/sparql"


def _sparql_links(names: list[str], lang: str = "en") -> dict | None:
    """{lang: title} of the Wikidata item whose catalogue codes (P528) include one of these names; the
    item with an article in the page language wins, then the earliest name in the list ("Sirius" over
    "Sirius A", "HIP 33856" over a code shared by a whole cluster)."""
    codes = list(dict.fromkeys(c for n in names for c in (" ".join(n.split()), n.replace(" ", ""))))
    vals = " ".join('"' + re.sub(r'[^A-Za-z0-9 +\-.]', '', c) + '"' for c in codes[:24])
    q = ("SELECT ?item ?code ?tr ?en WHERE { VALUES ?code { " + vals + " } ?item wdt:P528 ?code . "
         "OPTIONAL { ?tr schema:about ?item; schema:isPartOf <https://tr.wikipedia.org/> } "
         "OPTIONAL { ?en schema:about ?item; schema:isPartOf <https://en.wikipedia.org/> } } LIMIT 40")
    r = explorer._get(SPARQL, {"query": q, "format": "json"}, timeout=TIMEOUT, tries=2)
    rows = r.json().get("results", {}).get("bindings", [])
    if not rows:
        return None
    rank = {c: i for i, c in enumerate(codes)}
    best = min(rows, key=lambda x: (lang not in x, rank.get(x["code"]["value"], 99)))
    from urllib.parse import unquote
    return {lg: unquote(best[lg]["value"].rsplit("/wiki/", 1)[1]).replace("_", " ") for lg in ("tr", "en") if lg in best}


def _search_links(names: list[str]) -> dict | None:
    q = wikidata_item(names)
    if not q:
        return None
    r = explorer._get(WIKIDATA, {"action": "wbgetentities", "ids": q, "props": "sitelinks", "format": "json"},
                      timeout=TIMEOUT, tries=2)
    links = r.json().get("entities", {}).get(q, {}).get("sitelinks", {})
    return {lg: links[f"{lg}wiki"]["title"] for lg in ("tr", "en") if f"{lg}wiki" in links}


def wikipedia(names: list[str], lang: str) -> dict:
    try:
        links = _sparql_links(names, lang)
    except Exception:  # noqa: BLE001  (the query service is busy now and then: the search API is the fallback)
        links = None
    links = links or _search_links(names)
    if not links:
        return {"found": False}
    for lg in dict.fromkeys([lang, "en"]):
        title = links.get(lg)
        if not title:
            continue
        s = explorer._get(f"https://{lg}.wikipedia.org/api/rest_v1/page/summary/{title.replace(' ', '_')}",
                          timeout=TIMEOUT, tries=2).json()
        text = (s.get("extract") or "").strip()
        if text:
            return {"found": True, "lang": lg, "title": s.get("title") or title, "text": text,
                    "url": s.get("content_urls", {}).get("desktop", {}).get("page"), "fallback": lg != lang}
    return {"found": False}


def lookup(ident: str | None, ra: float, dec: float, lang: str, kind: str = "star") -> dict:
    lang = lang if lang in ("en", "tr") else "en"
    radius = 0.03 if kind == "dso" else 0.01
    key = f"{ident}|{ra:.5f}|{dec:.5f}|{kind}"
    out = {"simbad": {"ok": False}, "wiki": {"ok": False}}
    try:
        sb = explorer._cached_json("objsimbad", key, TTL, lambda: simbad(ident, ra, dec, radius))
        out["simbad"] = {"ok": True, **sb}
    except Exception as e:  # noqa: BLE001
        out["simbad"] = {"ok": False, "error": str(e)[:200]}
        sb = {}
    # Wikidata knows objects by catalogue names: the one we were given first, then SIMBAD's
    names = list(dict.fromkeys([n for n in [ident, *(sb.get("names") or [])] if n and not n.startswith(("2MASS", "Gaia", "TYC", "WISE"))]))
    names = [variants(n)[0] for n in names if not n[:1].isalpha() or re.match(r"^(M|NGC|IC|HD|HIP|HR|GJ|SAO|\* |V\* )", n)]
    names = [n.replace("* ", "").replace("V ", "") if n.startswith(("* ", "V* ")) else n for n in names][:12]
    if names:
        try:
            w = explorer._cached_json("objwiki", f"{lang}|{'|'.join(names)}", TTL, lambda: wikipedia(names, lang))
            out["wiki"] = {"ok": True, **w}
        except Exception as e:  # noqa: BLE001
            out["wiki"] = {"ok": False, "error": str(e)[:200]}
    else:
        out["wiki"] = {"ok": True, "found": False}
    return out
