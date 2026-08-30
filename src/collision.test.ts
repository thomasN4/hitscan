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

  test('float32-noisy tops still count as steppable and supportive', () => {
    // What Box3.setFromObject ACTUALLY yields for a tread built as exactly
    // 0.3 tall: mesh vertices are float32, inflating max.y to
    // 0.3000000059604645 (and dropping min.y to -5.96e-9). Without
    // COLLISION_EPSILON this walls off every real flight — caught live by
    // the smoke test's stairs phase.
    const noisyStep = new THREE.Box3(
      new THREE.Vector3(-1, -5.960464483090178e-9, -1),
      new THREE.Vector3(1, 0.3000000059604645, 1),
    );
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, 0, [noisyStep])).toBe(false);
    expect(supportHeightAt(0, 0, PLAYER_RADIUS, 0.3, [noisyStep])).toBe(0.3000000059604645);
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

  test('overhead cover built at exactly head height stays walkable-under', () => {
    // A slab whose bottom is designed at HEAD_HEIGHT stores one float32 ULP
    // LOW (1.9999997615814209); the overhead bound takes COLLISION_EPSILON
    // slack like the steppable bound does, or exact-height cover walls you in.
    const bottom = 1.9999997615814209;
    const cover = slab(0, 0, bottom, 3);
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, 0, [cover])).toBe(false);
    // One hair genuinely lower is real cover and still blocks.
    expect(collidesAt(at(0, 0), PLAYER_RADIUS, 0, [slab(0, 0, bottom - 0.01, 3)])).toBe(true);
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

  test('descending one riser while grounded sticks to the lower tread', () => {
    // The footprint just left the upper tread (top 0.6): support is the
    // lower tread top 0.3, but gravity has only pulled the feet down a hair,
    // so without the stick rule they free-fall ~0.29 m every tread.
    const lower = slab(0, 0, 0, STEP_HEIGHT);
    const r = resolveVertical(0.6, -22 * 0.016, 0.016, 0, 0, PLAYER_RADIUS, [lower], true);
    expect(r.onGround).toBe(true);
    expect(r.feetY).toBe(STEP_HEIGHT);
    expect(r.velY).toBe(0);
  });

  test('the same descent query without wasGrounded stays airborne', () => {
    const lower = slab(0, 0, 0, STEP_HEIGHT);
    const r = resolveVertical(0.6, -22 * 0.016, 0.016, 0, 0, PLAYER_RADIUS, [lower]);
    expect(r.onGround).toBe(false);
    expect(r.feetY).toBeGreaterThan(STEP_HEIGHT);
  });

  test('grounded descent onto a float32-noisy tread still sticks', () => {
    // The noise direction that matters here: a "0.3" riser measuring LOW
    // puts its top a hair OVER one STEP_HEIGHT below the feet — exactly
    // what COLLISION_EPSILON exists for on this comparison too.
    const noisyTop = STEP_HEIGHT - 1.7881393432617188e-7; // float32 ULP below 0.3
    const noisyLower = slab(0, 0, 0, noisyTop);
    const r = resolveVertical(0.6, -22 * 0.016, 0.016, 0, 0, PLAYER_RADIUS, [noisyLower], true);
    expect(r.onGround).toBe(true);
    expect(r.feetY).toBe(noisyTop);
  });

  test('the stick budget is exactly one STEP_HEIGHT plus epsilon', () => {
    const deep = slab(0, 0, 0, 0.29);     // 0.31 below the feet: falls
    const shallow = slab(0, 0, 0, 0.301); // 0.299 below: sticks
    const deepR = resolveVertical(0.6, -22 * 0.016, 0.016, 0, 0, PLAYER_RADIUS, [deep], true);
    const shallowR = resolveVertical(0.6, -22 * 0.016, 0.016, 0, 0, PLAYER_RADIUS, [shallow], true);
    expect(deepR.onGround).toBe(false);
    expect(shallowR.onGround).toBe(true);
    expect(shallowR.feetY).toBe(0.301);
  });

  test('a drop deeper than one step still goes airborne (ledge)', () => {
    // Past the platform edge over open ground: support (0) is more than
    // STEP_HEIGHT below the feet, so even a grounded entity falls.
    const platform = slab(0, 0, 0, 1.0, 5); // spans x -5..5
    const r = resolveVertical(1.0, -22 * 0.016, 0.016,
      5 + PLAYER_RADIUS + 0.01, 0, PLAYER_RADIUS, [platform], true);
    expect(r.onGround).toBe(false);
    expect(r.feetY).toBeLessThan(1.0);
  });

  test('jumping off a stair tread still rises (stick never blocks ascent)', () => {
    const lower = slab(0, 0, 0, STEP_HEIGHT);
    const r = resolveVertical(0.6, 8, 0.05, 0, 0, PLAYER_RADIUS, [lower], true);
    expect(r.onGround).toBe(false);
    expect(r.velY).toBe(8);
    expect(r.feetY).toBeCloseTo(1.0);
  });
});

