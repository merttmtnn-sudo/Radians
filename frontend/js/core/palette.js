// The colour palette of the blink viewer and its sharpening view: one choice for both (remembered in the
// browser and in ?cmap=), applied through the lookup tables in sky.js. The all-sky map does not use it:
// there one wavelength is always black and white, and colour belongs to blends of several wavelengths.

const VIEWER = new Set(['gray', 'invert', 'heat', 'inferno', 'viridis', 'rgb']);   // rgb: three-detector colour in the blink
const KEY = 'radians-palette';

let current = 'gray';
try {
  const url = new URLSearchParams(location.search).get('cmap');
  const saved = localStorage.getItem(KEY);
  if (url && VIEWER.has(url)) current = url;
  else if (saved && VIEWER.has(saved)) current = saved;
} catch { /* private mode */ }

export const getPalette = () => current;
/** Palette for the blink / sharpening canvases. */
export const viewerCmap = (p = current) => (VIEWER.has(p) ? p : 'gray');

export function setPalette(p) {
  if (p === current) return;
  current = p;
  try { localStorage.setItem(KEY, p); } catch { /* private mode */ }
  document.dispatchEvent(new CustomEvent('radians:palette', { detail: p }));
}

