// sim/bow.ts — the longbow's draw: how far back the string is, what a release
// at that point launches, and what the arrow is worth when it lands.
//
// Pure, like the rest of sim/: weapons.ts feeds in the live clock, LMB state
// and gates, and applies the decision. "Draw" here is the ARCHERY draw — the
// string pulled back — and is unrelated to WeaponPose.draw, which is the
// weapon being brought up after a swap (issue #15).

/**
 * Least draw fraction a release still looses an arrow at. Below it the string
 * is let down instead: the arrow stays on the string and nothing is spent.
 * A flicked click is a let-down, not a 12 m/s arrow dribbling off the rest.
 */
export const BOW_MIN_RELEASE = 0.2;

/** How far back the string is (0 at brace, 1 at full draw) after `heldFor` seconds. */
export function bowDrawFraction(heldFor: number, drawTime: number): number {
  return Math.min(1, Math.max(0, heldFor / drawTime));
}

/**
 * Launch speed for a release at `fraction`. A longbow's draw-force curve is
 * close to linear in draw length, so the stored energy grows with its square
 * and the arrow's speed — √(2E/m) — grows linearly with the fraction.
 */
export function launchSpeed(fraction: number, fullSpeed: number): number {
  return fullSpeed * Math.min(1, Math.max(0, fraction));
}

/**
 * Damage an arrow does, before zone multipliers, when it strikes at
 * `impactSpeed`. Scaled linearly with speed (momentum, not energy): a
 * half-drawn arrow still wounds, where the square law would make it a pat.
 * Rounded, so the HP readout stays whole.
 */
export function arrowDamage(fullDamage: number, impactSpeed: number, fullSpeed: number): number {
  return Math.round(fullDamage * Math.min(1, Math.max(0, impactSpeed / fullSpeed)));
}

/** Everything one frame of the bow's trigger decides on. */
export interface BowTriggerInput {
  now: number;
  /** Game time the current draw began, or null while the string is at rest. */
  drawStartedAt: number | null;
  /** LMB (or the touch fire button) is held. */
  held: boolean;
  /** A NEW draw may begin: an arrow is nocked and nothing else owns the hands. */
  ready: boolean;
  /** Something took the hands mid-draw (sprint, a reload, a swap): let down. */
  interrupted: boolean;
  drawTime: number;
}

export type BowAction =
  | { kind: 'idle' }
  | { kind: 'start' }
  | { kind: 'hold'; fraction: number }
  | { kind: 'loose'; fraction: number }
  | { kind: 'letDown' };

/**
 * Hold LMB to draw, release to loose. A release under BOW_MIN_RELEASE lets
 * the string down rather than firing, and so does any interruption — a
 * drawn bow never fires because something ELSE happened.
 */
export function planBowTrigger(input: BowTriggerInput): BowAction {
  const { now, drawStartedAt, held, ready, interrupted, drawTime } = input;
  if (drawStartedAt === null) return held && ready ? { kind: 'start' } : { kind: 'idle' };
  if (interrupted) return { kind: 'letDown' };
  const fraction = bowDrawFraction(now - drawStartedAt, drawTime);
  if (held) return { kind: 'hold', fraction };
  return fraction >= BOW_MIN_RELEASE ? { kind: 'loose', fraction } : { kind: 'letDown' };
}
