import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import {
  collidesAt, supportHeightAt, slideMoveXZ, resolveVertical, findFreeSpawn,
  STEP_HEIGHT, HEAD_HEIGHT,
} from './collision';

/** AABB spanning y 0..height, centred on (x, z). */
const wall = (x: number, z: number, halfW = 1, height = 4): THREE.Box3 => new THREE.Box3(
  new THREE.Vector3(x - halfW, 0, z - halfW),
  new THREE.Vector3(x + halfW, height, z + halfW),
);

/** AABB spanning yBottom..yTop, centred on (x, z) — for slabs and steps. */
const slab = (x: number, z: number, yBottom: number, yTop: number, halfW = 1): THREE.Box3 => new THREE.Box3(
  new THREE.Vector3(x - halfW, yBottom, z - halfW),
  new THREE.Vector3(x + halfW, yTop, z + halfW),
);

const at = (x: number, z: number): THREE.Vector3 => new THREE.Vector3(x, 1.7, z);
const PLAYER_RADIUS = 0.45;

describe('collidesAt', () => {
  test('blocks inside a collider', () => {
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, 0, [wall(0, 0)])).toBe(true);
  });

  test('clears well outside', () => {
    expect(collidesAt(at(10, 10), PLAYER_RADIUS, 0, [wall(0, 0)])).toBe(false);
  });

  test('an empty registry never blocks', () => {
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, 0, [])).toBe(false);
  });

  test('the entity radius is what makes contact, not its centre', () => {
    // Wall spans x -1..1. A centre at 1.3 is outside, but radius 0.45 reaches
    // to 0.85 — inside. This is why walking into a wall stops you short of it.
    const colliders = [wall(0, 0)];
    expect(collidesAt(at(1.3, 0), PLAYER_RADIUS, 0, colliders)).toBe(true);
    expect(collidesAt(at(1.6, 0), PLAYER_RADIUS, 0, colliders)).toBe(false);
  });

  test('tests every collider, not just the first', () => {
    const colliders = [wall(-20, -20), wall(0, 0)];
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, 0, colliders)).toBe(true);
  });
});

describe('collidesAt — blocking is relative to the feet', () => {
  test(`geometry up to ${STEP_HEIGHT} above the feet never blocks (a step)`, () => {
    // Top at exactly STEP_HEIGHT sits below the query span's floor
    // (feet + STEP_HEIGHT), so stairs read as floor, not wall.
    const step = slab(0, 0, 0, STEP_HEIGHT);
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, 0, [step])).toBe(false);
    // ...but one hair taller than the step budget blocks again.
    const curb = slab(0, 0, 0, STEP_HEIGHT + 0.01);
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, 0, [curb])).toBe(true);
  });

  test('a knee-high crate blocks at ground feet', () => {
    const crate = slab(0, 0, 0, 0.5);
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, 0, [crate])).toBe(true);
  });

  test('the same crate does not block feet standing on top of it', () => {
    // Feet at the crate's top: its top is BELOW the feet, the span starts
    // above it — this is what makes standing on boxes walkable.
    const crate = slab(0, 0, 0, 0.5);
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, 0.5, [crate])).toBe(false);
  });

  test('a wall still blocks feet elevated alongside it', () => {
    // Feet at 3 next to a 4-high wall: the wall's body spans the entity.
    expect(collidesAt(new THREE.Vector3(1.3, 4.7, 0), PLAYER_RADIUS, 3, [wall(0, 0, 1, 4)])).toBe(true);
    // ...but a 2m wall does not, once your feet are above ITS top + step.
    expect(collidesAt(new THREE.Vector3(1.3, 4.7, 0), PLAYER_RADIUS, 3, [wall(0, 0, 1, 2)])).toBe(false);
  });

  test('geometry entirely below the feet does not block', () => {
    const floorSlab = slab(0, 0, -1, -0.01);
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, 0, [floorSlab])).toBe(false);
  });

  test(`geometry entirely above head height (${HEAD_HEIGHT}) does not block`, () => {
    // Elevated tier crates must be walkable-under at ground level.
    const tier = slab(0, 0, 3, 6);
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, 0, [tier])).toBe(false);
  });
});

