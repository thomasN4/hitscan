// sim/damageNumbers.ts — how a damage number moves and fades over its life.
//
// Pure: hud.ts owns the DOM layer and the projection of each popup's world
// impact point; this only decides, from a popup's age in game seconds, how far
// it has risen, how opaque it is and how big it is drawn.

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
