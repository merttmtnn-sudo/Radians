// Run: node tests/colour.test.mjs
import assert from 'node:assert/strict';
import {
  IR_MIN_UM, IR_MAX_UM, VIS_MIN_NM, VIS_MAX_NM,
  visibleNm, nmToRgb, rainbowTint, ramp, pickTints, scaleRgb, rgbToHex, hexToRgb,
  nearestChannel, channelRamp,
} from '../js/map/colour.js';

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const nearRgb = (a, b, tol = 1e-9) => a.length === 3 && a.every((v, i) => near(v, b[i], tol));
const assertRgb = (a, b, tol = 1e-9, msg = '') => assert.ok(nearRgb(a, b, tol), `${msg} ${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// --- constants
assert.deepEqual([IR_MIN_UM, IR_MAX_UM, VIS_MIN_NM, VIS_MAX_NM], [0.75, 5.0, 380, 700]);

// --- visibleNm: end points, clamping, monotonic, log midpoint
assert.ok(near(visibleNm(0.75), 380));
assert.ok(near(visibleNm(5.0), 700));
assert.ok(near(visibleNm(0.1), 380));
assert.ok(near(visibleNm(-3), 380));
assert.ok(near(visibleNm(99), 700));
assert.ok(near(visibleNm(Math.sqrt(0.75 * 5)), 540, 1e-9));
assert.ok(Number.isNaN(visibleNm(NaN)));
assert.ok(Number.isNaN(visibleNm(Infinity)));
assert.ok(Number.isNaN(visibleNm(undefined)));
for (let um = 0.75; um < 5.0; um += 0.01) {
  assert.ok(visibleNm(um + 0.01) > visibleNm(um), `visibleNm not increasing at ${um}`);
}

// --- nmToRgb anchors
{
  const [r, g, b] = nmToRgb(380);                       // violet
  assert.ok(b === 1 && g === 0 && r > 0.4 && r < 0.7, `380 nm ${[r, g, b]}`);
}
for (const nm of [440, 445, 450]) assertRgb(nmToRgb(nm), [0, 0, 1], 0.05, `${nm} nm blue`);
{
  const [r, g, b] = nmToRgb(490);                       // cyan
  assert.ok(r === 0 && g >= 0.9 && b >= 0.9, `490 nm ${[r, g, b]}`);
}
assert.ok([510, 515, 520, 525, 530].some((nm) => nearRgb(nmToRgb(nm), [0, 1, 0], 0.05)), 'no pure green in 510-530');
{
  const [r, g, b] = nmToRgb(580);                       // yellow
  assert.ok(r >= 0.9 && g >= 0.9 && b === 0, `580 nm ${[r, g, b]}`);
}
{
  const [r, g, b] = nmToRgb(610);                       // orange
  assert.ok(r === 1 && g > 0.35 && g < 0.65 && b === 0, `610 nm ${[r, g, b]}`);
}
for (const nm of [645, 660, 700]) assert.deepEqual(nmToRgb(nm), [1, 0, 0], `${nm} nm red`);
// clamping
assert.deepEqual(nmToRgb(100), nmToRgb(380));
assert.deepEqual(nmToRgb(2000), nmToRgb(700));

// --- nmToRgb: max channel 1, range, continuity, no magenta, hue order
const hue = ([r, g, b]) => {                             // degrees: red 0, green 120, blue 240
  const max = Math.max(r, g, b); const d = max - Math.min(r, g, b);
  if (max === r) return (60 * ((g - b) / d) + 360) % 360;
  return max === g ? 60 * ((b - r) / d) + 120 : 60 * ((r - g) / d) + 240;
};
let prev = null;
for (let nm = 380; nm <= 700; nm++) {
  const c = nmToRgb(nm);
  assert.equal(Math.max(...c), 1, `max channel at ${nm} nm`);
  assert.ok(c.every((v) => v >= 0 && v <= 1), `range at ${nm} nm`);
  assert.ok(!(c[0] > 0.75 && c[2] > 0.75), `magenta at ${nm} nm`);
  if (prev) {
    assert.ok(c.every((v, i) => Math.abs(v - prev[i]) <= 0.05), `jump at ${nm} nm`);
    // violet (~273 deg) down to red (0 deg), never backwards
    assert.ok(hue(c) <= hue(prev) + 1e-9, `hue goes backwards at ${nm} nm`);
  }
  prev = c;
}
assert.ok(hue(nmToRgb(380)) > 240 && hue(nmToRgb(380)) < 300);
assert.equal(hue(nmToRgb(700)), 0);
// continuity on a finer grid too (0.05 per nm -> 0.005 per 0.1 nm)
for (let nm = 380; nm < 700; nm += 0.1) {
  const a = nmToRgb(nm); const b = nmToRgb(nm + 0.1);
  assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= 0.005 + 1e-9), `fine jump at ${nm} nm`);
}

// --- rainbowTint
assert.deepEqual(rainbowTint(0.75), nmToRgb(380));
assert.deepEqual(rainbowTint(5.0), [1, 0, 0]);
assert.deepEqual(rainbowTint(2.2), nmToRgb(visibleNm(2.2)));

// --- ramp
assert.deepEqual(ramp(0), [0, 0, 1]);
assert.deepEqual(ramp(-2), [0, 0, 1]);
assert.deepEqual(ramp(0.5), [0, 1, 0]);
assert.deepEqual(ramp(1), [1, 0, 0]);
assert.deepEqual(ramp(7), [1, 0, 0]);
assertRgb(ramp(0.25), [0, 0.5, 0.5]);
assertRgb(ramp(0.75), [0.5, 0.5, 0]);
for (let p = -0.2; p <= 1.2; p += 0.01) {
  const c = ramp(p);
  assert.ok(near(c[0] + c[1] + c[2], 1, 1e-12), `ramp sum at ${p}`);
  assert.ok(c.every((v) => v >= 0 && v <= 1));
}

// --- pickTints
const BLUE = [0, 0, 1]; const GREEN = [0, 1, 0]; const RED = [1, 0, 0];
assert.deepEqual(pickTints([]), []);
assert.deepEqual(pickTints([], 'fixed'), []);
assert.deepEqual(pickTints([2.2]), [[1, 1, 1]]);
assert.deepEqual(pickTints([2.2], 'stretch'), [[1, 1, 1]]);
// two picks, both input orders
assert.deepEqual(pickTints([1.0, 3.0]), [[0, 0.5, 1], [1, 0.5, 0]]);
assert.deepEqual(pickTints([3.0, 1.0]), [[1, 0.5, 0], [0, 0.5, 1]]);
assert.deepEqual(pickTints([2.0, 2.0]), [[0, 0.5, 1], [1, 0.5, 0]]);   // tie: input order
// three picks: the log centre is pure green, in every input order
const mid = Math.sqrt(1.0 * 4.0);
{
  const t = pickTints([1.0, mid, 4.0]);
  assert.deepEqual(t[0], BLUE); assertRgb(t[1], GREEN, 1e-9); assert.deepEqual(t[2], RED);
  const u = pickTints([4.0, 1.0, mid]);
  assert.deepEqual(u[0], RED); assert.deepEqual(u[1], BLUE); assertRgb(u[2], GREEN, 1e-9);
  const v = pickTints([mid, 4.0, 1.0], 'stretch');
  assertRgb(v[0], GREEN, 1e-9); assert.deepEqual(v[1], RED); assert.deepEqual(v[2], BLUE);
}
{
  // un-clamped middle: p = ln(1.5/1)/ln(4/1)
  const p = Math.log(1.5) / Math.log(4);
  assert.ok(p > 0.25 && p < 0.5);
  assertRgb(pickTints([1.0, 1.5, 4.0])[1], ramp(p));
  // linear midpoint is not the log midpoint
  assert.ok(pickTints([1.0, 2.5, 4.0])[1][0] > 0);
}
// the middle pick is clamped to p 0.25..0.75
assertRgb(pickTints([1.0, 1.01, 4.0])[1], ramp(0.25));
assertRgb(pickTints([1.0, 3.99, 4.0])[1], ramp(0.75));
assertRgb(pickTints([4.0, 1.01, 1.0])[1], ramp(0.25));
// ties
assert.deepEqual(pickTints([2.0, 2.0, 2.0]), [BLUE, GREEN, RED]);
{
  const t = pickTints([1.0, 1.0, 4.0]);                  // the two equal picks: first is the short end
  assert.deepEqual(t[0], BLUE); assertRgb(t[1], ramp(0.25)); assert.deepEqual(t[2], RED);
  const u = pickTints([4.0, 1.0, 4.0]);
  assertRgb(u[0], ramp(0.75)); assert.deepEqual(u[1], BLUE); assert.deepEqual(u[2], RED);
}
// unknown mapping = stretch; fixed = rainbow
assert.deepEqual(pickTints([4.0, 1.0, mid], 'whatever'), pickTints([4.0, 1.0, mid], 'stretch'));
assert.deepEqual(pickTints([3.3, 0.9, 1.6], 'fixed'), [rainbowTint(3.3), rainbowTint(0.9), rainbowTint(1.6)]);
assert.deepEqual(pickTints([2.0], 'fixed'), [rainbowTint(2.0)]);
// four picks: ramp over the log position, no clamp
{
  const t = pickTints([8.0, 1.0, 1.01, 2.0]);
  assert.equal(t.length, 4);
  assert.deepEqual(t[0], RED); assert.deepEqual(t[1], BLUE);
  assertRgb(t[2], ramp(Math.log(1.01) / Math.log(8)));
  assertRgb(t[3], ramp(1 / 3), 1e-9);
  assert.deepEqual(pickTints([2, 2, 2, 2]), [ramp(0), ramp(1 / 3), ramp(2 / 3), ramp(1)]);
}

// --- scaleRgb
assertRgb(scaleRgb([1, 0.5, 0], 0.5), [0.5, 0.25, 0]);
assert.deepEqual(scaleRgb([1, 0.5, 0], 4), [1, 1, 0]);
assert.deepEqual(scaleRgb([1, 0.5, 0.2], -1), [0, 0, 0]);

// --- rgbToHex / hexToRgb
assert.equal(rgbToHex([1, 0, 0]), '#ff0000');
assert.equal(rgbToHex([0, 0.5, 1]), '#0080ff');
assert.equal(rgbToHex([2, -1, 0.2]), '#ff0033');
assert.deepEqual(hexToRgb('#ff0000'), [1, 0, 0]);
assert.deepEqual(hexToRgb('00FF00'), [0, 1, 0]);
assert.deepEqual(hexToRgb('#0f0'), [0, 1, 0]);
assert.deepEqual(hexToRgb('fff'), [1, 1, 1]);
for (const bad of ['', '#', '#12', '#1234', '#12345', '#1234567', 'red', '#gg0000', null, undefined, 255, {}]) {
  assert.equal(hexToRgb(bad), null, `hexToRgb(${String(bad)})`);
}
for (const hex of ['#000000', '#ffffff', '#12ab9f', '#804020', '#0080ff']) {
  assert.equal(rgbToHex(hexToRgb(hex)), hex);
}
for (let nm = 380; nm <= 700; nm += 7) {
  assertRgb(hexToRgb(rgbToHex(nmToRgb(nm))), nmToRgb(nm), 0.5 / 255 + 1e-9, `round trip ${nm} nm`);
}

// --- nearestChannel
const channels = [1.0, 1.2, 1.4, 1.6, 1.8].map((w, i) => ({ frame: i, band: 1, channel: i + 1, wave_um: w }));
assert.equal(nearestChannel(channels, 1.21), channels[1]);
assert.equal(nearestChannel(channels, 0.2), channels[0]);
assert.equal(nearestChannel(channels, 9), channels[4]);
assert.equal(nearestChannel(channels, 1.21, [1]), channels[2]);
assert.equal(nearestChannel(channels, 1.21, new Set([1, 2])), channels[0]);
assert.equal(nearestChannel(channels, 1.21, []), channels[1]);
// ties -> the lower frame (1.5 is exactly between frames 2 and 3 in a dyadic list)
const dyadic = [1.0, 1.5, 2.0, 2.5].map((w, i) => ({ frame: i, band: 1, channel: i + 1, wave_um: w }));
assert.equal(nearestChannel(dyadic, 1.75), dyadic[1]);
assert.equal(nearestChannel(dyadic.slice().reverse(), 1.75), dyadic[1]);
assert.equal(nearestChannel(dyadic, 1.75, [1]), dyadic[2]);
assert.equal(nearestChannel(dyadic, 1.5, new Set([1])), dyadic[0]);
assert.equal(nearestChannel([], 1.5), null);
assert.equal(nearestChannel(channels, 1.5, [0, 1, 2, 3, 4]), null);
assert.equal(nearestChannel(channels, 1.5, new Set([0, 1, 2, 3, 4])), null);

// --- channelRamp
const tint = [1, 0.5, 0];
{
  const r = channelRamp(tint);
  assert.equal(r.length, 17);
  assert.equal(r[0], '#000000');
  assert.equal(r[16], rgbToHex(tint));
  assert.equal(r[8], rgbToHex(scaleRgb(tint, 0.5)));
  assert.ok(r.every((h) => /^#[0-9a-f]{6}$/.test(h)));
  // hue preserved: green stays half of red (within 8-bit rounding), blue stays 0
  for (const h of r) {
    const [rr, gg, bb] = hexToRgb(h).map((v) => v * 255);
    assert.equal(bb, 0);
    assert.ok(Math.abs(gg - rr / 2) <= 1, `hue drift in ${h}`);
  }
}
assert.equal(channelRamp(tint, 1, 5).length, 5);
assert.deepEqual(channelRamp([1, 1, 1], 1, 3), ['#000000', '#808080', '#ffffff']);
{
  // gain 2: full tint from the middle on
  const r = channelRamp(tint, 2);
  assert.equal(r[0], '#000000');
  assert.equal(r[4], rgbToHex(scaleRgb(tint, 0.5)));
  for (let i = 8; i < 17; i++) assert.equal(r[i], rgbToHex(tint), `gain 2 entry ${i}`);
  assert.notEqual(r[7], rgbToHex(tint));
  for (const h of r) {
    const [rr, gg] = hexToRgb(h).map((v) => v * 255);
    assert.ok(Math.abs(gg - rr / 2) <= 1, `hue drift in ${h}`);
  }
}
{
  // gain 0.5: ends at half strength
  const r = channelRamp(tint, 0.5);
  assert.equal(r[0], '#000000');
  assert.equal(r[16], rgbToHex(scaleRgb(tint, 0.5)));
}
// gain clamp 0.1..8, non-finite gain = 1
assert.deepEqual(channelRamp(tint, 100), channelRamp(tint, 8));
assert.deepEqual(channelRamp(tint, 0), channelRamp(tint, 0.1));
assert.deepEqual(channelRamp(tint, -5), channelRamp(tint, 0.1));
assert.deepEqual(channelRamp(tint, NaN), channelRamp(tint, 1));
assert.deepEqual(channelRamp(tint, Infinity), channelRamp(tint, 1));
assert.equal(channelRamp(tint, 8)[16], rgbToHex(tint));
assert.equal(channelRamp(tint, 8)[2], rgbToHex(tint));

// channelRamp with a gamma: darker at the faint end, same end points, hue kept
{
  const plain = channelRamp([1, 0.5, 0], 1, 9);
  const toned = channelRamp([1, 0.5, 0], 1, 9, 2);
  assert.equal(toned.length, 9);
  assert.equal(toned[0], '#000000');
  assert.equal(toned[8], plain[8]);
  assert.equal(toned[4], rgbToHex([0.25, 0.125, 0]));                 // (4/8)^2 = 0.25
  for (let i = 1; i < 8; i++) assert.ok(hexToRgb(toned[i])[0] < hexToRgb(plain[i])[0], `stop ${i} is darker`);
  assert.deepEqual(channelRamp([1, 1, 1], 1, 5, NaN), channelRamp([1, 1, 1], 1, 5));   // bad gamma counts as 1
  assert.deepEqual(channelRamp([1, 1, 1], 2, 5, 1), channelRamp([1, 1, 1], 2, 5));     // default unchanged
}
console.log('colour: all good');
