// The arming sword's RMB slash and LMB+RMB overhead cut on the viewmodel.
// Presentation only — a cut's damage resolves on the stroke frame
// (weapons.ts:swingMelee), like the knife's jab; this is the blade wound up
// and then carrying through.
import * as THREE from 'three';
import { SWORD_GRIP, type WeaponViewModel } from './weaponModels';
import type { WeaponPose } from '../sim/weaponAnimation';

const swing = new THREE.Quaternion();
const wrist = new THREE.Quaternion();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * The sword arm's shoulder, camera space (m): right of, below and just
 * behind the eye. A slash swings the whole arm from here.
 */
const SHOULDER = new THREE.Vector3(0.16, -0.22, 0.06);
/** Shoulder to hand at the guard. */
const ARM = new THREE.Vector3(SWORD_GRIP.x, SWORD_GRIP.y, SWORD_GRIP.z).sub(SHOULDER);
const arm = new THREE.Vector3();

/**
 * Swing the whole arm from the shoulder, from wound up high on the right to
 * finished low on the left: the hand travels an arc about SHOULDER, and the
 * blade turns with it. A flick about the grip alone read as all wrist
 * (playtest of #164); the wrist now adds only what the arm does not, so the
 * blade still lays across the view. The guard points the blade nearly down
 * the view axis, where a roll barely shows, so the cut lives in yaw and
 * pitch. Applied in camera space on top of the guard pose.
 */
export function poseSlash(vm: WeaponViewModel, pose: WeaponPose): void {
  const a = pose.slash;
  if (a === 0) return;
  const t = pose.slashSweep;
  euler.set(a * (0.55 - 0.6 * t), a * (-0.25 + 0.75 * t), 0);
  swing.setFromEuler(euler);
  vm.group.position.add(arm.copy(ARM).applyQuaternion(swing).sub(ARM));
  euler.set(a * (0.35 - 0.65 * t), a * (-0.65 + 1.25 * t), a * (0.8 - 1.3 * t));
  vm.body.quaternion.premultiply(swing.multiply(wrist.setFromEuler(euler)));
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
