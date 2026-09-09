import * as THREE from 'three';
import type { WeaponPose } from '../sim/weaponAnimation';
import type { WeaponViewModel } from './weaponModels';
import { attachmentPoint } from './weaponAssets';

/** Feed the chamber the crane swing has exposed. */
export function poseRevolverReload(vm: WeaponViewModel, pose: WeaponPose): void {
  const rig = vm.authored;
  const shell = vm.mechanisms.shell;
  if (!rig || !shell) throw new Error('Revolver is missing its authored reload rig');
  const port = attachmentPoint(rig.port, vm.body);
  // The cartridge enters from behind the cylinder, along the barrel axis.
  shell.position.copy(port).add(new THREE.Vector3(0, 0, .070 - .066 * pose.insert));
  shell.visible = pose.shell && pose.insert < .95;
}
