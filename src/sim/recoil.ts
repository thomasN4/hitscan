// sim/recoil.ts — recoil accumulation, decay, and the view punch.
//
// Pure: every input is a parameter. See sim/accuracy.ts for the rationale.
//
// `recoil` is in abstract "recoil units" (capped at RECOIL_CAP in
// core/state.ts), converted to an aim angle only by aimPitch() via the
// weapon's punchRad.

/**
 * Vertical aim angle including the recoil view punch.
 *
 * The camera (player.js:updateCamera) and the shot direction
 * (weapons.js:shoot) must BOTH derive pitch from this function, or the
 * crosshair stops being truthful about where bullets go — that divergence
 * is what shipped as `351f772`/`ed96163`. Keeping it as one pure function
 * with explicit arguments makes the shared call structural.
 */
export function aimPitch(pitch: number, recoil: number, punchRad: number): number {
  return pitch + recoil * punchRad;
}

/**
 * Horizontal counterpart of aimPitch(): base yaw plus the signed horizontal
 * recoil walk, converted to an angle by the same per-weapon punchRad.
 *
 * Same consumer contract as aimPitch — the camera and the shot direction must
 * both go through it, so screen center stays truthful horizontally as well as
 * vertically. Movement and mouse input deliberately stay on the BASE yaw: the
 * view punch must not steer the player's legs or fight the mouse.
 */
export function aimYaw(yaw: number, recoilYaw: number, punchRad: number): number {
  return yaw + recoilYaw * punchRad;
}

/**
 * Decay accumulated recoil toward 0 at `rate` units/second.
 *
 * `rate` MUST stay below the weapon's sustained-fire input
 * (recoilKick ÷ fireRate), or the drain outpaces accumulation and the spray
 * never climbs — it just vibrates. That constraint has been fixed by hand
 * twice (`46900f7`, `b080350`) and enforced by sim/validateWeapons.ts.
 *
 * @param recoil current recoil units
 * @param dt     frame delta in seconds
 * @param rate   units/second (weapon.recoilRecover)
 * @returns never negative
 */
export function decayRecoil(recoil: number, dt: number, rate: number): number {
  return Math.max(0, recoil - dt * rate);
}

/**
 * Decay the spray cone multiplier back toward its RESTING value of 1.
 *
 * Note the floor is 1, not 0: spray multiplies the situational spread terms,
 * so 1 means "no extra cone". Draining below it would make sustained fire
 * IMPROVE accuracy.
 *
 * Same sustained-fire constraint as decayRecoil: `rate` must stay below
 * sprayKick ÷ fireRate or sprays never bloom at all.
 *
 * @param spray current multiplier (>= 1)
 * @param dt    frame delta in seconds
 * @param rate  multiplier units/second (per-weapon sprayRecover)
 * @returns never below 1
 */
export function decaySpray(spray: number, dt: number, rate: number): number {
  return Math.max(1, spray - dt * rate);
}

/**
 * Decay a SIGNED value toward 0 at `rate` units/second, from either side.
 *
 * Used for the horizontal recoil walk, which swings both ways — unlike
 * decayRecoil, whose input is always non-negative so a plain clamp at 0 works.
 * Overshoot lands exactly on 0 rather than crossing into the opposite sign and
 * oscillating.
 *
 * Sustained-fire constraint, and it is NOT the one on decayRecoil/decaySpray:
 * the walk is mean-zero, so what matters is the drain per shot interval against
 * the MEAN kick — `rate × fireRate` must stay below `yawKick / 2`. Sizing it
 * against the vertical climb instead (rate = recoilRecover) returns the walk to
 * exactly 0 before every shot, so bullets never leave off-centre and only the
 * camera twitches. That is how horizontal recoil first shipped.
 */
export function decayToward(value: number, dt: number, rate: number): number {
  const step = dt * rate;
  return Math.abs(value) <= step ? 0 : value - Math.sign(value) * step;
}
