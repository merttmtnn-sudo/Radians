import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoords } from '../js/blink/sky.js';

const near = (a, b) => Math.abs(a - b) < 1e-4;

test('decimal degrees, with dot or comma', () => {
  assert.deepEqual(parseCoords('269.45 4.69'), [269.45, 4.69]);
  assert.deepEqual(parseCoords('269.45, -4.69'), [269.45, -4.69]);
  assert.deepEqual(parseCoords('269,45 4,69'), [269.45, 4.69]);
});

test('sexagesimal hours and degrees', () => {
  for (const s of ['17h57m48s +04d41m36s', '17:57:48 +04:41:36', '17 57 48 +04 41 36']) {
    const [ra, dec] = parseCoords(s);
    assert.ok(near(ra, 269.45) && near(dec, 4.6933), s);
  }
  const [, dec] = parseCoords('08:55:10.8 -07:14:42.5');
  assert.ok(dec < -7.2 && dec > -7.3);
  const [, d0] = parseCoords('12 00 00 -00 30 00');
  assert.ok(near(d0, -0.5));
});

test('names and nonsense are not positions', () => {
  for (const s of ['M31', "Barnard's Star", 'WISE 0855-0714', '400 10', '10 95', '']) assert.equal(parseCoords(s), null, s);
});
