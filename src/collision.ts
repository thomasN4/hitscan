// collision.ts — movement collision and line-of-sight queries.
//
// All mechanisms are PURE: each takes the registry it queries as a parameter
// (from world.ts) rather than importing it, so this module stays unit-testable
// in plain Node.
//   collidesAt       -> feet-aware AABB overlap test against `colliders`
//   supportHeightAt  -> highest walkable surface under a point (stairs, floors)
//   slideMoveXZ      -> axis-separated horizontal move with wall sliding
//   resolveVertical  -> gravity integration vs support (landing, step-up rest)
//   findFreeSpawn    -> rejection sampling over `colliders` (spawn placement)
//   hasLineOfSight   -> raycast against `solids` (used by bots before firing)
//
// Elevation model: entities are positioned by their FEET height (`feetY`),
// not their eye or mesh origin. A collider blocks movement only where it is
// too tall to step onto; surfaces at or below STEP_HEIGHT above the feet are
// climbed by resolveVertical instead. This is what makes stairs work — each
// riser reads as floor, not wall — and it also lets entities stand ON boxes,
// fall off edges and walk under elevated geometry, all without special cases.
import * as THREE from 'three';

/** Tallest riser an entity auto-climbs rather than collides with. */
export const STEP_HEIGHT = 0.3;
/** Top of the entity's collision span, relative to its feet. */
export const HEAD_HEIGHT = 2.0;
/**
 * Slack for the elevation comparisons, in metres.
 *
 * Collider AABBs are measured from meshes whose vertices are stored as
 * FLOAT32, so a tread built as exactly 0.3 tall measures
 * 0.3000000059604645 — a few nanometres too tall. Without this slack every
 * exact-height riser reads a hair above feet + STEP_HEIGHT and walls off
 * the entire flight (the smoke test caught exactly that). Orders of
 * magnitude: float32 noise ~5e-9, this epsilon 1e-6, STEP_HEIGHT 0.3.
 */
export const COLLISION_EPSILON = 1e-6;

/**
 * Test whether an entity whose FEET are at `feetY`, at `pos` in XZ, would
 * intersect any level geometry.
 *
 * A collider blocks only if it overlaps the XZ footprint AND rises more than
 * STEP_HEIGHT above the feet (a step, not a wall) AND dips below head height
 * (an overhead slab is not a wall). Geometry you are standing on has its top
 * below your feet and never blocks you — that is what makes platforms walkable.
 *
 * @param pos entity position (only x/z are read)
 * @param radius half-width of the entity (player: 0.45, bot: 0.5)
 * @param feetY height of the entity's feet; 0 on open ground
 * @param colliders registry from world.ts
 */
export function collidesAt(pos: THREE.Vector3, radius: number, feetY: number, colliders: THREE.Box3[]): boolean {
  // Explicit comparisons, not Box3.intersectsBox, for two reasons: THREE
  // treats mere EDGE CONTACT as intersecting, and stair risers sit EXACTLY
  // one STEP_HEIGHT above the previous tread — an inclusive test would wall
  // off every flight. Tops within STEP_HEIGHT of the feet are steppable,
  // bottoms at or above head height are overhead cover; both bounds take
  // COLLISION_EPSILON slack for float32-measured tops (see above).
  const minX = pos.x - radius, maxX = pos.x + radius;
  const minZ = pos.z - radius, maxZ = pos.z + radius;
  const steppableBelow = feetY + STEP_HEIGHT + COLLISION_EPSILON;
  const overheadAbove = feetY + HEAD_HEIGHT;
  for (const c of colliders) {
    if (minX >= c.max.x || maxX <= c.min.x) continue;
    if (minZ >= c.max.z || maxZ <= c.min.z) continue;
    if (c.max.y <= steppableBelow || c.min.y >= overheadAbove) continue;
    return true;
  }
  return false;
}

/**
 * Highest surface top at or below `ceilingY` whose footprint contains the
 * point's XZ footprint. Open ground counts as y = 0, so the return value is
 * always defined.
 *
 * Callers choose the ceiling per intent: `feetY + STEP_HEIGHT` when walking
 * (surfaces up to one riser above the feet are stepped onto), `prevFeetY +
 * STEP_HEIGHT` inside resolveVertical for landings — which is what makes fast
 * falls tunnel-proof, since any top passed through during the frame sits below
 * that ceiling.
 *
 * @param x centre x of the footprint
 * @param z centre z of the footprint
 * @param radius half-width of the entity footprint
 * @param ceilingY only tops at or below this count as support
 * @param colliders registry from world.ts
 */
