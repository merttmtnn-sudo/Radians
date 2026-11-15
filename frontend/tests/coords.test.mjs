// Run: node tests/coords.test.mjs
import assert from 'node:assert/strict';
import { parseCoords, formatRA, formatDec } from '../js/core/coords.js';

const near = (a, b, tol = 1e-4) => Math.abs(a - b) < tol;
const ra = 269.452083; const dec = 4.693333;
for (const text of ['17h57m48.5s +04d41m36s', '17:57:48.5 +04:41:36', '17 57 48.5 +4 41 36', '17h 57m 48.5s, +4° 41′ 36″']) {
  const r = parseCoords(text);
  assert.ok(r && near(r.ra, ra) && near(r.dec, dec), `${text} -> ${JSON.stringify(r)}`);
}
for (const text of ['269.452083 4.693333', '269.452083, +4.693333', '269,452083 4,693333', 'RA 269.452083 Dec 4.693333']) {
  const r = parseCoords(text);
  assert.ok(r && near(r.ra, ra) && near(r.dec, dec), `${text} -> ${JSON.stringify(r)}`);
}
assert.ok(near(parseCoords('08h55m10.831s -07d14m42.53s').dec, -(7 + 14 / 60 + 42.53 / 3600)));
assert.ok(near(parseCoords('00 30 00 -00 30 00').dec, -0.5));            // the sign of a zero-degree dec
assert.ok(near(parseCoords('133.8 −7.25').dec, -7.25));      // a Unicode minus sign
assert.equal(parseCoords('Barnard\'s Star'), null);
assert.equal(parseCoords('M42'), null);
for (const name of ['M31', 'WISE 0855-0714', '']) assert.equal(parseCoords(name), null, name);   // names go to the name resolver
assert.ok(near(parseCoords('269.45, -4.69').dec, -4.69));
assert.equal(parseCoords('400 10').error, 'ra');
assert.equal(parseCoords('10 95').error, 'dec');
assert.equal(parseCoords('17 75 00 +04 00 00').error, 'minutes');
assert.equal(formatRA(ra), '17h 57m 48.5s');
assert.equal(formatDec(-7.245147), '−07° 14′ 43″');
console.log('coords: all good');
