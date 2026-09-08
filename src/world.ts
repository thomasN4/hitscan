// world.ts — the ONE path by which level geometry enters the world.
//
// Every solid must land in BOTH registries or it is silently broken:
//   solids    -> raycast targets: bullets, bullet-hole decals, bot line-of-sight
//   colliders -> world-space AABBs: cheap per-frame movement tests
// A mesh in `solids` but not `colliders` can be shot but walked through; the
// reverse blocks movement but lets bullets pass. The map builders in `maps/`
// each used to carry their own copy of this logic, and the range copy shipped
// without the `colliders` push — the whole map was no-clip (`431ac6e`).
//
// Builders also own `navLinks` (level changes), `liftPads` (launch triggers),
// and `elevators` (moving geometry with persistent collider identities).
//
// `addSolidBox` and `addElevator` attach geometry to the scene. `addOpenStairs` composes boxes for the
// treads and adds its stringer group directly. Registration is scene-free, so the two
// invariants that have actually broken here — registering both registries,
// and flushing a group's world matrix before measuring it — are unit-tested
// in plain Node. `scene` is never read at module scope, and
// core/engine.ts has no module-scope side effects, so importing this file
// outside a browser is safe.
import * as THREE from 'three';
import { scene } from './core/engine';
import type { LiftPad } from './sim/lift';
import { elevatorSample, elevatorBlocked, elevatorSupports, type ElevatorBody, type ElevatorMotion } from './sim/elevator';

/** Meshes that block bullets AND bot line-of-sight. */
export const solids: THREE.Object3D[] = [];
/** World-space AABBs derived from solids, used for movement collision. */
export const colliders: THREE.Box3[] = [];

/**
 * A level change a walker can traverse but a grid of standable cells cannot
 * express cheaply — a stair flight, launch arc, or timed elevator ride.
 *
 * The navigation grid (sim/navGrid.ts) samples at 1 m, and a 0.75 m tread
 * means one cell along a flight climbs more than STEP_HEIGHT; sampled that
 * coarsely, every staircase reads as a wall. Rather than quadruple the sample
 * count to resolve treads, flights announce their own endpoints here and enter
 * the graph as a single edge.
 */
export interface NavLink {
  /** Floor-level mouth of the flight. */
  bottom: THREE.Vector3;
  /** Landing at the top, level with whatever the flight serves. */
  top: THREE.Vector3;
  /**
   * Half the flight's width across the line of travel (m). Navigation uses it
   * to recognise which sampled nodes are ON the flight, so a bot partway up
   * can route onward instead of back to the mouth.
   */
  halfWidth: number;
  /**
   * Traversable in the up direction only. Omitted means both ways, which is
   * right for stairs/elevators and wrong for a launch pad: a bidirectional pad edge
   * tells a bot it can descend by stepping off the deck onto the pad below —
   * which launches it straight back up, and it oscillates there forever.
   */
  oneWay?: boolean;
  elevatorId?: string;
  /** Extra cost in distance-equivalent units, for waiting and slow travel. */
  extraCost?: number;
}

/** Traversable level changes, populated only by the corresponding world builders. */
export const navLinks: NavLink[] = [];

/**
 * Launch pads, in the pure form sim/lift.ts tests against.
 *
 * A separate registry from `colliders` because a pad is BOTH — it is an
 * ordinary solid you stand on, registered as one, and additionally a trigger.
 * player.ts and bots.ts read this after their vertical resolve.
 */
export const liftPads: LiftPad[] = [];

export interface ElevatorSpec extends ElevatorMotion {
  id: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  thickness: number;
  lowerLanding: THREE.Vector3;
  upperLanding: THREE.Vector3;
  material?: THREE.Material;
}
export interface Elevator {
  spec: ElevatorSpec;
  mesh: THREE.Mesh;
  collider: THREE.Box3;
  previous: THREE.Box3;
  elapsed: number;
  deltaY: number;
  blocked: boolean;
  dock: 'lower' | 'upper' | null;
}
/** Dynamic world geometry, owned and advanced here just like its registries. */
export const elevators: Elevator[] = [];

