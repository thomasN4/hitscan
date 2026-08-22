// sim/smoothing.js — the frame-rate-aware easing used by every 0..1 blend.
//
// Pure. This pattern appeared open-coded five times (moveLerp, runLerp,
// crouchLerp, adsLerp, camera FOV), each with its own rate and its own
// snap-to-zero epsilon. One implementation means one place to reason about
// the dt clamp that keeps a slow frame from overshooting past the target.

/** Below this, a decaying blend is snapped to 0 so it doesn't creep forever. */
export const EPSILON = 0.001;

/**
 * Exponential ease from `current` toward `target`.
 *
 * `Math.min(1, dt * rate)` is the important part: without the clamp, a
 * frame longer than 1/rate produces a step >1 and the value overshoots and
 * oscillates. Higher `rate` = snappier.
 *
 * @param {number} current
 * @param {number} target
 * @param {number} dt   frame delta in seconds
 * @param {number} rate 1/seconds; e.g. 10 ≈ 100 ms to close most of the gap
 */
export function approach(current, target, dt, rate) {
  return current + (target - current) * Math.min(1, dt * rate);
}

/** Snap near-zero blends to exactly 0 (see EPSILON). */
export function deadZone(value, epsilon = EPSILON) {
  return value < epsilon ? 0 : value;
}
