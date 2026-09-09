import { Vector3 } from 'three';
import type { WeaponPose } from '../sim/weaponAnimation';
import type { WeaponViewModel } from './weaponModels';
import { attachmentPoint } from './weaponAssets';

/** Follow the authored magwell axis instead of shearing through the backstrap. */
export function posePistolMagazine(vm: WeaponViewModel, pose: WeaponPose): void {
  const rig = vm.authored;
  const magazine = vm.mechanisms.magazine;
  if (!rig?.magazineOut || !magazine) throw new Error('Pistol is missing its authored magazine path');
  const travel = attachmentPoint(rig.magazineOut, vm.body).sub(attachmentPoint(rig.port, vm.body));
  // Both markers are fixed in body space; the magazine can have a transformed parent.
  const parent = magazine.parent;
  if (!parent) throw new Error('Pistol magazine is detached');
  const rest = vm.rest.get(magazine);
  if (!rest) throw new Error('Pistol magazine has no rest pose');
  const start = vm.body.worldToLocal(parent.localToWorld(rest.position.clone()));
  const target = vm.body.localToWorld(start.addScaledVector(travel, pose.magazine));
  magazine.position.copy(parent.worldToLocal(target));
}

/** Roll around the receiver so the grip and withdrawn magazine stay in frame. */
export function posePistolReload(vm: WeaponViewModel, pose: WeaponPose): void {
  const amount = pose.reload;
  const pivot = vm.body.position.clone().add(new Vector3(0, -.075, 0));
  vm.group.rotation.set(-.10 * amount, .10 * amount, -1.10 * amount);
  vm.group.position.copy(pivot).sub(pivot.clone().applyEuler(vm.group.rotation))
    .add(new Vector3(-.10, .13, -.03).multiplyScalar(amount));
}
