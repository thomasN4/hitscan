import { describe, expect, test } from 'vitest';
import { DAMAGE_NUMBER_LIFE, damageHeat, damageNumberColor, damageNumberFrame, damageSpan } from './damageNumbers';
import { WEAPONS } from '../core/state';

describe('damageNumberFrame', () => {
  test('pops in oversized, rises, holds, then fades out', () => {
    const born = damageNumberFrame(0);
    expect(born).toEqual({ rise: 0, opacity: 1, scale: 1.35 });
    expect(damageNumberFrame(0.1)?.scale).toBe(1);
    expect(damageNumberFrame(0.3)?.opacity).toBe(1);
    const late = damageNumberFrame(0.8);
    expect(late?.opacity).toBeGreaterThan(0);
    expect(late?.opacity).toBeLessThan(0.25);
  });

  test('the rise never falls back', () => {
    let last = -1;
    for (let age = 0; age < DAMAGE_NUMBER_LIFE; age += 0.01) {
      const rise = damageNumberFrame(age)?.rise ?? NaN;
      expect(rise).toBeGreaterThanOrEqual(last);
      last = rise;
    }
    expect(last).toBeLessThanOrEqual(40);
  });

  test('nothing before birth, nothing once expired', () => {
    expect(damageNumberFrame(-0.01)).toBeNull();
    expect(damageNumberFrame(DAMAGE_NUMBER_LIFE)).toBeNull();
    expect(damageNumberFrame(NaN)).toBeNull();
  });
});

describe('damageSpan', () => {
  test('a firearm runs from a leg hit to a headshot', () => {
    expect(damageSpan(WEAPONS.smg)).toEqual({ min: 19.5, max: 52 });
  });

  test('a shotgun tops out at every pellet in the head', () => {
    expect(damageSpan(WEAPONS.shotgun)).toEqual({ min: 9.75, max: 416 });
  });

  test('the bow floors at its least loosing draw', () => {
    const span = damageSpan(WEAPONS.longbow);
    expect(span.min).toBeCloseTo(12);
    expect(span.max).toBe(240);
  });

  test('blades reach their backstab; the sword spans every stroke, its sweet-spot floors and its least charge', () => {
    expect(damageSpan(WEAPONS.knife)).toEqual({ min: 41.25, max: 165 });
    const sword = damageSpan(WEAPONS.armingSword);
    // RMB slash at its sweet-spot floor, released at its 0.3 minimum charge
    // (0.4 + 0.6 x 0.3 of its damage), in a leg — below even a tapped thrust.
    expect(sword.min).toBeCloseTo(60 * 0.35 * 0.58 * 0.75);
    expect(sword.max).toBe(200); // the full overhead cut from behind
  });

  test('every weapon has a non-empty span', () => {
    for (const def of Object.values(WEAPONS)) {
      const { min, max } = damageSpan(def);
      expect(min).toBeGreaterThan(0);
      expect(max).toBeGreaterThan(min);
    }
  });
});

describe('damageHeat', () => {
  const span = { min: 20, max: 60 };
  test('0 at the weakest, 1 at the strongest, clamped past either end', () => {
    expect(damageHeat(20, span)).toBe(0);
    expect(damageHeat(40, span)).toBe(0.5);
    expect(damageHeat(60, span)).toBe(1);
    expect(damageHeat(5, span)).toBe(0);
    expect(damageHeat(500, span)).toBe(1);
  });

  test('a degenerate span reads as full heat', () => {
    expect(damageHeat(30, { min: 30, max: 30 })).toBe(1);
  });
});

describe('damageNumberColor', () => {
  test('yellow when cold, red when hot, clamped', () => {
    expect(damageNumberColor(0)).toBe('rgb(255, 225, 50)');
    expect(damageNumberColor(1)).toBe('rgb(255, 45, 35)');
    expect(damageNumberColor(-1)).toBe(damageNumberColor(0));
    expect(damageNumberColor(2)).toBe(damageNumberColor(1));
  });

  test('green falls steadily as heat rises', () => {
    const green = (heat: number): number => Number(/rgb\(\d+, (\d+)/.exec(damageNumberColor(heat))?.[1]);
    let last = Infinity;
    for (let heat = 0; heat <= 1; heat += 0.05) {
      expect(green(heat)).toBeLessThanOrEqual(last);
      last = green(heat);
    }
  });
});
