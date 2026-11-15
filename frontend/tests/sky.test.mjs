// node --test frontend/tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { percentiles, stretchValue, pixToSky, skyToPix, formatRA, formatDec, flagNames, parseState, decodeB64 } from '../js/blink/sky.js';

test('decode float32 base64', () => {
  const a = new Float32Array([1.5, -2, NaN]);
  const b64 = Buffer.from(a.buffer).toString('base64');
  const d = decodeB64(b64, Float32Array);
  assert.equal(d[0], 1.5); assert.equal(d[1], -2); assert.ok(Number.isNaN(d[2]));
});

test('percentiles skip NaN', () => {
  const [lo, hi] = percentiles([new Float32Array([NaN, 0, 1, 2, 3, 4])], [0, 100]);
  assert.equal(lo, 0); assert.equal(hi, 4);
});

test('stretch clamps and is monotonic', () => {
  for (const k of ['linear', 'log', 'sqrt', 'asinh']) {
    assert.equal(stretchValue(-5, 0, 1, k), 0);
    assert.equal(stretchValue(5, 0, 1, k), 1);
    assert.ok(stretchValue(0.3, 0, 1, k) < stretchValue(0.6, 0, 1, k));
  }
});

test('pixel <-> sky round trip, east left, north up', () => {
  const grid = { n: 41, pixel_scale: 6.15, ra: 133.795, dec: -7.245 };
  const [ra, dec] = pixToSky(20, 20, grid);
  assert.ok(Math.abs(ra - 133.795) < 1e-9 && Math.abs(dec + 7.245) < 1e-9);
  const [raL] = pixToSky(10, 20, grid);
  assert.ok(raL > 133.795, 'left is east (larger RA)');
  const [, decUp] = pixToSky(20, 30, grid);
  assert.ok(decUp > -7.245, 'larger y is north');
  const [x, y] = skyToPix(...pixToSky(3.3, 37.1, grid), grid);
  assert.ok(Math.abs(x - 3.3) < 1e-6 && Math.abs(y - 37.1) < 1e-6);
});

test('sexagesimal formatting', () => {
  assert.equal(formatRA(133.79512916666664), '08h55m10.83s');
  assert.equal(formatDec(-7.245147222222222), '-07°14′42.5″');
});

test('flag names', () => {
  const f = flagNames((1 << 21) | (1 << 28), { 21: 'SOURCE', 28: 'HALO' }, 1 << 28);
  assert.deepEqual(f, [{ name: 'SOURCE', bad: false }, { name: 'HALO', bad: true }]);
});

test('url state', () => {
  const s = parseState('?q=Barnard%27s%20Star&ra=269.45&dec=4.69&fov=240&embed=1&pmra=');
  assert.equal(s.q, "Barnard's Star"); assert.equal(s.ra, 269.45); assert.equal(s.fov, 240);
  assert.equal(s.embed, true); assert.equal(s.pmra, null); assert.equal(s.frame, null);
});

import { medianImage, stackImage, computeView, stretchSigned, lutDiverging } from '../js/blink/sky.js';

test('median and difference views cancel static sky', () => {
  const a = new Float32Array([1, 5, NaN]), b = new Float32Array([1, 7, 2]), c = new Float32Array([1, 6, 4]);
  assert.deepEqual([...medianImage([a, b, c])].slice(0, 2), [1, 6]);
  assert.equal(medianImage([a, b, c])[2], 3);
  const d = computeView([a, b, c], null, 'diff_median');
  assert.equal(d[0][0], 0); assert.equal(d[1][1], 1);
  assert.equal(computeView([a, b, c], null, 'diff_prev')[1][1], 2);
  assert.equal(computeView([a, b, c], null, 'diff_first')[2][1], 1);
});

test('stack is inverse-variance weighted', () => {
  const s = stackImage([new Float32Array([1]), new Float32Array([4])], [new Float32Array([1]), new Float32Array([3])]);
  assert.ok(Math.abs(s[0] - (1 + 4 / 3) / (1 + 1 / 3)) < 1e-6);
  assert.equal(computeView([new Float32Array([1])], null, 'stack').length, 1);
});

test('signed stretch and diverging lut', () => {
  assert.equal(stretchSigned(-10, 1, 'linear'), -1);
  assert.equal(stretchSigned(0.5, 1, 'linear'), 0.5);
  const l = lutDiverging();
  assert.deepEqual([l[128 * 3], l[128 * 3 + 1], l[128 * 3 + 2]], [0, 0, 0]);
  assert.equal(l[255 * 3], 255); assert.equal(l[2], 255);
});