describe('supportHeightAt', () => {
  test('open ground supports at y = 0', () => {
    expect(supportHeightAt(0, 0, PLAYER_RADIUS, 5, [])).toBe(0);
    expect(supportHeightAt(0, 0, PLAYER_RADIUS, 5, [wall(-30, -30)])).toBe(0);
  });

  test('returns the top of a surface under the footprint', () => {
    const platform = slab(0, 0, 0, 2.4, 5);
    expect(supportHeightAt(0, 0, PLAYER_RADIUS, 5, [platform])).toBe(2.4);
  });

  test('ignores surfaces above the ceiling', () => {
    const platform = slab(0, 0, 0, 2.4, 5);
    expect(supportHeightAt(0, 0, PLAYER_RADIUS, 2.0, [platform])).toBe(0);
  });

  test('a ceiling exactly at the top still counts', () => {
    const platform = slab(0, 0, 0, 2.4, 5);
    expect(supportHeightAt(0, 0, PLAYER_RADIUS, 2.4, [platform])).toBe(2.4);
  });

  test('picks the highest eligible surface, not the first or last', () => {
    const low = slab(-20, -20, 0, 1, 2);
    const high = slab(0, 0, 0, 3, 5);
    const higherStill = slab(20, 20, 0, 2, 2);
    expect(supportHeightAt(0, 0, PLAYER_RADIUS, 4, [low, higherStill, high])).toBe(3);
  });

  test('mere boundary contact is not support', () => {
    // Footprint edge exactly at the platform edge: strict overlap required,
    // else entities stand on air at exact AABB boundaries.
    const platform = slab(0, 0, 0, 2.4, 5); // spans x -5..5
    expect(supportHeightAt(5 + PLAYER_RADIUS, 0, PLAYER_RADIUS, 5, [platform])).toBe(0);
    expect(supportHeightAt(5 + PLAYER_RADIUS - 0.01, 0, PLAYER_RADIUS, 5, [platform])).toBe(2.4);
  });
});

describe('resolveVertical', () => {
  test('resting on flat ground stays put with zeroed velocity', () => {
    const r = resolveVertical(0, -22 * 0.016, 0.016, 0, 0, PLAYER_RADIUS, []);
    expect(r.onGround).toBe(true);
    expect(r.feetY).toBe(0);
    expect(r.velY).toBe(0);
  });

  test('rising is never resolved as a landing', () => {
    const r = resolveVertical(0.5, 8, 0.05, 0, 0, PLAYER_RADIUS, []);
    expect(r.onGround).toBe(false);
    expect(r.velY).toBe(8);
    expect(r.feetY).toBeCloseTo(0.9);
  });

  test('walking into a riser lifts the feet onto it (step-up)', () => {
    // Standing with footprint overlapping a 0.3 riser: gravity nudges the
    // feet down a hair, support catches the riser top one STEP_HEIGHT up.
    const riser = slab(2, 0, 0, STEP_HEIGHT, 1);
    const r = resolveVertical(0, -22 * 0.016, 0.016, 2, 0, PLAYER_RADIUS, [riser]);
    expect(r.onGround).toBe(true);
    expect(r.feetY).toBe(STEP_HEIGHT);
  });

  test('landing is swept: fast falls cannot tunnel through a thin tread', () => {
    // One clamped-dt frame drops the feet from 5.0 to 4.45, straight past a
    // 0.3-thick tread whose top is 4.7. The support ceiling (prevFeet +
    // STEP_HEIGHT) still contains the passed-through top, so the entity
    // lands ON it instead of inside/below it.
    const tread = slab(0, 0, 4.4, 4.7, 5);
    const r = resolveVertical(5.0, -11, 0.05, 0, 0, PLAYER_RADIUS, [tread]);
    expect(r.onGround).toBe(true);
    expect(r.feetY).toBe(4.7);
    expect(r.velY).toBe(0);
  });

  test('walking off an edge loses support and goes airborne', () => {
    const platform = slab(0, 0, 0, 3, 5); // spans x -5..5
    // Just inside the edge: supported.
    const on = resolveVertical(3, -22 * 0.016, 0.016, 5 + PLAYER_RADIUS - 0.01, 0, PLAYER_RADIUS, [platform]);
    expect(on.onGround).toBe(true);
    expect(on.feetY).toBe(3);
    // Past the edge (boundary contact excluded): falls.
    const off = resolveVertical(3, -22 * 0.016, 0.016, 5 + PLAYER_RADIUS + 0.01, 0, PLAYER_RADIUS, [platform]);
    expect(off.onGround).toBe(false);
    expect(off.feetY).toBeLessThan(3);
  });

  test('falling beside a tall wall does not snap onto it', () => {
    // Wall top far above the support ceiling: excluded, keep falling.
    const r = resolveVertical(2, -10, 0.05, 1.3, 0, PLAYER_RADIUS, [wall(0, 0)]);
    expect(r.onGround).toBe(false);
    expect(r.feetY).toBeCloseTo(1.5);
  });
});