/** Register without touching the scene, also usable by Node verification. */
export function registerElevator(spec: ElevatorSpec): Elevator {
  const numbers = [spec.x, spec.z, spec.width, spec.depth, spec.thickness, spec.lowerY,
    spec.upperY, spec.speed, spec.dwell, ...spec.lowerLanding.toArray(), ...spec.upperLanding.toArray()];
  if (!spec.id || elevators.some(e => e.spec.id === spec.id) || !numbers.every(Number.isFinite)
      || spec.width <= 0 || spec.depth <= 0 || spec.thickness <= 0 || spec.lowerY < spec.thickness
      || spec.upperY <= spec.lowerY || spec.speed <= 0 || spec.dwell <= 0) {
    throw new Error('Invalid or duplicate elevator specification');
  }
  const mesh = createSolidBox(spec.x, spec.lowerY - spec.thickness, spec.z,
    spec.width, spec.thickness, spec.depth, spec.material);
  mesh.updateMatrixWorld(true);
  const collider = new THREE.Box3().setFromObject(mesh);
  const elevator: Elevator = { spec, mesh, collider, previous: collider.clone(), elapsed: 0,
    deltaY: 0, blocked: false, dock: 'lower' };
  solids.push(mesh);
  colliders.push(collider);
  elevators.push(elevator);
  // A* uses metres. Convert the expected half-cycle wait and ride to walking
  // distance (5 m/s); the geometric edge length remains the lower bound.
  const travel = (spec.upperY - spec.lowerY) / spec.speed;
  navLinks.push({ bottom: spec.lowerLanding.clone(), top: spec.upperLanding.clone(),
    halfWidth: Math.min(spec.width, spec.depth) / 2, elevatorId: spec.id,
    extraCost: (2 * travel + spec.dwell) * 5 });
  return elevator;
}

export function addElevator(spec: ElevatorSpec): Elevator {
  const elevator = registerElevator(spec);
  scene.add(elevator.mesh);
  return elevator;
}

/** Called before actor updates, so raycasts and physics see the same deck. */
export function updateElevators(dt: number, bodies: readonly ElevatorBody[]): void {
  for (const e of elevators) {
    e.previous.copy(e.collider);
    const next = elevatorSample(e.spec, e.elapsed + dt);
    const dy = next.topY - e.collider.max.y;
    e.blocked = elevatorBlocked(e.collider, dy, bodies, colliders);
    e.deltaY = e.blocked ? 0 : dy;
    if (e.blocked) continue;
    e.elapsed += dt;
    e.dock = next.dock;
    e.mesh.position.y = next.topY - e.spec.thickness / 2;
    e.mesh.updateMatrixWorld(true);
    e.collider.min.y = next.topY - e.spec.thickness;
    e.collider.max.y = next.topY;
  }
}

/** Each actor consumes its support displacement once, before its own input. */
export function elevatorCarry(body: ElevatorBody): number {
  for (const e of elevators) {
    const others = colliders.filter(c => c !== e.collider);
    if (elevatorSupports(body, e.previous, others)) return e.deltaY;
  }
  return 0;
}

/**
 * Register a mesh as a raycast target only — no movement AABB.
 *
 * For the ground planes in both builders: they need decals and must stop
 * bullets, but movement is bounded by other geometry instead (maps/arena.ts's
 * perimeter walls, maps/range.ts's lane walls). Giving a flat plane an AABB would
 * not trap anyone — it would simply do nothing: a PlaneGeometry rotated -PI/2
 * measures to a ZERO-HEIGHT box at y ~ 0, which collidesAt always reads as
 * steppable floor.
 *
 * That distinction matters when you extend a map. Geometry with real HEIGHT —
 * a thick floor slab, a raised platform, a ramp — is NOT this case. Routing
 * one of those through here ships a walk-through floor; it belongs in
 * addSolidBox (or registerSolidBox, if you positioned it yourself).
 */
