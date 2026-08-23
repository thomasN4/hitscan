import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { collidesAt, TEST_BOX_MIN_Y, TEST_BOX_MAX_Y } from './collision';

/** AABB spanning y 0..height, centred on (x, z). */
const wall = (x: number, z: number, halfW = 1, height = 4): THREE.Box3 => new THREE.Box3(
  new THREE.Vector3(x - halfW, 0, z - halfW),
  new THREE.Vector3(x + halfW, height, z + halfW),
);

const at = (x: number, z: number): THREE.Vector3 => new THREE.Vector3(x, 1.7, z);
const PLAYER_RADIUS = 0.45;

describe('collidesAt', () => {
  test('blocks inside a collider', () => {
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, [wall(0, 0)])).toBe(true);
  });

  test('clears well outside', () => {
    expect(collidesAt(at(10, 10), PLAYER_RADIUS, [wall(0, 0)])).toBe(false);
  });

  test('an empty registry never blocks', () => {
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, [])).toBe(false);
  });

  test('the entity radius is what makes contact, not its centre', () => {
    // Wall spans x -1..1. A centre at 1.3 is outside, but radius 0.45 reaches
    // to 0.85 — inside. This is why walking into a wall stops you short of it.
    const colliders = [wall(0, 0)];
    expect(collidesAt(at(1.3, 0), PLAYER_RADIUS, colliders)).toBe(true);
    expect(collidesAt(at(1.6, 0), PLAYER_RADIUS, colliders)).toBe(false);
  });

  test('tests every collider, not just the first', () => {
    const colliders = [wall(-20, -20), wall(0, 0)];
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, colliders)).toBe(true);
  });
});

describe('collidesAt — the y span is fixed', () => {
  test('a knee-high crate blocks even though the eye is above it', () => {
    // The test box spans 0.1..2.0 regardless of crouch, so entities cannot
    // pass under obstacles. pos.y is ignored entirely.
    const crate = new THREE.Box3(
      new THREE.Vector3(-1.5, 0, -1.5),
      new THREE.Vector3(1.5, 0.5, 1.5),
    );
    expect(collidesAt(new THREE.Vector3(0, 1.7, 0), PLAYER_RADIUS, [crate])).toBe(true);
    expect(collidesAt(new THREE.Vector3(0, 1.0, 0), PLAYER_RADIUS, [crate])).toBe(true);
  });

  test('geometry entirely below the span does not block', () => {
    // A floor slab under TEST_BOX_MIN_Y is walked on, not walked into.
    const floor = new THREE.Box3(
      new THREE.Vector3(-50, -1, -50),
      new THREE.Vector3(50, TEST_BOX_MIN_Y - 0.01, 50),
    );
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, [floor])).toBe(false);
  });

  test('geometry entirely above the span does not block', () => {
    const overhang = new THREE.Box3(
      new THREE.Vector3(-5, TEST_BOX_MAX_Y + 0.01, -5),
      new THREE.Vector3(5, 6, 5),
    );
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, [overhang])).toBe(false);
  });
});
