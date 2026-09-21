// sim/joystick.ts — the touch movement stick's geometry.
//
// Critical Ops-style floating stick: the base appears where the thumb lands,
// and the knob's offset from it is the movement intent. There is no separate
// sprint button — pushing the knob to the rim sprints, anything short of it
// walks — so the sprint decision is part of the stick's reading, and lives
// here where the suite can pin the thresholds.

/** Fraction of the radius ignored at the centre, so a resting thumb does not creep. */
export const STICK_DEAD_ZONE = 0.12;
/** Fraction of the radius past which the stick sprints. */
export const STICK_SPRINT_AT = 0.9;

export interface StickReading {
  /** Unit direction, screen right = +x (0 inside the dead zone). */
  x: number;
  /** Unit direction, screen UP = +y (0 inside the dead zone). */
  y: number;
  /** Knob displacement as a fraction of the radius, clamped to 0..1. */
  magnitude: number;
  /** Pushed to the rim: sprint intent. */
  sprint: boolean;
  /** Knob offset from the base in px, clamped to the radius (for drawing). */
  knobX: number;
  knobY: number;
}

/**
 * Read the stick from the thumb's offset to the base, in screen pixels
 * (+dy is DOWN, as pointer events report it). The direction is unit-length
 * rather than magnitude-scaled: player speed comes from the stance tiers in
 * sim/movement.ts, so a half-pushed stick walks at the same speed as W does.
 */
export function stickVector(dx: number, dy: number, radius: number): StickReading {
  const len = Math.hypot(dx, dy);
  const magnitude = Math.min(1, len / radius);
  const clamp = len > radius ? radius / len : 1;
  const knobX = dx * clamp, knobY = dy * clamp;
  if (magnitude < STICK_DEAD_ZONE) return { x: 0, y: 0, magnitude, sprint: false, knobX, knobY };
  return { x: dx / len, y: -dy / len, magnitude, sprint: magnitude > STICK_SPRINT_AT, knobX, knobY };
}