export function registerSolid(mesh: THREE.Object3D): THREE.Object3D {
  solids.push(mesh);
  return mesh;
}

/**
 * Register a mesh as BOTH a raycast target and a movement blocker.
 *
 * The AABB is resolved from the mesh's current world transform, so the mesh
 * must already be positioned (and parented, if it has a parent — see
 * registerGroupParts) before calling.
 */
export function registerSolidBox(mesh: THREE.Object3D): THREE.Object3D {
  solids.push(mesh);
  colliders.push(new THREE.Box3().setFromObject(mesh));
  return mesh;
}

/**
 * Register the parts of a transformed group.
 *
 * Flushes the group's world matrix FIRST. `Box3.setFromObject` composes each
 * part against its parent's CURRENT matrixWorld, which stays identity until
 * the first render — so measuring before the flush puts every AABB at the map
 * origin regardless of where the group sits (`faa52c5`: every range target's
 * collision box landed at 0,0,0).
 *
 * `shootable` and `blocking` are separate lists on purpose: a range target's
 * post blocks walking but is not a bullet target, so a single-list API would
 * silently change behavior.
 *
 * @param group positioned parent
 * @param parts.shootable raycast targets
 * @param parts.blocking  movement blockers
 */
export function registerGroupParts(
  group: THREE.Object3D,
  { shootable = [], blocking = [] }: { shootable?: THREE.Object3D[]; blocking?: THREE.Object3D[] } = {},
): void {
  group.updateMatrixWorld(true);
  solids.push(...shootable);
  for (const part of blocking) colliders.push(new THREE.Box3().setFromObject(part));
}

/**
 * Build a box mesh sitting on y = `y`. No scene, no registration — pure, so
 * the base-vs-centre convention below is unit-testable in plain Node.
 *
 * `y` is the box's BASE, not its centre: callers place walls and crates by the
 * ground they stand on. BoxGeometry is centred on its origin, so the mesh has
 * to be lifted by half its height. Drop that lift and every solid in both maps
 * sinks halfway into the floor.
 *
 * @param x centre x
 * @param y base y — the box's BASE, not its centre
 * @param z centre z
 * @param mat surface material; omitted means Mesh's own default
 * @returns unregistered, not in the scene
 */
export function createSolidBox(x: number, y: number, z: number, w: number, h: number, d: number, mat?: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y + h / 2, z); // BoxGeometry is centered; shift up so base sits at y
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

/**
 * Create a box sitting on y = `y`, add it to the scene, and register it in
 * both registries. The shared body of what `maps/arena.ts` and `maps/range.ts`
 * each used to implement separately, and the default for walls and crates.
 *
 * Browser-only: this is the one function here that touches the scene, so it
 * requires initEngine() to have run.
 *
 * @param x centre x
 * @param y base y — the box's BASE, not its centre
 * @param z centre z
 * @param mat surface material; omitted means Mesh's own default
 */
export function addSolidBox(x: number, y: number, z: number, w: number, h: number, d: number, mat?: THREE.Material): THREE.Mesh {
  const mesh = createSolidBox(x, y, z, w, h, d, mat);
  scene.add(mesh);
  registerSolidBox(mesh);
  return mesh;
}

/** Cardinal directions a stair flight can ascend along. */
export type StairDir = 'x+' | 'x-' | 'z+' | 'z-';

