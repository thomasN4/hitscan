import * as THREE from 'three';
import { colliders } from './core.js';

export function collidesAt(pos, radius) {
  const box = new THREE.Box3(
    new THREE.Vector3(pos.x - radius, 0.1, pos.z - radius),
    new THREE.Vector3(pos.x + radius, 2.0, pos.z + radius)
  );
  for (const c of colliders) if (c.intersectsBox(box)) return true;
  return false;
}

const losRaycaster = new THREE.Raycaster();
export function hasLineOfSight(from, to, solids) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const dist = dir.length();
  if (dist < 0.001) return true;
  dir.normalize();
  losRaycaster.set(from, dir);
  losRaycaster.far = dist - 0.1; // ignore the endpoint surfaces themselves
  return losRaycaster.intersectObjects(solids, false).length === 0;
}
