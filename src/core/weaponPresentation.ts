import * as THREE from 'three';
import type { WeaponId } from './state';
import type { WeaponViewModel } from './weaponModels';
import type { WeaponPose } from '../sim/weaponAnimation';
import { poseShotgunReload, poseShotgunFingers } from './shotgunPresentation';
import { poseHand } from './weaponHands';

/** Apply absolute offsets to saved rest transforms, never accumulate rotations. */
export function poseWeapon(vm: WeaponViewModel, id: WeaponId, pose: WeaponPose,
  now: number, ads: number, running: number): void {
  for (const [node, rest] of vm.rest) {
    node.position.copy(rest.position);
    node.rotation.copy(rest.rotation);
  }
  const { mechanisms: m, group, hands, anchors } = vm;
  const quiet = (1 - ads) * (1 - pose.reload);
  group.position.set(-0.095 * pose.reload - 0.045 * pose.swing,
    0.035 * pose.reload - 0.12 * pose.draw - 0.055 * running + Math.sin(now * 1.7) * 0.0012 * quiet,
    -0.12 * pose.reload - 0.16 * pose.swing + 0.07 * pose.draw);
  group.rotation.set(0.12 * pose.reload - 0.22 * pose.draw + 0.16 * running - 0.6 * pose.swing,
    (id === 'shotgun' ? 0.55 : id === 'sniper' || id === 'smg' ? 0.15 : 0) * pose.reload + 0.1 * pose.swing,
    (id === 'pistol' ? 0.48 : id === 'revolver' ? 0.22 : 0.30) * pose.reload - 0.22 * running - 0.45 * pose.swing);
  if (m.magazine) m.magazine.position.y -= 0.18 * pose.magazine;
  if (m.pump) m.pump.position.z += 0.095 * pose.pump;
  if (m.bolt) {
    m.bolt.rotation.z += 1.15 * Math.max(pose.boltLift, pose.charge);
    m.bolt.position.z += 0.105 * Math.max(pose.boltPull, pose.charge);
  }
  if (m.slide) m.slide.position.z += 0.045 * Math.max(pose.slide, pose.charge);
  if (m.cylinder) {
    m.cylinder.position.x -= 0.045 * pose.cylinder;
    m.cylinder.rotation.z += 1.05 * pose.cylinder;
  }
  if (m.rotor) m.rotor.rotation.z += Math.PI / 3 * pose.index;
  if (m.hammer) m.hammer.rotation.x -= 0.5 * pose.hammer;
  if (m.shell) {
    m.shell.visible = pose.shell;
    m.shell.position.set(id === 'revolver' ? -0.09 : -0.025 * (1 - pose.insert),
      id === 'revolver' ? -0.085 : -0.20 + 0.065 * pose.insert,
      (id === 'revolver' ? 0.09 : 0.065) - 0.065 * pose.insert);
  }

  const right = anchors.right.clone();
  const left = anchors.left.clone();
  const rightRotation = new THREE.Euler(0, Math.PI / 2, -0.12);
  const leftRotation = new THREE.Euler(0, -Math.PI / 2, 0.1);
  if (id === 'shotgun' || id === 'smg' || id === 'sniper') leftRotation.x = -0.55;
  if (id === 'shotgun') left.z += 0.095 * pose.pump;
  const loadTarget = anchors.reload.clone();
  if (id === 'shotgun' || id === 'revolver') {
    if (m.shell) loadTarget.copy(m.shell.position).add(new THREE.Vector3(-0.025, -0.05, 0.012));
  } else {
    loadTarget.y -= pose.magazine * 0.18;
  }
  left.lerp(loadTarget, pose.reach);
  leftRotation.z += 0.35 * pose.reach;
  const boltReach = Math.max(pose.boltLift, id === 'sniper' ? pose.charge : 0);
  if (id === 'sniper') {
    if (m.bolt) {
      const knob = new THREE.Vector3(0.065, -0.01, 0).applyEuler(m.bolt.rotation).add(m.bolt.position);
      right.lerp(knob.add(new THREE.Vector3(0.035, -0.05, 0)), boltReach);
    }
    rightRotation.x -= boltReach * 0.55;
  } else if (pose.charge > 0) {
    left.lerp(new THREE.Vector3(-0.035, -0.065, 0.10), pose.charge);
  }
  if (id === 'shotgun' && pose.reload > 0) {
    poseShotgunReload(vm, pose, right, left, rightRotation, leftRotation);
  }
  // Shoulder anchors and pole directions are in camera-relative prop space.
  // Invert only this frame's local transforms: the camera updates later.
  group.updateMatrix();
  vm.body.updateMatrix();
  const toBody = vm.body.matrix.clone().invert().multiply(group.matrix.clone().invert());
  const rightShoulder = new THREE.Vector3(0.22, -0.40, -0.39).applyMatrix4(toBody);
  const leftShoulder = new THREE.Vector3(-0.12, -0.40 + (id === 'shotgun' ? .06 * pose.reload : 0), -0.39).applyMatrix4(toBody);
  const rightPole = new THREE.Vector3(0.6, -1, 0.3).transformDirection(toBody);
  const leftPole = new THREE.Vector3(-0.6, -1, 0.3).transformDirection(toBody);
  poseHand(hands.right, right, rightRotation, 1 - 0.25 * boltReach, rightShoulder, rightPole);
  poseHand(hands.left, left, leftRotation, id === 'shotgun' ? 1 : 1 - 0.25 * pose.reach, leftShoulder, leftPole);
  if (id === 'shotgun') poseShotgunFingers(vm, pose.reload);
}
