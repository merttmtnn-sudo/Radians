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

test('how it moves: a line through the positions of the fast band', async () => {
  const { motionLines } = await import('../js/blink/curious.js');
  const gaia = { reachable: true, found: true, rate: 4.68, direction: 'south_east', parallax_ok: true, parallax_mas: 270.7, speed_kms: 82 };
  const fit = { ok: true, significant: true, rate: 4.684, err: 0.34, direction_deg: 122, n: 4, band: 5 };
  // no mover from the finders: the fit speaks for SPHEREx, with its error and the speed it implies
  const a = motionLines(null, gaia, fit);
  assert.deepEqual(a[0], ['cuMotionFit', { rate: '4.68', err: '0.34', dir: 'south_east', n: 4, b: 5 }]);
  assert.deepEqual(a[1], ['cuSpeed', { v: 82 }]);
  assert.ok(!a.some(([k]) => k === 'cuMotionStill'));
  // a mover the finders saw: their rate first, the fit after it, the speed only once
  const cand = { rate_arcsec_yr: 4.65, dir: 'south_east', points: [1, 2, 3, 4] };
  const b = motionLines(cand, gaia, fit).map(([k]) => k);
  assert.deepEqual(b.slice(0, 3), ['cuMotionOurs', 'cuSpeed', 'cuMotionFit']);
  assert.equal(b.filter(k => k === 'cuSpeed').length, 1);
  // too small to be sure: said so, and "no clear motion" stays
  const weak = motionLines(null, gaia, { ...fit, significant: false, rate: 0.3 }).map(([k]) => k);
  assert.deepEqual(weak.slice(0, 2), ['cuMotionStill', 'cuMotionFitWeak']);
  // saturated core: no number is made up
  assert.ok(motionLines(null, gaia, { ok: false, reason: 'saturated' }).some(([k]) => k === 'cuMotionFitSat'));
  // without a fit the answer is what it was before
  assert.deepEqual(motionLines(null, gaia), motionLines(null, gaia, null));
});
