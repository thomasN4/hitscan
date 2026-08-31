// sim/movement.ts — speed tiers, gravity and the movement-accuracy input.
//
// Pure: every input is a parameter.

/**
 * Gravity (m/s^2) — tuned so the player's jump arc feels snappy at 60fps+.
 * Shared by bots so both entity types fall and land identically.
 */
export const GRAVITY = 22;

/** Base walking speed (m/s). Also the normalizer for moveLerp. */
export const WALK_SPEED = 6.5;
/** Crouched speed (m/s) — slow, but silent and the most accurate stance. */
export const CROUCH_SPEED = 2.4;
/** Speed while aiming down sights (m/s). */
export const ADS_SPEED = 3.8;
/** Extra speed at full sprint ramp; WALK_SPEED + this = 9.75 ≈ 1.5×. */
export const SPRINT_BONUS = 3.25;
/** moveLerp ceiling — sprint is 1.5× walk. */
export const MAX_MOVE_LERP = 1.5;

/** Raw stance/buttons needed to decide whether the sprint action is active. */
export interface SprintInput {
  /** Shift held (the input slice calls this `running`). */
  sprintHeld: boolean;
  aiming: boolean;
  /** Effective crouch, after the caller applies the grounded-only rule. */
  crouching: boolean;
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
}

/**
 * Whether the player is actively sprinting: Shift plus a net movement
 * direction, unless aim or crouch takes precedence. Opposing keys cancel,
 * matching the movement vector rather than counting any WASD key blindly.
 */
export function isSprintActive({
  sprintHeld, aiming, crouching, forward, backward, left, right,
}: SprintInput): boolean {
  const pressingMove = forward !== backward || left !== right;
  return sprintHeld && pressingMove && !aiming && !crouching;
}

/** Inputs to speedFor — the stance flags the caller resolves plus the sprint blend. */
export interface SpeedInput {
  crouching: boolean;
  aiming: boolean;
  running: boolean;
  /** 0..1 sprint acceleration blend. */
  runLerp: number;
}

/**
 * Movement speed for the current stance, in m/s.
 *
 * Precedence is deliberate: crouch and aim both beat sprint, so there is no
 * sprint-scoping and no sprint-crouching. The caller resolves `running` to
 * already exclude those (see player.ts).
 */
export function speedFor({ crouching, aiming, running, runLerp }: SpeedInput): number {
  if (crouching) return CROUCH_SPEED;
  if (aiming) return ADS_SPEED;
  if (running) return WALK_SPEED + SPRINT_BONUS * runLerp;
  return WALK_SPEED;
}

/**
 * Normalized movement-accuracy input from MEASURED displacement.
 *
 * Measured, not intended: walking into a wall must not count as moving, or
 * the crosshair would bloom while the player is stuck in place.
 *
 * @param dx x displacement this frame (m)
 * @param dz z displacement this frame (m)
 * @param dt frame delta (s)
 * @returns 0 idle, 1 walk, up to MAX_MOVE_LERP sprinting
 */
export function measuredMoveLerp(dx: number, dz: number, dt: number): number {
  const speed = Math.hypot(dx, dz) / dt;
  return Math.min(speed / WALK_SPEED, MAX_MOVE_LERP);
}
