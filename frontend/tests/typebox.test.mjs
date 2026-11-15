// node --test frontend/tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { prettyType, catalogueLines, oursLines, printLine, typeLines } from '../js/blink/typebox.js';

test('Pickles range names read as ranges', () => {
  assert.equal(prettyType('B57V'), 'B5–7V');
  assert.equal(prettyType('K01II'), 'K0–1II');
  assert.equal(prettyType('M4V'), 'M4V');
  assert.equal(prettyType('T8.5V'), 'T8.5V');
  assert.equal(prettyType('rK2III'), 'K2III');
  // metal-rich and metal-weak twins of the best match are not "next best" types
  const k = oursLines({ note: null, standards: { type: 'rK2III', alternatives: [{ type: 'wK2III' }, { type: 'M0V' }, { type: 'K2III' }], n_bins: 46, chi2_red: 3 } });
  assert.deepEqual(k[0], ['tyBest', { type: 'K2III' }]);
  assert.deepEqual(k[1], ['tyAlt', { list: 'M0V' }]);
});

test('catalogue column: found, not found, down, still asking', () => {
  const lines = catalogueLines({
    simbad: { ok: true, found: true, id: "NAME Barnard's star", sptype: 'M4V' },
    gaia: { ok: true, found: true, teff: 3250.4, logg: 4.93, mh: -0.41, distance_pc: 1.828, parallax_mas: 546.98, p_star: 0.994 },
  });
  assert.deepEqual(lines, [
    ['tySimbadType', { id: "Barnard's star", type: 'M4V' }],
    ['tyGaia', { vals: '3250 K, log g 4.9, [M/H] −0.4' }],
    ['tyGaiaDist', { d: '6.0', plx: '547.0' }],
    ['tyGaiaStar', { p: 99 }],
  ]);
  assert.deepEqual(catalogueLines({ simbad: { ok: false }, gaia: { ok: true, found: false } }), [['tySimbadDown', {}], ['tyNoGaia', {}]]);
  assert.deepEqual(catalogueLines({ simbad: { ok: true, found: true, id: 'X', sptype: null }, gaia: { ok: true, found: true, teff: null } }),
    [['tySimbadNoType', { id: 'X' }], ['tyGaiaNoTeff', {}]]);
  assert.deepEqual(catalogueLines(null, true, false), [['tyChecking', {}]]);
  assert.deepEqual(catalogueLines(null, false, true), [['tyCatFail', {}]]);
});

test('our column: a star, a brown dwarf, saturated, too faint', () => {
  const star = oursLines({ note: null, standards: { type: 'M4V', range: ['M3', 'M5'], teff: 3200, alternatives: [{ type: 'M5V' }, { type: 'B57V' }], n_bins: 51, chi2_red: 1.3 }, model: null });
  assert.deepEqual(star.map(l => l[0]), ['tyBest', 'tyRange', 'tyTeff', 'tyAlt', 'tyFrom']);
  assert.equal(star[3][1].list, 'M5V, B5–7V');
  const bd = oursLines({ note: null, standards: null, model: { teff: 500, type: 'T9', chi2_red: 9.2, at_edge: false } });
  assert.deepEqual(bd.map(l => l[0]), ['tyModel', 'tyModelRough']);
  assert.deepEqual(oursLines({ note: 'saturated' }), [['tySaturated', {}]]);
  // no star at the spot: no type, whatever the fit says
  const fit = { note: null, standards: { type: 'G0III', range: ['G0', 'G8'], teff: 5920, n_bins: 51, chi2_red: 0.96 } };
  assert.deepEqual(oursLines(fit, { state: 'empty', snr: 1.5 }), [['tySpotEmpty', {}]]);
  assert.deepEqual(oursLines(fit, { state: 'wing', snr: 5.5 }), [['tySpotWing', {}]]);
  assert.equal(oursLines(fit, { state: 'star', snr: 40 })[0][0], 'tyBest');
  const none = typeLines({ fit, spot: { state: 'empty' }, agreement: 'agree', fingerprints: [{ id: 'h2o', verdict: 'absent', depth: 0 }], catalogue: null });
  assert.equal(none.verdict, null);
  assert.deepEqual(none.prints, []);
  assert.deepEqual(oursLines({ note: 'too_faint' }), [['tyTooFaint', {}]]);
});

test('fingerprint rows and the verdict', () => {
  assert.deepEqual(printLine({ id: 'water', verdict: 'present', depth: 0.184 }), ['fp_water', 'fpv_present', { pct: 18 }]);
  assert.deepEqual(printLine({ id: 'methane', verdict: 'no_data', depth: null }), ['fp_methane', 'fpv_no_data', { pct: '' }]);
  const all = typeLines({ fit: { note: 'too_faint' }, fingerprints: [], catalogue: null, pending: true, agreement: null });
  assert.equal(all.verdict, null);
  const rows = [{ id: 'water', verdict: 'present', depth: 0.2 }, { id: 'co', verdict: 'no_data', depth: null }];
  const good = typeLines({ fit: { note: null, standards: { type: 'M4V', n_bins: 50, chi2_red: 1 } }, fingerprints: rows, agreement: 'agree' });
  assert.deepEqual(good.verdict, ['tyAgree_agree', 'agree']);
  assert.equal(good.prints.length, 2);
  // a saturated star: the catalogue column still shows, but no verdict and no fingerprint rows
  const sat = typeLines({ fit: { note: 'saturated' }, fingerprints: rows, agreement: 'unknown' });
  assert.equal(sat.verdict, null);
  assert.deepEqual(sat.prints, []);
});
