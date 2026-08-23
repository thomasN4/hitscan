import { describe, expect, test } from 'vitest';
import { validateWeapons } from './validateWeapons';
import { WEAPONS, RECOIL_CAP } from '../core/state';

const SMG = WEAPONS[0];
const SNIPER = WEAPONS[1];

/** Clone a weapon def with mutations — the base for every synthetic case. */
function tuned(muts, base = SMG) {
  return { ...base, ...muts };
}

/** Violations that mention EVERY needle (weapon and field names). */
function matching(defs, ...needles) {
  return validateWeapons(defs).filter(m => needles.every(s => m.includes(s)));
}

describe('the shipped table', () => {
  test('produces zero violations', () => {
    // The hard gate: any retune that breaks an invariant fails npm test.
    // The sniper's over-drain passes BECAUSE of the semiAuto exemption —
    // see the live-branch tests below.
    expect(validateWeapons(WEAPONS)).toEqual([]);
  });
});

describe('sustained-fire bounds', () => {
  test('vertical recoil at/above the per-second input is flagged', () => {
    // smg input = 1 kick / 0.105 s ≈ 9.52/s
    expect(matching([tuned({ recoilRecover: 12 })], 'SMG', 'recoilRecover')).toHaveLength(1);
  });

  test('spray applies to EVERY weapon, semiAuto included', () => {
    expect(matching([tuned({ sprayRecover: 0.6 })], 'SMG', 'sprayRecover')).toHaveLength(1);
    expect(matching([tuned({ sprayRecover: 0.3 }, SNIPER)], 'SNIPER', 'sprayRecover')).toHaveLength(1); // input ≈ 0.227/s
  });

  test('horizontal yaw is sized against the MEAN kick, not the max', () => {
    // 2 × 0.105 = 0.21 ≥ yawKick/2 = 0.2 — the drain per shot interval beats
    // the average kick even though it never beats the full one.
    expect(matching([tuned({ yawRecover: 2 })], 'SMG', 'yawRecover')).toHaveLength(1);
  });
});

describe('NaN cannot slip through any bound', () => {
  // Every bound must test its valid case under a negation; a NaN constant
  // compares false against everything and would silently pass a direct
  // broken-case check.
  test.each([
    ['recoilRecover', 'recoilRecover'],
    ['recoilKick', 'recoilKick'],
    ['yawRecover', 'yawRecover'],
    ['sprayRecover', 'sprayRecover'],
    ['sprayKick', 'sprayRecover'], // a NaN kick surfaces as the spray rule's input figure
  ])('%s = NaN is flagged', (field, needle) => {
    expect(matching([tuned({ [field]: NaN })], needle)).toHaveLength(1);
  });

  test('scopeGate = NaN is flagged', () => {
    expect(matching([tuned({ scopeGate: NaN }, SNIPER)], 'SNIPER', 'scopeGate')).toHaveLength(1);
  });

  test('zero recoilKick on an exempted semiAuto weapon is still flagged', () => {
    // The sustained-fire rules skip semiAuto weapons; the static kick floor
    // must not.
    expect(matching([tuned({ recoilKick: 0 }, SNIPER)], 'SNIPER', 'recoilKick')).toHaveLength(1);
  });
});

describe('the semiAuto exemption is a live branch, not a disabled rule', () => {
  test('a full-auto clone of the sniper IS flagged on both rates', () => {
    const fullAutoSniper = tuned({ semiAuto: false }, SNIPER);
    expect(matching([fullAutoSniper], 'SNIPER', 'recoilRecover')).toHaveLength(1);
    expect(matching([fullAutoSniper], 'SNIPER', 'yawRecover')).toHaveLength(1);
  });

  test('and those violations vanish for the sniper itself', () => {
    const msgs = validateWeapons([SNIPER])
      .filter(m => m.includes('recoilRecover') || m.includes('yawRecover'));
    expect(msgs).toEqual([]);
  });
});

describe('static bounds', () => {
  test('sprayCap at the rested multiplier is flagged', () => {
    expect(matching([tuned({ sprayCap: 1 })], 'SMG', 'sprayCap')).toHaveLength(1);
  });

  test('zero inherent cone is flagged', () => {
    expect(matching([tuned({ inherent: 0 })], 'SMG', 'inherent')).toHaveLength(1);
  });

  test('zero yawKick is flagged', () => {
    expect(matching([tuned({ yawKick: 0 })], 'SMG', 'yawKick')).toHaveLength(1);
  });

  test('zoomFovs: empty, flat, and hip-width steps are each flagged', () => {
    expect(validateWeapons([tuned({ zoomFovs: [] })])).toHaveLength(1);
    expect(matching([tuned({ zoomFovs: [55, 55] })], 'zoomFovs')).toHaveLength(1);
    expect(matching([tuned({ zoomFovs: [75] })], 'zoomFovs')).toHaveLength(1); // BASE_FOV itself
  });

  test.each([
    ['magSize', 0],
    ['reserveMax', -1],
    ['fireRate', 0],
    ['reloadTime', 0],
    ['damage', 0],
    ['headshotMult', 0.99],
  ])('%s out of range is flagged by name', (field, value) => {
    expect(matching([tuned({ [field]: value })], 'SMG', field)).toHaveLength(1);
  });

  test('scopeGate outside (0, RECOIL_CAP) is flagged', () => {
    expect(matching([tuned({ scopeGate: RECOIL_CAP }, SNIPER)], 'SNIPER', 'scopeGate')).toHaveLength(1); // never opens
    expect(matching([tuned({ scopeGate: 0 }, SNIPER)], 'SNIPER', 'scopeGate')).toHaveLength(1);         // never blocks
  });

  test('punchRad climbing past ~10° over the cap is flagged', () => {
    // 0.03 rad × 6 units ≈ 10.3°
    expect(matching([tuned({ punchRad: 0.03 })], 'SMG', 'punchRad')).toHaveLength(1);
  });
});

describe('a fully valid def', () => {
  test('returns []', () => {
    expect(validateWeapons([{ ...SMG }])).toEqual([]);
  });
});
