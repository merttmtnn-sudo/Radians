// WebGL2 HiPS sky renderer: draws SPHEREx all-sky tiles (and other HiPS surveys) per pixel in the
// planetarium's own projection. Each fragment is inverse-projected to a J2000 direction, converted to a
// HEALPix (nested) tile + in-tile position, and sampled from a tile atlas (falling back to coarser orders).

const ATLAS = 4096, TILE = 512, PER_ROW = ATLAS / TILE, SLOTS = PER_ROW * PER_ROW; // 64 slots
const IDX_W = 128; // index texture 128x128 = 16384 entries >= sum_{k=0..5} 12*4^k = 16380
const ORDER_OFFSET = [0, 12, 60, 252, 1020, 4092];
const MAX_ORDER_INDEXED = 5;

// ---------------- HEALPix (nested) in JS ----------------
const spread = v => { let r = 0; for (let i = 0; i < 8; i++) r |= ((v >> i) & 1) << (2 * i); return r; };
export function vec2tile(x, y, z, order) {
  const nside = 1 << order;
  const za = Math.abs(z);
  let phi = Math.atan2(y, x); if (phi < 0) phi += 2 * Math.PI;
  const tt = phi * 2 / Math.PI;
  let face, xf, yf;
  if (za <= 2 / 3) {
    const t1 = nside * (0.5 + tt), t2 = nside * z * 0.75;
    const jp = t1 - t2, jm = t1 + t2;
    const ifp = Math.floor(jp / nside), ifm = Math.floor(jm / nside);
    face = ifp === ifm ? (ifp | 4) : ifp < ifm ? ifp : ifm + 8;
    xf = jm - nside * Math.floor(jm / nside);
    yf = nside - (jp - nside * Math.floor(jp / nside));
  } else {
    const ntt = Math.min(3, Math.floor(tt)), tp = tt - ntt;
    const s = Math.hypot(x, y);
    const tmp = nside * s * Math.sqrt(3 / (1 + za));
    const jp = Math.min(tp * tmp, nside - 1e-9), jm = Math.min((1 - tp) * tmp, nside - 1e-9);
    if (z > 0) { face = ntt; xf = nside - jm; yf = nside - jp; } else { face = ntt + 8; xf = jp; yf = jm; }
  }
  const xi = Math.min(nside - 1, Math.max(0, Math.floor(xf))), yi = Math.min(nside - 1, Math.max(0, Math.floor(yf)));
  return { npix: face * nside * nside + spread(xi) + 2 * spread(yi), u: xf - xi, v: yf - yi };
}