// ---------------------------------------------------------------- colour composite
import { ivCoadd, rgbChannels, RGB_GROUPS } from '../js/blink/sky.js';

test('ivCoadd weights by inverse variance and leaves empty pixels NaN', () => {
  const a = Float32Array.from([1, NaN, 5]), b = Float32Array.from([4, NaN, NaN]);
  const va = Float32Array.from([1, 1, 1]), vb = Float32Array.from([0.5, 1, 1]);
  const c = ivCoadd([a, b], [va, vb]);
  assert.ok(Math.abs(c[0] - 3) < 1e-6);            // (1/1 + 4/0.5) / (1 + 2) = 3
  assert.ok(Number.isNaN(c[1]));
  assert.equal(c[2], 5);
});

test('rgbChannels groups detectors into blue / green / red per epoch', () => {
  const img = (v) => Float32Array.from([v, v]), one = Float32Array.from([1, 1]);
  const frames = [
    { epoch: 1, detector: 1, image: img(10), variance: one }, { epoch: 1, detector: 2, image: img(20), variance: one },
    { epoch: 1, detector: 6, image: img(7), variance: one }, { epoch: 2, detector: 4, image: img(3), variance: one },
  ];
  const ch = rgbChannels(frames);
  assert.deepEqual(Object.keys(RGB_GROUPS), ['b', 'g', 'r']);
  assert.equal(ch[1].b[0], 15);                     // D1 + D2 averaged
  assert.equal(ch[1].g, null);                      // no D3/D4 in epoch 1
  assert.equal(ch[1].r[0], 7);
  assert.equal(ch[2].g[0], 3);
  assert.equal(ch.all.b[0], 15);
});

// ---------------------------------------------------------------- merged-in views (colour by time, matched difference)
test('colour by time: first visit blue, middle green, last red', async () => {
  const { timeColorChannels, timeColour, computeView } = await import('../js/blink/sky.js');
  const near = (x, y) => Math.abs(x - y) < 1e-5;
  // pixel 0: a steady star (4 in every visit) -> white; pixel 1: only in the first visit -> blue;
  // pixel 2: only in the last -> red; pixel 3: never seen in the last visit
  const a = Float32Array.of(4, 9, 0, 2), b = Float32Array.of(4, 0, 0, 2), c = Float32Array.of(4, 0, 9, NaN);
  const three = timeColorChannels([a, b, c]);
  assert.ok(near(three.r[0], 4) && near(three.g[0], 4) && near(three.b[0], 4));
  assert.ok(three.b[1] > three.g[1] && three.g[1] > three.r[1]);
  assert.ok(three.r[2] > three.g[2] && three.g[2] > three.b[2]);
  assert.ok(near(three.r[3], 2) && near(three.b[3], 2));        // the missing visit is left out, not counted as dark
  const four = timeColorChannels([a, b, b, c]);                 // every visit counts, not only three of them
  assert.ok(near(four.g[0], 4) && four.b[1] > four.r[1]);
  const blue = timeColour(0, 4), red = timeColour(3, 4);
  assert.ok(blue[2] > blue[0] && red[0] > red[2]);
  const two = timeColorChannels([a, c]);
  assert.ok(near(two.g[0], 4) && two.b[1] > two.r[1] && two.r[2] > two.b[2]);
  assert.equal(timeColorChannels([a]), null);
  assert.equal(computeView([a, b, c], null, 'timecolor').length, 1);
});

test('matched difference: noise stays dark, before is blue, now is orange', async () => {
  const { matchedDiffValue, lutBeforeNow, BEFORE_RGB, NOW_RGB } = await import('../js/blink/sky.js');
  assert.equal(matchedDiffValue(0.5, 10), 0);                  // 0.5 sigma of a 10-sigma scale: under the knee
  assert.equal(matchedDiffValue(-1, 10), -0);
  assert.ok(matchedDiffValue(5, 10) > 0.4 && matchedDiffValue(5, 10) < 0.5);
  assert.equal(matchedDiffValue(50, 10), 1);
  assert.equal(matchedDiffValue(-50, 10), -1);
  assert.ok(Number.isNaN(matchedDiffValue(NaN, 10)));
  const lut = lutBeforeNow();
  assert.deepEqual([...lut.slice(0, 3)].map(Math.round).slice(0, 3).length, 3);
  assert.ok(Math.abs(lut[1 * 3 + 2] - BEFORE_RGB[2]) <= 3);    // most negative: blue
  assert.ok(Math.abs(lut[255 * 3] - NOW_RGB[0]) <= 1);         // most positive: orange
  assert.ok(lut[128 * 3] < 10 && lut[128 * 3 + 1] < 12 && lut[128 * 3 + 2] < 16);   // no change: dark
});
