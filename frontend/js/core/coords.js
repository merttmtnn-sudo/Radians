// Read sky coordinates in every common format, and say how they were read.
//   17h57m48.5s +04d41m36s   17:57:48.5 +04:41:36   17 57 48.5 +4 41 36
//   269.45 4.69   269.45, +4.69   269,45 4,69 (decimal commas)   RA 269.45 Dec 4.69
// Returns {ra, dec, hours: bool} in degrees, {error: 'message'} if it looks like coordinates
// but does not make sense, or null if it does not look like coordinates (so: a name).

const COORDISH = /^[\s\d+\-−–.,:;°'"′″hmsdHMSD]*$/;

export function parseCoords(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  s = s.replace(/^\s*(ra|α)\s*[:=]?\s*/i, '').replace(/\s*(dec|δ)\s*[:=]?\s*/i, ' ');
  s = s.replace(/[−–]/g, '-');
  if (!COORDISH.test(s)) return null;
  if (!/\d/.test(s)) return null;

  // "269,45 4,69": two numbers that use decimal commas, separated by spaces
  if (/^[+-]?\d+,\d+\s+[+-]?\d+,\d+$/.test(s)) s = s.replace(/,/g, '.');

  const hasUnits = /[hms°'"′″d]/i.test(s);
  const hours = /\d\s*h/i.test(s) || /^\s*\d{1,2}:\d/.test(s);
  // split the declination off at its sign when there is one after the RA part
  const tokens = s.replace(/[hHdD°:'"′″mMsS,;]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (tokens.some((x) => !/^[+-]?\d+(\.\d+)?$/.test(x))) return { error: 'unreadable' };
  const nums = tokens.map(Number);

  let ra; let dec;
  if (nums.length === 2) {
    ra = hours ? nums[0] * 15 : nums[0];
    dec = nums[1];
  } else if (nums.length === 6 || (nums.length === 4 && hasUnits)) {
    const half = nums.length / 2;
    const [a, b, c = 0] = nums.slice(0, half);
    const decTokens = tokens.slice(half);
    const negative = decTokens[0].startsWith('-');
    const [d, e, f = 0] = nums.slice(half).map(Math.abs);
    if (b >= 60 || c >= 60 || e >= 60 || f >= 60) return { error: 'minutes' };
    const raVal = a + b / 60 + c / 3600;
    // sexagesimal RA is in hours, unless it is written in degrees ("269d27m09s" / "269°27′09″")
    const raInDegrees = /^\s*\d+(\.\d+)?\s*[d°]/i.test(s);
    ra = raInDegrees ? raVal : raVal * 15;
    dec = (negative ? -1 : 1) * (d + e / 60 + f / 3600);
  } else if (nums.length === 1) {
    return null;
  } else {
    return { error: 'count' };
  }
  if (!(ra >= 0 && ra < 360)) return { error: 'ra' };
  if (!(dec >= -90 && dec <= 90)) return { error: 'dec' };
  return { ra, dec };
}

function pad(n, w, d = 0) {
  const s = n.toFixed(d);
  const [i, f] = s.split('.');
  return i.padStart(w, '0') + (f ? '.' + f : '');
}

export function formatRA(deg) {
  let h = ((deg % 360) + 360) % 360 / 15;
  let hh = Math.floor(h); let m = (h - hh) * 60; let mm = Math.floor(m); let ss = (m - mm) * 60;
  if (ss >= 59.95) { ss = 0; mm += 1; }
  if (mm >= 60) { mm = 0; hh = (hh + 1) % 24; }
  return `${pad(hh, 2)}h ${pad(mm, 2)}m ${pad(ss, 2, 1)}s`;
}

export function formatDec(deg) {
  const sign = deg < 0 ? '−' : '+';
  let a = Math.abs(deg); let dd = Math.floor(a); let m = (a - dd) * 60; let mm = Math.floor(m); let ss = (m - mm) * 60;
  if (ss >= 59.5) { ss = 0; mm += 1; }
  if (mm >= 60) { mm = 0; dd += 1; }
  return `${sign}${pad(dd, 2)}° ${pad(mm, 2)}′ ${pad(ss, 2, 0)}″`;
}

export function formatBoth(ra, dec) {
  return `${formatRA(ra)}  ${formatDec(dec)}  (${ra.toFixed(4)}°, ${dec >= 0 ? '+' : ''}${dec.toFixed(4)}°)`;
}