// ---------------- shaders ----------------
const VS = `#version 300 es
in vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uAtlas0, uIndex0, uAtlas1, uIndex1, uLut;
uniform vec2 uRes, uC; uniform float uK, uMaxT; uniform int uProj;
uniform mat3 uRot, uMnt; uniform float uLon0, uLat0, uLonSign;
uniform int uOrder0, uOrder1, uMode0, uMode1, uOrient; uniform float uMix, uGain, uGamma, uBlack, uFade; uniform bool uHas1;
uniform sampler2D uMos; uniform bool uMosOn; uniform bool uCubic; uniform float uLod; uniform vec3 uM0, uME, uMN; uniform float uMScale, uMSize;
out vec4 outColor;
const float PI = 3.141592653589793;
float gi(float r) {
  if (uProj == 0) return 2.0 * atan(r / 2.0);
  if (uProj == 1) return r;
  if (uProj == 2) return r <= 1.0 ? asin(r) : -1.0;
  if (uProj == 3) return atan(r);
  return r <= 2.0 ? 2.0 * asin(r / 2.0) : -1.0;
}
// one tile of the atlas: bilinear, or Catmull-Rom (16 texels, inside the tile) when the view magnifies the
// data, which keeps stars round and crisp instead of soft squares
vec3 tileSample(sampler2D atlas, int slot, vec2 uv) {
  vec2 base = vec2(float(slot % ${PER_ROW}), float(slot / ${PER_ROW})) * ${TILE}.0;
  if (!uCubic) return textureLod(atlas, (base + uv * ${TILE}.0) / ${ATLAS}.0, uLod).rgb;   // mipmapped when minified
  vec2 t = uv * ${TILE}.0 - 0.5, f = fract(t);
  ivec2 i0 = ivec2(floor(t)), b = ivec2(base);
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  float wx[4] = float[4](w0.x, w1.x, w2.x, w3.x), wy[4] = float[4](w0.y, w1.y, w2.y, w3.y);
  vec3 c = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    ivec2 q = clamp(i0 + ivec2(i - 1, j - 1), ivec2(0), ivec2(${TILE} - 1));
    c += texelFetch(atlas, b + q, 0).rgb * wx[i] * wy[j];
  }
  return clamp(c, 0.0, 1.0);
}
int spreadBits(int v) { int r = 0; for (int i = 0; i < 6; i++) r |= ((v >> i) & 1) << (2 * i); return r; }
// returns rgb, a = 1 when a tile (or an empty marker) was found
vec4 sampleLayer(vec3 e, int maxOrder, sampler2D atlas, sampler2D idx) {
  float z = e.z, za = abs(z);
  float phi = atan(e.y, e.x); if (phi < 0.0) phi += 2.0 * PI;
  float tt = phi * 2.0 / PI;
  for (int k = 5; k >= 0; k--) {
    if (k > maxOrder) continue;
    float nside = float(1 << k);
    int face; float xf, yf;
    if (za <= 2.0 / 3.0) {
      float t1 = nside * (0.5 + tt), t2 = nside * z * 0.75;
      float jp = t1 - t2, jm = t1 + t2;
      int ifp = int(floor(jp / nside)), ifm = int(floor(jm / nside));
      face = ifp == ifm ? (ifp | 4) : (ifp < ifm ? ifp : ifm + 8);
      xf = jm - nside * floor(jm / nside);
      yf = nside - (jp - nside * floor(jp / nside));
    } else {
      int ntt = min(3, int(tt)); float tp = tt - float(ntt);
      float s = length(e.xy);
      float tmp = nside * s * sqrt(3.0 / (1.0 + za));
      float jp = min(tp * tmp, nside - 1e-4), jm = min((1.0 - tp) * tmp, nside - 1e-4);
      if (z > 0.0) { face = ntt; xf = nside - jm; yf = nside - jp; } else { face = ntt + 8; xf = jp; yf = jm; }
    }
    int ns = 1 << k;
    int xi = clamp(int(floor(xf)), 0, ns - 1), yi = clamp(int(floor(yf)), 0, ns - 1);
    int npix = face * ns * ns + spreadBits(xi) + 2 * spreadBits(yi);
    int off = k == 0 ? 0 : k == 1 ? 12 : k == 2 ? 60 : k == 3 ? 252 : k == 4 ? 1020 : 4092;
    int id = off + npix;
    float v = texelFetch(idx, ivec2(id % ${IDX_W}, id / ${IDX_W}), 0).r * 255.0;
    if (v < 0.5) continue;
    if (v > 254.5) return vec4(0.0, 0.0, 0.0, 1.0);
    int slot = int(v + 0.5) - 1;
    // keep away from the tile edge by half a texel of the mip level read, so neighbours in the atlas never bleed in
    float edge = (0.6 * exp2(uLod)) / ${TILE}.0;
    vec2 uv = clamp(vec2(xf - float(xi), yf - float(yi)), vec2(edge), vec2(1.0 - edge));
    if ((uOrient & 1) != 0) uv = uv.yx;
    if ((uOrient & 2) != 0) uv.x = 1.0 - uv.x;
    if ((uOrient & 4) != 0) uv.y = 1.0 - uv.y;
    return vec4(tileSample(atlas, slot, uv), 1.0);
  }
  return vec4(0.0);
}
vec3 tone(vec3 c, int mode) {
  c = clamp((c - vec3(uBlack)) / max(1.0 - uBlack, 1e-3), 0.0, 1.0);
  c = pow(c, vec3(uGamma)) * uGain;
  if (mode == 0) return texture(uLut, vec2(clamp(c.r, 0.0, 1.0), 0.5)).rgb;
  return clamp(c, 0.0, 1.0);
}
// screen pixel -> sky direction (false outside the projection)
bool dirAt(vec2 p, out vec3 e) {
  e = vec3(0.0, 0.0, 1.0);
  float X = (p.x - uC.x) / uK, Y = (uC.y - p.y) / uK, r = length(vec2(X, Y));
  if (uProj == 6) {
    if (X * X / 8.0 + Y * Y / 2.0 > 1.0) return false;
    float z = sqrt(max(0.0, 1.0 - X * X / 16.0 - Y * Y / 4.0));
    float lon = 2.0 * atan(z * X, 2.0 * (2.0 * z * z - 1.0)), lat = asin(clamp(z * Y, -1.0, 1.0));
    e = normalize(uRot * vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon)));
  } else if (uProj == 5) {
    float lon = uLon0 + uLonSign * X, lat = uLat0 + Y;
    if (abs(lat) > PI / 2.0 || abs(X) > uMaxT) return false;
    e = normalize(uMnt * vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat)));
  } else {
    float t = gi(r);
    if (t < 0.0 || t > uMaxT) return false;
    vec3 d = r < 1e-9 ? vec3(0.0, 0.0, 1.0) : vec3(X / r * sin(t), Y / r * sin(t), cos(t));
    e = normalize(uRot * d);
  }
  return true;
}
vec3 shade(vec3 e) {
  vec4 c0 = sampleLayer(e, uOrder0, uAtlas0, uIndex0);
  vec3 col = c0.a > 0.0 ? tone(c0.rgb, uMode0) : vec3(0.0);
  if (uHas1 && uMix > 0.0) {
    vec4 c1 = sampleLayer(e, uOrder1, uAtlas1, uIndex1);
    vec3 col1 = c1.a > 0.0 ? tone(c1.rgb, uMode1) : vec3(0.0);
    col = mix(col, col1, uMix);
  }
  // native-resolution mosaic (gnomonic image) draped over the all-sky map, feathered at its edges
  if (uMosOn) {
    float c0 = dot(e, uM0);
    if (c0 > 0.0) {
      float xi = dot(e, uME) / c0, eta = dot(e, uMN) / c0;
      vec2 uv = vec2(uMSize * 0.5 - xi / uMScale, uMSize * 0.5 - eta / uMScale) / uMSize;
      if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) {
        vec4 m = texture(uMos, uv);
        float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) * uMSize;
        col = mix(col, m.rgb, m.a * smoothstep(0.0, 14.0, edge));
      }
    }
  }
  return col;
}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec3 e;
  if (!dirAt(p, e)) { outColor = vec4(0.0); return; }
  outColor = vec4(shade(e) * uFade, 1.0);
}`;

