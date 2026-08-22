import * as THREE from 'three';
import { scene, impacts } from './core.js';

export function spawnImpact(point) {
  const g = new THREE.SphereGeometry(0.05, 6, 6);
  const m = new THREE.MeshBasicMaterial({ color: 0xffe0a0 });
  const p = new THREE.Mesh(g, m);
  p.position.copy(point);
  scene.add(p);
  impacts.push({ mesh: p, t: 0.25 });
}

export function updateEffects(dt) {
  for (let i = impacts.length - 1; i >= 0; i--) {
    impacts[i].t -= dt;
    impacts[i].mesh.scale.multiplyScalar(1 + dt * 4);
    if (impacts[i].t <= 0) { scene.remove(impacts[i].mesh); impacts.splice(i, 1); }
  }
}
