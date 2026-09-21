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
