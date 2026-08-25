import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { shotDirection, pelletShotDirection, EULER_ORDER } from './ballistics';

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

describe('pelletShotDirection — two-layer cone', () => {
  test('zero situational spread + centered rng is a dead-on shot', () => {
    const dir = pelletShotDirection(0.2, 0.3, 0, 0.02, () => 0.5);
    const forward = cameraForward(0.2, 0.3, 'YXZ');
    expect(dir.distanceTo(forward)).toBeLessThan(1e-12);
  });

  test('a perfectly aimed shot still scatters pellets — the pattern never tightens to a laser', () => {
    // The property the shotgun rebalance rests on: with the situational cone
    // fully zeroed (perfectly steady ADS-crouched aim), the fixed pattern
    // layer still deflects pellets away from the crosshair.
    const perfectAim = pelletShotDirection(0, 0, 0, 0.02, () => 1);
    const center = cameraForward(0, 0, 'YXZ');
    expect(perfectAim.angleTo(center)).toBeGreaterThan(1e-6);
  });

  test('with no pattern it matches shotDirection given equivalent draws', () => {
    // The cone layer's rng draws are consumed even when the cone is zero, so
    // equivalence means neutralizing them at 0.5 (the no-offset draw): the
    // situational layers then see identical values and the vectors agree
    // exactly — nothing about single-ray behavior changes when cone = 0.
    const pitch = -0.3, yaw = 2;
    const pellet = pelletShotDirection(pitch, yaw, 0.05, 0, seq(0.3, 0.5, 0.3, 0.5));
    const plain = shotDirection(pitch, yaw, 0.05, seq(0.3, 0.3));
    expect(pellet.distanceTo(plain)).toBeLessThan(1e-12);
  });

  test('deflections stay inside the (spread + cone) bound', () => {
    const spread = 0.04, cone = 0.02;
    // rng extremes on BOTH axes: each axis sits at −(spread+cone)/2 in view
    // space before rotation, so the worst-case corner is √2 × that per-axis
    // figure off forward.
    const extreme = pelletShotDirection(0, 0, spread, cone, () => 0);
    const center = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(0, 0, 0, EULER_ORDER));
    const maxAngle = Math.atan((Math.SQRT2 * (spread + cone)) / 2);
    expect(extreme.angleTo(center)).toBeLessThanOrEqual(maxAngle + 1e-9);
  });
});

/** Deterministic rng cycling through the given values. */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}
