import { Vector3 } from 'three';
import type { WeaponPose } from '../sim/weaponAnimation';
import type { WeaponViewModel } from './weaponModels';

/** Roll about the receiver to show the long magazine clearing its well. */
export function poseRifleReload(vm: WeaponViewModel, pose: WeaponPose): void {
  const amount = pose.reload;
  const pivot = vm.body.position.clone().add(new Vector3(0, -.075, 0));
  vm.group.rotation.set(.05 * amount, -.12 * amount, -1.1 * amount);
  vm.group.position.copy(pivot).sub(pivot.clone().applyEuler(vm.group.rotation))
    .add(new Vector3(-.13, .03, -.03).multiplyScalar(amount));
}
