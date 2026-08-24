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
// Only `addSolidBox` touches the scene. Everything else is pure, so the two
// invariants that have actually broken here — registering both registries,
// and flushing a group's world matrix before measuring it — are unit-tested
// in plain Node. `scene` is imported but read only inside `addSolidBox`, and
// core/engine.ts has no module-scope side effects, so importing this file
// outside a browser is safe.
import * as THREE from 'three';
import { scene } from './core/engine';

/** Meshes that block bullets AND bot line-of-sight. */
export const solids: THREE.Object3D[] = [];
/** World-space AABBs derived from solids, used for movement collision. */
export const colliders: THREE.Box3[] = [];

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

/** Empty both registries. Used by tests to isolate cases; not used at runtime. */
export function resetWorld(): void {
  solids.length = 0;
  colliders.length = 0;
}
