// The theme of the pictures, one choice for the whole site (remembered in the browser and in ?cmap=):
//   gray     regular: black sky, white stars
//   invert   inverted: white sky, dark stars
//   rgb      colour: the infrared range squeezed onto the colours the eye sees. It needs several wavelengths:
//            the whole range on the map, all detector bands in the blink viewer
//   science  scientific: one feature's wavelength against the light beside it (the map only)
// One wavelength, or one detector band, has no colour to show: it is regular or inverted.
export const THEMES = ['gray', 'invert', 'rgb', 'science'];
const VIEWER = new Set(['gray', 'invert', 'rgb']);
const KEY = 'radians-palette';

let current = 'gray';
try {
  const url = new URLSearchParams(location.search).get('cmap');
  const saved = localStorage.getItem(KEY);
  if (url && THEMES.includes(url)) current = url;
  else if (saved && THEMES.includes(saved)) current = saved;
} catch { /* private mode */ }

export const getPalette = () => current;
/** Theme for the blink / sharpening canvases (the scientific theme is the map's: regular there). */
export const viewerCmap = (p = current) => (VIEWER.has(p) ? p : 'gray');

export function setPalette(p) {
  if (p === current || !THEMES.includes(p)) return;
  current = p;
  try { localStorage.setItem(KEY, p); } catch { /* private mode */ }
  document.dispatchEvent(new CustomEvent('radians:palette', { detail: p }));
}
