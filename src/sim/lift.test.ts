import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { launchFrom, launchApex, type LiftPad } from './lift';
import { resolveVertical, HEAD_HEIGHT } from '../collision';
import { GRAVITY } from './movement';

/** maps/warehouse2.ts's pads: 4 x 4, 0.25 tall, throwing at 17 m/s. */
const pad: LiftPad = { minX: 6, maxX: 10, minZ: -12, maxZ: -8, topY: 0.25, launchVel: 17 };
const pads = [pad];

/** Body radius the map is walked with — the larger of bot 0.5 and player 0.45. */
const R = 0.5;

describe('launchFrom', () => {
  test('fires for a grounded body resting on the pad', () => {
    expect(launchFrom(8, -10, 0.25, true, R, pads)).toBe(17);
  });

  test('does not fire for a body on the floor beside it', () => {
    // Same footprint, feet one pad-height lower. Without the resting check a
    // pad would throw anyone who merely walked past its edge.
    expect(launchFrom(8, -10, 0, true, R, pads)).toBeNull();
    expect(launchFrom(2, -10, 0.25, true, R, pads)).toBeNull();
  });

  test('does not fire in mid-air', () => {
    // This is the whole re-trigger guard: the launch sets a positive vertical
    // velocity, resolveVertical reports airborne for the entire ascent, and
    // nothing can fire again until the body has landed somewhere. Drop it and
    // a body on a pad launches every frame.
    expect(launchFrom(8, -10, 0.25, false, R, pads)).toBeNull();
  });

  test('fires when the footprint only clips the pad', () => {
    // Overlap, not containment — the same convention collision.ts:blocks uses.
    // Catching a corner of a lift should still throw you.
    expect(launchFrom(10.4, -10, 0.25, true, R, pads)).toBe(17);
    // …but a footprint that merely touches the edge does not overlap it.
    expect(launchFrom(10.5, -10, 0.25, true, R, pads)).toBeNull();
  });

  test('tolerates a float32-measured pad top', () => {
    // Pad tops are measured off mesh vertices stored as float32, the same
    // source collision.ts:COLLISION_EPSILON exists for.
    expect(launchFrom(8, -10, 0.2500000372529, true, R, pads)).toBe(17);
  });

  test('an empty registry is not an error', () => {
    expect(launchFrom(8, -10, 0.25, true, R, [])).toBeNull();
  });
});

describe('launchApex', () => {
  test("warehouse2's pads clear its deck", () => {
    // DECK_Y is 5.1. The margin is what makes the arc usable rather than
    // merely sufficient: a body has to spend long enough ABOVE the deck to
    // travel the ~3 m onto it, because until it clears the slab its head is
    // underneath and slideMoveXZ will not let it move over.
    expect(launchApex(17, GRAVITY)).toBeGreaterThan(5.1);
    expect(launchApex(17, GRAVITY) - 5.1).toBeGreaterThan(0.5);
  });

  test('agrees with the jump the player already has', () => {
    // player.ts:JUMP_VEL is 8, documented as a ~1.45 m apex. Same formula.
    expect(launchApex(8, GRAVITY)).toBeCloseTo(1.45, 2);
  });
});

