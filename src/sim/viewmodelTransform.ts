// sim/viewmodelTransform.ts — the camera-space transform of the first-person
// weapon group (player.ts:updateViewmodel).
//
// Pure: every input is a parameter. See sim/accuracy.ts for the rationale, and
// sim/recoil.ts:convertOnSwap for why this is a seam at all — player.ts is
// browser-side and eslint.config.js bans src/**/*.test.ts from importing it, so
// the arithmetic deciding where the sights sit was unreachable from the suite
// until it moved here.
//
// THE INVARIANT: at ads = 1 the returned x, y and rotation must not depend on
// visualRecoil, recoilYaw, bobAmt or now. gunGroup is a child of the camera and
// the ADS offset puts the weapon's sight line ON the view axis, so a residual in
// any of those four is an uncorrected displacement of the sights away from
// screen centre — and screen centre is where recoil.ts:aimPitch/aimYaw promise
// the bullets go. z is deliberately NOT gated: with x = y = 0 the sight sits on
// the view axis, and translating along that axis leaves an on-axis point on it,
// so the depth punch is NDC-neutral and survives aiming.

/** Everything updateViewmodel reads, in the order it reads it. */
export interface ViewmodelInput {
  /** Hip -> ADS delta for the equipped weapon (weapons.ts:viewmodelAimOffset). */
  aimOffset: { x: number; y: number };
  /** 0 = hip, 1 = fully aimed (wpn.adsLerp). */
  ads: number;
  /** Reshaped cosmetic recoil (weapons.ts:currentViewmodelRecoil), NOT raw. */
  visualRecoil: number;
  /** Signed horizontal recoil walk in raw units (wpn.recoilYaw). */
  recoilYaw: number;
  /** View bob amplitude in metres (player.ts motion.bobAmt); weapon-only. */
  bobAmt: number;
  /** Bob phase source, in GAME seconds — a pause must not snap the cycle. */
  now: number;
}

/** rotation.z is never written by this stage, so it is not modelled. */
export interface ViewmodelTransform {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number };
}

export function viewmodelTransform(input: ViewmodelInput): ViewmodelTransform {
  const { aimOffset, ads, visualRecoil, recoilYaw, bobAmt, now } = input;
  // One gate shared by every term that would move the sights, linear in ads so
  // the pull-in blends rather than snapping at a threshold, and so hip fire
  // (ads = 0) stays bit-identical to what shipped before the gate.
  const hip = 1 - ads;
  return {
    position: {
      x: aimOffset.x * ads,
      y: aimOffset.y * ads + Math.sin(now * 10) * bobAmt * hip,
      z: visualRecoil * 0.012 + 0.06 * ads, // ADS pulls the gun slightly closer
    },
    rotation: {
      x: visualRecoil * 0.015 * hip,
      y: -recoilYaw * 0.01 * hip, // subtle sideways pull matching the walk
    },
  };
}