// Rising into a ceiling — the head is swept, not just the feet.
//
// Fixture is an open-tread plate: top 4.7, underside 4.4 (warehouse2's TREAD_T
// shape). Before the ceiling sweep a rising body passed straight through it —
// the head is above the support query's reach and the vertical stage ignored
// velY > 0 entirely — so a jump under a flight put the head inside the tread.
describe('resolveVertical ceiling sweep', () => {
  /** Underside 4.4, top 4.7 — a thin open-tread plate. */
  const tread = slab(0, 0, 4.4, 4.7, 5);

  test('a rising body cannot cross a thin tread underside', () => {
    // Feet 2.2 -> 3.2 this frame: the head sweeps 4.2 -> 5.2, straight
    // through the underside at 4.4.
    const r = resolveVertical(2.2, 20, 0.05, 0, 0, PLAYER_RADIUS, [tread]);
    expect(r.onGround).toBe(false);
  });

  test('it is clamped below the underside with zero velocity', () => {
    const r = resolveVertical(2.2, 20, 0.05, 0, 0, PLAYER_RADIUS, [tread]);
    expect(r.feetY).toBe(4.4 - HEAD_HEIGHT);
    expect(r.velY).toBe(0);
  });

  test('rises normally when no ceiling overlaps the footprint', () => {
    // Same tread, but the body stands beside it: no XZ overlap, no clamp.
    const r = resolveVertical(2.2, 20, 0.05, 5 + PLAYER_RADIUS, 0, PLAYER_RADIUS, [tread]);
    expect(r.velY).toBe(20);
    expect(r.feetY).toBeCloseTo(3.2);
    // ...and a ceiling above the swept interval is not crossed, not clamped.
    const highCover = slab(0, 0, 6, 9, 5);
    const clear = resolveVertical(2.2, 20, 0.05, 0, 0, PLAYER_RADIUS, [highCover]);
    expect(clear.feetY).toBeCloseTo(3.2);
  });

  test('a body whose head already overlaps the ceiling is not pulled down', () => {
    // Inside geometry (unwedge territory): the underside is below the head
    // already, so the sweep must leave it to the horizontal escape rule.
    const r = resolveVertical(2.5, 20, 0.05, 0, 0, PLAYER_RADIUS, [tread]);
    expect(r.feetY).toBeCloseTo(3.5);
    expect(r.velY).toBe(20);
  });

  test('an underside within float noise of the resting head still clamps', () => {
    // An exact-height overhead slab's underside stores a hair LOW; the head
    // at rest touches it. Rising must clamp at it, not slip past.
    const noisy = slab(0, 0, 3.9999997615814209, 4.3, 5);
    const r = resolveVertical(2.0, 8, 0.05, 0, 0, PLAYER_RADIUS, [noisy]);
    expect(r.feetY).toBe(3.9999997615814209 - HEAD_HEIGHT);
    expect(r.velY).toBe(0);
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
    // Approached from OUTSIDE, deliberately: this fixture used to start at
    // the wall's centre, which now reads as an entity trapped inside it and
    // is allowed to walk out (see the unwedging suite). Starting clear pins
    // what the test was always for — that feetY gates blocking — without
    // depending on the trapped case.
    const posA = at(-2, 0);
    slideMoveXZ(posA, 1.3, 0, PLAYER_RADIUS, 0, [wall(0, 0, 1, 2)]);
    expect(posA.x).toBe(-2);
    // ...but not feet at 2.5, where its top is below feet + STEP_HEIGHT.
    const posB = at(-2, 0);
    slideMoveXZ(posB, 1.3, 0, PLAYER_RADIUS, 2.5, [wall(0, 0, 1, 2)]);
    expect(posB.x).toBeCloseTo(-0.7, 12);
  });
});

