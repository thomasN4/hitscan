// effects.js — visual effects: transient impact puffs and persistent
// bullet-hole decals.
//
// Impacts are fire-and-forget meshes tracked in core.impacts, updated by
// updateEffects. Bullet holes are static decals tracked in core.bulletHoles
// with a FIFO cap — they need no per-frame update.
import * as THREE from 'three';
import { scene } from './core/engine.js';
import { impacts, bulletHoles } from './core/state.js';

/**
 * Spawn a small bright sphere at `point` that swells and fades over 0.25s.
 * Used both for player bullet impacts on geometry and as a cheap bot
 * muzzle flash.
 */
export function spawnImpact(point) {
  const g = new THREE.SphereGeometry(0.05, 6, 6);
  const m = new THREE.MeshBasicMaterial({ color: 0xffe0a0 });
  const p = new THREE.Mesh(g, m);
  p.position.copy(point);
  scene.add(p);
  impacts.push({ mesh: p, t: 0.25 }); // t = remaining lifetime in seconds
}

/** Advance effect lifetimes. Called every frame (even while paused). */
export function updateEffects(dt) {
  for (let i = impacts.length - 1; i >= 0; i--) {
    impacts[i].t -= dt;
    impacts[i].mesh.scale.multiplyScalar(1 + dt * 4); // swell outward
    if (impacts[i].t <= 0) { scene.remove(impacts[i].mesh); impacts.splice(i, 1); }
  }
}

// ---------- Bullet hole decals ----------
// Shared geometry/material for all decals — one allocation, N draw calls.
const HOLE_RADIUS = 0.06;
const holeGeo = new THREE.CircleGeometry(HOLE_RADIUS, 8);
const holeMat = new THREE.MeshBasicMaterial({
  color: 0x1a1a1a,
  transparent: true,
  opacity: 0.85,
  polygonOffset: true,      // push decal back in depth buffer...
  polygonOffsetFactor: -1,  // ...so it never z-fights with the wall
});
const MAX_HOLES = 200;

const tmpTarget = new THREE.Vector3();

/**
 * Stamp a permanent-looking bullet hole on a surface.
 *
 * @param {THREE.Vector3} point - hit position from the bullet raycast
 * @param {THREE.Vector3} normal - surface normal in WORLD space (use
 *   `hit.face.normal.clone().transformDirection(hit.object.matrixWorld)`
 *   — face normals are object-space and walls/ground are rotated meshes)
 *
 * Capped at MAX_HOLES via FIFO: once full, the oldest decal is removed so
 * long sessions can't accumulate unbounded draw calls.
 */
export function spawnBulletHole(point, normal) {
  const hole = new THREE.Mesh(holeGeo, holeMat);

  // Lift slightly off the surface along the normal to avoid z-fighting,
  // then orient the circle to face out of the wall.
  hole.position.copy(point).addScaledVector(normal, 0.01);
  tmpTarget.copy(point).add(normal);
  hole.lookAt(tmpTarget);
  // Random roll around the normal so repeated hits don't look stamped
  hole.rotateZ(Math.random() * Math.PI * 2);

  scene.add(hole);
  bulletHoles.push(hole);

  if (bulletHoles.length > MAX_HOLES) {
    const oldest = bulletHoles.shift();
    scene.remove(oldest);
  }
}
