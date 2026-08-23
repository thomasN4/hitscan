// sim/damage.ts — hit-zone resolution and damage multipliers.
//
// Pure: every input is a parameter, and this module has NO RUNTIME imports —
// the single `import type` below is erased, so nothing is pulled into Node at
// import time. Bot parts are compared by identity, so `object` is the honest
// parameter type (real callers pass THREE.Mesh; tests pass bare stand-ins).
//
// Zone multipliers are the game's core balance contract — head ×4 makes the
// smg a one-tap (26 × 4 = 104) and the sniper a guaranteed one
// (60 × 4 = 240); legs ×0.75 punishes low aim. Those design intents are
// pinned against the real WEAPONS table by sim/damage.test.ts.

import type { WeaponDef, HitZone } from '../core/state';

/**
 * Damage multiplier per hit zone. Torso is the ×1 reference. The head entry
 * is deliberately null: headshot damage is PER-WEAPON (weapon.headshotMult),
 * so there is no global multiplier to store here.
 *
 * Typed per-key rather than Record<HitZone, number | null> so that
 * damageForPart's narrowed 'torso' | 'legs' index stays a plain number.
 */
export const ZONE_MULTIPLIERS: {
  head: null;
  torso: number;
  legs: number;
} = {
  head: null, // per-weapon: weapon.headshotMult
  torso: 1,
  legs: 0.75,
};

/** Live stats damageForPart reads off either WEAPONS or the live `weapon`. */
export type DamageStats = Pick<WeaponDef, 'damage' | 'headshotMult'>;

/**
 * Which zone a raycast mesh belongs to.
 *
 * Bot parts are separate meshes precisely so a hitscan can tell them apart;
 * each is stamped with `userData.bot` in the Bot constructor.
 *
 * @param bot object with at least the head/legs part meshes (torso is unused)
 * @param mesh the intersected object
 * @returns torso is the fallback
 */
export function partForMesh(bot: { head: object; legs: object }, mesh: object): HitZone {
  if (mesh === bot.head) return 'head';
  if (mesh === bot.legs) return 'legs';
  return 'torso';
}

/**
 * Damage one hit deals, before the target's own resistances (there are none
 * today).
 */
export function damageForPart(weapon: DamageStats, part: HitZone): number {
  if (part === 'head') return weapon.damage * weapon.headshotMult;
  return weapon.damage * ZONE_MULTIPLIERS[part];
}
