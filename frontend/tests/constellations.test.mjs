// Run: node tests/constellations.test.mjs  (checks "You're looking at" on known stars)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.fetch = async (url) => ({ json: async () => JSON.parse(readFileSync(new URL('../' + String(url).replace('static/', ''), import.meta.url), 'utf8')) });
const m = await import('../js/map/constellations.js');
await m.loadConstellations();
const cases = [
  [83.82, -5.39, 'Ori'], [279.23, 38.78, 'Lyr'], [101.29, -16.72, 'CMa'], [37.95, 89.26, 'UMi'],
  [269.45, 4.69, 'Oph'], [331.04, -56.78, 'Ind'], [133.82, -7.25, 'Hya'], [248.17, 66.75, 'Dra'],
  [10.68, 41.27, 'And'], [56.6, 24.1, 'Tau'], [266.42, -29.0, 'Sgr'], [219.9, -60.83, 'Cen'],
  [80.89, -69.76, 'Dor'], [0.5, 10.0, 'Psc'], [359.5, -30.0, 'Scl'], [180.0, -89.0, 'Oct'],
];
for (const [ra, dec, want] of cases) {
  const got = m.constellationAt(ra, dec, 'en');
  assert.equal(got && got.id, want, `${ra} ${dec}: got ${JSON.stringify(got)}, want ${want}`);
}
assert.equal(m.constellationAt(83.82, -5.39, 'tr').name, 'Avcı');
console.log('constellations: all good');
