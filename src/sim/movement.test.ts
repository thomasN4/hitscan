import { describe, expect, test } from 'vitest';
import { isSprintActive, speedFor, measuredMoveLerp, WALK_SPEED, MAX_MOVE_LERP } from './movement';
import { approach, deadZone } from './smoothing';

const still = { crouching: false, aiming: false, running: false, runLerp: 0 };

describe('isSprintActive', () => {
  const sprint = {
    sprintHeld: true,
    aiming: false,
    crouching: false,
    forward: true,
    backward: false,
    left: false,
    right: false,
  };

  test('requires Shift plus a net movement direction', () => {
    expect(isSprintActive(sprint)).toBe(true);
    expect(isSprintActive({ ...sprint, sprintHeld: false })).toBe(false);
    expect(isSprintActive({ ...sprint, forward: false })).toBe(false);
  });

  test('opposing movement keys cancel instead of creating sprint intent', () => {
    expect(isSprintActive({ ...sprint, backward: true })).toBe(false);
    expect(isSprintActive({ ...sprint, forward: false, left: true, right: true })).toBe(false);
  });

  test('aim and crouch take precedence over sprint', () => {
    expect(isSprintActive({ ...sprint, aiming: true })).toBe(false);
    expect(isSprintActive({ ...sprint, crouching: true })).toBe(false);
  });
});

describe('speedFor', () => {
  test('walk is the baseline', () => {
    expect(speedFor(still)).toBe(WALK_SPEED);
  });

  test('orders the tiers crouch < aim < walk < sprint', () => {
    const crouch = speedFor({ ...still, crouching: true });
    const aim = speedFor({ ...still, aiming: true });
    const walk = speedFor(still);
    const sprint = speedFor({ ...still, running: true, runLerp: 1 });
    expect(crouch).toBeLessThan(aim);
    expect(aim).toBeLessThan(walk);
    expect(walk).toBeLessThan(sprint);
  });

  test('full sprint is 1.5x walk', () => {
    expect(speedFor({ ...still, running: true, runLerp: 1 })).toBeCloseTo(WALK_SPEED * 1.5, 10);
  });

  test('sprint speed ramps with runLerp', () => {
    const half = speedFor({ ...still, running: true, runLerp: 0.5 });
    expect(half).toBeGreaterThan(WALK_SPEED);
    expect(half).toBeLessThan(WALK_SPEED * 1.5);
  });

  test('crouch beats aim and sprint — no sprint-scoping, no sprint-crouching', () => {
    const both = speedFor({ crouching: true, aiming: true, running: true, runLerp: 1 });
    expect(both).toBe(speedFor({ ...still, crouching: true }));
  });
});

describe('measuredMoveLerp', () => {
  test('standing still is 0', () => {
    expect(measuredMoveLerp(0, 0, 1 / 60)).toBe(0);
  });

  test('walking one frame at walk speed is 1', () => {
    const dt = 1 / 60;
    expect(measuredMoveLerp(WALK_SPEED * dt, 0, dt)).toBeCloseTo(1, 10);
  });

  test('caps at the sprint ceiling', () => {
    const dt = 1 / 60;
    expect(measuredMoveLerp(WALK_SPEED * 10 * dt, 0, dt)).toBe(MAX_MOVE_LERP);
  });

  test('measures actual displacement, so a blocked player reads as still', () => {
    // Walking into a wall must not bloom the crosshair.
    expect(measuredMoveLerp(0, 0, 1 / 60)).toBe(0);
  });

  test('combines both axes', () => {
    const dt = 1 / 60;
    const diagonal = WALK_SPEED * dt / Math.SQRT2;
    expect(measuredMoveLerp(diagonal, diagonal, dt)).toBeCloseTo(1, 10);
  });
});

describe('approach', () => {
  test('moves toward the target without overshooting', () => {
    expect(approach(0, 1, 1 / 60, 10)).toBeGreaterThan(0);
    expect(approach(0, 1, 1 / 60, 10)).toBeLessThan(1);
  });

  test('clamps on a long frame instead of overshooting past the target', () => {
    // Without the Math.min(1, ...) clamp this returns >1 and oscillates.
    expect(approach(0, 1, 10, 12)).toBe(1);
  });

  test('is stable once it reaches the target', () => {
    expect(approach(1, 1, 1 / 60, 10)).toBe(1);
  });
});

describe('deadZone', () => {
  test('snaps a decaying trickle to zero', () => {
    expect(deadZone(0.0001)).toBe(0);
  });

  test('leaves meaningful values alone', () => {
    expect(deadZone(0.5)).toBe(0.5);
  });
});
