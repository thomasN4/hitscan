import * as THREE from 'three';
import type { WeaponPose } from '../sim/weaponAnimation';
import type { WeaponViewModel } from './weaponModels';

/** Reload-specific blocking: support the pump, expose the underside, feed with
 * the right hand. All transforms are absolute and driven by existing clocks.
 */
export function poseShotgunReload(vm: WeaponViewModel, pose: WeaponPose,
  right: THREE.Vector3, left: THREE.Vector3, rightRotation: THREE.Euler, leftRotation: THREE.Euler): void {
  const amount = pose.reload;
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.0, .32, 2.8));
  const receiverLocal = new THREE.Vector3(0, -.069, .035).add(vm.body.position);
  const receiver = receiverLocal.clone().applyQuaternion(vm.group.quaternion).add(vm.group.position);
  receiver.lerp(new THREE.Vector3(-.12, -.02, -.43), amount);
  receiver.z += .08 * Math.sin(Math.PI * amount); // Bring the pump inward during the turn.
  vm.group.quaternion.slerp(rotation, amount);
  // Rotate about the receiver, not the distant camera origin: otherwise the
  // intermediate pose swings the pump outside the support arm's reach.
  vm.group.position.copy(receiver).sub(receiverLocal.applyQuaternion(vm.group.quaternion));

  // The left palm stays on the pump throughout each shell cycle.
  left.copy(vm.anchors.left);
  left.z += .075 * amount; // Support the rear of the pump when the muzzle rises.
  leftRotation.set(-.55, -Math.PI / 2, .1);
  const shell = vm.mechanisms.shell;
  if (!shell) throw new Error('Shotgun viewmodel is missing its loading shell');
  // The visible shell travels nose-first along the tube axis, starting just
  // below the loading port. Wrist and shell share a fixed pinch offset.
  shell.position.set(.008, -.165 + .055 * pose.insert, .090 - .120 * pose.insert);
  // Release into the tube before the hand starts withdrawing for another shell.
  shell.visible = pose.shell && pose.insert < .95;
  const inverse = vm.group.quaternion.clone().invert();
  const pinchOffset = new THREE.Vector3(.065, -.035, .018).applyQuaternion(inverse);
  const feeding = shell.position.clone().add(pinchOffset);
  const retrieve = shell.position.clone().add(new THREE.Vector3(.22, -.22, .06).applyQuaternion(inverse));
  retrieve.lerp(feeding, pose.reach);
  right.lerp(retrieve, amount);
  // Carry the shell with the fingers during approach, not independently ahead
  // of the hand. Its final trajectory still feeds nose-first into the port.
  shell.position.copy(right).sub(pinchOffset);
  const grip = new THREE.Quaternion().setFromEuler(rightRotation);
  const pinch = inverse.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, 0, .95)));
  grip.slerp(pinch, amount);
  rightRotation.setFromQuaternion(grip);
}

/** A shell pinch needs an extended thumb and different finger curls from a
 * trigger grip. Blend back on completion/cancellation through the reload pose.
 */
export function poseShotgunFingers(vm: WeaponViewModel, amount: number): void {
  vm.hands.right.fingers.forEach((bone, i) => {
    const finger = Math.floor(i / 3);
    const target = finger < 2 ? (i % 3 === 0 ? -.38 : -.65) : -.95;
    bone.rotation.x = THREE.MathUtils.lerp(bone.rotation.x, target, amount);
  });
  const thumb = vm.hands.right.thumb;
  thumb.rotation.x = THREE.MathUtils.lerp(thumb.rotation.x, -.15, amount);
  thumb.rotation.z = THREE.MathUtils.lerp(thumb.rotation.z, -.85, amount);
}
