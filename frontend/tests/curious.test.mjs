// node --test frontend/tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { speedKms, motionLines, periodLines, knownLines, starRows } from '../js/blink/curious.js';

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
  // no answer is guessed: each reason has its own sentence
  assert.deepEqual(periodLines({ ok: false, reason: 'too_few' }), [['cuPeriodNone', {}]]);
  assert.deepEqual(periodLines({ ok: false, reason: 'too_faint' }), [['cuPeriodFaint', {}]]);
  assert.deepEqual(periodLines({ ok: false, reason: 'saturated' }), [['cuPeriodSat', {}]]);
  assert.deepEqual(periodLines({ ok: false, reason: 'saturated', wings: true }), [['cuPeriodSatWings', {}]]);
  assert.deepEqual(periodLines({ ok: false, reason: 'empty' }), [['cuPeriodEmpty', {}]]);
  assert.deepEqual(periodLines({ ok: false, reason: 'wing' }), [['cuPeriodWing', {}]]);
  assert.deepEqual(periodLines(null), [['cuPeriodNone', {}]]);
  const dropped = { flagged: 55, saturated: 4, faint: 0, sparse: 2, stray: 3 };
  // a rhythm that beat the scrambled copies
  const yes = periodLines({ ok: true, n: 296, dropped, convincing: true, period_d: 5.99, err_d: 0.38, amplitude_pct: 11.1, cycles: 16.2,
    aliased: true, search: { lo_d: 1, hi_d: 93.7 }, change: { pct: 0.9, err_pct: 3.5, sigma: 0.2, significant: false, brighter: true, from_mjd: 60896.5, to_mjd: 61096.5 } });
  assert.deepEqual(yes[0], ['cuPeriod', { p: '6.0', err: '0.4' }]);
  assert.deepEqual(yes[1], ['cuPeriodDetail', { amp: 11, c: 16 }]);
  assert.equal(yes[2][0], 'cuPeriodAlias');
  assert.deepEqual(yes[3], ['cuChangeSteady', { pct: 11 }]);          // 3 x the error of the comparison
  assert.deepEqual(yes[4], ['cuPeriodUsed', { n: 296, left: 64 }]);
  assert.deepEqual(periodLines({ ok: true, n: 400, convincing: true, period_d: 245.3, err_d: 12.4, amplitude_pct: 30, cycles: 2.4, aliased: false, change: null })[0],
    ['cuPeriod', { p: '245', err: '12' }]);
  // nothing found: said plainly, with the range that was tried, and never a "best guess"
  const no = periodLines({ ok: true, n: 296, dropped, convincing: false, period_d: 1.21, err_d: 0.02, search: { lo_d: 1, hi_d: 93.7 },
    change: { pct: 22.2, err_pct: 3.3, sigma: 6.7, significant: true, brighter: true, from_mjd: 60896.54, to_mjd: 61259.19 } });
  assert.deepEqual(no[0], ['cuPeriodNoRhythm', { lo: '1.0', hi: '94' }]);
  assert.deepEqual(no[1], ['cuChangeBrighter', { pct: 22, sigma: 7, a: '2025-08', b: '2026-08' }]);
  assert.equal(periodLines({ ok: true, n: 40, convincing: false, search: null, change: null })[0][0], 'cuPeriodNoSearch');
  assert.equal(periodLines({ ok: true, n: 40, convincing: false, search: null, change: null })[1][0], 'cuChangeOne');
});

test('is it a known variable star', () => {
  const rdra = { vsx: { reachable: true, found: true, name: 'R Dra', type: 'M', period_d: 246.12, sep_arcsec: 0.4 },
    gaia: { reachable: true, found: true, variable: true, class: 'LPV', score: 0.98 } };
  assert.deepEqual(knownLines(rdra, { ok: false, reason: 'saturated' }),
    [['cuKnownVsxPeriod', { name: 'R Dra', type: 'M', p: '246' }], ['cuKnownGaiaClass', { cls: 'LPV' }]]);
  assert.equal(knownLines(rdra, { ok: true, convincing: true, period_d: 240 }).at(-1)[0], 'cuKnownAgree');
  assert.equal(knownLines(rdra, { ok: true, convincing: true, period_d: 120 }).at(-1)[0], 'cuKnownDiffer');
  assert.equal(knownLines(rdra, { ok: true, convincing: false, period_d: 120 }).length, 2);       // nothing of ours to compare
  const quiet = { vsx: { reachable: true, found: false }, gaia: { reachable: true, found: true, variable: false, class: null } };
  assert.deepEqual(knownLines(quiet, null), [['cuKnownNone', {}]]);
  assert.deepEqual(knownLines({ vsx: { reachable: false }, gaia: { reachable: true, found: false } }, null), [['cuKnownDown', { cat: 'VSX' }]]);
  assert.deepEqual(knownLines(null, null), []);
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