// ---------------- layer (one HiPS source, its atlas and index) ----------------
class Layer {
  constructor(r, source) {
    this.r = r; this.gl = r.gl;
    const gl = this.gl;
    this.atlas = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.texStorage2D(gl.TEXTURE_2D, 4, gl.RGBA8, ATLAS, ATLAS);   // 4 mip levels: a tile is still 64 px at the last
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.index = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.index);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, IDX_W, IDX_W);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.idxData = new Uint8Array(IDX_W * IDX_W * 4);
    this.setSource(source);
  }
  setSource(source) {
    this.source = source;
    this.gen = (this.gen || 0) + 1;
    this.slots = new Map(); // key -> {slot, last, pinned}
    this.free = [...Array(SLOTS).keys()];
    this.loading = new Map();
    this.empty = new Set();
    this.idxData.fill(0);
    this.idxDirty = true;
    this.wanted = [];
  }
  key(o, n) { return o * 100000 + n; }
  setIndex(o, n, val) {
    const id = ORDER_OFFSET[o] + n;
    this.idxData[id * 4] = val;
    this.idxDirty = true;
  }
  upload() {
    const gl = this.gl;
    if (this.mipDirty) { gl.bindTexture(gl.TEXTURE_2D, this.atlas); gl.generateMipmap(gl.TEXTURE_2D); this.mipDirty = false; }
    if (!this.idxDirty) return;
    gl.bindTexture(gl.TEXTURE_2D, this.index);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, IDX_W, IDX_W, gl.RGBA, gl.UNSIGNED_BYTE, this.idxData);
    this.idxDirty = false;
  }
  // tiles = [[order, npix, priority], ...]
  request(tiles) {
    const now = performance.now();
    for (const [o, n] of tiles) { const s = this.slots.get(this.key(o, n)); if (s) s.last = now; }
    this.wanted = tiles.filter(([o, n]) => !this.slots.has(this.key(o, n)) && !this.empty.has(this.key(o, n)));
    this.pump();
  }
  pump() {
    const maxConc = 8;
    while (this.loading.size < maxConc && this.wanted.length) {
      const [o, n] = this.wanted.shift();
      const k = this.key(o, n);
      if (this.loading.has(k) || this.slots.has(k) || this.empty.has(k)) continue;
      const gen = this.gen;
      const p = this.source.load(o, n).then(img => {
        this.loading.delete(k);
        if (gen !== this.gen) return;
        if (!img) { this.empty.add(k); this.setIndex(o, n, 255); }
        else this.store(o, n, img);
        this.r.onUpdate?.();
        this.pump();
      }).catch(() => { this.loading.delete(k); this.pump(); });
      this.loading.set(k, p);
    }
  }
  store(o, n, img) {
    let slot;
    if (this.free.length) slot = this.free.pop();
    else {
      // evict least recently used, never order-0 tiles
      let best = null;
      for (const [k, s] of this.slots) if (!s.pinned && (!best || s.last < best[1].last)) best = [k, s];
      if (!best) return;
      this.slots.delete(best[0]);
      this.setIndex(best[1].o, best[1].n, 0);
      slot = best[1].slot;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, (slot % PER_ROW) * TILE, Math.floor(slot / PER_ROW) * TILE, gl.RGBA, gl.UNSIGNED_BYTE, img);
    this.mipDirty = true;
    this.slots.set(this.key(o, n), { slot, o, n, last: performance.now(), pinned: o === 0 });
    this.setIndex(o, n, slot + 1);
  }
  destroy() { this.gl.deleteTexture(this.atlas); this.gl.deleteTexture(this.index); }
}

