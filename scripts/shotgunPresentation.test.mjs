import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createWeaponViewModel } from '../src/core/weaponModels.ts';
import { poseWeapon } from '../src/core/weaponPresentation.ts';
import { weaponPose } from '../src/sim/weaponAnimation.ts';

async function model() {
  const bytes = readFileSync(new URL('../public/assets/arms.glb', import.meta.url));
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return createWeaponViewModel('shotgun', (await new GLTFLoader().parseAsync(buffer, '')).scene);
}
function pose(reloading, reloadT = .5) {
  return weaponPose({ id: 'shotgun', now: 10, shotAt: -10, fireInterval: .9,
    switchedAt: 0, hasOutgoing: false, aiming: false, reloading,
    reloadStartedAt: 9, reloadT, roundInterval: .6, lastRound: false,
    emptyReload: false, closeAt: 0, closeBlend: 0 });
}
function wrist(vm, hand) {
  vm.group.updateMatrixWorld(true);
  return vm.body.worldToLocal(hand.wrist.getWorldPosition(new Vector3()));
}
test('left hand supports the pump and right hand carries each shell without stretching', async () => {
  const vm = await model();
  for (const t of [.25, .5, .8]) {
    poseWeapon(vm, 'shotgun', pose(true, t), 10, 0, 0);
    expect(wrist(vm, vm.hands.left).distanceTo(vm.anchors.left.clone().add(new Vector3(0, 0, .075)))).toBeLessThan(.001);
    const shell = vm.mechanisms.shell;
    expect(shell.visible).toBe(t < .8);
    const offset = new Vector3(.065, -.035, .018).applyQuaternion(vm.group.quaternion.clone().invert());
    expect(wrist(vm, vm.hands.right).distanceTo(shell.position.clone().add(offset))).toBeLessThan(.001);
    expect(vm.hands.right.forearm.position.length()).toBeCloseTo(.3, 5);
  }
});
test('reload cancellation restores grip, finger curl and hidden shell immediately', async () => {
  const vm = await model();
  poseWeapon(vm, 'shotgun', pose(false), 10, 0, 0);
  const before = vm.hands.right.fingers.map(b => b.quaternion.clone());
  poseWeapon(vm, 'shotgun', pose(true), 10, 0, 0);
  poseWeapon(vm, 'shotgun', pose(false), 10, 0, 0);
  expect(vm.mechanisms.shell.visible).toBe(false);
  expect(wrist(vm, vm.hands.right).distanceTo(vm.anchors.right)).toBeLessThan(.001);
  vm.hands.right.fingers.forEach((b, i) => expect(b.quaternion.angleTo(before[i])).toBeLessThan(1e-6));
});


test('support hand stays on the pump through raising and lowering', async () => {
  const vm = await model();
  for (const amount of Array.from({ length: 41 }, (_, i) => i <= 20 ? i / 20 : (40 - i) / 20)) {
    const p = { ...pose(amount > 0), reload: amount };
    poseWeapon(vm, 'shotgun', p, 10, 0, 0);
    const support = vm.anchors.left.clone().add(new Vector3(0, 0, .075 * amount));
    expect(wrist(vm, vm.hands.left).distanceTo(support), `reload blend ${amount}`).toBeLessThan(.001);
  }
});