export function supportHeightAt(x: number, z: number, radius: number, ceilingY: number, colliders: THREE.Box3[]): number {
  let best = 0; // the base ground plane supports everything
  for (const c of colliders) {
    // Ceiling takes COLLISION_EPSILON slack too: float32-noisy tops must
    // still count as support, or the riser face lets you through
    // (collidesAt) but the lift never fires (here).
    if (c.max.y <= best || c.max.y > ceilingY + COLLISION_EPSILON) continue;
    if (x + radius <= c.min.x || x - radius >= c.max.x) continue;
    if (z + radius <= c.min.z || z - radius >= c.max.z) continue;
    best = c.max.y;
  }
  return best;
}

/**
 * Horizontal move with slide-along-walls: `pos` is advanced along x and z
 * SEPARATELY (mutated in place), so pressing into a wall while also pressing
 * along it keeps you sliding instead of sticking. Axis moves that would enter
 * a blocking collider (see collidesAt) are dropped entirely.
 *
 * Step-up is NOT done here: a riser simply doesn't block, and the caller's
 * vertical stage (resolveVertical) lifts the feet onto it afterwards.
 *
 * @param pos entity position; mutated in x/z, y untouched
 * @param moveX intended x displacement this frame
 * @param moveZ intended z displacement this frame
 * @param radius half-width of the entity
 * @param feetY height of the entity's feet (selects which colliders block)
 * @param colliders registry from world.ts
 */
export function slideMoveXZ(
  pos: THREE.Vector3,
  moveX: number,
  moveZ: number,
  radius: number,
  feetY: number,
  colliders: THREE.Box3[],
): void {
  const nx = pos.x + moveX;
  const probe = new THREE.Vector3(nx, 0, pos.z);
  if (!collidesAt(probe, radius, feetY, colliders)) pos.x = nx;
  probe.set(pos.x, 0, pos.z + moveZ);
  if (!collidesAt(probe, radius, feetY, colliders)) pos.z += moveZ;
}

/** Result of one vertical integration step — see resolveVertical. */
export interface VerticalResolve {
  /** New feet height: landed support, or free-fall position. */
  feetY: number;
  /** New vertical velocity: zeroed on landing. */
  velY: number;
  /** True when the entity came to rest on a surface this step. */
  onGround: boolean;
}

/**
 * Integrate one step of vertical motion against level geometry.
 *
 * While rising (velY > 0) nothing is resolved — you own the air. While
 * falling or resting, support is queried with the ceiling `prevFeetY +
 * STEP_HEIGHT`: any surface top between the new feet position and one riser
 * above the previous feet catches the entity. That single rule produces
 * resting on floors, stepping UP onto risers, landing after falls (swept, so
 * no tunneling through thin treads even at clamped-dt speeds) and walking OFF
 * edges (support drops away, next frames free-fall).
 *
 * @param prevFeetY feet height before this step's gravity was applied
 * @param velY vertical velocity AFTER gravity was applied by the caller
 * @param dt delta time (s)
 * @param x/z entity centre (post horizontal move — step-up lands here)
 * @param radius half-width of the entity footprint
 * @param colliders registry from world.ts
 */
export function resolveVertical(
  prevFeetY: number,
  velY: number,
  dt: number,
  x: number,
  z: number,
  radius: number,
  colliders: THREE.Box3[],
): VerticalResolve {
  const newFeetY = prevFeetY + velY * dt;
  if (velY > 0) return { feetY: newFeetY, velY, onGround: false };
  const ground = supportHeightAt(x, z, radius, prevFeetY + STEP_HEIGHT, colliders);
  if (newFeetY <= ground) return { feetY: ground, velY: 0, onGround: true };
  return { feetY: newFeetY, velY, onGround: false };
}

/**
 * Sample spawn candidates until one is clear of level geometry.
 *
 * `sample()` proposes a position (usually a random draw from the map's spawn
 * band); each is tested with collidesAt at the entity's radius, feet on open
 * ground (both maps sample spawns from y = 0 floor level). Bounded so a
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
  for (let i = 1; i < maxAttempts && collidesAt(pos, radius, 0, colliders); i++) pos = sample();
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