describe('slideMoveXZ', () => {
  test('an unobstructed move applies both axes', () => {
    const pos = at(0, 0);
    slideMoveXZ(pos, 1, 2, PLAYER_RADIUS, 0, []);
    expect(pos.x).toBe(1);
    expect(pos.z).toBe(2);
  });

  test('moving into a wall drops that axis but keeps the other (slide)', () => {
    // Long wall body spanning x -1..1 (face plane at x = 1) across the whole
    // z range of travel. Entity starts clear at x = 2 and presses diagonally
    // (-1.2 x, +1 z): the x leg would penetrate the face, so it is dropped;
    // the z leg proceeds — sliding along the wall.
    const longWall = new THREE.Box3(
      new THREE.Vector3(-1, 0, -10),
      new THREE.Vector3(1, 4, 10),
    );
    const pos = at(2, 5);
    slideMoveXZ(pos, -1.2, 1, PLAYER_RADIUS, 0, [longWall]);
    expect(pos.x).toBe(2);
    expect(pos.z).toBe(6);
  });

  test('a riser does NOT stop horizontal movement (climb happens vertically)', () => {
    const riser = slab(2, 0, 0, STEP_HEIGHT, 1);
    const pos = at(0, 0);
    slideMoveXZ(pos, 2, 0, PLAYER_RADIUS, 0, [riser]);
    expect(pos.x).toBe(2);
  });

  test('blocking follows the given feet height', () => {
    // The same 2m wall blocks feet at 0 ...
    const posA = at(0, 0);
    slideMoveXZ(posA, 1.3, 0, PLAYER_RADIUS, 0, [wall(0, 0, 1, 2)]);
    expect(posA.x).toBe(0);
    // ...but not feet at 2.5, where its top is below feet + STEP_HEIGHT.
    const posB = at(0, 0);
    slideMoveXZ(posB, 1.3, 0, PLAYER_RADIUS, 2.5, [wall(0, 0, 1, 2)]);
    expect(posB.x).toBe(1.3);
  });
});

describe('findFreeSpawn', () => {
  test('takes a clear first sample as-is', () => {
    const clear = at(10, 10);
    let calls = 0;
    const p = findFreeSpawn(() => { calls++; return clear; }, PLAYER_RADIUS, [wall(0, 0)]);
    expect(calls).toBe(1);
    expect(p).toBe(clear);
  });

  test('rejects colliding samples until one is clear', () => {
    // at(0,0) is inside the wall; at(1.3,0) is outside its edge but the
    // radius reaches in (see the collidesAt contact test above).
    const queue = [at(0, 0), at(1.3, 0), at(10, 10)];
    const want = queue[2]!;
    const p = findFreeSpawn(() => queue.shift()!, PLAYER_RADIUS, [wall(0, 0)]);
    expect(p).toBe(want);
  });

  test('exhausting maxAttempts returns the last sample instead of hanging', () => {
    const alwaysBlocked = at(0, 0);
    let calls = 0;
    const p = findFreeSpawn(() => { calls++; return alwaysBlocked; }, PLAYER_RADIUS, [wall(0, 0)], 5);
    expect(calls).toBe(5);
    expect(p).toBe(alwaysBlocked);
  });

  test('the returned position passes collidesAt at the same radius', () => {
    const p = findFreeSpawn(
      () => new THREE.Vector3((Math.random() - 0.5) * 20, 0, (Math.random() - 0.5) * 20),
      PLAYER_RADIUS,
      [wall(0, 0)],
    );
    expect(collidesAt(p, PLAYER_RADIUS, 0, [wall(0, 0)])).toBe(false);
  });
});
