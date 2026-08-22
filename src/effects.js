// effects.js — short-lived visual effects (currently: bullet impact puffs).
//
// Effects are fire-and-forget meshes tracked in core.impacts; updateEffects
// scales them up and removes them when their lifetime expires.
import * as THREE from 'three';
import { scene, impacts } from './core.js';

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
