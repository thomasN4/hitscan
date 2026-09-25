// sim/arrow.ts — an arrow in flight: gravity, air drag and a swept hit test.
//
// Pure apart from THREE's math classes. The scene query is injected as a
// SegmentCast, so the suite drives the integrator against a synthetic wall
// while arrows.ts hands it a real raycaster.

import * as THREE from 'three';

/**
 * Real gravity, not sim/movement.ts:GRAVITY (22). Bodies use a heavier value
 * for snappy jumps; an arrow is the one thing in the game whose drop the
 * player has to read, so it falls the way arrows do.
 */
export const ARROW_GRAVITY = 9.81;

/**
 * Quadratic drag per metre: a = −k·|v|·v, so speed decays as e^(−k·s) over
 * path length s. 0.0018 keeps ~93% of the launch speed at 40 m, in line with
 * a heavy war arrow losing a few per cent per ten metres.
 */
export const ARROW_DRAG = 0.0018;

/**
 * Integration substep (s). 1/240 s is ~0.24 m of flight at full launch speed,
 * finer than any wall or bot part, and each substep's chord is swept, so an
 * arrow cannot tunnel whatever the frame rate.
 */
export const ARROW_SUBSTEP = 1 / 240;

/** Seconds an unimpeded arrow flies before it is retired. */
export const ARROW_MAX_AGE = 6;

/** The flight state an arrow carries; `pos` is the TIP. */
export interface ArrowBody {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
}

/** What a SegmentCast reports: the nearest hit along the chord, if any. */
export interface SegmentHit<T> {
  point: THREE.Vector3;
  payload: T;
}

/** Nearest hit on the straight chord from `from` to `to`, or null. */
export type SegmentCast<T> = (from: THREE.Vector3, to: THREE.Vector3) => SegmentHit<T> | null;

const accel = new THREE.Vector3();

/** One semi-implicit Euler step of `h` seconds, in place. */
export function stepArrow(body: ArrowBody, h: number): void {
  const speed = body.vel.length();
  accel.copy(body.vel).multiplyScalar(-ARROW_DRAG * speed);
  accel.y -= ARROW_GRAVITY;
  body.vel.addScaledVector(accel, h);
  body.pos.addScaledVector(body.vel, h);
  body.age += h;
}

/**
 * Advance `body` by `dt`, sweeping every substep's chord through `cast`.
 * On a hit the tip is left AT the hit point with the velocity it arrived
 * with, and the hit is returned; the rest of the frame is not flown.
 */
export function advanceArrow<T>(body: ArrowBody, dt: number, cast: SegmentCast<T>): SegmentHit<T> | null {
  const steps = Math.max(1, Math.ceil(dt / ARROW_SUBSTEP - 1e-9));
  const h = dt / steps;
  const from = new THREE.Vector3();
  for (let i = 0; i < steps; i++) {
    from.copy(body.pos);
    stepArrow(body, h);
    const hit = cast(from, body.pos);
    if (hit) {
      body.pos.copy(hit.point);
      return hit;
    }
  }
  return null;
}

/** One sample of an arrow's recent path, stamped with the flight age it was taken at. */
export interface TrailPoint {
  at: THREE.Vector3;
  age: number;
}

/**
 * Drop trail samples older than `seconds` behind `age`, oldest first, always
 * keeping the newest two so a line has something to draw. By age rather than
 * by count: a count sized from an average frame time drifts once the list is
 * trimmed, and the trail shrank to a stub as the arrow flew.
 */
export function trimTrail(trail: TrailPoint[], age: number, seconds: number): void {
  // Bound-guarded: length > 2 before the read.
  while (trail.length > 2 && age - trail[0]!.age > seconds) trail.shift();
}
