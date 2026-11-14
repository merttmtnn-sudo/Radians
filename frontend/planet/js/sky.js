// Planetarium renderer: a Stellarium-style real-time sky on a 2-D canvas.
import { D2R, R2D, clamp, mod, fmtRA, fmtDec, fmtDeg, bus, state, TEST_TARGETS } from './util.js';
import * as A from './astro.js';
import { HipsRenderer, spherexSource } from './hips.js';

const PROJ = {
  stereo: { g: t => 2 * Math.tan(t / 2), gi: r => 2 * Math.atan(r / 2), max: 172 * D2R, maxFov: 235 },
  fisheye: { g: t => t, gi: r => r, max: 179 * D2R, maxFov: 300 },
  ortho: { g: t => Math.sin(t), gi: r => (r <= 1 ? Math.asin(r) : NaN), max: 90 * D2R, maxFov: 180 },
  gnomonic: { g: t => Math.tan(t), gi: r => Math.atan(r), max: 80 * D2R, maxFov: 120 },
  equal: { g: t => 2 * Math.sin(t / 2), gi: r => (r <= 2 ? 2 * Math.asin(r / 2) : NaN), max: 179 * D2R, maxFov: 300 },
};
const RATES = [-1e6, -1e5, -1e4, -1e3, -100, -10, -1, 0, 1, 10, 100, 1000, 1e4, 1e5, 1e6];
const GREEK = { 'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'ζ': 'zeta', 'η': 'eta', 'θ': 'theta', 'ι': 'iota', 'κ': 'kappa',
  'λ': 'lambda', 'μ': 'mu', 'ν': 'nu', 'ξ': 'xi', 'ο': 'omicron', 'π': 'pi', 'ρ': 'rho', 'σ': 'sigma', 'τ': 'tau', 'υ': 'upsilon', 'φ': 'phi',
  'χ': 'chi', 'ψ': 'psi', 'ω': 'omega' };
const DSO_TYPES = { gg: 'Galaxy', g: 'Galaxy', s: 'Spiral galaxy', s0: 'Lenticular galaxy', sd: 'Dwarf spheroidal galaxy', e: 'Elliptical galaxy',
  i: 'Irregular galaxy', oc: 'Open cluster', gc: 'Globular cluster', en: 'Emission nebula', bn: 'Bright nebula', sfr: 'Star-forming region',
  rn: 'Reflection nebula', pn: 'Planetary nebula', snr: 'Supernova remnant', dn: 'Dark nebula', pos: 'Asterism', ds: 'Double star', an: 'Nebula', '*': 'Star' };
export { GREEK, DSO_TYPES };

export class Sky {
  constructor(canvas, glCanvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    try { this.hips = new HipsRenderer(glCanvas); } catch (e) { console.error(e); this.hips = { ok: false }; }
    if (this.hips.ok) { this.hips.setBase(spherexSource([60])); this.hips.onUpdate = () => { this.dirty = true; }; }
    this.catalogs = {};
    this.catOn = {};
    this.fieldBox = null;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.loc = { lat: 41.0082, lon: 28.9784, elev: 40, name: 'Istanbul, Türkiye' };
    this.simMs = Date.now();
    this.rate = 1;
    this.view = { mount: 'altaz', az: 180, alt: 30, ra: 90, dec: 20, fov: 90, proj: 'stereo' };
    this.layers = { spherex: true, stars: false, constLines: true, constNames: true, constBounds: false, atmosphere: false, ground: true, cardinal: true,
      eqGrid: false, azGrid: false, ecliptic: false, galactic: false, meridian: false, milkyway: false, dsos: true, planets: true };
    this.opt = { bortle: 3, starScale: 1, magBoost: 0, lang: 'en', refraction: true, twinkle: true, starLabels: true, dsoLabels: true,
      targets: true, track: false };
    this.selection = null;
    this.dirty = true;
    this.anim = null;
    this.lastReal = performance.now();
    this.lastDraw = 0;
    this.visible = true;
    this.picks = [];
    this.atmo = document.createElement('canvas');
    this.sprites = this.makeSprites();
    this.resize();
    window.addEventListener('resize', () => { this.resize(); this.dirty = true; });
    this.bindInput();
  }

