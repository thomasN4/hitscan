import * as THREE from 'three';
import type { WeaponPose } from '../sim/weaponAnimation';
import type { WeaponViewModel } from './weaponModels';
import { attachmentPoint } from './weaponAssets';

/** Reload-specific blocking: roll the receiver over to expose the underside
 * loading port and feed shells into it. All transforms are absolute and driven
 * by existing clocks.
 */
export function poseShotgunReload(vm: WeaponViewModel, pose: WeaponPose): void {
  const amount = pose.reload;
  // Roll the receiver onto its back to expose the underside loading port, and
  // pitch only enough that the shell's travel down the tube reads as vertical
  // screen motion rather than pure foreshortening. The 66 degrees of nose-up
  // this replaces existed to hold the feed hand in a fixed arm's reach; it put
  // the muzzle past the top edge at the shotgun's 60-degree ADS fov. The bound
  // is pinned in scripts/shotgunPresentation.test.mjs.
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.65, .12, 2.60));
  const receiverLocal = new THREE.Vector3(0, -.025, .0).add(vm.body.position);
  const receiver = receiverLocal.clone().applyQuaternion(vm.group.quaternion).add(vm.group.position);
  receiver.lerp(new THREE.Vector3(0, -.16, -.50), amount);
  receiver.z += .04 * Math.sin(Math.PI * amount); // Ease the turn inward, then back.
  vm.group.quaternion.slerp(rotation, amount);
  // Rotate about the receiver, not the distant camera origin: otherwise the
  // intermediate pose swings the whole prop through an arc across the frame.
  vm.group.position.copy(receiver).sub(receiverLocal.applyQuaternion(vm.group.quaternion));

  const rig = vm.authored;
  if (!rig.port) throw new Error('Shotgun is missing its authored grip rig');
  const shell = vm.mechanisms.shell;
  if (!shell) throw new Error('Shotgun viewmodel is missing its loading shell');
  // The visible shell travels nose-first along the tube axis, starting just
  // below the loading port.
  shell.position.copy(attachmentPoint(rig.port, vm.body)).add(new THREE.Vector3(.0, -.065 + .045 * pose.insert, .07 - .075 * pose.insert));
  // Release into the tube before the next shell is retrieved.
  shell.visible = pose.shell && pose.insert < .95;
}