/**
 * Build a flight of stairs ascending along one cardinal direction from (x, z).
 *
 * Each step is a FULL-HEIGHT solid box from base `y` — no floating treads —
 * so bullets, decals and movement AABBs all behave like ordinary walls, and
 * collision.ts's step-up logic climbs the risers automatically. The top step
 * reaches exactly `y + count * stepH`: place the landing platform at that
 * height with its face flush against the last step for a seamless join.
 *
 * Also registers the flight's endpoints as a NavLink, so navigation gets
 * stairs for free from the same call that builds them — there is no second
 * place to keep in sync, and a map cannot ship a flight bots cannot see.
 *
 * Browser-only: composes addSolidBox, which touches the scene.
 *
 * @param x centre x of the flight's first step
 * @param y base y — the ground the stairs stand on
 * @param z centre z of the flight's first step
 * @param width stair width across the direction of travel (m)
 * @param stepH riser height per step; keep at or below STEP_HEIGHT or the
 *        steps become walls instead of climbable floors
 * @param stepD tread depth per step (m)
 * @param count number of steps
 * @param mat surface material; omitted means Mesh's own default
 * @param dir direction of ascent; the flight advances this way step by step
 */
export function addStairs(
  x: number,
  y: number,
  z: number,
  width: number,
  stepH: number,
  stepD: number,
  count: number,
  mat?: THREE.Material,
  dir: StairDir = 'z+',
): void {
  navLinks.push(stairLink(x, y, z, width, stepH, stepD, count, dir));
  for (let i = 0; i < count; i++) {
    const rise = (i + 1) * stepH;
    const run = (i + 0.5) * stepD;
    const cx = dir === 'x+' ? x + run : dir === 'x-' ? x - run : x;
    const cz = dir === 'z+' ? z + run : dir === 'z-' ? z - run : z;
    addSolidBox(cx, y, cz,
      dir === 'z+' || dir === 'z-' ? width : stepD,
      rise,
      dir === 'z+' || dir === 'z-' ? stepD : width,
      mat);
  }
}

/**
 * Build an OPEN flight — thin treads on two stringers, with air underneath.
 *
 * `addStairs` builds each step as a full-height box from the ground up, which
 * is what makes it bulletproof and also what makes it a wall: a solid flight
 * standing in the open is a 13 m wedge of cover. maps/warehouse2.ts puts both
 * its main flights in the middle of a 44 x 24 void, where that wedge would
 * dominate the space the void exists to create. These are the steel stairs the
 * greybox draws instead, and you can walk under them.
 *
 * Walk-under needs no special case anywhere. collision.ts:blocks already
 * ignores a collider whose UNDERSIDE is at or above `feet + HEAD_HEIGHT`, so a
 * tread stops blocking as soon as the flight has climbed clear of a standing
 * body — at stepH 0.3 and treadT 0.16 that is the eighth tread up, leaving the
 * rest of the run open. The graph gets it for free too: sim/navGrid.ts seeds
 * ground into every column before probing surface tops, precisely so a floor
 * under something elevated keeps its cells.
 *
 * Tread TOPS sit exactly where addStairs' step tops sit, so climbing,
 * descend-stick and the NavLink arithmetic are all identical — resolveVertical
 * is swept and explicitly documented against thin treads, so nothing tunnels
 * through them either.
 *
 * The stringers are registered SHOOTABLE BUT NOT BLOCKING, which is the split
 * registerGroupParts exists for. They have to be: they are rotated meshes, and
 * a rotated box's world AABB is the entire wedge — giving them collision would
 * wall off the underside and undo the whole point of the flight.
 *
 * Browser-only: composes addSolidBox, which touches the scene.
 *
 * @param x centre x of the flight's first tread
 * @param y base y — the ground the stairs stand on
 * @param z centre z of the flight's first tread
 * @param width stair width across the direction of travel (m)
 * @param stepH riser height per step; keep at or below STEP_HEIGHT
 * @param stepD tread depth per step (m)
 * @param count number of steps
 * @param treadT tread thickness (m) — the visible plate, hung below its top
 * @param mat surface material; omitted means Mesh's own default
 * @param dir direction of ascent
 */