// ---------------- sources ----------------
const loadImage = url => new Promise(res => {
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.onload = () => res(im);
  im.onerror = () => res(null);
  im.src = url;
});
const dirOf = (o, n) => Math.floor(n / 10000) * 10000;
// SPHEREx DR1 spectral cube, read straight from IRSA (frame 0 has no suffix, frame f is Npix<n>_<f>.png)
export const SPHEREX_CUBE = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
export const cubeTileUrl = (f, o, n) => `${SPHEREX_CUBE}/Norder${o}/Dir${dirOf(o, n)}/Npix${n}${f > 0 ? '_' + f : ''}.png`;
// one frame (grey) or three frames packed into R, G, B
export function spherexSource(frames) {
  const url = cubeTileUrl;
  const cv = document.createElement('canvas'); cv.width = cv.height = TILE;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  return {
    id: 'spherex:' + frames.join(','), maxOrder: 5, mono: frames.length === 1,
    async load(o, n) {
      if (frames.length === 1) return loadImage(url(frames[0], o, n));
      const imgs = await Promise.all(frames.map(f => loadImage(url(f, o, n))));
      if (imgs.every(i => !i)) return null;
      const out = cx.createImageData(TILE, TILE);
      imgs.forEach((im, c) => {
        if (!im) return;
        cx.clearRect(0, 0, TILE, TILE); cx.drawImage(im, 0, 0, TILE, TILE);
        const d = cx.getImageData(0, 0, TILE, TILE).data;
        for (let i = 0; i < TILE * TILE; i++) out.data[i * 4 + c] = d[i * 4];
      });
      for (let i = 0; i < TILE * TILE; i++) out.data[i * 4 + 3] = 255;
      return out;
    },
  };
}
// colour SPHEREx sky: each colour is the average of four wavelength frames of the cube (B = D1+D2,
// G = D3+D4, R = D5+D6, skipping the blank dichroic frames 50/51), which colours the sky and beats down
// the noise. Built in the browser from the cube tiles (the formula of Emre Bozkaya's colour server).
const COLOR_FRAMES = { r: [72, 78, 89, 97], g: [38, 46, 55, 63], b: [4, 12, 21, 29] };
const COLOR_BAL = { r: [4, 1.35], g: [4, 1.1], b: [4, 1.0] };
const COLOR_SAT = 1.45, COLOR_GAMMA = 1.6;
export async function colorTile(o, n, size = TILE) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const N = size * size, lin = new Float32Array(N * 3);
  const chans = await Promise.all(['r', 'g', 'b'].map(c => Promise.all(COLOR_FRAMES[c].map(f => loadImage(cubeTileUrl(f, o, n))))));
  if (chans.flat().every(i => !i)) return null;
  chans.forEach((imgs, ci) => {
    const list = imgs.filter(Boolean), [bk, gain] = COLOR_BAL['rgb'[ci]];
    if (!list.length) return;
    const sum = new Float32Array(N);
    for (const im of list) {
      cx.clearRect(0, 0, size, size); cx.drawImage(im, 0, 0, size, size);
      const d = cx.getImageData(0, 0, size, size).data;
      for (let i = 0; i < N; i++) sum[i] += d[i * 4];
    }
    for (let i = 0; i < N; i++) lin[i * 3 + ci] = Math.max(0, sum[i] / list.length - bk) * gain / 255;
  });
  const out = cx.createImageData(size, size), px = out.data;
  for (let i = 0; i < N; i++) {
    const r = lin[i * 3], g = lin[i * 3 + 1], b = lin[i * 3 + 2], L = (r + g + b) / 3;
    px[i * 4 + 3] = 255;
    if (L <= 0) continue;
    const k = Math.pow(Math.min(L, 1.5), COLOR_GAMMA) / L;
    px[i * 4] = Math.max(0, Math.min(255, (L + (r - L) * COLOR_SAT) * k * 255));
    px[i * 4 + 1] = Math.max(0, Math.min(255, (L + (g - L) * COLOR_SAT) * k * 255));
    px[i * 4 + 2] = Math.max(0, Math.min(255, (L + (b - L) * COLOR_SAT) * k * 255));
  }
  return out;
}
export function spherexColorSource() {
  return { id: 'spherex-color', maxOrder: 5, mono: false, load: (o, n) => colorTile(o, n) };
}
// any other HiPS (IRSA mirrors of 2MASS, AllWISE, DSS, ...)
export function urlSource(base, maxOrder, ext = 'jpg') {
  return { id: base, maxOrder, mono: false, load: (o, n) => loadImage(`${base}/Norder${o}/Dir${dirOf(o, n)}/Npix${n}.${ext}`) };
}

