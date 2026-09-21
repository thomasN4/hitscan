import * as THREE from 'three';
import type { WeaponPose } from '../sim/weaponAnimation';
import type { WeaponViewModel } from './weaponModels';
import { attachmentPoint } from './weaponAssets';

/** Shell travel follows the opened barrels, including their rotated bore axes. */
export function poseSawnOffReload(vm: WeaponViewModel, pose: WeaponPose): void {
  const hinge = vm.mechanisms.hinge;
  const chambers = vm.authored.chambers;
  if (!hinge || !chambers) throw new Error('Sawn-off is missing its break-action rig');
  hinge.rotation.x -= Math.PI / 5 * pose.breakOpen;
  vm.body.updateWorldMatrix(true, true);
  const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(hinge.quaternion);
  for (const [index, key] of (['shellLeft', 'shellRight'] as const).entries()) {
    const shell = vm.mechanisms[key];
    const chamber = chambers[index];
    if (!shell || !chamber) throw new Error('Sawn-off is missing its shell presentation');
    const extracting = index < pose.spentCount;
    shell.visible = extracting || index < pose.shellCount;
    shell.quaternion.copy(hinge.quaternion);
    shell.position.copy(attachmentPoint(chamber, vm.body))
      .addScaledVector(direction, extracting ? -.024 + .13 * pose.extraction : .12 - .144 * pose.insert);
  }
}
