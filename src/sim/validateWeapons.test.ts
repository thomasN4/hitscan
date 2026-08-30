import { describe, expect, test } from 'vitest';
import { validateWeapons } from './validateWeapons';
import { WEAPONS, RECOIL_CAP, type WeaponDef } from '../core/state';

const SMG = WEAPONS.smg;
const SNIPER = WEAPONS.sniper;
const KNIFE = WEAPONS.knife;

/** The numeric fields — exactly the ones a NaN can poison. */
type NumericField = {
  [K in keyof WeaponDef]-?: WeaponDef[K] extends number ? K : never;
}[keyof WeaponDef];

/** Clone a weapon def with mutations — the base for every synthetic case. */
function tuned(muts: Partial<WeaponDef>, base: WeaponDef = SMG): WeaponDef {
  return { ...base, ...muts };
}

/** Clone a weapon def with one numeric field poisoned. */
function tunedNumeric(field: NumericField, value: number, base: WeaponDef = SMG): WeaponDef {
  return tuned({ [field]: value }, base);
}

/** Violations that mention EVERY needle (weapon and field names). */
function matching(defs: readonly WeaponDef[], ...needles: string[]): string[] {
  return validateWeapons(defs).filter(m => needles.every(s => m.includes(s)));
}

describe('the shipped table', () => {
  test('produces zero violations', () => {
    // The hard gate: any retune that breaks an invariant fails npm test.
    // The sniper's over-drain passes BECAUSE of the semiAuto exemption —
    // see the live-branch tests below.
    expect(validateWeapons(Object.values(WEAPONS))).toEqual([]);
  });
});

describe('sustained-fire bounds', () => {
  test('vertical recoil at/above the per-second input is flagged', () => {
    // smg input = 1 kick / 0.075 s ≈ 13.3/s (800 RPM)
    expect(matching([tuned({ recoilRecover: 14 })], 'SMG', 'recoilRecover')).toHaveLength(1);
  });

  test('spray applies to EVERY weapon, semiAuto included', () => {
    expect(matching([tuned({ sprayRecover: 0.9 })], 'SMG', 'sprayRecover')).toHaveLength(1); // input = 0.06/0.075 = 0.8/s
    expect(matching([tuned({ sprayRecover: 0.3 }, SNIPER)], 'SNIPER', 'sprayRecover')).toHaveLength(1); // input ≈ 0.227/s
  });

  test('horizontal yaw is sized against the MEAN kick, not the max', () => {
    // 3 × 0.075 = 0.225 ≥ yawKick/2 = 0.2 — the drain per shot interval beats
    // the average kick even though it never beats the full one.
    expect(matching([tuned({ yawRecover: 3 })], 'SMG', 'yawRecover')).toHaveLength(1);
  });
});