// ---------------- renderer ----------------
export class HipsRenderer {
  constructor(canvas) {
    this.cv = canvas;
    const gl = this.gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true });
    this.ok = !!gl;
    if (!gl) return;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const pr = this.prog = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    this.u = {};
    for (const n of ['uAtlas0', 'uIndex0', 'uAtlas1', 'uIndex1', 'uLut', 'uRes', 'uC', 'uK', 'uMaxT', 'uProj', 'uRot', 'uOrder0', 'uOrder1', 'uMode0', 'uMode1',
      'uOrient', 'uMnt', 'uLon0', 'uLat0', 'uLonSign', 'uMix', 'uGain', 'uGamma', 'uBlack', 'uFade', 'uHas1', 'uMos', 'uMosOn', 'uM0', 'uME', 'uMN', 'uMScale', 'uMSize', 'uCubic', 'uLod']) this.u[n] = gl.getUniformLocation(pr, n);
    this.mosTex = gl.createTexture();
    this.mosaic = null;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const loc = gl.getAttribLocation(pr, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.lutTex = gl.createTexture();
    this.setLut(new Uint8Array(256 * 3).map((_, i) => Math.floor(i / 3)));
    this.base = null; this.cmp = null;
    this.orient = 1; // in-tile pixel layout (u/v swapped), verified against 7 bright IR stars
    this.opts = { gain: 1, gamma: 1, black: 0, mix: 0, fade: 1 };
  }
  setLut(rgb) {
    const gl = this.gl, d = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) { d[i * 4] = rgb[i * 3]; d[i * 4 + 1] = rgb[i * 3 + 1]; d[i * 4 + 2] = rgb[i * 3 + 2]; d[i * 4 + 3] = 255; }
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  }
  // mosaic: {rgba: Uint8Array n*n*4, n, ra0, dec0, scale (deg/px)}; null removes it
  setMosaic(m) {
    this.mosaic = m;
    if (!m || !this.ok) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.mosTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, m.n, m.n, 0, gl.RGBA, gl.UNSIGNED_BYTE, m.rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const a = m.ra0 * Math.PI / 180, d = m.dec0 * Math.PI / 180;
    m.v0 = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
    m.ve = [-Math.sin(a), Math.cos(a), 0];
    m.vn = [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)];
  }
  setBase(src) { if (!this.ok) return; if (this.base?.source.id === src.id) return; if (!this.base) this.base = new Layer(this, src); else this.base.setSource(src); }
  setCompare(src) {
    if (!this.ok) return;
    if (!src) { this.cmp?.destroy(); this.cmp = null; return; }
    if (this.cmp?.source.id === src.id) return;
    if (!this.cmp) this.cmp = new Layer(this, src); else this.cmp.setSource(src);
  }
  // view: {W, H, cx, cy, k, proj, maxT, rot(3x3 J2000->view rows), unproject(px,py)->J2000 vec}
  orderFor(layer, k, proj) {
    const need = Math.ceil(Math.log2(Math.max(1, 1.0233 * k * (proj === 6 ? Math.SQRT2 : 1) / TILE * 1.15)));
    return Math.max(0, Math.min(layer.source.maxOrder, MAX_ORDER_INDEXED, need));
  }
  update(view) {
    for (const L of [this.base, this.cmp]) {
      if (!L) continue;
      let order = this.orderFor(L, view.k, view.projIndex);
      let tiles;
      for (;;) {
        const set = new Map();
        const nx = 28, ny = Math.max(8, Math.round(28 * view.H / view.W));
        for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
          const px = i / nx * view.W, py = j / ny * view.H;
          const e = view.unproject(px, py);
          if (!e) continue;
          const t = vec2tile(e[0], e[1], e[2], order);
          const d = Math.hypot(px - view.cx, py - view.cy);
          const prev = set.get(t.npix);
          if (prev === undefined || d < prev) set.set(t.npix, d);
        }
        if (set.size <= SLOTS - 14 || order === 0) { tiles = [...set.entries()].sort((a, b) => a[1] - b[1]).map(([n]) => [order, n]); break; }
        order--;
      }
      L.order = order;
      const base0 = [...Array(12).keys()].map(n => [0, n]);
      L.request([...base0, ...tiles]);
    }
  }
  draw(view) {
    const gl = this.gl;
    if (this.cv.width !== view.W || this.cv.height !== view.H) { this.cv.width = view.W; this.cv.height = view.H; }
    gl.viewport(0, 0, view.W, view.H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.base || !view.enabled) return;
    this.update(view);
    this.base.upload(); this.cmp?.upload();
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    const u = this.u, o = this.opts;
    const bind = (unit, tex, name) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u[name], unit); };
    bind(0, this.base.atlas, 'uAtlas0'); bind(1, this.base.index, 'uIndex0');
    bind(2, (this.cmp || this.base).atlas, 'uAtlas1'); bind(3, (this.cmp || this.base).index, 'uIndex1');
    bind(4, this.lutTex, 'uLut');
    gl.uniform2f(u.uRes, view.W, view.H); gl.uniform2f(u.uC, view.cx, view.cy);
    gl.uniform1f(u.uK, view.k); gl.uniform1f(u.uMaxT, view.maxT); gl.uniform1i(u.uProj, view.projIndex);
    const R = view.rot; // rows of the J2000->view matrix = columns of view->J2000
    gl.uniformMatrix3fv(u.uRot, false, new Float32Array([R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]]));
    const N = view.mnt || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];   // column-major: columns of the mount -> J2000 matrix
    gl.uniformMatrix3fv(u.uMnt, false, new Float32Array([N[0][0], N[1][0], N[2][0], N[0][1], N[1][1], N[2][1], N[0][2], N[1][2], N[2][2]]));
    gl.uniform1f(u.uLon0, view.lon0 || 0); gl.uniform1f(u.uLat0, view.lat0 || 0); gl.uniform1f(u.uLonSign, view.lonSign || 1);
    // screen pixels per data pixel of the base layer: < 0.75 the data is minified (supersample), > 1.25 magnified (bicubic)
    const ratio = view.k * (view.projIndex === 6 ? Math.SQRT2 : 1) * 1.0233 / (TILE * 2 ** (this.base.order ?? 0));
    // minified: read a smaller mip level (the average of the texels under one screen pixel) instead of picking
    // one texel, so the whole-sky star field is smooth rather than grainy; magnified: bicubic
    gl.uniform1f(u.uLod, Math.min(3, Math.max(0, -Math.log2(ratio) - 0.5)));   // half a level crisper than a plain box average gl.uniform1i(u.uCubic, ratio > 1.25 ? 1 : 0);
    gl.uniform1i(u.uOrder0, this.base.order ?? 0); gl.uniform1i(u.uOrder1, this.cmp?.order ?? 0);
    gl.uniform1i(u.uMode0, this.base.source.mono ? 0 : 1); gl.uniform1i(u.uMode1, this.cmp?.source.mono ? 0 : 1);
    gl.uniform1i(u.uOrient, this.orient);
    gl.uniform1f(u.uMix, this.cmp ? o.mix : 0); gl.uniform1i(u.uHas1, this.cmp ? 1 : 0);
    gl.uniform1f(u.uGain, o.gain); gl.uniform1f(u.uGamma, o.gamma); gl.uniform1f(u.uBlack, o.black); gl.uniform1f(u.uFade, o.fade);
    const m = this.mosaic;
    gl.uniform1i(u.uMosOn, m ? 1 : 0);
    bind(5, this.mosTex, 'uMos');
    if (m) {
      gl.uniform3fv(u.uM0, m.v0); gl.uniform3fv(u.uME, m.ve); gl.uniform3fv(u.uMN, m.vn);
      gl.uniform1f(u.uMScale, m.scale * Math.PI / 180); gl.uniform1f(u.uMSize, m.n);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  loadingCount() { return (this.base?.loading.size || 0) + (this.cmp?.loading.size || 0); }
}
