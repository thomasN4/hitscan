import { describe, expect, test } from 'vitest';
import { chargeDamageFactor, chargeFraction, planStrokeTrigger, type StrokeTriggerInput } from './swordStroke';

const TIME = 0.5;
const HOLD = 0.3;

function input(over: Partial<StrokeTriggerInput>): StrokeTriggerInput {
  return {
    now: 10, windUp: null, lmb: false, rmb: false, ready: true, time: TIME, hold: HOLD,
    minCharge: { primary: 0, alt: 0.3, combo: 0.5 }, ...over,
  };
}

describe('charge', () => {
  test('rises linearly to full and holds there', () => {
    expect(chargeFraction(0, TIME)).toBe(0);
    expect(chargeFraction(TIME / 2, TIME)).toBeCloseTo(0.5, 12);
    expect(chargeFraction(TIME * 3, TIME)).toBe(1);
    expect(chargeFraction(-1, TIME)).toBe(0);
  });

  test('damage runs from the floor on a tap to whole at full charge', () => {
    expect(chargeDamageFactor(0, 0.4)).toBe(0.4);
    expect(chargeDamageFactor(0.5, 0.4)).toBeCloseTo(0.7, 12);
    expect(chargeDamageFactor(1, 0.4)).toBe(1);
    expect(chargeDamageFactor(2, 0.4)).toBe(1);
  });
});

describe('planStrokeTrigger', () => {
  test('a press picks the stroke from the buttons down, only once ready', () => {
    expect(planStrokeTrigger(input({ lmb: true }))).toEqual({ kind: 'start', stroke: 'primary' });
    expect(planStrokeTrigger(input({ rmb: true }))).toEqual({ kind: 'start', stroke: 'alt' });
    expect(planStrokeTrigger(input({ lmb: true, rmb: true }))).toEqual({ kind: 'start', stroke: 'combo' });
    expect(planStrokeTrigger(input({ lmb: true, ready: false }))).toEqual({ kind: 'idle' });
    expect(planStrokeTrigger(input({}))).toEqual({ kind: 'idle' });
  });

  test('a tapped thrust strikes at no charge; a tapped slash or combo lowers the blade', () => {
    expect(planStrokeTrigger(input({ windUp: { startedAt: 10, kind: 'primary' } })))
      .toEqual({ kind: 'strike', stroke: 'primary', fraction: 0 });
    expect(planStrokeTrigger(input({ windUp: { startedAt: 10 - 0.1, kind: 'alt' } }))).toEqual({ kind: 'cancel' });
    expect(planStrokeTrigger(input({ windUp: { startedAt: 10 - 0.2, kind: 'combo' }, lmb: true }))).toEqual({ kind: 'cancel' });
  });

  test('a release at or past the minimum strikes at that charge', () => {
    const slash = planStrokeTrigger(input({ windUp: { startedAt: 10 - 0.3, kind: 'alt' } }));
    expect(slash.kind).toBe('strike');
    if (slash.kind === 'strike') expect(slash.fraction).toBeCloseTo(0.6, 12);
    expect(planStrokeTrigger(input({ windUp: { startedAt: 10 - 0.25, kind: 'combo' } })))
      .toEqual({ kind: 'strike', stroke: 'combo', fraction: 0.5 });
  });

  test('holding reports the charge', () => {
    expect(planStrokeTrigger(input({ windUp: { startedAt: 10 - 0.25, kind: 'primary' }, lmb: true })))
      .toEqual({ kind: 'hold', stroke: 'primary', fraction: 0.5 });
    expect(planStrokeTrigger(input({ windUp: { startedAt: 10 - 0.6, kind: 'alt' }, rmb: true })))
      .toEqual({ kind: 'hold', stroke: 'alt', fraction: 1 });
  });

  test('the second button turns a wind-up into the combo, keeping its charge', () => {
    expect(planStrokeTrigger(input({ windUp: { startedAt: 10 - 0.25, kind: 'primary' }, lmb: true, rmb: true })))
      .toEqual({ kind: 'hold', stroke: 'combo', fraction: 0.5 });
    expect(planStrokeTrigger(input({ windUp: { startedAt: 10 - 0.25, kind: 'alt' }, lmb: true, rmb: true })))
      .toEqual({ kind: 'hold', stroke: 'combo', fraction: 0.5 });
  });

  test('a combo releases when either button does', () => {
    const combo = { startedAt: 10 - TIME, kind: 'combo' as const };
    expect(planStrokeTrigger(input({ windUp: combo, lmb: true }))).toEqual({ kind: 'strike', stroke: 'combo', fraction: 1 });
    expect(planStrokeTrigger(input({ windUp: combo, rmb: true }))).toEqual({ kind: 'strike', stroke: 'combo', fraction: 1 });
  });

  test('the other button alone does not hold a single-button stroke', () => {
    expect(planStrokeTrigger(input({ windUp: { startedAt: 10 - TIME, kind: 'primary' }, rmb: true })))
      .toEqual({ kind: 'strike', stroke: 'primary', fraction: 1 });
  });

  test('a full charge held past its grace strikes on its own', () => {
    expect(planStrokeTrigger(input({ windUp: { startedAt: 10 - (TIME + HOLD) + 0.01, kind: 'alt' }, rmb: true })).kind)
      .toBe('hold');
    expect(planStrokeTrigger(input({ windUp: { startedAt: 10 - (TIME + HOLD), kind: 'alt' }, rmb: true })))
      .toEqual({ kind: 'strike', stroke: 'alt', fraction: 1 });
  });
});
