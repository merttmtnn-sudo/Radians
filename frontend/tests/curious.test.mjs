// node --test frontend/tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { speedKms, motionLines, periodLines, starRows } from '../js/blink/curious.js';

const barnard = { reachable: true, found: true, id: '4472832130942575872', g: 8.195, bp_rp: 2.834, rate: 10.393, direction: 'north',
  parallax_mas: 546.976, parallax_ok: true, speed_kms: 90.1 };

test('speed across the sky', () => {
  assert.ok(Math.abs(speedKms(10.39, 546.98) - 90.0) < 0.5);
  assert.equal(speedKms(1, 0), null);
  assert.equal(speedKms(1, undefined), null);
});

test('how it moves: SPHEREx mover next to Gaia', () => {
  const l = motionLines({ rate_arcsec_yr: 10.38, dir: 'north', points: [1, 2, 3, 4] }, barnard);
  assert.deepEqual(l.map(x => x[0]), ['cuMotionOurs', 'cuSpeed', 'cuMotionGaia', 'tyGaiaDist', 'cuSpeedGaia']);
  assert.deepEqual(l[0][1], { rate: '10.38', dir: 'north', n: 4 });
  assert.equal(l[1][1].v, 90);
  assert.equal(l[3][1].d, '6.0');
});

test('how it moves: still star, no Gaia, Gaia down, slow star', () => {
  assert.deepEqual(motionLines(null, null).map(x => x[0]), ['cuMotionStill', 'tyNoGaia']);
  assert.deepEqual(motionLines(null, { reachable: false }).map(x => x[0]), ['cuMotionStill', 'tyGaiaDown']);
  const slow = motionLines(null, { reachable: true, found: true, rate: 0.0123, direction: 'east', parallax_ok: false, parallax_mas: 0.3, speed_kms: null });
  assert.deepEqual(slow.map(x => x[0]), ['cuMotionStill', 'cuMotionGaia']);
  assert.equal(slow[1][1].rate, '0.012');
});

test('does it pulse', () => {
  assert.deepEqual(periodLines({ ok: false, reason: 'too_few' }), [['cuPeriodNone', {}]]);
  assert.deepEqual(periodLines({ ok: true, period_d: 245.3, err_d: 12.4, cycles: 1.7, convincing: true }),
    [['cuPeriod', { p: 245, err: 12 }], ['cuPeriodCycles', { c: '1.7' }]]);
  assert.equal(periodLines({ ok: true, period_d: 300, err_d: 0.2, cycles: 0.9, convincing: false })[0][0], 'cuPeriodWeak');
});

test('other catalogues table', () => {
  const rows = starRows(barnard, [
    { survey: '2MASS', state: 'found', id: '17574849+0441405', sep_arcsec: 0.3, mags: { J: 5.244, H: 4.834, K: 4.524 } },
    { survey: 'AllWISE', state: 'unreachable' }]);
  assert.deepEqual(rows[0], ['Gaia DR3', '4472832130942575872', 'G 8.20 · BP−RP 2.83', null]);
  assert.deepEqual(rows[1], ['2MASS', '17574849+0441405 (0.3″)', 'J 5.24 · H 4.83 · K 4.52', null]);
  assert.deepEqual(rows[2], ['AllWISE', null, '', 'cuUnreachable']);
  assert.deepEqual(starRows(null, [{ survey: '2MASS', state: 'none' }]), [['Gaia DR3', null, '', 'cuNotListed'], ['2MASS', null, '', 'cuNotListed']]);
});
