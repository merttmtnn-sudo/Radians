// About / help page content.
export function aboutHtml() {
  const ok = '<span class="ok">✔</span>';
  const link = (u, t) => `<a href="${u}" target="_blank" rel="noopener">${t || u}</a>`;
  const ex = (q, t) => `<a href="?${q}">${t}</a>`;
  return `
<h1>SPHEREx Sky Explorer</h1>
<p class="muted">NASA Space Apps Challenge 2026 · <b>Planet X and SPHEREx</b> — a public web tool with a Stellarium-style planetarium whose sky is made of
SPHEREx infrared images, plus SPHEREx time-lapse imaging and on-the-fly spectrophotometry (in the spirit of IRSA's Spectrophotometry Tool), all driven by live NASA/IPAC IRSA data.</p>

<h2>Quick start</h2>
<ol>
  <li><b>Planetarium</b> — the whole sky as SPHEREx sees it (the DR1 all-sky maps at any of 102 infrared wavelengths, or a 3-colour composite), with all the
  planetarium tools on top: real-time sky for any place and date, constellations, planets, grids, horizon, search, object info. Zoom in for full SPHEREx resolution,
  compare with 2MASS / WISE / DSS / Spitzer / GALEX by blinking or cross-fading, and overlay Gaia, AllWISE, 2MASS or SIMBAD sources. Click any object, then
  <i>SPHEREx time-lapse</i> or <i>SPHEREx spectrum</i>.</li>
  <li><b>Time-Lapse &amp; Spectra</b> — enter RA/Dec (or a name), choose a field of view and press <i>Search SPHEREx &amp; load</i>. The tool finds every SPHEREx exposure
  covering that position, cuts them out, aligns them north-up and plays them as a little movie; moving objects jump between survey epochs. The panel under the
  movie measures the source in every exposure (102 wavelengths × every epoch) to build a 0.75–5 µm spectrum, a light curve and a measurement table.</li>
</ol>
<p>Try the challenge test targets:
${ex('view=blink&target=wise0855&auto=1', 'WISE 0855−0714')} ·
${ex('view=blink&target=barnard&auto=1', "Barnard's Star")} ·
${ex('view=blink&target=epsindb&auto=1&fov=0.15', 'Epsilon Indi B')} ·
${ex('view=spectro&target=rwaur&auto=1', 'RW Aurigae (spectrum)')} ·
${ex('view=spectro&target=rdra&auto=1', 'R Draconis (spectrum)')}</p>

<h2>Challenge objectives → features</h2>
<table>
<tr><th>Objective / consideration</th><th>How this tool addresses it</th></tr>
<tr><td>${ok} Public-facing web tool displaying SPHEREx images</td><td>Single-page web app served by a one-click local executable; data streamed live from IRSA.</td></tr>
<tr><td>${ok} User enters RA &amp; Dec</td><td>Sexagesimal (<code>08h55m10.831s -07d14m42.53s</code>) or decimal degrees, object names (CDS Sesame), or a click in the planetarium.</td></tr>
<tr><td>${ok} Series of images like a little video</td><td>Play / pause / step, adjustable fps, bounce mode, frame slider, keyboard (Space, ←, →), WebM video export.</td></tr>
<tr><td>${ok} Test on Barnard's Star, ε Indi B, WISE 0855, RW Aur, R Dra</td><td>All five are built-in presets (positions, proper motions, parallaxes from SIMBAD) and highlighted on the sky.</td></tr>
<tr><td>${ok} Easy to update with new data releases</td><td>No local data copies: every query goes to IRSA's live <code>spherex.plane/artifact</code> TAP tables, so QR3, DR1 and later releases appear automatically; release filter chips.</td></tr>
<tr><td>${ok} Creative use of 102 bands / co-add each of the six detectors</td><td>Epoch stacks per detector (D1…D6), all-detector broadband co-add, RGB composite (D1+D2 / D3+D4 / D5+D6), wavelength window filter.</td></tr>
<tr><td>${ok} Spectra on the fly (extra kudos)</td><td>Forced PSF or aperture photometry on every exposure, using the per-pixel spectral WCS; click any pixel in the time-lapse to get its spectrum.</td></tr>
<tr><td>${ok} Add / subtract images from different times</td><td>Difference vs. first / previous / median frame, and a deep co-add of all epochs.</td></tr>
<tr><td>${ok} Choose the field of view</td><td>2.4′ to 24′ cutouts; 1×–3× resampling.</td></tr>
<tr><td>${ok} Overlay Gaia / WISE data</td><td>Gaia DR3 and CatWISE2020 sources moved to each frame's epoch with their proper motions (and parallax); AllWISE and 2MASS too.</td></tr>
<tr><td>${ok} Query by coordinates in the URL / embeddable</td><td><code>?view=blink&amp;ra=133.795&amp;dec=-7.245&amp;fov=0.1&amp;auto=1</code>; add <code>&amp;embed=1</code> for an iframe-friendly layout. The Share button copies both.</td></tr>
<tr><td>${ok} Display metadata such as contamination flags</td><td>Per-frame metadata (obs ID, release, λ, exposure, PSF FWHM, DQA, glow flags), flags at the target, a flagged-pixel overlay and an exposure table.</td></tr>
<tr><td>${ok} Use public tools for displaying astronomical data (e.g. Aladin, CDS)</td><td>The planetarium renders the HiPS standard used by Aladin directly on the GPU:
the SPHEREx DR1 all-sky cube (102 wavelengths) plus IRSA's mirrors of 2MASS, AllWISE, DSS2, SDSS, Spitzer and GALEX for comparison.</td></tr>
</table>

<h2>A planetarium made of SPHEREx images</h2>
<ul>
<li>The sky background is the SPHEREx DR1 all-sky cube (HiPS, order 0–5, ≈13″ pixels): pick one of the 102 wavelengths with a colour map, or combine three
wavelengths into RGB (presets for stars &amp; dust, ices CO / CO₂ / H₂O, and the 3.3 µm PAH band). Keys <kbd>[</kbd> <kbd>]</kbd> step through wavelength.</li>
<li>Each screen pixel is projected back onto the sky on the GPU, so the images follow every projection, mount and time setting exactly; coarse tiles appear instantly and
sharper tiles stream in as you zoom.</li>
<li>Blink or cross-fade against another survey (2MASS, AllWISE, DSS2, SDSS, Spitzer IRAC, GALEX, or SPHEREx at another wavelength).</li>
<li>With the atmosphere switched on, daylight and twilight veil the images as in a real sky; switch it off to see SPHEREx at any time.</li>
</ul>

<h2>Stellarium-style planetarium features</h2>
<ul>
<li>~41,000 stars to magnitude 8 with B−V colours, twinkling, labels; 88 constellations with lines, boundaries and names in 11 languages (including Turkish).</li>
<li>Sun, Moon (phases) and all planets plus Pluto from JPL orbital elements; magnitudes, apparent sizes, distances, rise/transit/set times.</li>
<li>Messier and bright deep-sky objects with type symbols; optional catalogue star dots and a drawn Milky Way when the SPHEREx images are switched off.</li>
<li>Physically motivated atmosphere (day, twilight, night, moonlight), Bortle light-pollution slider, refraction, landscape with hills, cardinal points.</li>
<li>Equatorial, azimuthal, ecliptic, galactic and meridian lines; alt-azimuth or equatorial mount; 5 projections (stereographic, fisheye, orthographic, gnomonic, equal-area).</li>
<li>Time travel: pause, real time, up to 10⁶× forward/backward, day/hour/sidereal-day/year jumps, date picker. Location presets, custom coordinates and geolocation.</li>
<li>Search (stars, Bayer names, HIP numbers, constellations, Messier/NGC, planets, coordinates, SIMBAD), info panel, object tracking, night mode, full screen, screenshots.</li>
</ul>
<p>Keyboard (planetarium): <kbd>I</kbd> SPHEREx images · <kbd>S</kbd> catalogue stars · <kbd>[</kbd>/<kbd>]</kbd> wavelength · <kbd>F7</kbd> SPHEREx panel · <kbd>C</kbd> lines · <kbd>V</kbd> names · <kbd>B</kbd> boundaries · <kbd>A</kbd> atmosphere · <kbd>G</kbd> ground · <kbd>Q</kbd> cardinal ·
<kbd>E</kbd> equatorial grid · <kbd>Z</kbd> azimuthal grid · <kbd>,</kbd> ecliptic · <kbd>.</kbd> galactic · <kbd>;</kbd> meridian · <kbd>M</kbd> Milky Way ·
<kbd>D</kbd> DSOs · <kbd>P</kbd> planets · <kbd>J</kbd>/<kbd>K</kbd>/<kbd>L</kbd> time speed · <kbd>8</kbd> now · <kbd>Space</kbd> center · <kbd>T</kbd> track ·
<kbd>PgUp</kbd>/<kbd>PgDn</kbd> zoom · arrows pan · <kbd>F4</kbd>/<kbd>F5</kbd>/<kbd>F6</kbd> windows · <kbd>Ctrl+N</kbd> night · <kbd>/</kbd> search.</p>

<h2>How the SPHEREx processing works</h2>
<ul>
<li><b>Discovery:</b> IRSA TAP query <code>CONTAINS(POINT, spherex.plane.poly)</code> joined with <code>spherex.artifact</code> returns every Level-2 spectral image covering the position.</li>
<li><b>Cutouts:</b> IRSA's on-the-fly cutout service (<code>?center=…&amp;size=…</code>). The local server parses the multi-extension FITS while it streams (IMAGE, FLAGS, VARIANCE, ZODI)
and stops the download before the large PSF extension, caching the small result on disk. The WCS-WAVE lookup table is fetched once per detector calibration.</li>
<li><b>Astrometry:</b> full TAN-SIP world↔pixel transforms; each frame is resampled onto a common north-up tangent-plane grid.</li>
<li><b>Wavelength:</b> the bilinear <code>WAVE-TAB</code> spectral WCS gives the central wavelength and bandwidth of every pixel (the linear variable filters make λ vary across the detector).</li>
<li><b>Stacking:</b> zodiacal-light model and median background removed, bad-pixel flags masked, inverse-variance weighted co-adds per survey epoch / visit / detector.</li>
<li><b>Photometry:</b> pixel-integrated Gaussian PSF fit (FWHM from each exposure's header) with a local background, or aperture photometry with an annulus and aperture correction;
fluxes converted from MJy/sr to µJy with each image's pixel solid angle (OMEGA_MEDIAN). High-proper-motion targets are followed through time (proper motion + annual parallax).</li>
</ul>
<p class="muted">Note: this is a discovery/visualisation tool. For publication-grade photometry use IRSA's official SPHEREx tools and the Explanatory Supplement.</p>

<h2>Data &amp; credits</h2>
<ul>
<li>SPHEREx data: NASA / JPL-Caltech / IPAC — ${link('https://irsa.ipac.caltech.edu/Missions/spherex.html', 'NASA/IPAC Infrared Science Archive')}. DOIs 10.26131/IRSA678, 10.26131/IRSA679.
Please cite SPHEREx as described by IRSA when using these data.</li>
<li>Gaia DR3 (ESA/DPAC), CatWISE2020, AllWISE, 2MASS via IRSA TAP. Names via ${link('https://cds.unistra.fr/cgi-bin/Sesame', 'CDS Sesame')}; SIMBAD and VizieR (CDS, Strasbourg).</li>
<li>Comparison surveys from IRSA's HiPS node (mirrors of CDS HiPS: 2MASS, AllWISE, DSS2, SDSS9, Spitzer, GALEX). SIMBAD objects via SIMBAD TAP (CDS, with the Harvard CfA mirror as fallback).</li>
<li>Star, constellation, Milky Way and DSO data from ${link('https://github.com/ofrohn/d3-celestial', 'd3-celestial')} (© Olaf Frohn, BSD-3-Clause; based on the Hipparcos/Tycho catalogues).</li>
<li>Planet positions: JPL "Approximate Positions of the Planets" (E. M. Standish); Moon: J. Meeus, <i>Astronomical Algorithms</i>.</li>
<li>Inspired by ${link('https://stellarium-web.org/', 'Stellarium Web')}, ${link('http://byw.tools/wiseview', 'WiseView')} and IRSA's SPHEREx Spectrophotometry Tool.</li>
</ul>`;
}
