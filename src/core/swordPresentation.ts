// The arming sword's RMB slash and LMB+RMB overhead cut on the viewmodel.
// Presentation only — a cut's damage resolves on the stroke frame
// (weapons.ts:swingMelee), like the knife's jab; this is the blade wound up
// and then carrying through.
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

/**
 * Raise the blade over the head and bring it straight down: a pitch about the
 * grip, from tipped up and back to past the guard, while the hand rises and
 * then drops through the frame. Kept in pitch alone (plus a slight inward
 * roll) so it reads as a vertical cut rather than the slash's diagonal.
 */
export function poseOverhead(vm: WeaponViewModel, pose: WeaponPose): void {
  const a = pose.overhead;
  if (a === 0) return;
  const t = pose.overheadSweep;
  euler.set(a * (2.2 - 3.0 * t), a * 0.1 * (1 - t), a * -0.2 * (1 - t));
  vm.body.quaternion.premultiply(swing.setFromEuler(euler));
  vm.group.position.x += a * -0.10 * (1 - 0.5 * t);
  vm.group.position.y += a * (0.16 - 0.28 * t);
  vm.group.position.z += a * 0.06 * (1 - t);
}
