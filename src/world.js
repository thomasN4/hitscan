// world.js — the ONE path by which level geometry enters the world.
//
// Every solid must land in BOTH registries or it is silently broken:
//   solids    -> raycast targets: bullets, bullet-hole decals, bot line-of-sight
//   colliders -> world-space AABBs: cheap per-frame movement tests
// A mesh in `solids` but not `colliders` can be shot but walked through; the
// reverse blocks movement but lets bullets pass. `map.js` and `range.js` each
// used to carry their own copy of this logic, and the range copy shipped
// without the `colliders` push — the whole map was no-clip (`431ac6e`).
//
// Only `addSolidBox` touches the scene. Everything else is pure, so the two
// invariants that have actually broken here — registering both registries,
// and flushing a group's world matrix before measuring it — are unit-tested
// in plain Node. `scene` is imported but read only inside `addSolidBox`, and
// core/engine.js has no module-scope side effects, so importing this file
// outside a browser is safe.
import * as THREE from 'three';
import { scene } from './core/engine.js';

/** Meshes that block bullets AND bot line-of-sight. */
export const solids = [];
/** World-space AABBs derived from solids, used for movement collision. */
export const colliders = [];

/**
 * Register a mesh as a raycast target only — no movement AABB.
 *
 * For the ground planes in both builders: they need decals and must stop
 * bullets, but walking is bounded by the perimeter walls instead, and a
 * ground-plane AABB would be a floor-height box the player stands inside.
 *
 * @param {THREE.Object3D} mesh
 * @returns {THREE.Object3D} the same mesh, for chaining
 */
export function registerSolid(mesh) {
  solids.push(mesh);
  return mesh;
}

/**
 * Register a mesh as BOTH a raycast target and a movement blocker.
 *
 * The AABB is resolved from the mesh's current world transform, so the mesh
 * must already be positioned (and parented, if it has a parent — see
 * registerGroupParts) before calling.
 *
 * @param {THREE.Object3D} mesh
 * @returns {THREE.Object3D} the same mesh, for chaining
 */
export function registerSolidBox(mesh) {
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
 * @param {THREE.Object3D} group positioned parent
 * @param {object} parts
 * @param {THREE.Object3D[]} [parts.shootable] raycast targets
 * @param {THREE.Object3D[]} [parts.blocking]  movement blockers
 */
export function registerGroupParts(group, { shootable = [], blocking = [] }) {
  group.updateMatrixWorld(true);
  solids.push(...shootable);
  for (const part of blocking) colliders.push(new THREE.Box3().setFromObject(part));
}

/**
 * Create a box sitting on y = `y`, add it to the scene, and register it in
 * both registries. The shared body of what `map.js` and `range.js` each used
 * to implement separately.
 *
 * Browser-only: this is the one function here that touches the scene, so it
 * requires initEngine() to have run.
 *
 * @param {number} x centre x
 * @param {number} y base y — the box's BASE, not its centre
 * @param {number} z centre z
 * @param {number} w width  @param {number} h height  @param {number} d depth
 * @param {THREE.Material} mat
 * @returns {THREE.Mesh}
 */
export function addSolidBox(x, y, z, w, h, d, mat) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y + h / 2, z); // BoxGeometry is centered; shift up so base sits at y
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  return registerSolidBox(mesh);
}

/** Empty both registries. Used by tests to isolate cases; not used at runtime. */
export function resetWorld() {
  solids.length = 0;
  colliders.length = 0;
}
