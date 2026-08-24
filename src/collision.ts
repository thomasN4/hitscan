// collision.ts — movement collision and line-of-sight queries.
//
// Three independent mechanisms, all PURE: each takes the registry it queries
// as a parameter (from world.ts) rather than importing it, so this module
// stays unit-testable in plain Node.
//   collidesAt      -> AABB overlap test against `colliders` (cheap, per-frame)
//   findFreeSpawn   -> rejection sampling over `colliders` (spawn placement)
//   hasLineOfSight  -> raycast against `solids` (used by bots before firing)
import * as THREE from 'three';

/** Entity test box spans this y range regardless of crouch — see collidesAt. */
export const TEST_BOX_MIN_Y = 0.1;
export const TEST_BOX_MAX_Y = 2.0;

/**
 * Test whether an entity capsule (approximated as a box) at `pos` would
 * intersect any level geometry.
 *
 * The test box deliberately spans y 0.1..2.0 regardless of crouch state:
 * entities can't pass under obstacles, and low crates block everyone.
 *
 * @param pos entity position (y is ignored by this test)
 * @param radius half-width of the entity (player: 0.45, bot: 0.5)
 * @param colliders registry from world.ts
 */
export function collidesAt(pos: THREE.Vector3, radius: number, colliders: THREE.Box3[]): boolean {
  const box = new THREE.Box3(
    new THREE.Vector3(pos.x - radius, TEST_BOX_MIN_Y, pos.z - radius),
    new THREE.Vector3(pos.x + radius, TEST_BOX_MAX_Y, pos.z + radius)
  );
  for (const c of colliders) if (c.intersectsBox(box)) return true;
  return false;
}

/**
 * Sample spawn candidates until one is clear of level geometry.
 *
 * `sample()` proposes a position (usually a random draw from the map's spawn
 * band); each is tested with collidesAt at the entity's radius. Bounded so a
 * pathological registry can never hang the respawn scheduler — on exhaustion
 * the LAST candidate is returned, degrading to unvalidated placement rather
 * than inventing a coordinate no sampler produced. With ~80% of the arena
 * band open floor, 32 consecutive misses is ~1e-22 probability.
 *
 * @param sample produces the next candidate position
 * @param radius half-width of the entity to place
 * @param colliders registry from world.ts
 * @param maxAttempts sampling budget before giving up
 */
export function findFreeSpawn(
  sample: () => THREE.Vector3,
  radius: number,
  colliders: THREE.Box3[],
  maxAttempts = 32,
): THREE.Vector3 {
  let pos = sample();
  for (let i = 1; i < maxAttempts && collidesAt(pos, radius, colliders); i++) pos = sample();
  return pos;
}

// Reused raycaster — allocation in the frame loop is the thing to avoid here.
const losRaycaster = new THREE.Raycaster();

/**
 * True if nothing in `solids` blocks the straight path from `from` to `to`.
 * Used by bots to decide whether they can fire; player bullets use their own
 * full raycast in weapons.ts instead.
 *
 * @param from e.g. Bot.eyePos()
 * @param to   e.g. camera.position
 */
export function hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3, solids: THREE.Object3D[]): boolean {
  const dir = new THREE.Vector3().subVectors(to, from);
  const dist = dir.length();
  if (dist < 0.001) return true;
  dir.normalize();
  losRaycaster.set(from, dir);
  // Shorten the ray slightly so surfaces AT the endpoints (the bot's own
  // head hitbox plane, geometry touching the camera) don't count as blockers.
  losRaycaster.far = dist - 0.1;
  return losRaycaster.intersectObjects(solids, false).length === 0;
}