  async load() {
    const get = f => fetch('data/' + f).then(r => r.json());
    const [stars, names, cons, mw, dsos] = await Promise.all([get('stars.json'), get('starnames.json'), get('constellations.json'),
      get('milkyway.json'), get('dsos.json')]);
    const n = stars.length / 5;
    const idx = [...Array(n).keys()].sort((a, b) => stars[a * 5 + 2] - stars[b * 5 + 2]);
    this.N = n;
    this.sx = new Float64Array(n); this.sy = new Float64Array(n); this.sz = new Float64Array(n);
    this.smag = new Float32Array(n); this.sbv = new Float32Array(n); this.ship = new Int32Array(n); this.sbin = new Uint8Array(n);
    this.sra = new Float32Array(n); this.sdec = new Float32Array(n);
    idx.forEach((k, i) => {
      const ra = stars[k * 5], dec = stars[k * 5 + 1];
      const v = A.radec2v(ra, dec);
      this.sx[i] = v[0]; this.sy[i] = v[1]; this.sz[i] = v[2];
      this.sra[i] = ra; this.sdec[i] = dec;
      this.smag[i] = stars[k * 5 + 2]; this.sbv[i] = stars[k * 5 + 3]; this.ship[i] = stars[k * 5 + 4];
      this.sbin[i] = clamp(Math.round((this.sbv[i] + 0.4) / 2.4 * 15), 0, 15);
    });
    this.starNames = names;
    this.hipIndex = new Map();
    for (let i = 0; i < n; i++) this.hipIndex.set(this.ship[i], i);
    this.cons = cons.cons.map(c => ({ ...c, v: A.radec2v(c.ra, c.dec) }));
    this.consById = Object.fromEntries(this.cons.map(c => [c.id, c]));
    this.consLines = Object.entries(cons.lines).map(([id, ls]) => ({ id, lines: ls.map(l => l.map(([ra, dec]) => A.radec2v(ra, dec))) }));
    this.bounds = cons.bounds;
    // boundaries: densify edges so they curve properly
    this.boundLines = [];
    for (const polys of Object.values(cons.bounds)) for (const p of polys) {
      const pts = [];
      for (let i = 0; i < p.length; i++) {
        const [r1, d1] = p[i], [r2, d2] = p[(i + 1) % p.length];
        let dr = r2 - r1; if (dr > 180) dr -= 360; if (dr < -180) dr += 360;
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dr), Math.abs(d2 - d1)) / 2));
        for (let s = 0; s < steps; s++) pts.push(A.radec2v(r1 + dr * s / steps, d1 + (d2 - d1) * s / steps));
      }
      pts.push(pts[0]);
      this.boundLines.push(pts);
    }
    this.mw = [];
    for (let i = 0; i < mw.length; i += 3) this.mw.push({ v: A.radec2v(mw[i], mw[i + 1]), l: mw[i + 2] });
    this.dsos = dsos.map(d => ({ ...d, v: A.radec2v(d.ra, d.dec), kind: 'dso' }));
    this.buildGrids();
    this.dirty = true;
  }

  buildGrids() {
    const circle = (fn, n = 180) => [...Array(n + 1).keys()].map(i => fn(i / n * 360));
    this.eqLines = [];
    for (let dec = -80; dec <= 80; dec += 10) this.eqLines.push(circle(ra => A.radec2v(ra, dec)));
    for (let h = 0; h < 24; h++) this.eqLines.push([...Array(91).keys()].map(i => A.radec2v(h * 15, -90 + i * 2)));
    this.celEq = circle(ra => A.radec2v(ra, 0));
    this.eclLine = circle(l => A.ecl2equ([Math.cos(l * D2R), Math.sin(l * D2R), 0]));
    this.galLine = circle(l => A.mulv(A.GAL2EQ, [Math.cos(l * D2R), Math.sin(l * D2R), 0]));
    this.azLines = [];
    for (let alt = -80; alt <= 80; alt += 10) this.azLines.push(circle(az => A.altaz2v(alt, az)));
    for (let az = 0; az < 360; az += 15) this.azLines.push([...Array(91).keys()].map(i => A.altaz2v(-90 + i * 2, az)));
    this.horizonLine = circle(az => A.altaz2v(0, az));
    this.meridianLine = [...Array(181).keys()].map(i => { const a = -90 + i; return a <= 90 ? A.altaz2v(a, 0) : null; })
      .concat([...Array(181).keys()].map(i => A.altaz2v(90 - i, 180)));
    // hills of the landscape
    this.hills = [];
    for (let az = 0; az <= 360; az += 1.5) {
      const h = 0.9 + 0.8 * Math.sin(az * D2R * 3 + 1) + 0.6 * Math.sin(az * D2R * 7 + 2) + 0.35 * Math.sin(az * D2R * 17) + 0.5 * Math.cos(az * D2R * 2);
      this.hills.push(A.altaz2v(Math.max(0.15, h), az));
    }
  }

  makeSprites() {
    const sprites = [];
    for (let b = 0; b < 16; b++) {
      const bv = -0.4 + b / 15 * 2.4;
      const [r, g, bl] = A.bvToRgb(bv);
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const x = c.getContext('2d');
      const grd = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.18, `rgba(${r},${g},${bl},1)`);
      grd.addColorStop(0.35, `rgba(${r},${g},${bl},0.35)`);
      grd.addColorStop(1, `rgba(${r},${g},${bl},0)`);
      x.fillStyle = grd; x.fillRect(0, 0, 64, 64);
      sprites.push(c);
    }
    const glow = document.createElement('canvas'); glow.width = glow.height = 128;
    const g = glow.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,250,230,1)'); gr.addColorStop(0.08, 'rgba(255,245,210,0.9)'); gr.addColorStop(0.25, 'rgba(255,230,170,0.25)');
    gr.addColorStop(1, 'rgba(255,220,150,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    sprites.glow = glow;
    const mw = document.createElement('canvas'); mw.width = mw.height = 32;
    const m = mw.getContext('2d');
    const mg = m.createRadialGradient(16, 16, 0, 16, 16, 16);
    mg.addColorStop(0, 'rgba(190,200,255,0.5)'); mg.addColorStop(1, 'rgba(190,200,255,0)');
    m.fillStyle = mg; m.fillRect(0, 0, 32, 32);
    sprites.mw = mw;
    return sprites;
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    this.W = Math.max(1, Math.round(r.width * this.dpr));
    this.H = Math.max(1, Math.round(r.height * this.dpr));
    this.cv.width = this.W; this.cv.height = this.H;
    this.atmo.width = Math.max(8, Math.round(this.W / 10)); this.atmo.height = Math.max(8, Math.round(this.H / 10));
  }

  // ------------------------------------------------------------------ time
  get date() { return new Date(this.simMs); }
  get jd() { return this.simMs / 86400000 + 2440587.5; }
  setDate(d) { this.simMs = d.getTime(); this.dirty = true; bus.emit('skytime'); }
  setRate(r) { this.rate = r; this.dirty = true; bus.emit('skytime'); }
  faster() { const i = RATES.findIndex(x => x >= this.rate); this.setRate(RATES[Math.min(RATES.length - 1, (RATES[i] === this.rate ? i : i - 1) + 1)]); }
  slower() { const i = RATES.findIndex(x => x >= this.rate); this.setRate(RATES[Math.max(0, i - 1)]); }
  togglePause() { this.setRate(this.rate === 0 ? 1 : 0); }

  // ------------------------------------------------------------------ geometry
  basis() {
    const v = this.view;
    if (v.mount === 'altaz') {
      const a = v.alt * D2R, z = v.az * D2R;
      return [[-Math.sin(z), Math.cos(z), 0], [-Math.sin(a) * Math.cos(z), -Math.sin(a) * Math.sin(z), Math.cos(a)],
        [Math.cos(a) * Math.cos(z), Math.cos(a) * Math.sin(z), Math.sin(a)]];
    }
    const a = v.ra * D2R, d = v.dec * D2R;
    return [[Math.sin(a), -Math.cos(a), 0], [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)],
      [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]];
  }
  setupFrame() {
    this.jdNow = this.jd;
    this.M = A.horizMatrix(this.jdNow, this.loc.lat, this.loc.lon);
    this.Mt = A.transpose(this.M);
    this.B = this.basis();
    const P = PROJ[this.view.proj];
    this.P = P;
    this.view.fov = clamp(this.view.fov, 0.05, P.maxFov);
    this.k = (this.H / 2) / P.g(this.view.fov * D2R / 2);
    this.cx = this.W / 2; this.cy = this.H / 2;
    this.cosMax = Math.cos(P.max);
    this.altaz = this.view.mount === 'altaz';
  }
  // J2000 vector -> view vector (with refraction in alt-az mode)
  j2view(v, refr = true) {
    let h = A.mulv(this.M, v);
    if (this.altaz) {
      if (refr && this.opt.refraction && this.layers.atmosphere) h = this.refract(h);
      return A.mulv(this.B, h);
    }
    return A.mulv(this.B, v);
  }
  hor2view(h) { return this.altaz ? A.mulv(this.B, h) : A.mulv(this.B, A.mulv(this.Mt, h)); }
  refract(h) {
    if (h[2] > 0.5 || h[2] < -0.04) return h;
    const alt = Math.asin(h[2]) * R2D, alt2 = alt + A.refraction(alt);
    const c = Math.cos(alt2 * D2R), r = Math.hypot(h[0], h[1]) || 1;
    return [h[0] / r * c, h[1] / r * c, Math.sin(alt2 * D2R)];
  }
  project(v, clampFar = false) {
    let z = v[2];
    if (z < this.cosMax) {
      if (!clampFar) return null;
      z = this.cosMax;
    }
    const s = Math.hypot(v[0], v[1]);
    const t = Math.atan2(s, z);
    const rho = this.P.g(clampFar ? Math.min(t, this.P.max) : t) * this.k;
    if (s < 1e-12) return [this.cx, this.cy];
    return [this.cx + rho * v[0] / s, this.cy - rho * v[1] / s];
  }
  unproject(px, py) {
    const X = (px - this.cx) / this.k, Y = (this.cy - py) / this.k, r = Math.hypot(X, Y);
    const t = this.P.gi(r);
    if (!isFinite(t)) return null;
    const s = Math.sin(t);
    const vv = r < 1e-12 ? [0, 0, 1] : [X / r * s, Y / r * s, Math.cos(t)];
    // view -> mount frame (B is orthonormal)
    const B = this.B;
    return [B[0][0] * vv[0] + B[1][0] * vv[1] + B[2][0] * vv[2], B[0][1] * vv[0] + B[1][1] * vv[1] + B[2][1] * vv[2],
      B[0][2] * vv[0] + B[1][2] * vv[1] + B[2][2] * vv[2]];
  }
  // screen -> {ra, dec (J2000), alt, az}
  screenToSky(px, py) {
    this.setupFrame();
    const m = this.unproject(px * this.dpr, py * this.dpr);
    if (!m) return null;
    let hv, eq;
    if (this.altaz) { hv = m; eq = A.mulv(this.Mt, m); } else { eq = m; hv = A.mulv(this.M, m); }
    const [ra, dec] = A.v2radec(eq);
    const [alt, az] = A.hor2altaz(hv);
    return { ra, dec, alt, az };
  }

  // ------------------------------------------------------------------ atmosphere model
  skyState() {
    const sun = A.sunPos(this.jdNow), moon = A.moonPos(this.jdNow);
    const sh = A.mulv(this.M, A.radec2v(sun.ra, sun.dec)), mh = A.mulv(this.M, A.radec2v(moon.ra, moon.dec));
    const sunAlt = Math.asin(sh[2]) * R2D, moonAlt = Math.asin(mh[2]) * R2D;
    const lp = (this.opt.bortle - 1) / 8;
    let lim = 6.7 - 0.5 * (this.opt.bortle - 1);
    let day = 0;
    if (this.layers.atmosphere) {
      day = clamp((sunAlt + 18) / 22, 0, 1); // 0 at astronomical night, 1 when Sun is 4 deg up
      lim = lim - (lim + 1.2) * Math.pow(day, 0.7);
      if (moonAlt > 0) lim -= 0.9 * moon.illum * (1 - day);
    } else lim = 7.0;
    return { sun, moon, sh, mh, sunAlt, moonAlt, lp, lim, day };
  }

  drawAtmosphere(ss) {
    const ctx = this.ctx;
    if (!this.layers.atmosphere) { ctx.fillStyle = '#000006'; ctx.fillRect(0, 0, this.W, this.H); return; }
    const aw = this.atmo.width, ah = this.atmo.height;
    const actx = this.atmo.getContext('2d');
    const img = actx.createImageData(aw, ah);
    const d = img.data;
    const { sh, mh, sunAlt, moonAlt, lp, day } = ss;
    const moonUp = moonAlt > -2 ? ss.moon.illum * clamp((moonAlt + 2) / 10, 0, 1) : 0;
    const twi = clamp(1 - Math.abs(sunAlt + 3) / 10, 0, 1); // sunset colors strongest around -3 deg
    for (let j = 0; j < ah; j++) for (let i = 0; i < aw; i++) {
      const m = this.unproject((i + 0.5) / aw * this.W, (j + 0.5) / ah * this.H);
      const o = (j * aw + i) * 4;
      if (!m) { d[o + 3] = 255; continue; }
      const h = this.altaz ? m : A.mulv(this.M, m);
      const alt = Math.max(0, h[2]);
      const cs = h[0] * sh[0] + h[1] * sh[1] + h[2] * sh[2];
      const cm = h[0] * mh[0] + h[1] * mh[1] + h[2] * mh[2];
      const hz = Math.pow(1 - alt, 3.5);
      // night + light pollution
      let r = 3 + 26 * lp * hz + 4 * lp, g = 5 + 22 * lp * hz + 4 * lp, b = 14 + 18 * lp * hz + 6 * lp;
      // moonlight
      r += moonUp * (18 + 30 * Math.pow(Math.max(cm, 0), 8)); g += moonUp * (24 + 34 * Math.pow(Math.max(cm, 0), 8)); b += moonUp * (40 + 40 * Math.pow(Math.max(cm, 0), 8));
      // daylight
      const dd = day * day;
      const sunGlow = Math.pow(Math.max(cs, 0), 24) * 0.9 + Math.pow(Math.max(cs, 0), 4) * 0.25;
      r = r * (1 - dd) + dd * (60 + 120 * hz + 160 * sunGlow);
      g = g * (1 - dd) + dd * (115 + 95 * hz + 140 * sunGlow);
      b = b * (1 - dd) + dd * (215 + 30 * hz + 100 * sunGlow);
      // twilight / sunset band
      const side = Math.max(0, (cs + 0.2) / 1.2);
      const band = twi * Math.pow(1 - alt, 7) * (0.35 + 0.65 * side * side);
      r += band * 230; g += band * 110; b += band * 20;
      if (h[2] < 0 && this.layers.ground) { r *= 0.3; g *= 0.3; b *= 0.3; }
      d[o] = Math.min(255, r); d[o + 1] = Math.min(255, g); d[o + 2] = Math.min(255, b); d[o + 3] = 255;
    }
    actx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.atmo, 0, 0, this.W, this.H);
  }

  // ------------------------------------------------------------------ drawing helpers
  polyline(points, frame, style, width = 1, dash = null) {
    const ctx = this.ctx;
    ctx.beginPath();
    let pen = false, last = null;
    const maxJump = Math.max(this.W, this.H) * 0.6;
    for (const p of points) {
      if (!p) { pen = false; continue; }
      const v = frame === 'hor' ? this.hor2view(p) : this.j2view(p, false);
      const q = this.project(v);
      if (!q) { pen = false; continue; }
      if (pen && last && Math.hypot(q[0] - last[0], q[1] - last[1]) < maxJump) ctx.lineTo(q[0], q[1]);
      else ctx.moveTo(q[0], q[1]);
      pen = true; last = q;
    }
    ctx.strokeStyle = style; ctx.lineWidth = width * this.dpr;
    ctx.setLineDash(dash ? dash.map(x => x * this.dpr) : []);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  onScreen(q, m = 40) { return q && q[0] > -m && q[1] > -m && q[0] < this.W + m && q[1] < this.H + m; }
  label(text, x, y, color, size = 12, align = 'left', force = false, bold = false) {
    const ctx = this.ctx;
    ctx.font = `${bold ? '600 ' : ''}${size * this.dpr}px Segoe UI, system-ui, sans-serif`;
    const w = ctx.measureText(text).width, h = size * this.dpr;
    const x0 = align === 'center' ? x - w / 2 : x;
    const box = [x0 - 2, y - h, x0 + w + 2, y + 3];
    if (!force) for (const b of this.labelBoxes) if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) return false;
    this.labelBoxes.push(box);
    ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x0, y);
    return true;
  }
  isBelow(v) { return this.layers.ground && A.mulv(this.M, v)[2] < -0.002; }

  // ------------------------------------------------------------------ main render
  render(now) {
    const ctx = this.ctx;
    this.setupFrame();
    this.labelBoxes = [];
    this.picks = [];
    const ss = this.skyState();
    this.ss = ss;
    const lim = clamp(ss.lim + 2.4 * Math.log10(60 / Math.min(this.view.fov, 60)) + this.opt.magBoost, -2, 8.2);
    this.limMag = lim;
    if (this.opt.track && this.selection) this.centerOn(this.selection, false);

    const starFade = clamp(1 - ss.day * 1.1, 0, 1);
    const imagery = this.imageryOn();
    this.drawImagery(imagery, starFade);
    if (imagery) {
      ctx.clearRect(0, 0, this.W, this.H);
      // daylight/twilight sky veils the SPHEREx imagery, like surveys in Stellarium
      if (this.layers.atmosphere && ss.day > 0.02) { ctx.globalAlpha = clamp(ss.day * 1.3, 0, 1); this.drawAtmosphere(ss); ctx.globalAlpha = 1; }
    } else this.drawAtmosphere(ss);

    // Milky Way (drawn only without SPHEREx imagery, which already shows it)
    if (!imagery && this.layers.milkyway && starFade > 0.05) {
      ctx.globalCompositeOperation = 'lighter';
      const sz = Math.max(3, 1.6 * D2R * this.k);
      const a0 = 0.11 * starFade * (1 - 0.6 * ss.lp);
      for (const p of this.mw) {
        if (this.isBelow(p.v)) continue;
        const q = this.project(this.j2view(p.v, false));
        if (!this.onScreen(q, sz)) continue;
        ctx.globalAlpha = Math.min(1, a0 * p.l);
        ctx.drawImage(this.sprites.mw, q[0] - sz, q[1] - sz, sz * 2, sz * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // grids and lines
    const L = this.layers;
    if (L.eqGrid) { for (const l of this.eqLines) this.polyline(l, 'j2000', 'rgba(90,140,255,0.35)', 0.8); this.polyline(this.celEq, 'j2000', 'rgba(120,170,255,0.7)', 1.2); }
    if (L.azGrid) { for (const l of this.azLines) this.polyline(l, 'hor', 'rgba(255,150,90,0.3)', 0.8); }
    if (L.ecliptic) this.polyline(this.eclLine, 'j2000', 'rgba(255,214,90,0.75)', 1.3);
    if (L.galactic) this.polyline(this.galLine, 'j2000', 'rgba(200,120,255,0.65)', 1.2, [6, 4]);
    if (L.meridian) this.polyline(this.meridianLine, 'hor', 'rgba(120,255,170,0.6)', 1.1);
    if (L.constBounds) for (const b of this.boundLines) this.polyline(b, 'j2000', 'rgba(255,170,80,0.28)', 0.8, [3, 3]);
    if (L.constLines) {
      const a = 0.25 + 0.4 * starFade;
      for (const c of this.consLines) for (const l of c.lines) this.polyline(l, 'j2000', `rgba(110,160,255,${a})`, 1);
    }

    // deep-sky objects
    if (L.dsos && starFade > 0.1) this.drawDsos(lim);

    // stars (catalog dots are optional on top of SPHEREx imagery; names are always available)
    this.drawStars(lim, starFade, now, ss, !imagery || this.layers.stars);
    this.drawCatalogs();

    // solar system
    this.drawSolarSystem(ss, lim);

    // SPHEREx targets & current target
    this.drawTargets();

    // ground
    if (L.ground) this.drawGround(ss);
    if (L.azGrid || L.ground) this.polyline(this.horizonLine, 'hor', 'rgba(255,160,90,0.55)', 1);
    if (L.cardinal) this.drawCardinal();

    // labels (after ground)
    this.drawLabels(lim, starFade, ss);
    this.drawSelection(now);
    this.dirty = false;
  }

  imageryOn() { return !!(this.layers.spherex && this.hips?.ok); }
  drawImagery(on, fade) {
    if (!this.hips?.ok) return;
    const V = this.altaz ? A.mul(this.B, this.M) : this.B;
    const projIndex = { stereo: 0, fisheye: 1, ortho: 2, gnomonic: 3, equal: 4 }[this.view.proj];
    this.hips.opts.fade = this.layers.atmosphere ? fade : 1;
    this.hips.draw({ enabled: on, W: this.W, H: this.H, cx: this.cx, cy: this.cy, k: this.k, projIndex, maxT: this.P.max, rot: V,
      unproject: (px, py) => { const m = this.unproject(px, py); return m && (this.altaz ? A.mulv(this.Mt, m) : m); } });
  }
  // Gaia / AllWISE / 2MASS / SIMBAD markers when zoomed in, plus the Time-Lapse field of view
  drawCatalogs() {
    const ctx = this.ctx, s = this.dpr;
    if (this.fieldBox && this.view.fov < 20) {
      const f = this.fieldBox, h = f.size / 2, c = Math.cos(f.dec * D2R);
      const corners = [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].map(([dx, dy]) => this.project(this.j2view(A.radec2v(f.ra + dx / c, f.dec + dy), false)));
      if (corners.every(Boolean)) {
        ctx.strokeStyle = 'rgba(255,138,61,0.9)'; ctx.lineWidth = 1.5 * s; ctx.setLineDash([6 * s, 4 * s]);
        ctx.beginPath(); corners.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.stroke(); ctx.setLineDash([]);
        this.label('Time-lapse field', corners[3][0], corners[3][1] - 4 * s, 'rgba(255,170,110,0.9)', 11, 'left', true);
      }
    }
    if (this.view.fov > 3) return;
    const style = { gaia: ['#5be38f', 'circle'], allwise: ['#ff6bd6', 'x'], '2mass': ['#ffd84d', 'plus'], simbad: ['#66d9ff', 'square'] };
    this.catPicks = [];
    for (const [cat, rows] of Object.entries(this.catalogs)) {
      if (!this.catOn[cat] || !rows) continue;
      const [col, shape] = style[cat];
      ctx.strokeStyle = col; ctx.lineWidth = 1.2 * s; ctx.globalAlpha = 0.85;
      // SIMBAD rows arrive sorted by number of references: show only the best-known objects
      for (const r of cat === 'simbad' ? rows.slice(0, 250) : rows) {
        const v = A.radec2v(r.ra, r.dec);
        if (this.isBelow(v)) continue;
        const q = this.project(this.j2view(v));
        if (!this.onScreen(q, 10)) continue;
        const rad = cat === 'simbad' ? 5 * s : Math.max(3 * s, Math.min(8 * s, (20 - (r.mag || 18)) * s));
        ctx.beginPath();
        if (shape === 'circle') ctx.arc(q[0], q[1], rad, 0, Math.PI * 2);
        else if (shape === 'square') ctx.rect(q[0] - rad, q[1] - rad, rad * 2, rad * 2);
        else if (shape === 'x') { ctx.moveTo(q[0] - rad, q[1] - rad); ctx.lineTo(q[0] + rad, q[1] + rad); ctx.moveTo(q[0] + rad, q[1] - rad); ctx.lineTo(q[0] - rad, q[1] + rad); }
        else { ctx.moveTo(q[0] - rad, q[1]); ctx.lineTo(q[0] + rad, q[1]); ctx.moveTo(q[0], q[1] - rad); ctx.lineTo(q[0], q[1] + rad); }
        ctx.stroke();
        this.picks.push({ type: 'cat', t: { ...r, name: r.id, type: { gaia: 'Gaia DR3 source', allwise: 'AllWISE source', '2mass': '2MASS source', simbad: 'SIMBAD: ' + (r.type || '') }[cat] }, x: q[0], y: q[1], mag: 2 });
        if (cat === 'simbad' && this.view.fov < 1) this.label(r.id, q[0] + rad + 3 * s, q[1] + 4 * s, 'rgba(102,217,255,0.85)', 11);
      }
      ctx.globalAlpha = 1;
    }
  }

  drawStars(lim, fade, now, ss, dots = true) {
    const ctx = this.ctx, M = this.M, B = this.B, k = this.k, sc = this.opt.starScale * this.dpr;
    const altaz = this.altaz, ground = this.layers.ground, refr = this.opt.refraction && this.layers.atmosphere;
    const tw = this.opt.twinkle && this.layers.atmosphere ? now / 1000 : null;
    const W = this.W, H = this.H, cx = this.cx, cy = this.cy, P = this.P, cosMax = this.cosMax;
    this.starScreen = [];
    if (fade <= 0.01 && lim < 0) return;
    for (let i = 0; i < this.N; i++) {
      const mag = this.smag[i];
      if (mag > lim) break;
      const x = this.sx[i], y = this.sy[i], z = this.sz[i];
      let vx, vy, vz;
      if (altaz) {
        let hx = M[0][0] * x + M[0][1] * y + M[0][2] * z, hy = M[1][0] * x + M[1][1] * y + M[1][2] * z, hz = M[2][0] * x + M[2][1] * y + M[2][2] * z;
        if (ground && hz < -0.002) continue;
        if (refr && hz < 0.5) { const h = this.refract([hx, hy, hz]); hx = h[0]; hy = h[1]; hz = h[2]; }
        vx = B[0][0] * hx + B[0][1] * hy + B[0][2] * hz; vy = B[1][0] * hx + B[1][1] * hy + B[1][2] * hz; vz = B[2][0] * hx + B[2][1] * hy + B[2][2] * hz;
      } else {
        vx = B[0][0] * x + B[0][1] * y + B[0][2] * z; vy = B[1][0] * x + B[1][1] * y + B[1][2] * z; vz = B[2][0] * x + B[2][1] * y + B[2][2] * z;
      }
      if (vz < cosMax) continue;
      const s = Math.hypot(vx, vy);
      const rho = P.g(Math.atan2(s, vz)) * k;
      const px = s < 1e-12 ? cx : cx + rho * vx / s, py = s < 1e-12 ? cy : cy - rho * vy / s;
      if (px < -20 || py < -20 || px > W + 20 || py > H + 20) continue;
      const rel = lim - mag;
      let r = (0.55 + 0.38 * rel) * sc;
      let a = clamp(0.22 + 0.28 * rel, 0, 1) * fade;
      if (mag < 1) a = Math.max(a, clamp(1 - ss.day * 0.6, 0.15, 1));
      if (tw !== null) {
        const ph = i * 12.9898;
        const low = altaz ? 1 - clamp(vz, 0, 1) : 0.5;
        a *= 1 - 0.28 * (0.4 + low) * (0.5 + 0.5 * Math.sin(tw * (6 + (i % 7)) + ph));
      }
      if (a < 0.02) continue;
      r = Math.min(r, 11 * this.dpr);
      if (dots) {
        const R = r * 2.4;
        ctx.globalAlpha = Math.min(1, a);
        ctx.drawImage(this.sprites[this.sbin[i]], px - R, py - R, R * 2, R * 2);
        if (rel > 3.2) { ctx.globalAlpha = Math.min(0.3, (rel - 3) * 0.06) * a; const G = r * 7; ctx.drawImage(this.sprites.glow, px - G, py - G, G * 2, G * 2); }
      } else r = 3 * this.dpr;
      if (rel > 0.4 || this.view.fov < 10) this.picks.push({ type: 'star', i, x: px, y: py, mag });
      if (mag < lim - 1.2) this.starScreen.push([i, px, py, r]);
    }
    ctx.globalAlpha = 1;
  }

  drawDsos(lim) {
    const ctx = this.ctx;
    for (const d of this.dsos) {
      const mag = isFinite(d.mag) ? d.mag : 10;
      if (mag > lim + 3 && this.view.fov > 30) continue;
      if (this.isBelow(d.v)) continue;
      const q = this.project(this.j2view(d.v));
      if (!this.onScreen(q)) continue;
      const dim = parseFloat(d.dim) || 5;
      const r = Math.max(4 * this.dpr, dim / 60 * D2R * this.k / 2);
      ctx.strokeStyle = 'rgba(140,210,255,0.75)'; ctx.lineWidth = 1 * this.dpr;
      ctx.beginPath();
      const t = d.type;
      if (['gg', 'g', 's', 's0', 'sd', 'e', 'i'].includes(t)) ctx.ellipse(q[0], q[1], r, r * 0.5, -0.5, 0, Math.PI * 2);
      else if (t === 'oc') { ctx.setLineDash([2 * this.dpr, 2 * this.dpr]); ctx.arc(q[0], q[1], r, 0, Math.PI * 2); }
      else if (t === 'gc') { ctx.arc(q[0], q[1], r, 0, Math.PI * 2); ctx.moveTo(q[0] - r, q[1]); ctx.lineTo(q[0] + r, q[1]); ctx.moveTo(q[0], q[1] - r); ctx.lineTo(q[0], q[1] + r); }
      else if (t === 'pn') { ctx.arc(q[0], q[1], r * 0.6, 0, Math.PI * 2); for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; ctx.moveTo(q[0] + Math.cos(a) * r * 0.6, q[1] + Math.sin(a) * r * 0.6); ctx.lineTo(q[0] + Math.cos(a) * r, q[1] + Math.sin(a) * r); } }
      else ctx.rect(q[0] - r, q[1] - r, 2 * r, 2 * r);
      ctx.stroke(); ctx.setLineDash([]);
      this.picks.push({ type: 'dso', d, x: q[0], y: q[1], mag: mag - 3 });
      d._q = q; d._r = r;
    }
  }

  drawSolarSystem(ss, lim) {
    const ctx = this.ctx;
    const bodies = A.solarSystem(this.jdNow);
    this.bodies = bodies;
    const sunQ = this.project(this.j2view(A.radec2v(ss.sun.ra, ss.sun.dec)), true);
    for (const b of bodies) {
      const v = A.radec2v(b.ra, b.dec);
      if (this.isBelow(v) && b.id !== 'sun' && b.id !== 'moon') continue;
      if (this.isBelow(v) && A.mulv(this.M, v)[2] < -0.02) continue;
      const q = this.project(this.j2view(v));
      b._q = null;
      if (!this.onScreen(q, 200)) continue;
      b._q = q;
      const R = Math.max(b.diam * D2R * this.k / 2, 0);
      if (b.id === 'sun') {
        const G = Math.max(70 * this.dpr, R * 8);
        ctx.globalAlpha = 1; ctx.drawImage(this.sprites.glow, q[0] - G, q[1] - G, G * 2, G * 2);
        ctx.fillStyle = '#fffbea'; ctx.beginPath(); ctx.arc(q[0], q[1], Math.max(R, 6 * this.dpr), 0, Math.PI * 2); ctx.fill();
      } else if (b.id === 'moon') {
        const r = Math.max(R, 6 * this.dpr);
        ctx.globalAlpha = 0.5; const G = r * 4; ctx.drawImage(this.sprites.glow, q[0] - G, q[1] - G, G * 2, G * 2); ctx.globalAlpha = 1;
        this.drawPhase(q, r, b, sunQ);
      } else {
        const r = Math.max(R, (1.4 + 0.45 * Math.max(0, lim - b.mag)) * this.dpr * this.opt.starScale * 0.9);
        if (b.mag > lim + 0.5 && R < 2) continue;
        if (R > 3 * this.dpr) this.drawPhase(q, R, b, sunQ, b.color);
        else {
          const RR = Math.min(r, 9 * this.dpr) * 2.4;
          ctx.globalAlpha = 1; ctx.drawImage(this.sprites[b.id === 'mars' ? 14 : b.id === 'neptune' || b.id === 'uranus' ? 3 : 9], q[0] - RR, q[1] - RR, RR * 2, RR * 2);
        }
        if (b.id === 'saturn' && R > 2 * this.dpr) { ctx.strokeStyle = 'rgba(240,216,144,0.8)'; ctx.lineWidth = Math.max(1, R * 0.25); ctx.beginPath(); ctx.ellipse(q[0], q[1], R * 2.2, R * 0.8, -0.4, 0, Math.PI * 2); ctx.stroke(); }
      }
      this.picks.push({ type: 'body', b, x: q[0], y: q[1], mag: b.mag - 5 });
    }
    ctx.globalAlpha = 1;
  }
  drawPhase(q, r, b, sunQ, color = '#efe9dc') {
    const ctx = this.ctx;
    const ang = sunQ ? Math.atan2(sunQ[1] - q[1], sunQ[0] - q[0]) : 0;
    ctx.save(); ctx.translate(q[0], q[1]); ctx.rotate(ang);
    ctx.fillStyle = 'rgba(40,40,48,0.85)'; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    const k = b.illum ?? 1;
    const ex = r * Math.abs(1 - 2 * k);
    ctx.fillStyle = color; ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false); // lit half towards the Sun (+x)
    ctx.ellipse(0, 0, ex, r, 0, Math.PI / 2, -Math.PI / 2, k < 0.5);
    ctx.fill();
    ctx.restore();
  }

  drawTargets() {
    const ctx = this.ctx;
    const list = [];
    if (this.opt.targets) list.push(...TEST_TARGETS.map(t => ({ ...t, test: true })));
    if (state.target) list.push({ ...state.target, current: true });
    this.targetQ = [];
    for (const t of list) {
      const v = A.radec2v(t.ra, t.dec);
      if (this.isBelow(v)) continue;
      const q = this.project(this.j2view(v));
      if (!this.onScreen(q)) continue;
      const s = 7 * this.dpr;
      ctx.strokeStyle = t.current ? '#66d9ff' : 'rgba(255,138,61,0.95)'; ctx.lineWidth = 1.5 * this.dpr;
      ctx.beginPath();
      if (t.current) { ctx.arc(q[0], q[1], s * 1.4, 0, Math.PI * 2); }
      else { ctx.moveTo(q[0], q[1] - s); ctx.lineTo(q[0] + s, q[1]); ctx.lineTo(q[0], q[1] + s); ctx.lineTo(q[0] - s, q[1]); ctx.closePath(); }
      ctx.stroke();
      this.targetQ.push({ t, q });
      this.picks.push({ type: 'target', t, x: q[0], y: q[1], mag: -3 });
    }
  }

  drawGround(ss) {
    const ctx = this.ctx;
    const pts = this.hills.map(h => this.project(this.hor2view(h), true));
    const nad = this.hor2view([0, 0, -1]), zen = this.hor2view([0, 0, 1]);
    const groundInside = nad[2] > zen[2];
    const light = clamp((ss.sunAlt + 12) / 18, 0, 1);
    const c1 = [16 + 36 * light, 13 + 40 * light, 11 + 30 * light], c0 = [3 + 18 * light, 3 + 20 * light, 4 + 16 * light];
    ctx.beginPath();
    if (!groundInside) { ctx.moveTo(-10, -10); ctx.lineTo(this.W + 10, -10); ctx.lineTo(this.W + 10, this.H + 10); ctx.lineTo(-10, this.H + 10); ctx.closePath(); }
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    const nq = this.project(nad, true), hq = pts[0];
    const grd = nq && hq ? ctx.createLinearGradient(hq[0], hq[1], nq[0], nq[1]) : null;
    if (grd) { grd.addColorStop(0, `rgb(${c1.join(',')})`); grd.addColorStop(1, `rgb(${c0.join(',')})`); ctx.fillStyle = grd; }
    else ctx.fillStyle = `rgb(${c0.join(',')})`;
    ctx.fill('evenodd');
    // amber glow along the skyline
    ctx.save();
    ctx.strokeStyle = 'rgba(255,179,71,0.55)'; ctx.lineWidth = 1.4 * this.dpr;
    ctx.shadowColor = 'rgba(255,179,71,0.8)'; ctx.shadowBlur = 14 * this.dpr;
    ctx.beginPath();
    let pen = false;
    for (const p of pts) {
      if (p[0] < -50 || p[0] > this.W + 50 || p[1] < -50 || p[1] > this.H + 50) { pen = false; continue; }
      if (pen) ctx.lineTo(p[0], p[1]); else { ctx.moveTo(p[0], p[1]); pen = true; }
    }
    ctx.stroke();
    ctx.restore();
    // horizon haze
    if (this.layers.atmosphere) {
      ctx.strokeStyle = `rgba(${160 + 60 * light},${150 + 60 * light},${140 + 80 * light},0.18)`;
      ctx.lineWidth = 3 * this.dpr; ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
    }
  }

  drawCardinal() {
    const names = [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]];
    for (const [n, az] of names) {
      const q = this.project(this.hor2view(A.altaz2v(0.2, az)));
      if (!this.onScreen(q, 0)) continue;
      this.label(n, q[0], q[1] - 6 * this.dpr, n.length === 1 ? '#ffb070' : 'rgba(255,176,112,0.6)', n.length === 1 ? 17 : 12, 'center', true, true);
    }
    if (this.layers.azGrid || !this.layers.ground) {
      const z = this.project(this.hor2view([0, 0, 1]));
      if (this.onScreen(z, 0)) this.label('Zenith', z[0], z[1], 'rgba(255,176,112,0.7)', 11, 'center', true);
    }
  }

  drawLabels(lim, fade, ss) {
    const lang = this.opt.lang;
    // planets
    if (this.layers.planets && this.bodies) for (const b of this.bodies) {
      if (!b._q || !this.onScreen(b._q, 0)) continue;
      const nm = lang === 'tr' ? b.tr : b.name;
      this.label(nm, b._q[0] + 8 * this.dpr, b._q[1] - 6 * this.dpr, '#ffd28a', 13, 'left', true);
    }
    // SPHEREx targets
    for (const { t, q } of this.targetQ || []) this.label(t.current ? '◎ ' + (t.name || 'Target') : t.name, q[0] + 10 * this.dpr, q[1] + 4 * this.dpr, t.current ? '#66d9ff' : '#ffb27a', 12, 'left', true);
    // constellations
    if (this.layers.constNames && fade > 0.05) for (const c of this.cons) {
      if (this.view.fov > 120 && c.rank > 2) continue;
      if (this.isBelow(c.v)) continue;
      const q = this.project(this.j2view(c.v, false));
      if (!this.onScreen(q, 0)) continue;
      const nm = (c.n[lang] || c.name);
      this.label(lang === 'en' || lang === 'la' ? nm.toUpperCase() : nm, q[0], q[1], `rgba(140,180,255,${0.35 + 0.45 * fade})`, 11.5, 'center');
    }
    // DSO labels
    if (this.layers.dsos && this.opt.dsoLabels && fade > 0.1) for (const d of this.dsos) {
      if (!d._q || !this.onScreen(d._q, 0)) { d._q = null; continue; }
      if (this.view.fov > 60 && !(d.mag < 6)) { d._q = null; continue; }
      this.label(d.id + (d.alt && this.view.fov < 40 ? ' ' + d.alt : ''), d._q[0] + d._r + 3 * this.dpr, d._q[1] + 3 * this.dpr, 'rgba(140,210,255,0.75)', 11);
      d._q = null;
    }
    // star names
    if (this.opt.starLabels && fade > 0.05 && this.starScreen) {
      const maxN = this.view.fov > 100 ? 25 : this.view.fov > 40 ? 60 : 200;
      let n = 0;
      for (const [i, x, y, r] of this.starScreen) {
        if (n >= maxN) break;
        const nm = this.starNames[this.ship[i]];
        if (!nm) continue;
        let text = nm[0];
        if (!text && this.view.fov < 40) text = nm[1] ? nm[1] + ' ' + nm[3] : nm[2] ? nm[2] + ' ' + nm[3] : '';
        if (!text) continue;
        if (this.label(text, x + r + 4 * this.dpr, y + 4 * this.dpr, 'rgba(200,215,255,0.85)', 12)) n++;
      }
    }
  }

  drawSelection(now) {
    const s = this.selection;
    if (!s) return;
    const pos = this.objectPos(s);
    if (!pos) return;
    const v = A.radec2v(pos.ra, pos.dec);
    const q = this.project(this.j2view(v));
    if (!this.onScreen(q)) return;
    const ctx = this.ctx, r = (14 + 2 * Math.sin(now / 250)) * this.dpr;
    ctx.strokeStyle = '#ffcc4d'; ctx.lineWidth = 1.6 * this.dpr;
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + Math.PI / 4;
      ctx.beginPath(); ctx.arc(q[0], q[1], r, a - 0.45, a + 0.45); ctx.stroke();
    }
  }

  // ------------------------------------------------------------------ objects
  objectPos(o) {
    if (!o) return null;
    if (o.type === 'body') { const b = A.solarSystem(this.jdNow || this.jd).find(x => x.id === o.b.id); return b; }
    if (o.type === 'star') return { ra: this.sra[o.i], dec: this.sdec[o.i] };
    if (o.type === 'dso') return { ra: o.d.ra, dec: o.d.dec };
    if (o.type === 'target' || o.type === 'point' || o.type === 'cat') return { ra: o.t.ra, dec: o.t.dec };
    return null;
  }
  starName(i) {
    const nm = this.starNames[this.ship[i]];
    const parts = [];
    if (nm && nm[0]) parts.push(nm[0]);
    if (nm && nm[1]) parts.push(`${nm[1]} ${nm[3]}`);
    else if (nm && nm[2]) parts.push(`${nm[2]} ${nm[3]}`);
    parts.push('HIP ' + this.ship[i]);
    if (nm && nm[4]) parts.push(nm[4]);
    return parts;
  }
  // point-in-constellation: boundaries are projected stereographically around the test point (origin),
  // which keeps polygons that wrap in RA or surround a pole correct
  constellationAt(ra, dec) {
    const a0 = ra * D2R, d0 = dec * D2R, sd0 = Math.sin(d0), cd0 = Math.cos(d0);
    const proj = (r, d) => {
      const a = r * D2R - a0, dd = d * D2R, cd = Math.cos(dd), sd = Math.sin(dd), ca = Math.cos(a);
      const k = 2 / (1 + sd0 * sd + cd0 * cd * ca + 1e-12);
      return [k * cd * Math.sin(a), k * (cd0 * sd - sd0 * cd * ca)];
    };
    let best = null;
    for (const [id, polys] of Object.entries(this.bounds)) {
      for (const p of polys) {
        // quick reject: polygon must have a vertex within 100 degrees
        if (!p.some(([r, d]) => Math.sin(d * D2R) * sd0 + Math.cos(d * D2R) * cd0 * Math.cos(r * D2R - a0) > -0.17)) continue;
        const q = p.map(([r, d]) => proj(r, d));
        let inside = false;
        for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
          const [xi, yi] = q[i], [xj, yj] = q[j];
          if ((yi > 0) !== (yj > 0) && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) { best = this.consById[id]; break; }
      }
      if (best) return best;
    }
    return dec > 0 ? this.consById.UMi : this.consById.Oct;
  }
  pick(px, py) {
    px *= this.dpr; py *= this.dpr;
    let best = null, bd = 18 * this.dpr;
    for (const p of this.picks) {
      const d = Math.hypot(p.x - px, p.y - py) + (p.type === 'star' ? 0 : -4 * this.dpr) + p.mag * 0.3;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  // ------------------------------------------------------------------ navigation
  centerOn(o, animate = true) {
    const pos = this.objectPos(o);
    if (!pos) return;
    this.lookAt(pos.ra, pos.dec, animate);
  }
  lookAt(ra, dec, animate = true, fov = null) {
    this.setupFrame();
    let to;
    if (this.view.mount === 'altaz') { const h = A.mulv(this.M, A.radec2v(ra, dec)); const [alt, az] = A.hor2altaz(h); to = { az, alt }; }
    else to = { ra, dec };
    if (!animate) { Object.assign(this.view, to); if (fov) this.view.fov = fov; this.dirty = true; return; }
    const from = this.view.mount === 'altaz' ? { az: this.view.az, alt: this.view.alt } : { ra: this.view.ra, dec: this.view.dec };
    const k1 = this.view.mount === 'altaz' ? 'az' : 'ra', k2 = this.view.mount === 'altaz' ? 'alt' : 'dec';
    let d1 = mod(to[k1] - from[k1] + 180, 360) - 180;
    this.anim = { t0: performance.now(), dur: 900, from, d1, d2: to[k2] - from[k2], k1, k2, fov0: this.view.fov, fov1: fov || this.view.fov };
  }
  stepAnim(now) {
    const a = this.anim;
    if (!a) return;
    let t = clamp((now - a.t0) / a.dur, 0, 1);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    this.view[a.k1] = mod(a.from[a.k1] + a.d1 * e, 360);
    this.view[a.k2] = a.from[a.k2] + a.d2 * e;
    this.view.fov = a.fov0 * Math.pow(a.fov1 / a.fov0, e);
    this.dirty = true;
    if (t >= 1) this.anim = null;
  }
  zoom(f, px = null, py = null) {
    const before = px != null ? this.screenToSky(px, py) : null;
    this.view.fov = clamp(this.view.fov * f, 0.05, PROJ[this.view.proj].maxFov);
    if (before) {
      const after = this.screenToSky(px, py);
      if (after) {
        if (this.view.mount === 'altaz') { this.view.az = mod(this.view.az + mod(before.az - after.az + 180, 360) - 180, 360); this.view.alt = clamp(this.view.alt + before.alt - after.alt, -90, 90); }
        else { this.view.ra = mod(this.view.ra + mod(before.ra - after.ra + 180, 360) - 180, 360); this.view.dec = clamp(this.view.dec + before.dec - after.dec, -90, 90); }
      }
    }
    this.dirty = true;
  }
  setMount(m) {
    this.setupFrame();
    const c = this.unproject(this.cx, this.cy);
    let eq, h;
    if (this.altaz) { h = c; eq = A.mulv(this.Mt, c); } else { eq = c; h = A.mulv(this.M, c); }
    this.view.mount = m;
    if (m === 'altaz') { const [alt, az] = A.hor2altaz(h); this.view.alt = alt; this.view.az = az; }
    else { const [ra, dec] = A.v2radec(eq); this.view.ra = ra; this.view.dec = dec; }
    this.dirty = true;
  }

  bindInput() {
    const cv = this.cv;
    const ptrs = new Map();
    let drag = null, pinch = null, moved = false;
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
      moved = false;
      if (ptrs.size === 1) drag = { x: e.offsetX, y: e.offsetY };
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), fov: this.view.fov }; drag = null; }
      this.anim = null;
    });
    cv.addEventListener('pointermove', e => {
      if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (pinch && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        this.view.fov = clamp(pinch.fov * pinch.d / Math.max(d, 1), 0.05, PROJ[this.view.proj].maxFov);
        this.dirty = true; moved = true; return;
      }
      if (drag) {
        const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        if (!moved) return;
        cv.classList.add('dragging');
        this.setupFrame();
        const dpp = R2D / this.k * this.dpr;
        if (this.view.mount === 'altaz') {
          this.view.az = mod(this.view.az - dx * dpp / Math.max(0.2, Math.cos(this.view.alt * D2R) ** 0.5), 360);
          this.view.alt = clamp(this.view.alt + dy * dpp, -90, 90);
        } else {
          this.view.ra = mod(this.view.ra + dx * dpp / Math.max(0.2, Math.cos(this.view.dec * D2R) ** 0.5), 360);
          this.view.dec = clamp(this.view.dec + dy * dpp, -90, 90);
        }
        drag = { x: e.offsetX, y: e.offsetY };
        if (this.opt.track) { this.opt.track = false; bus.emit('trackoff'); }
        this.dirty = true;
      } else bus.emit('skyhover', { x: e.offsetX, y: e.offsetY });
    });
    const up = e => {
      ptrs.delete(e.pointerId);
      cv.classList.remove('dragging');
      if (ptrs.size < 2) pinch = null;
      if (drag && !moved && ptrs.size === 0) {
        const p = this.pick(e.offsetX, e.offsetY);
        if (p) this.select(p);
        else {
          const s = this.screenToSky(e.offsetX, e.offsetY);
          if (s) this.select({ type: 'point', t: { ra: s.ra, dec: s.dec, name: 'Sky position' } });
        }
      }
      drag = ptrs.size === 1 ? { x: [...ptrs.values()][0][0], y: [...ptrs.values()][0][1] } : null;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => bus.emit('skyhover', null));
    cv.addEventListener('wheel', e => { e.preventDefault(); this.anim = null; this.zoom(Math.pow(1.0015, e.deltaY), e.offsetX, e.offsetY); }, { passive: false });
    cv.addEventListener('dblclick', e => { const p = this.pick(e.offsetX, e.offsetY); if (p) { this.select(p); this.centerOn(p); } });
  }
  select(o) { this.selection = o; this.dirty = true; bus.emit('skyselect', o); }

  // ------------------------------------------------------------------ loop
  tick(now) {
    const dt = now - this.lastReal;
    this.lastReal = now;
    if (this.rate !== 0) { this.simMs += dt * this.rate; }
    this.stepAnim(now);
    if (!this.visible) return;
    if (this.blinkCmp && now - (this.lastBlink || 0) > this.blinkCmp * 1000) { this.lastBlink = now; this.hips.opts.mix = this.hips.opts.mix > 0.5 ? 0 : 1; this.dirty = true; bus.emit('blinkstate', this.hips.opts.mix); }
    const continuous = this.dirty || this.anim || (this.rate !== 0 && Math.abs(this.rate) > 1) || this.opt.track && this.rate !== 0;
    const twinkle = this.opt.twinkle && this.layers.atmosphere && now - this.lastDraw > 50;
    const realtime = this.rate !== 0 && now - this.lastDraw > 1000;
    const sel = this.selection && now - this.lastDraw > 60;
    if (continuous || twinkle || realtime || sel) {
      this.render(now);
      this.lastDraw = now;
      bus.emit('skyframe');
    }
  }
}
