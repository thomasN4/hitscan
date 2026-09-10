// sim/recoil.ts — recoil accumulation, decay, and the view punch.
//
// Pure: every input is a parameter. See sim/accuracy.ts for the rationale.
//
// `recoil` is in abstract "recoil units" (capped at RECOIL_CAP in
// core/state.ts), converted to an aim angle only by aimPitch() via the
// weapon's punchRad. Because the units are weapon-RELATIVE in exactly that
// way, changing weapons has to rescale them — convertOnSwap() below.

/**
 * Vertical aim angle including the recoil view punch.
 *
 * The camera (player.ts:updateCamera) and the shot direction
 * (weapons.ts:shoot) must BOTH derive pitch from this function, or the
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
 * Recoil signal used only by the first-person weapon model.
 *
 * A weapon's first kick stays linear so semi-automatic shots and the knife
 * lunge keep their existing feel. Accumulated recoil beyond that kick eases
 * toward twice the one-shot value instead of letting a sustained burst carry
 * the model progressively farther from the crosshair. The value still falls
 * for every decrease in raw recoil, so releasing fire starts the visual return
 * immediately rather than holding at a hard cap.
 *
 * Gameplay aim deliberately does NOT use this mapping: aimPitch/aimYaw keep
 * consuming raw recoil so the camera, bullets and screen-centre crosshair stay
 * aligned with the existing recoil model.
 */
export function viewmodelRecoil(recoil: number, recoilKick: number): number {
  if (recoil <= recoilKick) return recoil;
  const excess = recoil - recoilKick;
  return recoilKick + recoilKick * (1 - Math.exp(-excess / recoilKick));
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

/** The weapon-relative state a swap has to carry across. */
export interface SwapState {
  recoil: number;
  recoilYaw: number;
  spray: number;
}

/**
 * Convert recoil/spray state onto an incoming weapon's terms, for a swap
 * whose deploy window (sim/weaponSwap.ts:SWAP_DELAY) freezes decay.
 *
 * INVARIANT: the rendered view punch — `recoil × punchRad`, the angle
 * aimPitch/aimYaw actually apply — comes out unchanged. That invariant is what
 * fixes the ratio's DIRECTION: holding `recoil × punchRad` constant requires
 * scaling by outgoing ÷ incoming. The reciprocal scales the angle by ratio²
 * instead of holding it, which is how `f5fcb6a` shipped a ~2.8° aim snap on
 * every mid-spray swap — and, because the overshoot clips at the cap, a 1-2-1
 * that returned 40% less recoil than it started with. Preventing that snap is
 * what this function is for, so the direction is its whole contract.
 *
 * SCOPE, because the caller's comment used to overclaim: this is the swap's
 * INSTANT effect only. It does not and cannot stop 1-2-1 being a recoil
 * cancel — once converted, the units decay at the incoming weapon's
 * recoilRecover, and the sniper's 13/s clears a full smg climb in 0.277 s.
 * A lossless conversion followed by a fast drain still nets a reset. That
 * half is fixed OUTSIDE this function (issue #15): switchWeapon opens a
 * SWAP_DELAY deploy window during which updateWeapon freezes recoil/spray
 * decay and shoot/tryReload/the scope gate refuse — so the converted state
 * survives the swap instead of draining through it.
 *
 * The caps still bite by design: converting onto a weapon with a SMALLER
 * punchRad scales recoil up, and clipping there is a real loss of state, not
 * a leak. Only the direction that scales down is continuous end to end.
 *
 * `spray` is weapon-agnostic but bounded per weapon, so it re-clamps rather
 * than rescaling — carrying a sniper's 2.7 onto an smg that cannot generate
 * past ~1.9 widens its cone for seconds.
 *
 * Taking the two weapons as objects rather than four bare numbers is
 * deliberate: transposing them is a type error, since `incoming` needs a
 * sprayCap and `outgoing` does not.
 *
 * @param outgoing the weapon being holstered
 * @param incoming the weapon being drawn
 * @param caps     RECOIL_CAP / RECOIL_YAW_CAP from core/state
 */
export function convertOnSwap(
  state: SwapState,
  outgoing: { punchRad: number },
  incoming: { punchRad: number; sprayCap: number },
  caps: { recoil: number; recoilYaw: number },
): SwapState {
  const punchRatio = outgoing.punchRad / incoming.punchRad;
  const yaw = state.recoilYaw * punchRatio;
  return {
    recoil: Math.min(state.recoil * punchRatio, caps.recoil),
    // Symmetric clamp, inlined rather than THREE.MathUtils.clamp so this
    // module keeps its "every input is a parameter, no imports" contract.
    recoilYaw: Math.max(-caps.recoilYaw, Math.min(caps.recoilYaw, yaw)),
    spray: Math.min(state.spray, incoming.sprayCap),
  };
}
