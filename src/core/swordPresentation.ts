// The arming sword's RMB slash and LMB+RMB overhead cut on the viewmodel.
// Presentation only — a cut's damage resolves on the stroke frame
// (weapons.ts:swingMelee), like the knife's jab; this is the blade wound up
// and then carrying through.
import * as THREE from 'three';
import { SWORD_GRIP, type WeaponViewModel } from './weaponModels';
import type { WeaponPose } from '../sim/weaponAnimation';

const swing = new THREE.Quaternion();
const turn = new THREE.Quaternion();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * The sword arm's shoulder, camera space (m): right of, below and just
 * behind the eye. A slash swings the whole arm from here.
 */
const SHOULDER = new THREE.Vector3(0.16, -0.22, 0.06);
/** Shoulder to hand at the guard. */
const ARM = new THREE.Vector3(SWORD_GRIP.x, SWORD_GRIP.y, SWORD_GRIP.z).sub(SHOULDER);
/**
 * The slash's plane, camera space, as the axis it turns about: tilted 45° so
 * a positive turn carries a forward blade left AND down — high right to low
 * left. Fitted per frame to lie square to the blade (see poseSlash).
 */
const CUT_AXIS = new THREE.Vector3(-1, 1, 0).normalize();
/** Turn (rad) about the cut axis the stroke winds back to, and cuts through to. */
const WIND_BACK = 1.2;
const CUT_THROUGH = 0.8;
/** Share of the turn the arm makes from the shoulder; the wrist makes the rest. */
const ARM_SHARE = 0.375;
/**
 * How far (m, camera space) the hand rises with the wind-up. It rides the
 * stroke's envelope, which holds still through the cut itself, so the cut
 * stays a pure turn about the edge axis; without it the guard hand sits at
 * the frame's bottom edge and the cut leaves the view at once.
 */
const LIFT = new THREE.Vector3(0.02, 0.15, 0.03);
const arm = new THREE.Vector3();
const blade = new THREE.Vector3();
const flat = new THREE.Vector3();
const axis = new THREE.Vector3();
const cross = new THREE.Vector3();

/**
 * Cut with the EDGE: the blade turns only about the normal of its own flat,
 * so every point of it moves along the edge, never broadside — any other
 * turn, the old yaw/pitch/roll mix included, swings the flat into the target
 * and reads as a slap (playtest of #164). So the wind-up first rolls the
 * blade about its own length until its flat lies across the cut plane (the
 * wrist turning the edge into the cut, the smaller way round), and from
 * there arm and wrist both turn about that one axis: the arm from the
 * shoulder, so the hand rises high right and crosses to low left, and the
 * wrist on top. The hand's LIFT is the one motion off that axis, and it
 * happens in the wind-up and the recovery, never during the cut. Applied in
 * camera space on top of the guard pose.
 */
export function poseSlash(vm: WeaponViewModel, pose: WeaponPose): void {
  const a = pose.slash;
  if (a === 0) return;
  const t = pose.slashSweep;
  const guard = vm.body.quaternion;
  // Model space: the blade runs down -z from the grip, its flats face ±x.
  blade.set(0, 0, -1).applyQuaternion(guard);
  flat.set(1, 0, 0).applyQuaternion(guard);
  axis.copy(CUT_AXIS).addScaledVector(blade, -CUT_AXIS.dot(blade)).normalize();
  let roll = Math.atan2(blade.dot(cross.crossVectors(flat, axis)), flat.dot(axis));
  // Either face of the flat may lead into the cut; take the shorter roll.
  if (roll > Math.PI / 2) roll -= Math.PI;
  else if (roll < -Math.PI / 2) roll += Math.PI;
  const angle = a * (-WIND_BACK + (WIND_BACK + CUT_THROUGH) * t);
  swing.setFromAxisAngle(axis, ARM_SHARE * angle);
  vm.group.position.add(arm.copy(ARM).applyQuaternion(swing).sub(ARM)).addScaledVector(LIFT, a);
  guard.premultiply(turn.setFromAxisAngle(blade, a * roll))
    .premultiply(turn.setFromAxisAngle(axis, (1 - ARM_SHARE) * angle))
    .premultiply(swing);
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
