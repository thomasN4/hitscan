// sim/damage.js — hit-zone resolution and damage multipliers.
//
// Pure: every input is a parameter.
//
// Zone multipliers are the game's core balance contract — head ×4 makes the
// rifle a one-tap (26 × 4 = 104) and the sniper a guaranteed one
// (60 × 4 = 240); legs ×0.75 punishes low aim. sim/validateWeapons.js pins
// those design intents against the real WEAPONS table.

/** Damage multiplier per hit zone. Torso is the ×1 reference. */
export const ZONE_MULTIPLIERS = {
  head: null, // per-weapon: weapon.headshotMult
  torso: 1,
  legs: 0.75,
};

/**
 * Which zone a raycast mesh belongs to.
 *
 * Bot parts are separate meshes precisely so a hitscan can tell them apart;
 * each is stamped with `userData.bot` in the Bot constructor.
 *
 * @param {{head: object, torso: object, legs: object}} bot
 * @param {object} mesh the intersected object
 * @returns {'head'|'torso'|'legs'} torso is the fallback
 */
export function partForMesh(bot, mesh) {
  if (mesh === bot.head) return 'head';
  if (mesh === bot.legs) return 'legs';
  return 'torso';
}

/**
 * Damage one hit deals, before the target's own resistances (there are none
 * today).
 *
 * @param {{damage: number, headshotMult: number}} weapon live weapon stats
 * @param {'head'|'torso'|'legs'} part
 */
export function damageForPart(weapon, part) {
  if (part === 'head') return weapon.damage * weapon.headshotMult;
  return weapon.damage * ZONE_MULTIPLIERS[part];
}
