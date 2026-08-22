import { describe, expect, test } from 'vitest';
import { computeSpread, crosshairGapPx, MIN_SPREAD, MAX_GAP_PX } from './accuracy.js';
import { WEAPONS } from '../core/state.js';

const still = { crouchLerp: 0, moveLerp: 0, bloom: 0, adsMul: 1 };

describe('computeSpread — stance', () => {
  test('crouching tightens the cone', () => {
    const standing = computeSpread(still);
    const crouched = computeSpread({ ...still, crouchLerp: 1 });
    expect(crouched).toBeLessThan(standing);
  });

  test('walking opens the cone at least 3x over standing still', () => {
    // Mirrors the smoke test's assertion, now without a browser.
    const standing = computeSpread(still);
    const walking = computeSpread({ ...still, moveLerp: 1 });
    expect(walking).toBeGreaterThanOrEqual(standing * 3);
  });

  test('crouch-walk is the most accurate mobile stance', () => {
    // The comment in accuracy.js claims crouch both lowers the base cone AND
    // halves the movement penalty. If either half regressed, crouch-walking
    // would stop beating standing-walk.
    const standWalk = computeSpread({ ...still, moveLerp: 1 });
    const crouchWalk = computeSpread({ ...still, moveLerp: 1, crouchLerp: 1 });
    expect(crouchWalk).toBeLessThan(standWalk);
  });

  test('sprinting is worse than walking', () => {
    const walking = computeSpread({ ...still, moveLerp: 1 });
    const sprinting = computeSpread({ ...still, moveLerp: 1.5 });
    expect(sprinting).toBeGreaterThan(walking);
  });
});

describe('computeSpread — ADS and bloom', () => {
  test('ADS scales the whole cone by the weapon spreadMul', () => {
    const hip = computeSpread({ ...still, moveLerp: 1 });
    const rifle = WEAPONS[0];
    const ads = computeSpread({ ...still, moveLerp: 1, adsMul: rifle.spreadMul });
    expect(ads).toBeCloseTo(hip * rifle.spreadMul, 10);
  });

  test('a scoped sniper is tighter than rifle iron sights', () => {
    const [rifle, sniper] = WEAPONS;
    expect(computeSpread({ ...still, adsMul: sniper.spreadMul }))
      .toBeLessThan(computeSpread({ ...still, adsMul: rifle.spreadMul }));
  });

  test('bloom adds directly to the cone', () => {
    const base = computeSpread(still);
    expect(computeSpread({ ...still, bloom: 0.02 })).toBeCloseTo(base + 0.02, 10);
  });

  test('the floor clamps a perfectly still scoped shot', () => {
    // sniper spreadMul 0.05 x base 0.0025 = 0.000125, below the floor
    expect(computeSpread({ ...still, adsMul: 0.05 })).toBe(MIN_SPREAD);
  });
});

describe('crosshairGapPx', () => {
  test('a wider cone pushes the arms further out', () => {
    expect(crosshairGapPx(0.02, 75, 720)).toBeGreaterThan(crosshairGapPx(0.002, 75, 720));
  });

  test('zooming in widens the on-screen gap for the same cone', () => {
    // Same bullet scatter subtends more pixels at a narrower FOV — this is
    // why the gap has to be computed from the LIVE fov, not the base one.
    expect(crosshairGapPx(0.01, 25, 720)).toBeGreaterThan(crosshairGapPx(0.01, 75, 720));
  });

  test('caps so a full spray cannot push the arms offscreen', () => {
    expect(crosshairGapPx(1.0, 6.25, 720)).toBe(MAX_GAP_PX);
  });
});
