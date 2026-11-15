// node --test frontend/tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { compass, clarity, headline, positionAt, nearestAt, catalogueStatus, cleanId, tooFast } from '../js/blink/finds.js';

const variable = (fluxes, ratio) => ({ type: 'variable', ratio, detectors: [{ detector: 3, ratio, fluxes }] });

test('compass points', () => {
  assert.equal(compass(354), 'north');
  assert.equal(compass(44), 'north_east');
  assert.equal(compass(180), 'south');
  assert.equal(compass(-90), 'west');
});

test('clarity words follow the noise multiple', () => {
  assert.deepEqual(clarity(303.2), { key: 'fVeryClear', vars: { z: 303 } });
  assert.equal(clarity(12).key, 'fClear');
  assert.equal(clarity(6.1).key, 'fFaint');
});

test('variable headline says brighter or fainter in time order', () => {
  const up = headline(variable([{ epoch: 1, flux_ujy: 100 }, { epoch: 3, flux_ujy: 129 }], 1.29));
  assert.deepEqual(up, { key: 'fBrighterBy', vars: { pct: 29 }, from: 1, to: 3 });
  const down = headline(variable([{ epoch: 1, flux_ujy: 128 }, { epoch: 2, flux_ujy: 100 }], 1.28));
  assert.deepEqual(down, { key: 'fFainterBy', vars: { pct: 22 }, from: 1, to: 2 });
  const big = headline(variable([{ epoch: 1, flux_ujy: 100 }, { epoch: 2, flux_ujy: 240 }], 2.4));
  assert.deepEqual(big, { key: 'fBrighterX', vars: { x: '2.4' }, from: 1, to: 2 });
  // the pair the card shows wins over the detector series, so words and pictures agree
  const shown = headline(variable([{ epoch: 1, flux_ujy: 100 }, { epoch: 3, flux_ujy: 155 }], 1.55), [1, 2, 3], { brighter: false, from: 1, to: 2 });
  assert.deepEqual(shown, { key: 'fFainterBy', vars: { pct: 35 }, from: 1, to: 2 });
});

test('mover and one-epoch headlines', () => {
  assert.deepEqual(headline({ type: 'moving', rate_arcsec_yr: 10.38, pa_deg: 354 }),
    { key: 'fMover', vars: { rate: 10.38, dir: 'north' } });
  assert.equal(headline({ type: 'transient', epoch: 3 }, [1, 2, 3]).key, 'fAppeared');
  assert.equal(headline({ type: 'transient', epoch: 1 }, [1, 2, 3]).key, 'fVanished');
  assert.equal(headline({ type: 'transient', epoch: 2 }, [1, 2, 3]).key, 'fOnlyOnce');
});

test('catalogue positions move with proper motion from their own epoch', () => {
  const barnard = { ra: 269.452, dec: 4.693, pmra: -801.551, pmdec: 10362.394, epoch: 2000 };
  const mjd2026 = 51544.5 + 26 * 365.25;
  const [, dec] = positionAt(barnard, mjd2026);
  assert.ok(Math.abs((dec - 4.693) * 3600 - 269.4) < 0.5);                  // 10.36"/yr for 26 years
  const here = { type: 'moving', ra: 269.452 - 801.551 * 26 / 3.6e6 / Math.cos(4.693 * Math.PI / 180), dec, rate_arcsec_yr: 10.4 };
  assert.equal(nearestAt([barnard], here, mjd2026), barnard);
  // a star that does not move like the candidate is not the candidate
  assert.equal(nearestAt([{ ra: here.ra, dec: here.dec, pmra: 0, pmdec: 0, epoch: 2016 }], here, mjd2026), null);
  // too far away
  assert.equal(nearestAt([barnard], { type: 'variable', ra: 269.452, dec: 4.693 }, mjd2026), null);
});

test('catalogue line: known, new, partly checked, unchecked, waiting', () => {
  const c = { type: 'variable' };
  const ok = { gaia: 'ok', simbad: 'ok', catwise: 'ok' };
  const none = { gaia: null, simbad: null, catwise: null };
  assert.equal(catalogueStatus({ ...c, is_target: true }, ok, none), null);
  const known = catalogueStatus(c, ok, { gaia: { id: '4064475062895232640' }, simbad: { id: 'V* OGLE BLG-LPV-256626' }, catwise: { id: 'CatWISE2020 J1' } });
  assert.deepEqual(known, { kind: 'known', key: 'fKnown', vars: { names: 'Gaia DR3 4064475062895232640 · OGLE BLG-LPV-256626' } });
  assert.deepEqual(catalogueStatus(c, ok, none), { kind: 'new', key: 'fNew', vars: { cats: 'Gaia DR3, SIMBAD, CatWISE2020' } });
  assert.deepEqual(catalogueStatus(c, { ...ok, catwise: 'fail' }, none),
    { kind: 'partly', key: 'fPartly', vars: { checked: 'Gaia DR3, SIMBAD', unchecked: 'CatWISE2020' } });
  assert.equal(catalogueStatus(c, { gaia: 'fail', simbad: 'fail', catwise: 'fail' }, none).kind, 'unchecked');
  assert.equal(catalogueStatus(c, { ...ok, simbad: 'wait' }, none).kind, 'wait');
  // a hit in one catalogue is enough even while another is still loading
  assert.equal(catalogueStatus(c, { ...ok, simbad: 'wait' }, { ...none, gaia: { id: '1' } }).kind, 'known');
});

