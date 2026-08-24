import { describe, expect, test } from 'vitest';
import { isLowAmmo } from './ammo';
import { WEAPONS } from '../core/state';

describe('isLowAmmo', () => {
  test('a FULL mag is never low — the issue #10 regression', () => {
    for (const w of WEAPONS) {
      expect(isLowAmmo(w.magSize, w.magSize)).toBe(false);
    }
  });

  test('empty mag is always low', () => {
    for (const w of WEAPONS) {
      expect(isLowAmmo(0, w.magSize)).toBe(true);
    }
  });

  test('smg threshold stays at its historical 10', () => {
    expect(isLowAmmo(10, WEAPONS[0].magSize)).toBe(true);
    expect(isLowAmmo(11, WEAPONS[0].magSize)).toBe(false);
  });

  test('sniper prompts below a third of its 10-round mag (floor → <=3)', () => {
    expect(isLowAmmo(3, WEAPONS[1].magSize)).toBe(true);
    expect(isLowAmmo(4, WEAPONS[1].magSize)).toBe(false);
  });
});
