// One colour palette for the whole site: the all-sky map, the blink viewer and the sharpening view use the
// same choice (remembered in the browser and in ?cmap=). The map applies it as a CSS / SVG filter on Aladin's
// image canvas; the viewer through the lookup tables in sky.js.
import { PALETTE_STOPS } from './sky.js';

export const MAP_PALETTES = ['gray', 'invert', 'inferno', 'viridis', 'tint', 'rgb'];
const VIEWER = new Set(['gray', 'invert', 'heat', 'inferno', 'viridis']);
const KEY = 'radians-palette';

let current = 'gray';
try {
  const url = new URLSearchParams(location.search).get('cmap');
  const saved = localStorage.getItem(KEY);
  if (url && (MAP_PALETTES.includes(url) || VIEWER.has(url))) current = url;
  else if (saved && (MAP_PALETTES.includes(saved) || VIEWER.has(saved))) current = saved;
} catch { /* private mode */ }

export const getPalette = () => current;
/** Palette for the blink / sharpening canvases (the wavelength tint is a map-only look: grey there). */
export const viewerCmap = (p = current) => (VIEWER.has(p) ? p : 'gray');

export function setPalette(p) {
  if (p === current) return;
  current = p;
  try { localStorage.setItem(KEY, p); } catch { /* private mode */ }
  document.dispatchEvent(new CustomEvent('radians:palette', { detail: p }));
}

/** CSS gradient of a palette, for swatches and the colour bar. */
export function gradient(p, dir = '90deg') {
  const stops = PALETTE_STOPS[p] || PALETTE_STOPS.gray;
  return `linear-gradient(${dir}, ${stops.join(', ')})`;
}

/** SVG filters that turn the (grey) sky image into a palette: luminance -> lookup table per channel. */
export function paletteFilters() {
  const ch = (hex, k) => parseInt(hex.slice(1 + 2 * k, 3 + 2 * k), 16) / 255;
  const lum = '0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0';
  const f = (name) => {
    const s = PALETTE_STOPS[name];
    const tv = (k) => s.map(h => ch(h, k).toFixed(3)).join(' ');
    return `<filter id="pal-${name}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${lum}"/>`
      + `<feComponentTransfer><feFuncR type="table" tableValues="${tv(0)}"/><feFuncG type="table" tableValues="${tv(1)}"/>`
      + `<feFuncB type="table" tableValues="${tv(2)}"/></feComponentTransfer></filter>`;
  };
  const div = document.createElement('div');
  div.innerHTML = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${f('inferno')}${f('viridis')}</svg>`;
  return div.firstChild;
}