describe('NaN cannot slip through any bound', () => {
  // Every bound must test its valid case under a negation; a NaN constant
  // compares false against everything and would silently pass a direct
  // broken-case check.
  test.each<NumericField>([
    'recoilRecover',
    'recoilKick',
    'yawRecover',
    'sprayRecover',
  ])('%s = NaN is flagged', field => {
    expect(matching([tunedNumeric(field, NaN)], field)).toHaveLength(1);
  });

  test('a NaN sprayKick surfaces as the spray rule input figure', () => {
    expect(matching([tunedNumeric('sprayKick', NaN)], 'sprayRecover')).toHaveLength(1);
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

  test.each<[NumericField, number]>([
    ['magSize', 0],
    ['reserveMax', -1],
    ['fireRate', 0],
    ['reloadTime', 0],
    ['damage', 0],
    ['headshotMult', 0.99],
  ])('%s out of range is flagged by name', (field, value) => {
    expect(matching([tunedNumeric(field, value)], 'SMG', field)).toHaveLength(1);
  });

  test('scopeGate outside (0, RECOIL_CAP) is flagged', () => {
    expect(matching([tuned({ scopeGate: RECOIL_CAP }, SNIPER)], 'SNIPER', 'scopeGate')).toHaveLength(1); // never opens
    expect(matching([tuned({ scopeGate: 0 }, SNIPER)], 'SNIPER', 'scopeGate')).toHaveLength(1);         // never blocks
  });

  test('punchRad climbing past ~10° over the cap is flagged', () => {
    // 0.03 rad × 6 units ≈ 10.3°
    expect(matching([tuned({ punchRad: 0.03 })], 'SMG', 'punchRad')).toHaveLength(1);
  });

  test('pellets and pelletCone: present means positive, cone needs pellets', () => {
    const SHOTGUN = WEAPONS.shotgun;
    expect(matching([tuned({ pellets: 0 }, SHOTGUN)], 'SHOTGUN', 'pellets')).toHaveLength(1);
    expect(matching([tuned({ pelletCone: 0 }, SHOTGUN)], 'SHOTGUN', 'pelletCone')).toHaveLength(1);
    // A fixed pattern on a single-ray weapon does nothing — flag the dead field.
    expect(matching([tuned({ pelletCone: 0.02, pellets: undefined }, SHOTGUN)], 'SHOTGUN', 'pelletCone')).toHaveLength(1);
  });

  test('crosshairGain: absent passes, below 1 (NaN included) is flagged', () => {
    // The shotgun's shipped override is 1 and clears the table gate above;
    // anything under 1 would put the arms inside the true scatter.
    expect(matching([tuned({ crosshairGain: 0.5 })], 'crosshairGain')).toHaveLength(1);
    expect(matching([tuned({ crosshairGain: NaN })], 'crosshairGain')).toHaveLength(1);
    expect(matching([tuned({ crosshairGain: 1 })], 'crosshairGain')).toHaveLength(0);
  });
});

describe('melee weapons', () => {
  test('the shipped knife produces zero violations', () => {
    // The shipped-table gate above already covers the knife via
    // Object.values; this pins the def in isolation so a knife-specific
    // regression names itself instead of hiding among five guns.
    expect(validateWeapons([KNIFE])).toEqual([]);
  });

  test('zero mag/reload is exempt ONLY while melee — flip it off and they flag', () => {
    expect(matching([KNIFE], 'magSize')).toHaveLength(0);
    expect(matching([KNIFE], 'reloadTime')).toHaveLength(0);
    expect(matching([tuned({ melee: false }, KNIFE)], 'KNIFE', 'magSize')).toHaveLength(1);
    expect(matching([tuned({ melee: false }, KNIFE)], 'KNIFE', 'reloadTime')).toHaveLength(1);
  });

  test('reach fields exist exactly when the def swings', () => {
    expect(matching([tuned({ range: undefined }, KNIFE)], 'KNIFE', 'range')).toHaveLength(1);
    expect(matching([tuned({ arcRad: undefined }, KNIFE)], 'KNIFE', 'arcRad')).toHaveLength(1);
    expect(matching([tuned({ range: 0 }, KNIFE)], 'KNIFE', 'range')).toHaveLength(1);
    // Past a half-turn the cone would strike behind the eye.
    expect(matching([tuned({ arcRad: Math.PI + 0.1 }, KNIFE)], 'KNIFE', 'arcRad')).toHaveLength(1);
  });

  test('reach fields on a firearm are a dead field, like pelletCone without pellets', () => {
    expect(matching([tuned({ range: 2 })], 'SMG', 'range/arcRad')).toHaveLength(1);
    expect(matching([tuned({ arcRad: 0.6 })], 'SMG', 'range/arcRad')).toHaveLength(1);
  });

  test('NaN reach cannot slip through the pairing bounds', () => {
    expect(matching([tuned({ range: NaN }, KNIFE)], 'KNIFE', 'range')).toHaveLength(1);
    expect(matching([tuned({ arcRad: NaN }, KNIFE)], 'KNIFE', 'arcRad')).toHaveLength(1);
  });

  test('backstabMult exists exactly when the def swings, finite and >= 1', () => {
    // The shipped knife's x3 passes — pinned in isolation, like the reach
    // fields, so a knife-specific regression names itself.
    expect(matching([KNIFE], 'backstabMult')).toHaveLength(0);
    // Missing on a melee def must be flagged, never silently defaulted.
    expect(matching([tuned({ backstabMult: undefined }, KNIFE)], 'KNIFE', 'backstabMult')).toHaveLength(1);
    expect(matching([tuned({ backstabMult: 0.99 }, KNIFE)], 'KNIFE', 'backstabMult')).toHaveLength(1);
    expect(matching([tuned({ backstabMult: NaN }, KNIFE)], 'KNIFE', 'backstabMult')).toHaveLength(1);
    expect(matching([tuned({ backstabMult: Infinity }, KNIFE)], 'KNIFE', 'backstabMult')).toHaveLength(1);
    // A firearm backstab multiplier is a dead field, like range without melee.
    expect(matching([tuned({ backstabMult: 3 })], 'SMG', 'backstabMult')).toHaveLength(1);
  });
});

describe('a fully valid def', () => {
  test('returns []', () => {
    expect(validateWeapons([{ ...SMG }])).toEqual([]);
  });
});
