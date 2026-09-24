import { describe, expect, test } from 'vitest';
import { BOW_MIN_RELEASE, arrowDamage, bowDrawFraction, launchSpeed, planBowTrigger, type BowTriggerInput } from './bow';

const DRAW_TIME = 0.9;

function input(over: Partial<BowTriggerInput>): BowTriggerInput {
  return { now: 10, drawStartedAt: null, held: false, ready: true, interrupted: false, drawTime: DRAW_TIME, ...over };
}

describe('draw', () => {
  test('rises linearly to full draw and holds there', () => {
    expect(bowDrawFraction(0, DRAW_TIME)).toBe(0);
    expect(bowDrawFraction(DRAW_TIME / 2, DRAW_TIME)).toBeCloseTo(0.5, 12);
    expect(bowDrawFraction(DRAW_TIME * 3, DRAW_TIME)).toBe(1);
    expect(bowDrawFraction(-1, DRAW_TIME)).toBe(0);
  });

  test('launch speed is linear in draw, damage linear in impact speed', () => {
    expect(launchSpeed(1, 58)).toBe(58);
    expect(launchSpeed(0.5, 58)).toBe(29);
    expect(launchSpeed(2, 58)).toBe(58);
    expect(arrowDamage(80, 58, 58)).toBe(80);
    expect(arrowDamage(80, 29, 58)).toBe(40);
    expect(arrowDamage(80, 70, 58)).toBe(80);
  });
});

describe('planBowTrigger', () => {
  test('a press with an arrow nocked starts the draw; without one it waits', () => {
    expect(planBowTrigger(input({ held: true }))).toEqual({ kind: 'start' });
    expect(planBowTrigger(input({ held: true, ready: false }))).toEqual({ kind: 'idle' });
    expect(planBowTrigger(input({ held: false }))).toEqual({ kind: 'idle' });
  });

  test('holding reports the draw; releasing looses at that fraction', () => {
    const drawing = { drawStartedAt: 10 - DRAW_TIME * 0.6 };
    const hold = planBowTrigger(input({ ...drawing, held: true }));
    expect(hold.kind).toBe('hold');
    const loose = planBowTrigger(input({ ...drawing, held: false }));
    expect(loose.kind).toBe('loose');
    if (loose.kind === 'loose') expect(loose.fraction).toBeCloseTo(0.6, 12);
  });

  test('a release short of BOW_MIN_RELEASE lets the string down instead', () => {
    const early = 10 - DRAW_TIME * BOW_MIN_RELEASE * 0.5;
    expect(planBowTrigger(input({ drawStartedAt: early }))).toEqual({ kind: 'letDown' });
  });

  test('an interruption lets down even at full draw, and never looses', () => {
    const full = { drawStartedAt: 10 - DRAW_TIME * 2 };
    expect(planBowTrigger(input({ ...full, held: true, interrupted: true }))).toEqual({ kind: 'letDown' });
    expect(planBowTrigger(input({ ...full, held: false, interrupted: true }))).toEqual({ kind: 'letDown' });
  });
});
