// collision.ts — movement collision and line-of-sight queries.
//
// All mechanisms are PURE: each takes the registry it queries as a parameter
// (from world.ts) rather than importing it, so this module stays unit-testable
// in plain Node.
//   collidesAt       -> feet-aware AABB overlap test against `colliders`
//   supportHeightAt  -> highest walkable surface under a point (stairs, floors)
//   slideMoveXZ      -> axis-separated horizontal move with wall sliding
//   resolveVertical  -> gravity integration vs support (rest, step-up,
//                       landings, stair descent, edge-fall) and vs ceilings
//                       while rising
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
  for (const c of colliders) {
    if (blocks(c, pos.x, pos.z, radius, feetY)) return true;
  }
  return false;
}

/**
 * Whether a body with its feet at `feetY` could walk onto (x, z): nothing
 * blocks the footprint there (collidesAt) AND a surface within one step
 * below the feet sits under the point itself. collidesAt alone answers "no
 * wall here", which a point in mid-air past a deck edge also satisfies, so a
 * planner sampling a line between nav nodes — which carry a floor guarantee
 * the points between them do not — asks this instead. A drop deeper than
 * STEP_HEIGHT is a fall, not a step.
 *
 * Support is tested at the CENTRE, not over the footprint, on purpose. The
 * movement stage keeps a body up while any part of its footprint overlaps a
 * surface, so the centres that fall form a band more than `radius` outside
 * every surface — and a sampled line can clip that band for less than one
 * sample step, passing every footprint test and still dropping the body
 * between two samples. With the centre itself required to be over a
 * surface at samples no further apart than `radius`, no point between two
 * passing samples is more than half a radius from a surface, so none can
 * fall. Stricter than resolveVertical near an edge, which is the right side
 * to err on for a shortcut; the nodes themselves stay reachable.
 */
export function standableAt(pos: THREE.Vector3, radius: number, feetY: number, colliders: THREE.Box3[]): boolean {
  if (collidesAt(pos, radius, feetY, colliders)) return false;
  const support = supportHeightAt(pos.x, pos.z, 0, feetY + STEP_HEIGHT, colliders);
  return support >= feetY - STEP_HEIGHT - COLLISION_EPSILON;
}

/**
 * Whether ONE collider blocks a footprint centred at (x, z) with feet at
 * `feetY`. The predicate collidesAt is built from, factored out so the
 * unwedge test below cannot drift away from it.
 *
 * Explicit comparisons, not Box3.intersectsBox, for two reasons: THREE
 * treats mere EDGE CONTACT as intersecting, and stair risers sit EXACTLY
 * one STEP_HEIGHT above the previous tread — an inclusive test would wall
 * off every flight. Tops within STEP_HEIGHT of the feet are steppable,
 * bottoms at or above head height are overhead cover; both bounds take
 * COLLISION_EPSILON slack for float32-measured tops (see above). Minus slack
 * on the ceiling: float32 stores bottoms LOW, and an exact-height overhead
 * slab must still read as walkable-under.
 */
function blocks(c: THREE.Box3, x: number, z: number, radius: number, feetY: number): boolean {
  if (x - radius >= c.max.x || x + radius <= c.min.x) return false;
  if (z - radius >= c.max.z || z + radius <= c.min.z) return false;
  if (c.max.y <= feetY + STEP_HEIGHT + COLLISION_EPSILON) return false;
  if (c.min.y >= feetY + HEAD_HEIGHT - COLLISION_EPSILON) return false;
  return true;
}

/**
 * Overlap between the footprint span [c − radius, c + radius] and [lo, hi].
 * Zero when they are disjoint.
 */
function axisOverlap(c: number, radius: number, lo: number, hi: number): number {
  return Math.max(0, Math.min(c + radius, hi) - Math.max(c - radius, lo));
}

/**
 * Whether a blocked single-axis move strictly UNWEDGES: every collider that
 * blocks at the destination overlaps the footprint LESS along the moving
 * axis than it does right now.
 *
 * This is what keeps a binary overlap test from being a trap. `collidesAt`
 * answers "would I be inside something" with no notion of how deep, so an
 * entity that is ALREADY inside has every direction refused — including the
 * ones heading out. That soft-lock is not theoretical: on the elevation map's
 * internal flight, feet at 1.5 m put the x >= 6 second-floor slab's underside
 * below head height, and a player or bot whose radius laps that edge is
 * pinned at one coordinate permanently, jump included.
 *
 * It cannot open a path through anything. Walking into a wall from OUTSIDE
 * has zero overlap now and positive overlap at the destination, so the strict
 * decrease never holds and the move is refused exactly as before; the escape
 * only ever fires from inside, and only toward the way out.
 */