test('a mover faster than any star is not called new', () => {
  const ghost = { type: 'moving', rate_arcsec_yr: 31 };
  assert.ok(tooFast(ghost));
  assert.ok(!tooFast({ type: 'moving', rate_arcsec_yr: 10.4 }));
  const s = catalogueStatus(ghost, { gaia: 'ok', simbad: 'ok', catwise: 'ok' }, {});
  assert.equal(s.kind, 'notin');
});

test('SIMBAD prefixes are dropped', () => {
  assert.equal(cleanId("NAME Barnard's star"), "Barnard's star");
  assert.equal(cleanId('V* R Dra'), 'R Dra');
  assert.equal(cleanId('OGLE BLG-LPV-256626'), 'OGLE BLG-LPV-256626');
});

// ---------------------------------------------------------------- two finders, one list
test('finds of the two finders merge when they are the same thing', async () => {
  const { mergeFinds, sepArcsec } = await import('../js/blink/finds.js');
  assert.ok(Math.abs(sepArcsec(10, 0, 10, 1 / 3600) - 1) < 1e-9);
  assert.ok(Math.abs(sepArcsec(359.9999, 60, 0.0001, 60) - 0.36) < 0.01);          // across RA = 0, cos(dec) applied
  const as = 1 / 3600;
  const tracking = [
    { type: 'moving', id: 'T-mover', sky: [[10, 20], [10, 20 + 6 * as], [10, 20 + 12 * as]] },
    { type: 'variable', id: 'T-var', sky: [[10.02, 20]] },
  ];
  const difference = [
    { type: 'moving', id: 'D-mover', sky: [[10, 20 + 1 * as], [10, 20 + 13 * as]], rate_arcsec_yr: 10.4 },
    { type: 'transient', id: 'D-new', sky: [[10.02, 20]] },                       // same place as T-var, other type
    { type: 'variable', id: 'D-var-far', sky: [[10.05, 20]] },
  ];
  const out = mergeFinds(tracking, difference);
  assert.deepEqual(out.map(c => c.id), ['T-mover', 'T-var', 'D-new', 'D-var-far']);
  assert.deepEqual(out[0].methods, ['tracking', 'difference']);
  assert.equal(out[0].also.id, 'D-mover');
  assert.deepEqual(out[1].methods, ['tracking']);                                 // a type mismatch is not a match
  assert.equal(out[1].also, null);
  assert.deepEqual(out[2].methods, ['difference']);
  assert.deepEqual(mergeFinds([], difference).map(c => c.methods[0]), ['difference', 'difference', 'difference']);
  assert.deepEqual(mergeFinds(tracking, []).map(c => c.methods.length), [1, 1]);
});

test('headlines of difference-picture finds', async () => {
  const { headline } = await import('../js/blink/finds.js');
  const d = (o) => headline({ method: 'difference', from: 1, to: 3, ...o });
  assert.deepEqual(d({ type: 'transient', kind: 'appeared' }), { key: 'fAppeared', vars: {}, to: 3 });
  assert.deepEqual(d({ type: 'transient', kind: 'vanished' }), { key: 'fVanished', vars: {}, from: 1 });
  assert.deepEqual(d({ type: 'variable', kind: 'faded', ratio: 2 }), { key: 'fFainterBy', vars: { pct: 50 }, from: 1, to: 3 });
  assert.deepEqual(d({ type: 'variable', kind: 'brightened', ratio: 1.25 }), { key: 'fBrighterBy', vars: { pct: 25 }, from: 1, to: 3 });
  assert.deepEqual(d({ type: 'variable', kind: 'brightened', ratio: 3 }), { key: 'fBrighterX', vars: { x: '3.0' }, from: 1, to: 3 });
  assert.equal(d({ type: 'variable', kind: 'faded', ratio: null }).key, 'fFainter');      // saturated: no number claimed
  assert.equal(d({ type: 'moving', kind: 'mover', rate_arcsec_yr: 4.37, pa_deg: 129 }).key, 'fMover');
});
