// node --test frontend/tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { percentiles, stretchValue, pixToSky, skyToPix, formatRA, formatDec, flagNames, parseState, decodeB64 } from '../sky.js';

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

import { medianImage, stackImage, computeView, stretchSigned, lutDiverging } from '../sky.js';

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
