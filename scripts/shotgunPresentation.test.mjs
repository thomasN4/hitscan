import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PerspectiveCamera } from 'three';
import { WEAPONS, BASE_FOV } from '../src/core/state.ts';
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
  return createWeaponViewModel('shotgun', {shotgun: await asset('shotgun'), revolver: await asset('revolver'), pistol: await asset('pistol')});
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

/** Where a body-local point lands in NDC. vm.group has no parent here, so world
 * space IS camera space — the relationship gunGroup gives it in game once its
 * ADS terms have centred the sight line. */
function ndc(vm, local, fovDeg) {
  const camera = new PerspectiveCamera(fovDeg, 16 / 9, .1, 300);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  vm.group.updateMatrixWorld(true);
  return vm.body.localToWorld(local.clone()).project(camera);
}

test('the reload pose keeps the muzzle and port in frame at the narrowest fov', async () => {
  const vm = await model();
  // Sampled at rest for the same reason as above: the port rides the pump.
  poseWeapon(vm, 'shotgun', pose(false), 10, 0, 0);
  const muzzle = attachmentPoint(vm.authored.muzzle, vm.body);
  const port = attachmentPoint(vm.authored.port, vm.body);
  // The ADS fov is what actually clips, not BASE_FOV. At the 1.15 rad of nose-up
  // this pose replaced, the muzzle read 1.02 here — off the top edge.
  const fov = WEAPONS.shotgun.zoomFovs[0];
  expect(fov).toBeLessThan(BASE_FOV);
  for (let i = 0; i <= 20; i++) {
    const amount = i / 20;
    poseWeapon(vm, 'shotgun', { ...pose(amount > 0), reload: amount }, 10, 0, 0);
    expect(ndc(vm, muzzle, fov).y, `muzzle at reload ${amount}`).toBeLessThan(.6);
    expect(ndc(vm, port, fov).y, `port at reload ${amount}`).toBeGreaterThan(-.9);
  }
});
