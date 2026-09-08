import type { WeaponId } from './state';
import type { WeaponViewModel } from './weaponModels';
import type { WeaponPose } from '../sim/weaponAnimation';
import { poseShotgunReload } from './shotgunPresentation';
import { poseRevolverReload } from './revolverPresentation';

/** Apply absolute offsets to saved rest transforms, never accumulate rotations. */
export function poseWeapon(vm: WeaponViewModel, id: WeaponId, pose: WeaponPose,
  now: number, ads: number, running: number): void {
  for (const [node, rest] of vm.rest) {
    node.position.copy(rest.position);
    node.rotation.copy(rest.rotation);
  }
  const { mechanisms: m, group } = vm;
  const quiet = (1 - ads) * (1 - pose.reload);
  // Reloading tilts the weapon to the right and dips it slightly; it does not
  // travel. The z push-back and the per-weapon reload yaw that used to live here
  // existed to hold a magwell or loading port inside a fixed arm's reach, and
  // with the arms gone they only shrink the prop and swing it off its own frame.
  group.position.set(-0.10 * pose.reload - 0.045 * pose.swing,
    -0.05 * pose.reload - 0.12 * pose.draw - 0.055 * running + Math.sin(now * 1.7) * 0.0012 * quiet,
    -0.16 * pose.swing + 0.07 * pose.draw);
  group.rotation.set(0.10 * pose.reload - 0.22 * pose.draw + 0.16 * running - 0.6 * pose.swing,
    0.1 * pose.swing,
    0.28 * pose.reload - 0.22 * running - 0.45 * pose.swing);
  if (m.magazine) m.magazine.position.y -= 0.18 * pose.magazine;
  if (m.pump) m.pump.position.z += 0.095 * pose.pump;
  if (m.bolt) {
    m.bolt.rotation.z += 1.15 * Math.max(pose.boltLift, pose.charge);
    m.bolt.position.z += 0.105 * Math.max(pose.boltPull, pose.charge);
  }
  if (m.slide) m.slide.position.z += 0.045 * Math.max(pose.slide, pose.charge);
  if (m.cylinder) {
    m.cylinder.rotation.z += 1.60 * pose.cylinder;
  }
  if (m.rotor) m.rotor.rotation.z += Math.PI / 3 * pose.index;
  if (m.hammer) m.hammer.rotation.x -= 0.5 * pose.hammer;
  if (m.shell) {
    m.shell.visible = pose.shell;
    m.shell.position.set(id === 'revolver' ? -0.09 : -0.025 * (1 - pose.insert),
      id === 'revolver' ? -0.085 : -0.20 + 0.065 * pose.insert,
      (id === 'revolver' ? 0.09 : 0.065) - 0.065 * pose.insert);
  }
  // The authored weapons override the generic shell path above with a trajectory
  // anchored to their own loading port, and the shotgun additionally replaces the
  // group transform to expose that port.
  if (id === 'shotgun' && pose.reload > 0) poseShotgunReload(vm, pose);
  if (id === 'revolver') poseRevolverReload(vm, pose);
}
