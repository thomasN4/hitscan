import { describe, expect, test } from 'vitest';
import {
  computeSpread, crosshairGapPx,
  MIN_SPREAD, MAX_GAP_FRACTION, AIR_PENALTY, MOVE_EXPONENT,
} from './accuracy';
import { WEAPONS } from '../core/state';

/** Rested, standing, hip-firing, no inherent cone — isolates one term at a time. */
const still = { crouchLerp: 0, moveLerp: 0, airLerp: 0, spray: 1, inherent: 0, adsMul: 1 };

describe('computeSpread — stance', () => {
  test('crouching tightens the cone', () => {
    expect(computeSpread({ ...still, crouchLerp: 1 }))
      .toBeLessThan(computeSpread(still));
  });

  test('walking opens the cone at least 3x over standing still', () => {
    const walking = computeSpread({ ...still, moveLerp: 1 });
    expect(walking).toBeGreaterThanOrEqual(computeSpread(still) * 3);
  });

  test('crouch-walk is the most accurate mobile stance', () => {
    // Crouch both lowers the base cone AND halves the movement penalty; if
    // either half regressed, crouch-walking would stop beating standing-walk.
    expect(computeSpread({ ...still, moveLerp: 1, crouchLerp: 1 }))
      .toBeLessThan(computeSpread({ ...still, moveLerp: 1 }));
  });

  test('the four stances order crouched < standing < walking < airborne', () => {
    const crouched = computeSpread({ ...still, crouchLerp: 1 });
    const standing = computeSpread(still);
    const walking = computeSpread({ ...still, moveLerp: 1 });
    const airborne = computeSpread({ ...still, airLerp: 1 });
    expect(crouched).toBeLessThan(standing);
    expect(standing).toBeLessThan(walking);
    expect(walking).toBeLessThan(airborne);
  });

  test('mid-air is worse than a full sprint, so jump-shooting is never viable', () => {
    expect(computeSpread({ ...still, airLerp: 1 }))
      .toBeGreaterThan(computeSpread({ ...still, moveLerp: 1.5 }));
  });

  test('the air penalty blends rather than snapping in', () => {
    const half = computeSpread({ ...still, airLerp: 0.5 });
    expect(half).toBeGreaterThan(computeSpread(still));
    expect(half).toBeLessThan(computeSpread({ ...still, airLerp: 1 }));
  });
});

describe('computeSpread — movement is cubic', () => {
  test('sprint diverges sharply from walk, not linearly', () => {
    // The whole point of MOVE_EXPONENT: at 1.5x walk speed the movement term
    // is 1.5³ = 3.375x, not 1.5x.
    const walk = computeSpread({ ...still, moveLerp: 1 }) - computeSpread(still);
    const sprint = computeSpread({ ...still, moveLerp: 1.5 }) - computeSpread(still);
    expect(sprint / walk).toBeCloseTo(Math.pow(1.5, MOVE_EXPONENT), 6);
  });

  test('creeping barely costs anything', () => {
    // 0.25³ = 1.6% of the walk penalty — slow strafes stay accurate.
    const creep = computeSpread({ ...still, moveLerp: 0.25 }) - computeSpread(still);
    const walk = computeSpread({ ...still, moveLerp: 1 }) - computeSpread(still);
    expect(creep / walk).toBeLessThan(0.02);
  });
});

describe('computeSpread — spray is a multiplier, not an addend', () => {
  test('rested spray is 1 and adds nothing', () => {
    expect(computeSpread({ ...still, spray: 1 })).toBe(computeSpread(still));
  });

  test('spray scales the situational terms', () => {
    const base = computeSpread(still);
    expect(computeSpread({ ...still, spray: 2 })).toBeCloseTo(base * 2, 12);
  });

  test('spray does NOT inflate the inherent cone', () => {
    // The defining property of the reshape: sustained fire opens the
    // situational cone but never degrades the weapon's own rest accuracy.
    const inherent = 0.003;
    const rested = computeSpread({ ...still, inherent });
    const sprayed = computeSpread({ ...still, inherent, spray: 3 });
    const situational = rested - inherent;
    expect(sprayed).toBeCloseTo(situational * 3 + inherent, 12);
  });

  test('a fully sprayed crouch still beats a rested sprint', () => {
    expect(computeSpread({ ...still, crouchLerp: 1, spray: 4 }))
      .toBeLessThan(computeSpread({ ...still, moveLerp: 1.5 }));
  });
});

describe('computeSpread — inherent cone', () => {
  test('adds directly, unscaled by stance', () => {
    const base = computeSpread(still);
    expect(computeSpread({ ...still, inherent: 0.0031 })).toBeCloseTo(base + 0.0031, 12);
  });

  test('dominates hip-fire, so both weapons are similarly bad from the hip', () => {
    const [smg, sniper] = WEAPONS;
    const hip = def => computeSpread({ ...still, crouchLerp: 1, inherent: def.inherent });
    const ratio = hip(smg) / hip(sniper);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });
});

describe('computeSpread — ADS', () => {
  test('scales the whole cone, inherent included', () => {
    const smg = WEAPONS[0];
    const hip = computeSpread({ ...still, inherent: smg.inherent });
    const ads = computeSpread({ ...still, inherent: smg.inherent, adsMul: smg.spreadMul });
    expect(ads).toBeCloseTo(hip * smg.spreadMul, 12);
  });

  test('a scoped sniper is tighter than smg iron sights', () => {
    const [smg, sniper] = WEAPONS;
    const ads = def => computeSpread({
      ...still, crouchLerp: 1, inherent: def.inherent, adsMul: def.spreadMul,
    });
    expect(ads(sniper)).toBeLessThan(ads(smg));
  });

  test('the floor clamps an absurdly tight shot', () => {
    expect(computeSpread({ ...still, crouchLerp: 1, adsMul: 1e-6 })).toBe(MIN_SPREAD);
  });
});

describe('crosshairGapPx', () => {
  test('is purely proportional — doubling the cone doubles the gap', () => {
    // No additive floor: an earlier version added 3 px, which buried the
    // stance differences under a stance-independent baseline.
    const a = crosshairGapPx(0.002, 75, 800);
    const b = crosshairGapPx(0.004, 75, 800);
    expect(b / a).toBeCloseTo(2, 4);
  });

  test('a wider cone pushes the arms further out', () => {
    expect(crosshairGapPx(0.02, 75, 800)).toBeGreaterThan(crosshairGapPx(0.002, 75, 800));
  });

  test('zooming in widens the gap for the same cone', () => {
    // Same scatter subtends more pixels at a narrower FOV — which is why the
    // gap must be computed from the LIVE fov, not the base one.
    expect(crosshairGapPx(0.01, 25, 800)).toBeGreaterThan(crosshairGapPx(0.01, 75, 800));
  });

  test('saturates rather than pushing arms off screen', () => {
    expect(crosshairGapPx(AIR_PENALTY * 2, 6.25, 800)).toBe(MAX_GAP_FRACTION * 800);
  });

  test('the cap scales with the viewport, so ratios survive a tall screen', () => {
    // An absolute pixel cap clamped a standing sprint and a jump-shot to the
    // same arms at 1080p, hiding a 17% difference in cone.
    const sprint = 0.073, airborne = 0.0855; // standing sprint / mid-air cones
    for (const h of [800, 1000, 1440]) {
      expect(crosshairGapPx(airborne, 75, h)).toBeLessThan(MAX_GAP_FRACTION * h);
      expect(crosshairGapPx(airborne, 75, h))
        .toBeGreaterThan(crosshairGapPx(sprint, 80, h));
    }
  });
});