export function addOpenStairs(
  x: number,
  y: number,
  z: number,
  width: number,
  stepH: number,
  stepD: number,
  count: number,
  treadT: number,
  mat?: THREE.Material,
  dir: StairDir = 'z+',
): void {
  navLinks.push(stairLink(x, y, z, width, stepH, stepD, count, dir));
  const alongZ = dir === 'z+' || dir === 'z-';
  for (let i = 0; i < count; i++) {
    const run = (i + 0.5) * stepD;
    const cx = dir === 'x+' ? x + run : dir === 'x-' ? x - run : x;
    const cz = dir === 'z+' ? z + run : dir === 'z-' ? z - run : z;
    addSolidBox(cx, openTreadBase(y, i, stepH, treadT), cz,
      alongZ ? width : stepD,
      treadT,
      alongZ ? stepD : width,
      mat);
  }

  // Stringers: one rotated beam per side, spanning mouth to landing.
  const totalRun = count * stepD;
  const totalRise = count * stepH;
  const angle = Math.atan2(totalRise, totalRun);
  const length = Math.hypot(totalRun, totalRise);
  const sign = dir === 'x+' || dir === 'z+' ? 1 : -1;
  const group = new THREE.Group();
  const parts: THREE.Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(alongZ ? 0.2 : length, 0.34, alongZ ? length : 0.2),
      mat);
    const offset = side * (width / 2 - 0.1);
    beam.position.set(
      alongZ ? x + offset : x + sign * totalRun / 2,
      y + totalRise / 2 - 0.2,
      alongZ ? z + sign * totalRun / 2 : z + offset,
    );
    if (alongZ) beam.rotation.x = -sign * angle;
    else beam.rotation.z = sign * angle;
    beam.castShadow = beam.receiveShadow = true;
    group.add(beam);
    parts.push(beam);
  }
  scene.add(group);
  registerGroupParts(group, { shootable: parts });
}

/**
 * Build a launch pad: a low pad that throws whatever stands on it up to
 * `landing`.
 *
 * The pad itself is an ordinary solid — you walk onto it, it is shot at, it
 * takes decals — so it goes through addSolidBox like anything else. What makes
 * it a lift is the second registration into `liftPads`, which player.ts and
 * bots.ts consult through sim/lift.ts:launchFrom after their vertical resolve.
 *
 * Keep `h` at or below collision.ts:STEP_HEIGHT. A taller pad has to be JUMPED
 * onto, and bots have no jump in BrainIntent — they would path to a lift they
 * could never board.
 *
 * The published NavLink is `oneWay`, which is what the name promises: routing
 * a bot DOWN a lift would walk it off the deck onto the pad, which launches it
 * again, forever.
 *
 * @param x centre x of the pad
 * @param y base y — the ground the pad sits on
 * @param z centre z of the pad
 * @param w/d pad footprint (m)
 * @param h pad height; at or below STEP_HEIGHT so it can be walked onto
 * @param launchVel upward velocity imparted (m/s); see sim/lift.ts:launchApex
 * @param landing where the arc is meant to put a body down — the NavLink's top
 * @param mat surface material
 */
export function addLiftPad(
  x: number,
  y: number,
  z: number,
  w: number,
  d: number,
  h: number,
  launchVel: number,
  landing: THREE.Vector3,
  mat?: THREE.Material,
): void {
  addSolidBox(x, y, z, w, h, d, mat);
  liftPads.push({
    minX: x - w / 2, maxX: x + w / 2,
    minZ: z - d / 2, maxZ: z + d / 2,
    topY: y + h,
    launchVel,
  });
  navLinks.push({
    bottom: new THREE.Vector3(x, y + h, z),
    top: landing.clone(),
    halfWidth: Math.min(w, d) / 2,
    oneWay: true,
  });
}

