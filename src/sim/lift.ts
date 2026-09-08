// lift.ts — cargo lifts: the predicate that decides when a body is thrown
// upward, and nothing else.
//
// This is the launch-pad mechanic originally used by Warehouse 2. That map
// now uses physical elevators (sim/elevator.ts); this API remains available
// for maps that want an upward impulse. It reuses resolveVertical's ceiling
// sweep and landing support, identically for players and bots.
//
// Pure and engine-free like everything in sim/: pads are plain numbers, so
// this is testable without a scene or a collider registry. world.ts owns the
// registry and publishes each pad's NavLink; player.ts and bots.ts apply the
// result.

/** One launch pad: its footprint, the surface stood on, and what it imparts. */
export interface LiftPad {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Walking surface of the pad — the height a body's feet rest at on it. */
  topY: number;
  /** Upward velocity imparted to a body that comes to rest on it (m/s). */
  launchVel: number;
}

/**
 * How far a launch carries feet that start at rest, under constant gravity.
 *
 * `v² / 2g`, and exported rather than inlined so a map can check its own pads
 * actually reach the deck they serve — maps/warehouse2.ts:checkClearances does
 * exactly that, against the same DECK_Y the geometry is built from.
 */
export function launchApex(launchVel: number, gravity: number): number {
  return (launchVel * launchVel) / (2 * gravity);
}

/**
 * Tolerance (m) on "feet are resting on this pad".
 *
 * resolveVertical snaps feet to the support height exactly, so in principle
 * this could be zero; it is not, because pad tops are measured off float32
 * mesh vertices (the same source as collision.ts:COLLISION_EPSILON's slack).
 * Loose enough to survive that, far tighter than the pad's own height, so a
 * body on the floor beside the pad can never read as standing on it.
 */
const REST_TOLERANCE = 0.05;

/**
 * The velocity a pad imparts to this body, or null when none does.
 *
 * Grounded-only, which is what makes the launch non-repeating without any
 * state to track: the launch sets a positive vertical velocity, resolveVertical
 * reports `onGround: false` for the whole ascent, and nothing can fire again
 * until the body has landed somewhere.
 *
 * The footprint only has to OVERLAP the pad, not sit inside it — clipping the
 * corner of a lift should still throw you, and the same overlap convention is
 * what collision.ts:blocks uses.
 *
 * @param x/z body centre
 * @param feetY body feet height
 * @param onGround whether the body is resting on support this frame
 * @param radius half-width of the body footprint
 * @param pads registry from world.ts
 */
export function launchFrom(
  x: number,
  z: number,
  feetY: number,
  onGround: boolean,
  radius: number,
  pads: readonly LiftPad[],
): number | null {
  if (!onGround) return null;
  for (const pad of pads) {
    if (Math.abs(feetY - pad.topY) > REST_TOLERANCE) continue;
    if (x - radius >= pad.maxX || x + radius <= pad.minX) continue;
    if (z - radius >= pad.maxZ || z + radius <= pad.minZ) continue;
    return pad.launchVel;
  }
  return null;
}
