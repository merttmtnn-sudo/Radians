/** Minimal animated-GIF encoder (GIF89a, 256-colour global palette, LZW, looping).
 *  frames: array of Uint8Array palette indices (w*h each); palette: Uint8Array of 256*3 RGB. */
export function encodeGif(frames, w, h, palette, delayCs = 50) {
  const out = [];
  const byte = (b) => out.push(b & 255);
  const word = (v) => { byte(v); byte(v >> 8); };
  const str = (s) => { for (const c of s) byte(c.charCodeAt(0)); };
  str('GIF89a'); word(w); word(h);
  byte(0xf7); byte(0); byte(0);                       // global colour table, 8 bits
  for (let i = 0; i < 768; i++) byte(palette[i] || 0);
  str('!\xff\x0bNETSCAPE2.0'); byte(3); byte(1); word(0); byte(0);   // loop forever
  for (const px of frames) {
    byte(0x21); byte(0xf9); byte(4); byte(0); word(delayCs); byte(0); byte(0);
    byte(0x2c); word(0); word(0); word(w); word(h); byte(0);
    byte(8);
    const data = lzw(px, 8);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      byte(n);
      for (let k = 0; k < n; k++) out.push(data[i + k]);
    }
    byte(0);
  }
  byte(0x3b);
  return new Uint8Array(out);
}

function lzw(px, minSize) {
  const clear = 1 << minSize, eoi = clear + 1;
  const out = [];
  let cur = 0, nbits = 0, size = minSize + 1;
  const emit = (code) => {
    cur |= code << nbits; nbits += size;
    while (nbits >= 8) { out.push(cur & 255); cur >>>= 8; nbits -= 8; }
  };
  let dict = new Map(), next = eoi + 1;
  emit(clear);
  let prefix = px[0];
  for (let i = 1; i < px.length; i++) {
    const k = px[i], key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << size) && size < 12) size++;
    } else {
      emit(clear); dict = new Map(); next = eoi + 1; size = minSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (nbits > 0) out.push(cur & 255);
  return out;
}
