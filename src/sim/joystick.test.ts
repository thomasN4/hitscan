import { describe, expect, test } from 'vitest';
import { stickVector, STICK_DEAD_ZONE, STICK_SPRINT_AT } from './joystick';

const R = 60;

describe('stickVector', () => {
  test('inside the dead zone reads as no movement', () => {
    const s = stickVector(R * STICK_DEAD_ZONE * 0.5, 0, R);
    expect(s.x).toBe(0);
    expect(s.y).toBe(0);
    expect(s.sprint).toBe(false);
  });

  test('screen-up is forward (+y), and the direction is unit length', () => {
    const s = stickVector(0, -R / 2, R);
    expect(s.x).toBeCloseTo(0);
    expect(s.y).toBeCloseTo(1);
    const d = stickVector(20, 20, R);
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(1);
    expect(d.y).toBeLessThan(0);
  });

  test('sprint only past the rim threshold', () => {
    expect(stickVector(R * (STICK_SPRINT_AT - 0.05), 0, R).sprint).toBe(false);
    expect(stickVector(R * (STICK_SPRINT_AT + 0.05), 0, R).sprint).toBe(true);
  });

  test('knob and magnitude clamp to the radius when the thumb overshoots', () => {
    const s = stickVector(3 * R, 4 * R, R);
    expect(s.magnitude).toBe(1);
    expect(Math.hypot(s.knobX, s.knobY)).toBeCloseTo(R);
    expect(s.sprint).toBe(true);
  });
});
