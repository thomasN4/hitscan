// sim/ballistics.ts — hitscan shot direction.
//
// Pure apart from THREE's math classes (Vector3/Euler import fine in Node).
//
// This module exists to own ONE fact: the Euler order. The camera in
// player.ts uses 'YXZ', and a shot direction built with the default 'XYZ'
// diverges from the view direction as pitch and yaw both grow — bullets fly
// somewhere other than the crosshair. That shipped once as `351f772`
// ("bullets flying skyward"). Keeping the construction here, with a test
// that pins it against a 'YXZ' camera matrix, means the two can no longer
// drift apart silently.
import * as THREE from 'three';

/** Euler order shared by the camera and every shot. Do not change one alone. */
export const EULER_ORDER = 'YXZ';

/**
 * Direction of one bullet, as a unit vector in world space.
 *
 * The cone is sampled per-axis in view space (±spread/2 on x and y against
 * a -1 forward), then rotated into world space by the aim Euler. Pass the
 * PRE-kick pitch: weapons.ts:shoot builds the ray before adding this shot's
 * recoil, so the first round of a burst lands dead-on (`5e004a5`).
 *
 * @param pitch  aim pitch in radians, INCLUDING the recoil punch
 *               (i.e. the result of sim/recoil.ts:aimPitch)
 * @param yaw    aim yaw in radians (aim.yaw)
 * @param spread total cone in radians, from sim/accuracy.ts
 * @param rng    uniform [0,1) source; injected so tests can make the
 *               scatter deterministic
 */
export function shotDirection(
  pitch: number,
  yaw: number,
  spread: number,
  rng: () => number = Math.random,
): THREE.Vector3 {
  return new THREE.Vector3(
    (rng() - 0.5) * spread,
    (rng() - 0.5) * spread,
    -1,
  ).normalize().applyEuler(new THREE.Euler(pitch, yaw, 0, EULER_ORDER));
}