// Unwedging — the escape that keeps a binary overlap test from being a trap.
//
// Fixture is the elevation map's real trap, reduced: the second-floor slab
// x[6,14] y[3.2,3.6], and an entity standing on riser 5 of the internal
// flight (feet 1.5) with its radius lapping the slab's west edge. The slab's
// underside is below that entity's head, so it blocks; and because collidesAt
// only answers "inside or not", every direction was refused — the way out
// included. Player and bot alike were pinned there permanently.
describe('slideMoveXZ unwedging', () => {
  const slabEdge = new THREE.Box3(
    new THREE.Vector3(6, 3.2, -12),
    new THREE.Vector3(14, 3.6, 12),
  );
  const BOT_RADIUS = 0.5;
  const TRAPPED_FEET = 1.5;
  /** The exact coordinate a traced bot froze at for 18 s. */
  const trapped = (): THREE.Vector3 => new THREE.Vector3(6.15, 0, -6.42);

  test('lets a trapped entity move back out of the overlap', () => {
    const pos = trapped();
    slideMoveXZ(pos, -0.07, 0, BOT_RADIUS, TRAPPED_FEET, [slabEdge]);
    expect(pos.x).toBeCloseTo(6.08, 12);
  });

  test('refuses the same move driven deeper in', () => {
    const pos = trapped();
    slideMoveXZ(pos, 0.07, 0, BOT_RADIUS, TRAPPED_FEET, [slabEdge]);
    expect(pos.x).toBe(6.15);
  });

  test('refuses an axis that cannot reduce the overlap', () => {
    // The footprint sits well inside the slab's z span, so sliding along z
    // leaves the overlap exactly as it was — indifferent, not an escape.
    const pos = trapped();
    slideMoveXZ(pos, 0, 0.07, BOT_RADIUS, TRAPPED_FEET, [slabEdge]);
    expect(pos.z).toBe(-6.42);
  });

  test('keeps walls solid from outside — the escape only fires from within', () => {
    // Zero overlap now, positive overlap at the destination: the strict
    // decrease cannot hold, so this is refused exactly as it was before.
    const pos = new THREE.Vector3(5, 0, -6.42);
    slideMoveXZ(pos, 0.6, 0, BOT_RADIUS, TRAPPED_FEET, [slabEdge]);
    expect(pos.x).toBe(5);
  });

  test('will not burrow into one face to escape another', () => {
    // A perpendicular wall the move would push INTO vetoes the escape.
    const crossWall = new THREE.Box3(
      new THREE.Vector3(4, 0, -7),
      new THREE.Vector3(5.9, 4, -6),
    );
    const pos = trapped();
    slideMoveXZ(pos, -0.3, 0, BOT_RADIUS, TRAPPED_FEET, [slabEdge, crossWall]);
    expect(pos.x).toBe(6.15);
  });

  test('escapes in one step even when the move clears the blocker outright', () => {
    // Lap the slab by less than one frame's move, with a span-swallowing beam
    // also blocking. The move clears the slab entirely, so a destination-only
    // scan never sees it — leaving only the indifferent beam, no improvement,
    // and a move refused forever. Scanning both ends credits the clearance.
    const beam = new THREE.Box3(
      new THREE.Vector3(0, 3.2, -7),
      new THREE.Vector3(20, 3.6, -6),
    );
    const pos = new THREE.Vector3(5.55, 0, -6.42); // footprint [5.05, 6.05]: 0.05 into the slab
    slideMoveXZ(pos, -0.07, 0, BOT_RADIUS, TRAPPED_FEET, [slabEdge, beam]);
    expect(pos.x).toBeCloseTo(5.48, 12);
  });

  test('a collider the axis cannot escape does not veto one it can', () => {
    // A beam spanning the whole x range swallows the footprint, so an x move
    // cannot reduce ITS overlap. Indifferent must not read as "worse", or
    // the fix rebuilds the trap out of a second collider.
    const beam = new THREE.Box3(
      new THREE.Vector3(0, 3.2, -7),
      new THREE.Vector3(20, 3.6, -6),
    );
    const pos = trapped();
    slideMoveXZ(pos, -0.07, 0, BOT_RADIUS, TRAPPED_FEET, [slabEdge, beam]);
    expect(pos.x).toBeCloseTo(6.08, 12);
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
