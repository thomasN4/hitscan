import { describe, expect, test } from 'vitest';
import { DAMAGE_NUMBER_LIFE, damageNumberFrame } from './damageNumbers';

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
