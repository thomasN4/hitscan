// sim/accuracy.js — the shot-cone model, as pure functions.
//
// Pure: no imports from engine.js, no DOM, no reads of shared state. Every
// input is a parameter, so this file is unit-testable in plain Node and
// converts to TypeScript without restructuring.
//
// totalSpread = (stance base + movement penalty + recoil bloom) × ADS
//   stance base: crouching cuts it ~72% AND halves the movement penalty,
//                making crouch-walk the most accurate mobile stance
//   movement:    moveLerp is MEASURED speed ÷ walk (see player.js)
//   ADS:         the weapon's spreadMul — 30% for the rifle's iron sights,
//                5% for a scoped sniper shot
//
// The value this returns is consumed by BOTH the bullet direction
// (weapons.js:shoot) and the crosshair gap (crosshairGapPx below), which is
// what keeps the reticle honest about where bullets can land.

/** Standing, still, hip-fire cone (radians). */
export const STANCE_BASE = 0.0025;
/** How much of STANCE_BASE a full crouch removes (0.0025 → 0.0007). */
export const CROUCH_BONUS = 0.0018;
/** Cone added at full walk speed (moveLerp = 1) while standing. */
export const MOVE_PENALTY = 0.010;
/** Fraction of the movement penalty a full crouch removes. */
export const CROUCH_MOVE_RELIEF = 0.5;
/** Floor: even a perfectly still scoped shot keeps this much cone. */
export const MIN_SPREAD = 0.0005;

/**
 * Total shot cone in radians (full angle, not half).
 *
 * @param {object} p
 * @param {number} p.crouchLerp 0..1 smoothed crouch blend
 * @param {number} p.moveLerp   measured speed ÷ walk speed (0 idle, 1 walk, 1.5 sprint)
 * @param {number} p.bloom      accumulated per-shot recoil bloom (radians)
 * @param {number} p.adsMul     1 when hip-firing, else the weapon's spreadMul
 * @returns {number} cone in radians, never below MIN_SPREAD
 */
export function computeSpread({ crouchLerp, moveLerp, bloom, adsMul }) {
  const stanceBase = STANCE_BASE - CROUCH_BONUS * crouchLerp;
  const movePenalty = MOVE_PENALTY * moveLerp * (1 - CROUCH_MOVE_RELIEF * crouchLerp);
  return Math.max(MIN_SPREAD, (stanceBase + movePenalty + bloom) * adsMul);
}

/** Smallest crosshair half-gap in px, so the arms never collapse onto the dot. */
export const MIN_GAP_PX = 3;
/** Largest crosshair half-gap in px, so a full spray doesn't push arms offscreen. */
export const MAX_GAP_PX = 60;

/**
 * Project a shot cone onto the screen as a crosshair half-gap in pixels.
 *
 * The arms sit at the EDGE of the actual scatter cone (per-axis half-angle
 * ≈ spread/2), so the gap tracks where bullets can land at the live FOV —
 * hip-fire or scoped. The mean impact point is screen center itself, via
 * aimPitch() in sim/recoil.js.
 *
 * @param {number} spread cone in radians, from computeSpread
 * @param {number} fovDeg live vertical camera FOV in degrees
 * @param {number} viewportHeight px
 */
export function crosshairGapPx(spread, fovDeg, viewportHeight) {
  const pxPerTan = viewportHeight / 2 / Math.tan(fovDeg * Math.PI / 360);
  return Math.min(MIN_GAP_PX + Math.tan(spread / 2) * pxPerTan, MAX_GAP_PX);
}
