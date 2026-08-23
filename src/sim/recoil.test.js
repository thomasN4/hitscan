import { describe, expect, test } from 'vitest';
import { aimPitch, aimYaw, decayRecoil, decaySpray, decayToward } from './recoil.js';
import { WEAPONS, RECOIL_CAP, RECOIL_YAW_CAP } from '../core/state.js';

describe('aimPitch', () => {
  test('at rest is exactly the look pitch', () => {
    expect(aimPitch(0.3, 0, 0.012)).toBe(0.3);
  });

  test('climbs by punchRad per recoil unit', () => {
    expect(aimPitch(0, 3, 0.012)).toBeCloseTo(0.036, 12);
  });

  test('a full smg spray climbs to roughly 4 degrees', () => {
    const deg = aimPitch(0, RECOIL_CAP, WEAPONS[0].punchRad) * 180 / Math.PI;
    expect(deg).toBeGreaterThan(3.5);
    expect(deg).toBeLessThan(4.5);
  });

  test('one sniper shot kicks roughly 4.6 degrees', () => {
    const sniper = WEAPONS[1];
    const deg = aimPitch(0, sniper.recoilKick, sniper.punchRad) * 180 / Math.PI;
    expect(deg).toBeGreaterThan(4.0);
    expect(deg).toBeLessThan(5.2);
  });
});

describe('aimYaw', () => {
  test('at rest is exactly the look yaw', () => {
    expect(aimYaw(1.2, 0, 0.012)).toBe(1.2);
  });

  test('mirrors aimPitch — same punchRad, same units', () => {
    expect(aimYaw(0, 2.5, 0.012)).toBeCloseTo(aimPitch(0, 2.5, 0.012), 12);
  });

  test('is signed, unlike the vertical climb', () => {
    // recoilYaw wanders both ways; recoil only ever accumulates upward.
    expect(aimYaw(0, -2, 0.012)).toBeCloseTo(-0.024, 12);
  });

  test('a maxed-out smg walk stays around 2 degrees of wander', () => {
    const deg = aimYaw(0, RECOIL_YAW_CAP, WEAPONS[0].punchRad) * 180 / Math.PI;
    expect(deg).toBeGreaterThan(1.5);
    expect(deg).toBeLessThan(2.5);
  });
});

describe('decayRecoil', () => {
  test('never goes negative', () => {
    expect(decayRecoil(0.1, 1, 100)).toBe(0);
  });

  test('drains at the given rate', () => {
    expect(decayRecoil(6, 0.5, 6)).toBeCloseTo(3, 12);
  });

  test('the smg clears a full climb in about a second', () => {
    const smg = WEAPONS[0];
    let recoil = RECOIL_CAP;
    let elapsed = 0;
    const dt = 1 / 60;
    while (recoil > 0 && elapsed < 5) {
      recoil = decayRecoil(recoil, dt, smg.recoilRecover);
      elapsed += dt;
    }
    expect(elapsed).toBeGreaterThan(0.8);
    expect(elapsed).toBeLessThan(1.3);
  });
});

describe('decaySpray', () => {
  test('floors at 1, the RESTING multiplier — never 0', () => {
    // Draining below 1 would make sustained fire IMPROVE accuracy.
    expect(decaySpray(1.05, 1, 100)).toBe(1);
    expect(decaySpray(1, 1, 100)).toBe(1);
  });

  test('drains at the given rate', () => {
    expect(decaySpray(3, 1, 0.5)).toBeCloseTo(2.5, 12);
  });

  test('the smg clears a full-mag spray in about four seconds', () => {
    // sprayRecover's tuning note: 30 shots x 0.06 = 1.8 over ~4 s.
    const smg = WEAPONS[0];
    let spray = 1 + 30 * smg.sprayKick;
    let elapsed = 0;
    const dt = 1 / 60;
    while (spray > 1 && elapsed < 10) {
      spray = decaySpray(spray, dt, smg.sprayRecover);
      elapsed += dt;
    }
    expect(elapsed).toBeGreaterThan(3.4);
    expect(elapsed).toBeLessThan(4.6);
  });

  test('a sustained smg spray outruns its own recovery', () => {
    // The invariant two commits fixed by hand: recover must stay under the
    // per-second input, or the spray never accumulates at all.
    const smg = WEAPONS[0];
    expect(smg.sprayRecover).toBeLessThan(smg.sprayKick / smg.fireRate);
  });
});

describe('decayToward', () => {
  test('pulls a positive value down to exactly 0', () => {
    expect(decayToward(0.5, 1, 100)).toBe(0);
  });

  test('pulls a negative value up to exactly 0 — no sign flip', () => {
    // A naive `value - rate*dt` would overshoot into the opposite sign and
    // oscillate; the walk has to settle, not ring.
    expect(decayToward(-0.5, 1, 100)).toBe(0);
  });

  test('drains at the given rate from both sides', () => {
    expect(decayToward(3, 0.5, 2)).toBeCloseTo(2, 12);
    expect(decayToward(-3, 0.5, 2)).toBeCloseTo(-2, 12);
  });

  test('a maxed sniper walk settles in well under a second', () => {
    const sniper = WEAPONS[1];
    let yaw = RECOIL_YAW_CAP;
    let elapsed = 0;
    const dt = 1 / 60;
    while (yaw !== 0 && elapsed < 3) {
      yaw = decayToward(yaw, dt, sniper.recoilRecover);
      elapsed += dt;
    }
    expect(elapsed).toBeLessThan(0.5);
  });
});
