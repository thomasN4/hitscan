// sim/accuracy.js — the shot-cone model, as pure functions.
//
// Pure: no imports from engine.js, no DOM, no reads of shared state. Every
// input is a parameter, so this file is unit-testable in plain Node and
// converts to TypeScript without restructuring.
//
//   totalSpread = ((stance + movement + air) × spray + inherent) × ADS
//
//   stance:    CROUCH_FLOOR crouched, + STAND_EXTRA standing
//   movement:  moveLerp is MEASURED speed ÷ walk (see sim/movement.js), scaled
//              CUBICALLY so sprinting diverges sharply from walking
//   air:       a flat penalty blended by airLerp — mid-air beats even a
//              standing sprint, so jump-shooting is never viable
//   spray:     a cone MULTIPLIER (1 at rest, grown per shot up to the weapon's
//              sprayCap). It scales the situational group only.
//   inherent:  the weapon's resting cone, added AFTER spray so sustained fire
//              never inflates it. This is what makes hip-fire similarly bad on
//              both weapons and what sets the floor an ADS shot can reach.
//   ADS:       the weapon's spreadMul
//
// The value this returns is consumed by BOTH the bullet direction
// (weapons.js:shoot) and the crosshair gap (crosshairGapPx below), so the
// reticle tracks every change in the real cone. It does not draw the cone's
// literal edge: crosshairGapPx exaggerates by CROSSHAIR_GAIN, so bullets land
// well inside the arms. What the shared value buys is that the reticle can
// never disagree with the scatter about DIRECTION or RATIO, only scale.

/** Cone floor at a full crouch, before movement/spray/inherent (radians). */
export const CROUCH_FLOOR = 0.0006;
/** Extra cone added by standing upright, tapering away as crouchLerp → 1. */
export const STAND_EXTRA = 0.0018;
/** Movement cone coefficient, applied to moveLerp³. */
export const MOVE_PENALTY = 0.02;
/** Movement scales with this power of measured speed — cubic separates sprint from walk. */
export const MOVE_EXPONENT = 3;
/** Fraction of the movement penalty a full crouch removes. */
export const CROUCH_MOVE_RELIEF = 0.5;
/** Flat cone while fully airborne — deliberately worse than a standing sprint. */
export const AIR_PENALTY = 0.08;
/** Floor: even a perfectly still scoped shot keeps this much cone. */
export const MIN_SPREAD = 0.00005;

/**
 * Total shot cone in radians (full angle, not half).
 *
 * @param {object} p
 * @param {number} p.crouchLerp 0..1 smoothed crouch blend
 * @param {number} p.moveLerp   measured speed ÷ walk speed (0 idle, 1 walk, 1.5 sprint)
 * @param {number} p.airLerp    0..1 airborne blend
 * @param {number} p.spray      cone multiplier, 1 at rest
 * @param {number} p.inherent   the weapon's resting cone (radians)
 * @param {number} p.adsMul     1 when hip-firing, else the weapon's spreadMul
 * @returns {number} cone in radians, never below MIN_SPREAD
 */
export function computeSpread({ crouchLerp, moveLerp, airLerp, spray, inherent, adsMul }) {
  const stance = CROUCH_FLOOR + STAND_EXTRA * (1 - crouchLerp);
  const movement = MOVE_PENALTY * Math.pow(moveLerp, MOVE_EXPONENT)
    * (1 - CROUCH_MOVE_RELIEF * crouchLerp);
  const air = AIR_PENALTY * airLerp;
  return Math.max(MIN_SPREAD, ((stance + movement + air) * spray + inherent) * adsMul);
}

/**
 * Exaggeration applied when projecting the cone to screen space.
 *
 * 1 would draw the literal cone edge, which is too subtle to read at hip-fire
 * spreads (stance deltas land sub-pixel). 6 scales every state uniformly, so
 * the ratios between stances stay truthful while the differences are visible.
 */
export const CROSSHAIR_GAIN = 6;
/**
 * Largest crosshair half-gap, as a FRACTION of viewport height.
 *
 * Relative because the projection below is: an absolute pixel cap (this was
 * 120 px) saturates at ordinary states on tall viewports — a standing sprint
 * projects ~0.131 h and airborne ~0.167 h, so at 1080p and up both clamped to
 * the same arms despite a 17% difference in cone, defeating the whole reason
 * CROSSHAIR_GAIN scales uniformly. 0.2 leaves every single-cause state
 * unclamped at any viewport size; only compounded sprint+air+spray saturates,
 * and there the arms are off toward the screen edge anyway.
 */
export const MAX_GAP_FRACTION = 0.2;

/**
 * Project a shot cone onto the screen as a crosshair half-gap in pixels.
 *
 * Purely proportional — no additive floor. An earlier version added 3 px,
 * which buried the stance differences under a stance-independent baseline.
 *
 * @param {number} spread cone in radians, from computeSpread
 * @param {number} fovDeg live vertical camera FOV in degrees
 * @param {number} viewportHeight px
 */
export function crosshairGapPx(spread, fovDeg, viewportHeight) {
  const pxPerTan = viewportHeight / 2 / Math.tan(fovDeg * Math.PI / 360);
  return Math.min(Math.tan(spread / 2) * pxPerTan * CROSSHAIR_GAIN,
    MAX_GAP_FRACTION * viewportHeight);
}