describe('a pad beneath an overhang', () => {
  // The relaunch bounce review-bot found on warehouse2: a pad whose far edge
  // sat ON the void lip threw bodies into the ring slab's underside. The head
  // sweep in resolveVertical clamped the rise at feet 4.7 - HEAD_HEIGHT, the
  // body fell back onto the pad, and the pad fired again — forever. The fix
  // stands the pads LIP_GAP = 1 back from the lip (maps/warehouse2.ts), which
  // makes "footprint under the slab" and "footprint on the pad" disjoint.
  // These cases model the map's north half in plain numbers and pin both
  // halves of that claim against the real resolveVertical, so a future change
  // to the ceiling sweep that would reintroduce the trap fails here rather
  // than in a play session.
  const slab = new THREE.Box3(
    new THREE.Vector3(-29.5, 4.7, -19.5),
    new THREE.Vector3(29.5, 5.1, -12),
  );
  const DECK_Y = 5.1;
  const SLAB_UNDERSIDE = 4.7;
  const PAD_TOP = 0.25;
  const DT = 1 / 60;
  const X = 8; // pad A's centre x

  /** The shipped pad A: centre (8, -9), standing LIP_GAP back from the lip. */
  const shippedPads: LiftPad[] = [
    { minX: 6, maxX: 10, minZ: -11, maxZ: -7, topY: PAD_TOP, launchVel: 17 },
  ];
  /** The old flush pad A: centre (8, -10), far edge ON the lip. */
  const flushPads: LiftPad[] = [
    { minX: 6, maxX: 10, minZ: -12, maxZ: -8, topY: PAD_TOP, launchVel: 17 },
  ];

  /**
   * The model's colliders: the ring slab plus the pad itself —
   * world.ts:addLiftPad registers the pad as an ordinary solid, and it is the
   * support a stopped body lands back on.
   */
  function collidersFor(pad: LiftPad): THREE.Box3[] {
    return [
      slab,
      new THREE.Box3(
        new THREE.Vector3(pad.minX, 0, pad.minZ),
        new THREE.Vector3(pad.maxX, pad.topY, pad.maxZ),
      ),
    ];
  }

  /**
   * Launch a body resting on the pad at body-centre z, then integrate
   * resolveVertical at a fixed dt (caller-side gravity, as player.ts and
   * bots.ts do) until the rise stops. Peak feet height, or null when no pad
   * fires for that z.
   */
  function peakFeet(z: number, pads: readonly LiftPad[]): number | null {
    const vel = launchFrom(X, z, PAD_TOP, true, R, pads);
    if (vel === null) return null;
    const colliders = collidersFor(pads[0]!);
    let feet = PAD_TOP;
    let velY = vel;
    let onGround = true;
    let peak = feet;
    while (velY > 0) {
      const r = resolveVertical(feet, velY, DT, X, z, R, colliders, onGround);
      feet = r.feetY;
      velY = r.velY;
      onGround = r.onGround;
      peak = Math.max(peak, feet);
      velY -= GRAVITY * DT;
    }
    return peak;
  }

  test('the fix holds: every sampled launch that fires clears the deck', () => {
    let fired = 0;
    for (let i = 0; i <= 60; i++) {
      const z = -12 + i * 0.1;
      const peak = peakFeet(z, shippedPads);
      if (peak === null) continue;
      fired++;
      // A launch position under the slab would clamp at 4.7 - HEAD_HEIGHT
      // and fall back onto the pad — the bounce. None may exist.
      expect(peak).toBeGreaterThan(DECK_Y);
    }
    expect(fired).toBeGreaterThan(0);
  });

  test('the guard is not vacuous: the old flush pad clamps and relaunches', () => {
    const z = -11.9;
    expect(launchFrom(X, z, PAD_TOP, true, R, flushPads)).toBe(17);
    const colliders = collidersFor(flushPads[0]!);

    let feet = PAD_TOP;
    let velY = 17;
    let onGround = true;
    let peak = feet;
    // Rise: the head sweep stops the body under the slab. The bonk spends
    // the frame's remainder falling (issue #125), so the peak sits up to one
    // frame of fall below the clamp — still under the slab, no snap.
    while (velY > 0) {
      const r = resolveVertical(feet, velY, DT, X, z, R, colliders, onGround);
      feet = r.feetY;
      velY = r.velY;
      onGround = r.onGround;
      peak = Math.max(peak, feet);
      velY -= GRAVITY * DT;
    }
    expect(peak).toBeLessThanOrEqual(SLAB_UNDERSIDE - HEAD_HEIGHT);
    expect(SLAB_UNDERSIDE - HEAD_HEIGHT - peak).toBeLessThan(0.05);

    // Fall: back onto the pad top, not the floor.
    for (let i = 0; !onGround && i < 600; i++) {
      const r = resolveVertical(feet, velY, DT, X, z, R, colliders, onGround);
      feet = r.feetY;
      velY = r.velY;
      onGround = r.onGround;
      velY -= GRAVITY * DT;
    }
    expect(onGround).toBe(true);
    expect(feet).toBeCloseTo(PAD_TOP, 2);

    // …and the pad fires again. That relaunch is the permanent bounce.
    expect(launchFrom(X, z, feet, onGround, R, flushPads)).toBe(17);
  });
});
