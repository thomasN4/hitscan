// collision.js — movement collision and line-of-sight queries.
//
// Two independent mechanisms, both PURE: each takes the registry it queries
// as a parameter (from world.js) rather than importing it, so this module
// stays unit-testable in plain Node.
//   collidesAt      -> AABB overlap test against `colliders` (cheap, per-frame)
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
 * @param {THREE.Vector3} pos - entity position (y is ignored by this test)
 * @param {number} radius - half-width of the entity (player: 0.45, bot: 0.5)
 * @param {THREE.Box3[]} colliders - registry from world.js
 */
export function collidesAt(pos, radius, colliders) {
  const box = new THREE.Box3(
    new THREE.Vector3(pos.x - radius, TEST_BOX_MIN_Y, pos.z - radius),
    new THREE.Vector3(pos.x + radius, TEST_BOX_MAX_Y, pos.z + radius)
  );
  for (const c of colliders) if (c.intersectsBox(box)) return true;
  return false;
}

// Reused raycaster — allocation in the frame loop is the thing to avoid here.
const losRaycaster = new THREE.Raycaster();

/**
 * True if nothing in `solids` blocks the straight path from `from` to `to`.
 * Used by bots to decide whether they can fire; player bullets use their own
 * full raycast in weapons.js instead.
 *
 * @param {THREE.Vector3} from - e.g. Bot.eyePos()
 * @param {THREE.Vector3} to   - e.g. camera.position
 */
export function hasLineOfSight(from, to, solids) {
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