function unwedges(
  fromX: number, fromZ: number,
  toX: number, toZ: number,
  radius: number, feetY: number, colliders: THREE.Box3[],
): boolean {
  const movingX = toX !== fromX;
  let improved = false;
  for (const c of colliders) {
    // EITHER end, not just the destination. A move that clears an escapable
    // collider outright drops it from a destination-only scan, so `improved`
    // never gets set and the escape is refused forever — another state with no
    // exit, which is the whole thing this function exists to remove. Crediting
    // it needs no new rule: a collider blocking here but not there has overlap
    // 0 there, which the comparison below already reads as an improvement.
    if (!blocks(c, toX, toZ, radius, feetY) && !blocks(c, fromX, fromZ, radius, feetY)) continue;
    const before = movingX
      ? axisOverlap(fromX, radius, c.min.x, c.max.x)
      : axisOverlap(fromZ, radius, c.min.z, c.max.z);
    const after = movingX
      ? axisOverlap(toX, radius, c.min.x, c.max.x)
      : axisOverlap(toZ, radius, c.min.z, c.max.z);
    // Strictly worse vetoes outright: escaping one face must not be paid for
    // by burrowing into another, and approaching from OUTSIDE is this case
    // (0 before, positive after) — which is what keeps walls solid.
    if (after > before) return false;
    // UNCHANGED is indifferent, not a veto. A collider the moving axis
    // cannot escape — one whose span swallows the whole footprint — would
    // otherwise veto every escape from the collider that IS escapable, and
    // rebuild the trap out of the fix.
    if (after < before) improved = true;
  }
  return improved;
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
 * An axis move that WOULD be blocked is still taken when it strictly reduces
 * the overlap that is blocking it (see unwedges) — otherwise an entity that
 * ends up inside geometry has no way out and stays there for good.
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
  if (!collidesAt(probe, radius, feetY, colliders)
      || unwedges(pos.x, pos.z, nx, pos.z, radius, feetY, colliders)) {
    pos.x = nx;
  }
  const nz = pos.z + moveZ;
  probe.set(pos.x, 0, nz);
  if (!collidesAt(probe, radius, feetY, colliders)
      || unwedges(pos.x, pos.z, pos.x, nz, radius, feetY, colliders)) {
    pos.z = nz;
  }
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
 * Lowest collider underside the head crosses while rising from `lo` to `hi`,
 * or Infinity when none does.
 *
 * A collider counts when its underside sits inside the swept head interval —
 * the head started at or below it and ends above it — AND its XZ footprint
 * strictly overlaps the body's, by the same convention supportHeightAt uses
 * (mere edge contact is not overlap). COLLISION_EPSILON slack on both bounds:
 * float32 stores undersides LOW and feet tops HIGH, so an underside designed
 * exactly at the head measures a hair under it and must still clamp, while
 * one a hair above the frame's end must not be slipped past.
 *
 * Undersides BELOW the interval are deliberately ignored: a head already past
 * them means the body is inside geometry, and clamping there would pull it
 * deeper down instead of letting the unwedge rule walk it out.
 */
function lowestCeiling(
  x: number,
  z: number,
  radius: number,
  lo: number,
  hi: number,
  colliders: THREE.Box3[],
): number {
  let best = Infinity;
  for (const c of colliders) {
    if (c.min.y < lo - COLLISION_EPSILON || c.min.y > hi + COLLISION_EPSILON) continue;
    if (x + radius <= c.min.x || x - radius >= c.max.x) continue;
    if (z + radius <= c.min.z || z - radius >= c.max.z) continue;
    if (c.min.y < best) best = c.min.y;
  }
  return best;
}

/**
 * Integrate one step of vertical motion against level geometry.
 *
 * While rising (velY > 0) the entity's head is swept from its old to its new
 * position against collider UNDERSIDES (see lowestCeiling): the first one the
 * head would cross stops the rise — feet clamp below it, velocity zeroes, and
 * the entity stays airborne. Anything already well above the head, below the
 * feet, or beside the footprint is ignored, so jumping on the flat, riding
 * lift arcs through open air, and escaping geometry the unwedge rule allows
 * all behave exactly as before.
 *
 * While falling or resting, support is queried with the ceiling `prevFeetY +
 * STEP_HEIGHT`: any surface top between the new feet position and one riser
 * above the previous feet catches the entity. That single rule produces
 * resting on floors, stepping UP onto risers, landing after falls (swept, so
 * no tunneling through thin treads even at clamped-dt speeds) and walking OFF
 * edges (support drops away, next frames free-fall).
 *
 * A GROUNDED entity additionally sticks to support within one STEP_HEIGHT
 * below its feet: descending a flight keeps it attached tread-to-tread
 * instead of micro-free-falling into every riser (~13 frames of near-full
 * air-accuracy penalty per tread at walk speed), while a deeper drop (a
 * ledge) still breaks into a fall. Callers feed back the grounded state they
 * tracked last frame.
 *
 * @param prevFeetY feet height before this step's gravity was applied
 * @param velY vertical velocity AFTER gravity was applied by the caller
 * @param dt delta time (s)
 * @param x/z entity centre (post horizontal move — step-up lands here)
 * @param radius half-width of the entity footprint
 * @param colliders registry from world.ts
 * @param wasGrounded grounded last frame; default false preserves the
 *   free-fall behavior for spawns and callers that don't track it
 */
export function resolveVertical(
  prevFeetY: number,
  velY: number,
  dt: number,
  x: number,
  z: number,
  radius: number,
  colliders: THREE.Box3[],
  wasGrounded = false,
): VerticalResolve {
  const newFeetY = prevFeetY + velY * dt;
  if (velY > 0) {
    const ceiling = lowestCeiling(
      x, z, radius,
      prevFeetY + HEAD_HEIGHT, newFeetY + HEAD_HEIGHT,
      colliders,
    );
    // Head meets a ceiling: stop under it, spent. The clamp is exact (not
    // epsilon-slack) because the underside itself is the noise source — the
    // body rests where the geometry actually measures.
    if (ceiling !== Infinity) {
      return { feetY: ceiling - HEAD_HEIGHT, velY: 0, onGround: false };
    }
    return { feetY: newFeetY, velY, onGround: false };
  }
  const ground = supportHeightAt(x, z, radius, prevFeetY + STEP_HEIGHT, colliders);
  if (newFeetY <= ground) return { feetY: ground, velY: 0, onGround: true };
  // Descend-stick. COLLISION_EPSILON slack because float32-noisy treads can
  // measure a hair under exactly one STEP_HEIGHT below the feet (same
  // ordering argument as the epsilon in collidesAt).
  if (wasGrounded && ground >= prevFeetY - STEP_HEIGHT - COLLISION_EPSILON) {
    return { feetY: ground, velY: 0, onGround: true };
  }
  return { feetY: newFeetY, velY, onGround: false };
}

/**
 * Sample spawn candidates until one is clear of level geometry.
 *
 * `sample()` proposes a position (usually a random draw from the map's spawn
 * zone); each is tested with collidesAt at the entity's radius. Bounded so a
 * pathological registry can never hang the respawn scheduler — on exhaustion
 * the LAST candidate is returned, degrading to unvalidated placement rather
 * than inventing a coordinate no sampler produced. With ~80% of the arena
 * band open floor, 32 consecutive misses is ~1e-22 probability.
 *
 * `feetY` defaults to 0 because every spawn zone was floor-level when this was
 * written. It is a parameter now because maps/warehouse2.ts spawns a whole
 * team ON the catwalk: tested at y = 0 those candidates are checked against
 * the ground-floor geometry UNDER the ring, which rejects the good ones and
 * accepts positions the body cannot actually occupy.
 *
 * @param sample produces the next candidate position
 * @param radius half-width of the entity to place
 * @param colliders registry from world.ts
 * @param maxAttempts sampling budget before giving up
 * @param feetY height the candidate's feet sit at; 0 is open ground
 */
export function findFreeSpawn(
  sample: () => THREE.Vector3,
  radius: number,
  colliders: THREE.Box3[],
  maxAttempts = 32,
  feetY = 0,
): THREE.Vector3 {
  let pos = sample();
  for (let i = 1; i < maxAttempts && collidesAt(pos, radius, feetY, colliders); i++) pos = sample();
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
