// sim/swordStroke.ts — a charged blade's trigger: press winds a stroke up,
// release delivers it, and the wind-up scales what it deals.
//
// Pure, like sim/bow.ts, which this mirrors: weapons.ts feeds in the clock,
// both buttons and the readiness gate, and applies the decision. Unlike a
// drawn bow a wound-up blade cannot be held forever — past full charge it
// holds for a short grace and then strikes on its own.

/** Which stroke: LMB alone, RMB alone, or both buttons together. */
export type StrokeKind = 'primary' | 'alt' | 'combo';

/** A stroke being wound up: when the first button went down, and what it has become. */
export interface WindUp {
  startedAt: number;
  kind: StrokeKind;
}

/** How far a wind-up has charged (0 at the press, 1 at full) after `heldFor` seconds. */
export function chargeFraction(heldFor: number, time: number): number {
  return Math.min(1, Math.max(0, heldFor / time));
}

/** Fraction of a stroke's damage a release at `fraction` deals: `floor` on a tap, linear to 1 at full. */
export function chargeDamageFactor(fraction: number, floor: number): number {
  return floor + (1 - floor) * Math.min(1, Math.max(0, fraction));
}

/** Everything one frame of the blade's trigger decides on. */
export interface StrokeTriggerInput {
  now: number;
  windUp: WindUp | null;
  /** LMB held and not latched from the last stroke. */
  lmb: boolean;
  /** RMB held (a fresh press since the last stroke). */
  rmb: boolean;
  /** A NEW wind-up may begin: recovered from the last stroke, not deploying. */
  ready: boolean;
  /** Seconds from press to full charge. */
  time: number;
  /** Seconds a full charge holds before striking on its own. */
  hold: number;
  /** Least charge each stroke strikes at; a release below it lowers the blade. */
  minCharge: Record<StrokeKind, number>;
}

export type StrokeAction =
  | { kind: 'idle' }
  | { kind: 'start'; stroke: StrokeKind }
  | { kind: 'hold'; stroke: StrokeKind; fraction: number }
  | { kind: 'strike'; stroke: StrokeKind; fraction: number }
  | { kind: 'cancel' };

function pressed(lmb: boolean, rmb: boolean): StrokeKind | null {
  if (lmb && rmb) return 'combo';
  if (lmb) return 'primary';
  return rmb ? 'alt' : null;
}

/**
 * Press to wind up, release to strike. Both buttons down at any point of a
 * wind-up turns it into the combo stroke WITHOUT restarting its clock — the
 * charge already built carries over. A combo releases when either button
 * does. A release under the stroke's minCharge lowers the blade instead of
 * striking; past `time + hold` the stroke strikes at full on its own.
 */
export function planStrokeTrigger(input: StrokeTriggerInput): StrokeAction {
  const { now, windUp, lmb, rmb, ready, time, hold, minCharge } = input;
  if (windUp === null) {
    const stroke = ready ? pressed(lmb, rmb) : null;
    return stroke === null ? { kind: 'idle' } : { kind: 'start', stroke };
  }
  const stroke: StrokeKind = windUp.kind === 'combo' || (lmb && rmb) ? 'combo' : windUp.kind;
  const heldFor = now - windUp.startedAt;
  if (heldFor >= time + hold) return { kind: 'strike', stroke, fraction: 1 };
  const held = stroke === 'combo' ? lmb && rmb : stroke === 'primary' ? lmb : rmb;
  const fraction = chargeFraction(heldFor, time);
  if (held) return { kind: 'hold', stroke, fraction };
  return fraction >= minCharge[stroke] ? { kind: 'strike', stroke, fraction } : { kind: 'cancel' };
}
