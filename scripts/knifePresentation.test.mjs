import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PerspectiveCamera } from 'three';
import { BASE_FOV, WEAPONS } from '../src/core/state.ts';
import { createWeaponViewModel } from '../src/core/weaponModels.ts';
import { poseWeapon } from '../src/core/weaponPresentation.ts';
import { attachmentPoint } from '../src/core/weaponAssets.ts';
import { weaponPose } from '../src/sim/weaponAnimation.ts';

// Issue #143: the first-person swing is a stab down the view axis, not a slash
// across the frame. vm.group has no parent here, so world space IS camera space.

async function model() {
  const bytes = readFileSync(new URL('../public/assets/knife.glb', import.meta.url));
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  const knife = (await new GLTFLoader().parseAsync(buffer, '')).scene;
  return createWeaponViewModel('knife', { knife });
}
const rest = weaponPose({ id: 'knife', now: 10, shotAt: -Infinity, fireInterval: WEAPONS.knife.fireRate,
  switchedAt: -Infinity, hasOutgoing: false, aiming: false, reloading: false,
  reloadStartedAt: -Infinity, reloadT: 0, roundInterval: 0, lastRound: false,
  emptyReload: false, closeAt: -Infinity, closeBlend: 0 });

function inCamera(vm, node) {
  vm.group.updateMatrixWorld(true);
  return vm.body.localToWorld(attachmentPoint(node, vm.body));
}
const tipInCamera = vm => inCamera(vm, vm.authored.bladeTip);
function tipNdc(vm) {
  const camera = new PerspectiveCamera(BASE_FOV, 16 / 9, .1, 300);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return tipInCamera(vm).project(camera);
}

test('the swing thrusts straight down the view axis with no sweep or roll', async () => {
  const vm = await model();
  poseWeapon(vm, 'knife', rest, 10, 0, 0);
  const position = vm.group.position.clone();
  const rotation = vm.group.rotation.toArray();
  const tip = tipInCamera(vm);
  for (let i = 0; i <= 10; i++) {
    const swing = i / 10;
    poseWeapon(vm, 'knife', { ...rest, swing }, 10, 0, 0);
    expect(vm.group.rotation.toArray(), `rotation at swing ${swing}`).toEqual(rotation);
    expect(vm.group.position.x, `x at swing ${swing}`).toBe(position.x);
    expect(vm.group.position.y, `y at swing ${swing}`).toBe(position.y);
    expect(vm.group.position.z - position.z, `z at swing ${swing}`).toBeCloseTo(-.10 * swing);
  }
  // Non-vacuity: the peak actually carries the blade tip forward.
  expect(tip.z - tipInCamera(vm).z).toBeGreaterThan(.08);
});

test('the thrust carries the blade tip in toward the crosshair', async () => {
  const vm = await model();
  let previous = Infinity;
  for (let i = 0; i <= 10; i++) {
    const swing = i / 10;
    poseWeapon(vm, 'knife', { ...rest, swing }, 10, 0, 0);
    const ndc = tipNdc(vm);
    const offCentre = Math.hypot(ndc.x, ndc.y);
    expect(offCentre, `tip off-centre at swing ${swing}`).toBeLessThan(previous);
    previous = offCentre;
  }
});

test('the blade returns exactly to its rest pose after a swing', async () => {
  const vm = await model();
  poseWeapon(vm, 'knife', rest, 10, 0, 0);
  const position = vm.group.position.clone();
  const quaternion = vm.group.quaternion.clone();
  poseWeapon(vm, 'knife', { ...rest, swing: 1 }, 10, 0, 0);
  expect(vm.group.position.distanceTo(position)).toBeGreaterThan(.08);
  poseWeapon(vm, 'knife', rest, 10, 0, 0);
  expect(vm.group.position.distanceTo(position)).toBeLessThan(1e-9);
  expect(vm.group.quaternion.angleTo(quaternion)).toBeLessThan(1e-9);
});

test('the blade is held angled up and in, aimed at the crosshair inside melee reach', async () => {
  const vm = await model();
  poseWeapon(vm, 'knife', rest, 10, 0, 0);
  const grip = inCamera(vm, vm.authored.grip);
  const tip = tipInCamera(vm);
  const along = tip.clone().sub(grip).normalize();
  // Held parallel to the view axis, the pommel faced the camera end-on.
  expect(Math.acos(-along.z)).toBeGreaterThan(.2);
  // Where the blade's line passes closest to the view axis (x = y = 0).
  const t = -(grip.x * along.x + grip.y * along.y) / (along.x ** 2 + along.y ** 2);
  const closest = grip.clone().addScaledVector(along, t);
  expect(Math.hypot(closest.x, closest.y)).toBeLessThan(.05);
  expect(-closest.z).toBeGreaterThan(1);
  expect(-closest.z).toBeLessThan(WEAPONS.knife.range);
  for (const swing of [0, 1]) {
    poseWeapon(vm, 'knife', { ...rest, swing }, 10, 0, 0);
    const ndc = tipNdc(vm);
    expect(Math.max(Math.abs(ndc.x), Math.abs(ndc.y)), `tip in frame at swing ${swing}`).toBeLessThan(1);
  }
});
