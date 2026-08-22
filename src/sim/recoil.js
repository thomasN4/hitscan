// sim/recoil.js — recoil accumulation, decay, and the view punch.
//
// Pure: every input is a parameter. See sim/accuracy.js for the rationale.
//
// `recoil` is in abstract "recoil units" (capped at RECOIL_CAP in
// core/state.js), converted to an aim angle only by aimPitch() via the
// weapon's punchRad.

/**
 * Vertical aim angle including the recoil view punch.
 *
 * The camera (player.js:updateCamera) and the shot direction
 * (weapons.js:shoot) must BOTH derive pitch from this function, or the
 * crosshair stops being truthful about where bullets go — that divergence
 * is what shipped as `351f772`/`ed96163`. Keeping it as one pure function
 * with explicit arguments makes the shared call structural.
 *
 * @param {number} pitch    look pitch in radians (game.pitch)
 * @param {number} recoil   accumulated recoil units (game.recoil)
 * @param {number} punchRad radians of climb per recoil unit (per-weapon)
 */
export function aimPitch(pitch, recoil, punchRad) {
  return pitch + recoil * punchRad;
}

/**
 * Decay accumulated recoil toward 0 at `rate` units/second.
 *
 * `rate` MUST stay below the weapon's sustained-fire input
 * (recoilKick ÷ fireRate), or the drain outpaces accumulation and the spray
 * never climbs — it just vibrates. That constraint has been fixed by hand
 * twice (`46900f7`, `b080350`); PR 4's sim/validateWeapons.js will enforce it.
 *
 * @param {number} recoil current recoil units
 * @param {number} dt     frame delta in seconds
 * @param {number} rate   units/second (weapon.recoilRecover)
 * @returns {number} never negative
 */
export function decayRecoil(recoil, dt, rate) {
  return Math.max(0, recoil - dt * rate);
}

/**
 * Decay accumulated spread bloom toward 0 at `rate` radians/second.
 * Same sustained-fire constraint as decayRecoil.
 *
 * @param {number} bloom current bloom in radians
 * @param {number} dt    frame delta in seconds
 * @param {number} rate  radians/second (per-weapon bloomRecover)
 * @returns {number} never negative
 */
export function decayBloom(bloom, dt, rate) {
  return Math.max(0, bloom - dt * rate);
}
