// The SPHEREx DR1 all-sky HiPS cube served by NASA/IPAC IRSA: 102 planes in ascending wavelength,
// one per band (1-6) and channel (1-17). Planes 50 and 51 (the dichroic channels) are blank.
// Values from the cube's own properties file (data_cube_crval3_arr).
export const CUBE_URL = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
export const CUBE_WL = [0.753, 0.771, 0.790, 0.809, 0.828, 0.848, 0.868, 0.889, 0.910, 0.932, 0.955, 0.978, 1.001, 1.025,
  1.050, 1.075, 1.102, 1.113, 1.139, 1.167, 1.195, 1.224, 1.254, 1.284, 1.315, 1.346, 1.378, 1.412, 1.446, 1.481, 1.517,
  1.554, 1.592, 1.631, 1.656, 1.695, 1.735, 1.775, 1.818, 1.861, 1.905, 1.949, 1.995, 2.041, 2.089, 2.139, 2.189, 2.240,
  2.292, 2.345, 2.399, 2.445, 2.506, 2.575, 2.646, 2.719, 2.794, 2.871, 2.951, 3.033, 3.118, 3.204, 3.293, 3.383, 3.476,
  3.570, 3.667, 3.768, 3.833, 3.867, 3.901, 3.935, 3.970, 4.005, 4.040, 4.076, 4.112, 4.148, 4.184, 4.220, 4.257, 4.294,
  4.331, 4.368, 4.405, 4.435, 4.467, 4.500, 4.533, 4.566, 4.600, 4.635, 4.669, 4.704, 4.739, 4.773, 4.808, 4.843, 4.879,
  4.915, 4.951, 4.988];
export const BLANK = new Set([50, 51]);
export const bandOf = (i) => Math.floor(i / 17) + 1;

/** Nearest non-blank plane to a wavelength in µm. */
export function nearestSlice(um) {
  let best = 0;
  CUBE_WL.forEach((w, i) => { if (!BLANK.has(i) && Math.abs(w - um) < Math.abs(CUBE_WL[best] - um)) best = i; });
  return best;
}

/** Next non-blank plane after i (wrapping). */
export function nextSlice(i, step = 1) {
  let j = i;
  do { j = (j + step + CUBE_WL.length) % CUBE_WL.length; } while (BLANK.has(j));
  return j;
}
