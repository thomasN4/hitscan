import { describe, expect, test } from 'vitest';
import { launchFrom, launchApex, type LiftPad } from './lift';
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
    // travel the ~2.5 m onto it, because until it clears the slab its head is
    // underneath and slideMoveXZ will not let it move over.
    expect(launchApex(17, GRAVITY)).toBeGreaterThan(5.1);
    expect(launchApex(17, GRAVITY) - 5.1).toBeGreaterThan(0.5);
  });

  test('agrees with the jump the player already has', () => {
    // player.ts:JUMP_VEL is 8, documented as a ~1.45 m apex. Same formula.
    expect(launchApex(8, GRAVITY)).toBeCloseTo(1.45, 2);
  });
});