/**
 * Base y of an open flight's tread `index`, counting from 0.
 *
 * Pure and separate for the same reason createSolidBox is: the convention it
 * encodes is invertible-looking and load-bearing. addSolidBox takes a BASE, but
 * what a walker meets is the TOP, and the top has to land on exactly the same
 * `(index + 1) * stepH` a solid step from addStairs would — otherwise climbing,
 * descend-stick and the NavLink all disagree about where the flight is. So the
 * plate hangs BELOW its walking surface rather than sitting on it, and the
 * thickness is subtracted rather than added.
 *
 * It is also what decides how much of the flight you can walk under: a tread
 * stops blocking a body once this base clears collision.ts:HEAD_HEIGHT.
 */
export function openTreadBase(y: number, index: number, stepH: number, treadT: number): number {
  return y + (index + 1) * stepH - treadT;
}

/**
 * The endpoints addStairs would build a flight between, without building it.
 *
 * Pure and separate so the arithmetic is testable against the coordinates the
 * map builders document independently — maps/elevation.ts states its internal
 * flight tops out at z = 0 and its external one at z = 12.5, and this must
 * agree with both or navigation is aiming at nothing.
 */
export function stairLink(
  x: number,
  y: number,
  z: number,
  width: number,
  stepH: number,
  stepD: number,
  count: number,
  dir: StairDir,
): NavLink {
  // (x, z) is the flight's origin — step 0's centre sits half a tread along
  // dir from it — so the origin itself is the floor immediately at the mouth.
  // The far edge of the last step is count treads along, at count risers up.
  const run = count * stepD;
  return {
    halfWidth: width / 2,
    bottom: new THREE.Vector3(x, y, z),
    top: new THREE.Vector3(
      dir === 'x+' ? x + run : dir === 'x-' ? x - run : x,
      y + count * stepH,
      dir === 'z+' ? z + run : dir === 'z-' ? z - run : z,
    ),
  };
}

/** Two solids whose TOP faces share a plane, and the footprint they share. */
export interface CoplanarTop {
  /** The plane both tops lie in. */
  y: number;
  /** The shared footprint, in world x/z. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Area of that footprint, m^2 — how much surface is fighting. */
  area: number;
}

/**
 * Every pair of boxes whose top faces are coplanar AND overlap in x/z.
 *
 * That combination is a rendering bug with no visual tell in the source: two
 * up-facing surfaces at the same height write the same depth, so which one
 * wins is decided by the opaque draw order, three.js re-sorts that by distance
 * every frame, and the winner flips as the camera moves. It reads as a patch
 * of surface flickering between two materials. Coincident faces pointing in
 * OPPOSITE directions (a slab resting on a wall) are fine — backface culling
 * means only one of them is ever drawn — which is why this looks only at tops.
 *
 * Pure, and O(n^2) over the collider list, so it is for a DEV-only check at
 * build time rather than anything per-frame.
 *
 * @param tol how far apart two tops may sit and still count as one plane, and
 *   how much footprint overlap to dismiss as float noise (m). The colliders
 *   are measured from float32 vertex data, where one ulp at this map's scale
 *   is ~2e-6 m; the default sits 50x above that and 600x below the smallest
 *   overlap a builder could write by hand.
 */
export function coplanarTopOverlaps(boxes: readonly THREE.Box3[], tol = 1e-4): CoplanarTop[] {
  const found: CoplanarTop[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      if (Math.abs(a.max.y - b.max.y) > tol) continue;
      const minX = Math.max(a.min.x, b.min.x), maxX = Math.min(a.max.x, b.max.x);
      const minZ = Math.max(a.min.z, b.min.z), maxZ = Math.min(a.max.z, b.max.z);
      if (maxX - minX <= tol || maxZ - minZ <= tol) continue;
      found.push({ y: a.max.y, minX, maxX, minZ, maxZ, area: (maxX - minX) * (maxZ - minZ) });
    }
  }
  return found;
}

/** Empty both registries. Used by tests to isolate cases; not used at runtime. */
export function resetWorld(): void {
  solids.length = 0;
  colliders.length = 0;
  navLinks.length = 0;
  liftPads.length = 0;
  elevators.length = 0;
}
