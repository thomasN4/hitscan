// The arming sword's RMB slash on the viewmodel. Presentation only — the
// cut's damage resolves on the stroke frame (weapons.ts:swingMelee), like the
// knife's jab; this is the blade carrying through.
import * as THREE from 'three';
import type { WeaponViewModel } from './weaponModels';
import type { WeaponPose } from '../sim/weaponAnimation';

const swing = new THREE.Quaternion();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * Sweep the blade about the grip (the body origin), from wound up high on
 * the right to finished low on the left, while the hand crosses the body.
 * A rotation about the hand reads as a cut across the frame, which is the
 * motion a jab must avoid and a slash wants. The guard points the blade
 * nearly down the view axis, where a roll barely shows, so the cut lives in
 * yaw and pitch: large enough to lay the blade across the view. Applied in
 * camera space on top of the guard pose.
 */
export function poseSlash(vm: WeaponViewModel, pose: WeaponPose): void {
  const a = pose.slash;
  if (a === 0) return;
  const t = pose.slashSweep;
  euler.set(a * (0.9 - 1.5 * t), a * (-0.9 + 2.2 * t), a * (0.8 - 1.3 * t));
  vm.body.quaternion.premultiply(swing.setFromEuler(euler));
  vm.group.position.x += a * (0.10 - 0.30 * t);
  vm.group.position.y += a * (0.08 - 0.14 * t);
}
