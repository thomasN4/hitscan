import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { shotDirection, EULER_ORDER } from './ballistics';

/** Forward vector of a camera posed like player.ts does. */
function cameraForward(pitch: number, yaw: number, order: THREE.EulerOrder) {
  const cam = new THREE.Object3D();
  cam.rotation.set(pitch, yaw, 0, order);
  cam.updateMatrixWorld(true);
  return new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
}

describe('shotDirection — Euler order', () => {
  test('is YXZ, matching the camera in player.ts', () => {
    expect(EULER_ORDER).toBe('YXZ');
  });

  test('with no spread, points exactly where a YXZ camera looks', () => {
    // This is the invariant that `351f772` broke: the camera used YXZ while
    // shots were built with the default XYZ, so bullets left the crosshair.
    const pitch = 0.4, yaw = 1.1;
    const dir = shotDirection(pitch, yaw, 0);
    const forward = cameraForward(pitch, yaw, 'YXZ');
    expect(dir.x).toBeCloseTo(forward.x, 12);
    expect(dir.y).toBeCloseTo(forward.y, 12);
    expect(dir.z).toBeCloseTo(forward.z, 12);
  });

  test('diverges from an XYZ camera once pitch AND yaw are both non-zero', () => {
    // Pins the bug's signature: XYZ agrees on the axes but not in general,
    // which is why it went unnoticed until players looked up while turning.
    const pitch = 0.4, yaw = 1.1;
    const dir = shotDirection(pitch, yaw, 0);
    const wrong = cameraForward(pitch, yaw, 'XYZ');
    expect(dir.distanceTo(wrong)).toBeGreaterThan(0.01);
  });

  test('agrees with both orders when only one axis is rotated', () => {
    const dir = shotDirection(0.4, 0, 0);
    expect(dir.distanceTo(cameraForward(0.4, 0, 'XYZ'))).toBeLessThan(1e-9);
  });
});

describe('shotDirection — cone', () => {
  test('always returns a unit vector', () => {
    expect(shotDirection(0.3, -0.8, 0.05, () => 0.9).length()).toBeCloseTo(1, 12);
  });

  test('rng at 0.5 is the cone center — a dead-on shot', () => {
    const centered = shotDirection(0.2, 0.3, 0.05, () => 0.5);
    const noSpread = shotDirection(0.2, 0.3, 0);
    expect(centered.distanceTo(noSpread)).toBeLessThan(1e-12);
  });

  test('a wider cone scatters further from center', () => {
    const near = shotDirection(0, 0, 0.001, () => 1);
    const far = shotDirection(0, 0, 0.05, () => 1);
    const center = shotDirection(0, 0, 0);
    expect(far.distanceTo(center)).toBeGreaterThan(near.distanceTo(center));
  });
});

describe('recoil climb between consecutive shots', () => {
  test('the first shot is dead-on and the next is kicked by exactly punchRad', () => {
    // weapons.ts:shoot builds the ray BEFORE adding this shot's kick, so the
    // opening round of a burst lands on the crosshair (`5e004a5`). The next
    // shot leaves from pitch + recoilKick * punchRad.
    const pitch = 0, yaw = 0, punchRad = 0.012, recoilKick = 1;
    const first = shotDirection(pitch, yaw, 0);
    const second = shotDirection(pitch + recoilKick * punchRad, yaw, 0);

    expect(first.distanceTo(cameraForward(pitch, yaw, 'YXZ'))).toBeLessThan(1e-12);
    // Angle between them is the punch for one recoil unit.
    expect(first.angleTo(second)).toBeCloseTo(recoilKick * punchRad, 6);
  });
});
