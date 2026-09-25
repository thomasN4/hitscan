// sim/damageNumbers.ts — how a damage number moves, fades and is coloured.
//
// Pure: hud.ts owns the DOM layer and the projection of each popup's world
// impact point; this only decides, from a popup's age in game seconds, how far
// it has risen, how opaque it is and how big it is drawn — and, from what the
// hit dealt against the weapon's own damage span, where it sits on the
// yellow-to-red ramp.

import type { WeaponDef } from '../core/state';
import { ZONE_MULTIPLIERS } from './damage';
import { BOW_MIN_RELEASE } from './bow';

/** Seconds a damage number stays on screen. */
export const DAMAGE_NUMBER_LIFE = 0.9;
/** Seconds of the opening pop, oversized and settling to its rest scale. */
const POP = 0.08;
/** Seconds held fully opaque before the fade begins. */
const HOLD = 0.35;
/** Screen pixels the number rises over its whole life. */
const RISE_PX = 40;

export interface DamageNumberFrame {
  /** Pixels above the projected impact point. */
  rise: number;
  opacity: number;
  scale: number;
}

/** The popup's look at `age` seconds, or null before it is born and once it has expired. */
export function damageNumberFrame(age: number): DamageNumberFrame | null {
  if (!(age >= 0 && age < DAMAGE_NUMBER_LIFE)) return null;
  const t = age / DAMAGE_NUMBER_LIFE;
  return {
    rise: RISE_PX * (1 - (1 - t) * (1 - t)), // ease-out: quick lift, slow drift
    opacity: age <= HOLD ? 1 : 1 - (age - HOLD) / (DAMAGE_NUMBER_LIFE - HOLD),
    scale: age < POP ? 1.35 - 0.35 * (age / POP) : 1,
  };
}

// ---------- Colour ----------

/** The least and most one popup can read for a weapon; see damageSpan. */
export interface DamageSpan {
  min: number;
  max: number;
}

/**
 * The range a weapon's damage numbers are coloured across. One popup is one
 * trigger pull's total on one victim (weapons.ts sums a blast's pellets), so
 * `min` is the weakest connecting hit — a leg, at the bow's least loosing draw
 * or a stroke's sweet-spot floor — and `max` the best trigger pull there is:
 * every pellet in the head, from behind. Melee weapons take both strokes.
 */
export function damageSpan(def: WeaponDef): DamageSpan {
  const strokes = [{ damage: def.damage, floor: def.sweetSpot?.floor ?? 1 }];
  if (def.altAttack) strokes.push({ damage: def.altAttack.damage, floor: def.altAttack.sweetSpot?.floor ?? 1 });
  // A bow's weakest arrow is the least draw that still looses one (drag can
  // take a long shot lower still; damageHeat clamps it).
  const weakest = def.drawTime !== undefined ? BOW_MIN_RELEASE : 1;
  const best = Math.max(def.headshotMult, 1) * (def.pellets ?? 1) * (def.backstabMult ?? 1);
  return {
    min: Math.min(...strokes.map(s => s.damage * s.floor)) * weakest * ZONE_MULTIPLIERS.legs,
    max: Math.max(...strokes.map(s => s.damage)) * best,
  };
}

/** Where `amount` sits in `span`: 0 at its weakest, 1 at its strongest, clamped. */
export function damageHeat(amount: number, span: DamageSpan): number {
  if (!(span.max > span.min)) return 1;
  return Math.min(1, Math.max(0, (amount - span.min) / (span.max - span.min)));
}

/** The ramp's ends. Red stays full across it, so the midpoint is orange rather than brown. */
const COLD = [255, 225, 50] as const;
const HOT = [255, 45, 35] as const;

/** CSS colour for a popup at `heat` (0..1): yellow through orange to red. */
export function damageNumberColor(heat: number): string {
  const t = Math.min(1, Math.max(0, heat));
  const mix = (i: 0 | 1 | 2): number => Math.round(COLD[i] + (HOT[i] - COLD[i]) * t);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}
