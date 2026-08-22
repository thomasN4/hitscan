import { describe, expect, test } from 'vitest';
import { aimPitch, decayRecoil, decayBloom } from './recoil.js';
import { WEAPONS, RECOIL_CAP } from '../core/state.js';

describe('aimPitch', () => {
  test('at rest is exactly the look pitch', () => {
    expect(aimPitch(0.3, 0, 0.012)).toBe(0.3);
  });

  test('climbs by punchRad per recoil unit', () => {
    expect(aimPitch(0, 3, 0.012)).toBeCloseTo(0.036, 12);
  });

  test('a full rifle spray climbs to roughly 4 degrees', () => {
    // The tuning note on RIFLE.punchRad quotes ~4° at the cap.
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

describe('decayRecoil', () => {
  test('never goes negative', () => {
    expect(decayRecoil(0.1, 1, 100)).toBe(0);
  });

  test('drains at the given rate', () => {
    expect(decayRecoil(6, 0.5, 6)).toBeCloseTo(3, 12);
  });

  test('the rifle clears a full climb in about a second', () => {
    // RIFLE.recoilRecover is documented as "~1 s settle-back" from the cap.
    const rifle = WEAPONS[0];
    let recoil = RECOIL_CAP;
    let elapsed = 0;
    const dt = 1 / 60;
    while (recoil > 0 && elapsed < 5) {
      recoil = decayRecoil(recoil, dt, rifle.recoilRecover);
      elapsed += dt;
    }
    expect(elapsed).toBeGreaterThan(0.8);
    expect(elapsed).toBeLessThan(1.3);
  });
});

describe('decayBloom', () => {
  test('never goes negative', () => {
    expect(decayBloom(0.001, 1, 10)).toBe(0);
  });

  test('the rifle clears full bloom in about two seconds', () => {
    // RIFLE.bloomRecover is documented as "clears full bloom ~2 s".
    const rifle = WEAPONS[0];
    let bloom = 0.25;
    let elapsed = 0;
    const dt = 1 / 60;
    while (bloom > 0 && elapsed < 6) {
      bloom = decayBloom(bloom, dt, rifle.bloomRecover);
      elapsed += dt;
    }
    expect(elapsed).toBeGreaterThan(1.5);
    expect(elapsed).toBeLessThan(2.5);
  });
});
