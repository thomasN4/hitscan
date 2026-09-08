import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createWeaponViewModel } from '../src/core/weaponModels.ts';
import { poseWeapon } from '../src/core/weaponPresentation.ts';
import { attachmentPoint } from '../src/core/weaponAssets.ts';
import { weaponPose } from '../src/sim/weaponAnimation.ts';

async function asset(id) {
  const bytes = readFileSync(new URL(`../public/assets/${id}.glb`, import.meta.url));
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return (await new GLTFLoader().parseAsync(buffer, '')).scene;
}
async function model() {
  return createWeaponViewModel('shotgun', {shotgun: await asset('shotgun'), revolver: await asset('revolver')});
}
function pose(reloading, reloadT = .5) {
  return weaponPose({ id: 'shotgun', now: 10, shotAt: -10, fireInterval: .9,
    switchedAt: 0, hasOutgoing: false, aiming: false, reloading,
    reloadStartedAt: 9, reloadT, roundInterval: .6, lastRound: false,
    emptyReload: false, closeAt: 0, closeBlend: 0 });
}

test('each shell closes on the loading port and disappears as it is released', async () => {
  const vm = await model();
  // Sampled at rest, outside the loop: the port marker is parented to
  // mechanism_pump, so re-reading it per frame would fold pump travel in.
  poseWeapon(vm, 'shotgun', pose(false), 10, 0, 0);
  const port = attachmentPoint(vm.authored.port, vm.body);
  let previous = Infinity;
  for (const t of [.25, .5, .8]) {
    const p = pose(true, t);
    poseWeapon(vm, 'shotgun', p, 10, 0, 0);
    const shell = vm.mechanisms.shell;
    expect(shell.visible, `visible at ${t}`).toBe(p.shell && p.insert < .95);
    const gap = shell.position.distanceTo(port);
    expect(gap, `shell gap at reload ${t}`).toBeLessThan(previous);
    previous = gap;
  }
});

test('cancelling a reload restores the firing pose and hides the shell immediately', async () => {
  const vm = await model();
  poseWeapon(vm, 'shotgun', pose(false), 10, 0, 0);
  const position = vm.group.position.clone();
  const quaternion = vm.group.quaternion.clone();
  poseWeapon(vm, 'shotgun', pose(true), 10, 0, 0);
  // Non-vacuity: a reload that never moved the weapon would pass the restore
  // assertions below for the wrong reason.
  expect(vm.group.quaternion.angleTo(quaternion)).toBeGreaterThan(.5);
  poseWeapon(vm, 'shotgun', pose(false), 10, 0, 0);
  expect(vm.mechanisms.shell.visible).toBe(false);
  expect(vm.group.position.distanceTo(position)).toBeLessThan(1e-9);
  expect(vm.group.quaternion.angleTo(quaternion)).toBeLessThan(1e-9);
});
