// sim/look.ts — turning pointer deltas into view yaw/pitch.
//
// Shared by the mouse (main.ts mousemove) and the touch look surfaces
// (touchControls.ts), so both inputs clamp and scale identically. Only the
// sensitivity differs: a mouse reports raw counts, a finger CSS pixels.

/** Pitch stays just short of straight up/down so the view never flips over. */
export const PITCH_LIMIT = Math.PI / 2 - 0.01;

/**
 * Apply a pointer delta to the base aim. `zoomScale` shrinks toward the FOV
 * ratio while scoped (weapons.ts), so aiming stays controllable at 12x
 * instead of flinging across the sky.
 *
 * @param sens radians per pixel of pointer movement
 */
export function applyLook(
  yaw: number, pitch: number, dx: number, dy: number, sens: number, zoomScale: number,
): { yaw: number; pitch: number } {
  return {
    yaw: yaw - dx * sens * zoomScale,
    pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch - dy * sens * zoomScale)),
  };
}

// ---------- Sensitivity and acceleration ----------
// User-facing sensitivities (core/settings.ts) are MULTIPLIERS of these
// bases, so 1.0 with no acceleration is the original fixed feel.

/** Radians per mouse count at mouse sensitivity 1.0. */
export const MOUSE_BASE_SENS = 0.0022;
/** Radians per CSS pixel of finger travel at touch sensitivity 1.0 — a ~700 px swipe turns about 180°. */
export const TOUCH_BASE_SENS = 0.0045;
/** Finger speed (px/s) at which acceleration 1.0 doubles the turn per pixel. */
export const ACCEL_REF_PXS = 1000;
/** Finger speed (px/s) past which acceleration stops growing, so one wild flick cannot spin the view. */
export const ACCEL_CAP_PXS = 3000;

/** One sensitivity/acceleration pair — the hip and ADS tunings each hold one. */
export interface LookTuning {
  /** Multiplier of the base sensitivity. */
  sens: number;
  /** 0 = linear; each 1.0 adds another base's worth of turn per pixel at ACCEL_REF_PXS. */
  accel: number;
}

/**
 * Turn multiplier for a finger moving at `speedPxPerS`: fast flicks turn
 * further per pixel than slow tracking drags, so one setting can serve both.
 * Linear in speed up to the cap; exactly 1 when accel is 0.
 */
export function accelGain(speedPxPerS: number, accel: number): number {
  return 1 + accel * Math.min(Math.max(speedPxPerS, 0), ACCEL_CAP_PXS) / ACCEL_REF_PXS;
}

/**
 * Blend the hip and ADS tunings by the sights' raise progress (wpn.adsLerp,
 * 0..1), so raising the sights eases between the two feels instead of
 * snapping mid-drag.
 */
export function blendLook(hip: LookTuning, ads: LookTuning, t: number): LookTuning {
  const k = Math.min(1, Math.max(0, t));
  return { sens: hip.sens + (ads.sens - hip.sens) * k, accel: hip.accel + (ads.accel - hip.accel) * k };
}
