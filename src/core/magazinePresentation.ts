import type { WeaponPose } from '../sim/weaponAnimation';
import type { WeaponViewModel } from './weaponModels';
import { attachmentPoint } from './weaponAssets';

/** Follow the authored magwell axis instead of shearing through the backstrap. */
export function poseMagazine(vm: WeaponViewModel, pose: WeaponPose): void {
  const rig = vm.authored;
  const magazine = vm.mechanisms.magazine;
  if (!rig.port || !rig.magazineOut || !magazine) throw new Error('Weapon is missing its authored magazine path');
  const travel = attachmentPoint(rig.magazineOut, vm.body).sub(attachmentPoint(rig.port, vm.body));
  // Both markers are fixed in body space; the magazine can have a transformed parent.
  const parent = magazine.parent;
  if (!parent) throw new Error('Weapon magazine is detached');
  const rest = vm.rest.get(magazine);
  if (!rest) throw new Error('Weapon magazine has no rest pose');
  const start = vm.body.worldToLocal(parent.localToWorld(rest.position.clone()));
  const target = vm.body.localToWorld(start.addScaledVector(travel, pose.magazine));
  magazine.position.copy(parent.worldToLocal(target));
}
