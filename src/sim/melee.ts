// sim/melee.ts — melee swing resolution.
//
// Pure apart from THREE's math classes (Vector3 imports fine in Node, like
// ballistics.ts). weapons.ts supplies the eye origin, the exact view
// direction and one candidate strike point per live enemy bot part; this
// module alone decides whether the swing connects, and with what.
//
// The model is deliberately generous where bullets are precise: a hit is
// RANGE + ARC, not a raycast. A blade that only cut along the crosshair
// would feel unfair at swing cadence; CS-style melee reads the whole
// forward cone. Cover does NOT block swings (no wall test here) — a known,
// accepted simplification over the hitscan path.

import * as THREE from 'three';
import type { HitZone } from '../core/state';

/**
 * One candidate strike point: a bot part's world position plus its zone.
 * `payload` rides through to the winner untouched so callers can map a hit
 * back to its owner without this module knowing what a bot is.
 */
export interface MeleeCandidate<P> {
  payload: P;
  zone: HitZone;
  at: THREE.Vector3;
}

/** What a connected swing struck, and how far away it was. */
export interface SwingHit<P> {
  payload: P;
  part: HitZone;
  /** Eye-to-strike-point distance in metres (<= `range`). */
  distance: number;
}

/**
 * Resolve one melee swing against the candidates.
 *
 * A candidate connects when it is within `range` of the eye AND within
 * arcRad/2 of the view direction (angular offset via dot product); among
 * those the NEAREST wins, ties going to the first encountered. Boundary
 * distances/angles are inclusive, matching how every other bound in the
 * game reads.
 *
 * @param origin eye position (world space)
 * @param dir    UNIT view direction (the exact aim, no cone sampling)
 * @param range  reach in metres
 * @param arcRad total apex angle of the swing cone, radians
 */
export function meleeSwing<P>(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  range: number,
  arcRad: number,
  candidates: readonly MeleeCandidate<P>[],
): SwingHit<P> | undefined {
  const halfArcCos = Math.cos(arcRad / 2);
  let best: SwingHit<P> | undefined;
  for (const c of candidates) {
    const offset = c.at.clone().sub(origin);
    const dist = offset.length();
    // A strike point sitting ON the eye is degenerate but must not NaN out
    // of the dot below — treat it as dead-center alignment instead.
    const align = dist < 1e-6 ? 1 : offset.dot(dir) / dist;
    if (dist > range || align < halfArcCos) continue;
    if (best === undefined || dist < best.distance) {
      best = { payload: c.payload, part: c.zone, distance: dist };
    }
  }
  return best;
}
