// collision.js — movement collision and line-of-sight queries.
//
// Two independent mechanisms:
//   collidesAt      -> AABB overlap test against core.colliders (cheap, per-frame)
//   hasLineOfSight  -> raycast against core.solids (used by bots before firing)
import * as THREE from 'three';
import { colliders } from './core/state.js';

/**
 * Test whether an entity capsule (approximated as a box) at `pos` would
 * intersect any level geometry.
 *
 * The test box deliberately spans y 0.1..2.0 regardless of crouch state:
 * entities can't pass under obstacles, and low crates block everyone.
 *
 * @param {THREE.Vector3} pos - entity position (y is ignored by this test)
 * @param {number} radius - half-width of the entity (player: 0.45, bot: 0.5)
 */
export function collidesAt(pos, radius) {
  const box = new THREE.Box3(
    new THREE.Vector3(pos.x - radius, 0.1, pos.z - radius),
    new THREE.Vector3(pos.x + radius, 2.0, pos.z + radius)
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
