// sim/viewmodelHold.ts — the hip hold every firearm viewmodel shares.
//
// Pure: every input is a parameter (see sim/accuracy.ts). One rule instead of a
// hand-tuned offset per weapon: the grip sits at the same hand point, and the
// bore is turned to cross the crosshair a fixed distance out — the rule the
// knife's hold was derived from (weaponModels.ts, issue #143). Each weapon then
// shows at its real size and the same inward cant, instead of a long gun and a
// pistol at unrelated depths that perspective turns into unrelated angles.

export interface Vec3 { x: number; y: number; z: number }

export interface HipHold {
  /** Camera-space position of the model origin. */
  position: Vec3;
  /** Euler angles, order 'YXZ' (yaw, then pitch); no roll. */
  yaw: number;
  pitch: number;
}

/**
 * Rotate `v` by yaw about Y after pitch about X — three.js Euler order 'YXZ'.
 */
export function rotateYawPitch(v: Vec3, yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y = v.y * cp - v.z * sp;
  const z1 = v.y * sp + v.z * cp;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return { x: v.x * cy + z1 * sy, y, z: -v.x * sy + z1 * cy };
}

/**
 * Seat `grip` (model space) on `anchor` (camera space) and turn the bore — the
 * line through `muzzle` along model -z — onto the view axis at `convergence`
 * metres ahead of the eye.
 *
 * The muzzle's camera position depends on the rotation being solved for, so
 * this iterates; the correction shrinks by the muzzle-to-target over
 * grip-to-target ratio each pass, and eight passes settle every weapon here to
 * well under a microradian.
 */
export function hipHold(grip: Vec3, muzzle: Vec3, anchor: Vec3, convergence: number): HipHold {
  let yaw = 0, pitch = 0;
  const arm = { x: muzzle.x - grip.x, y: muzzle.y - grip.y, z: muzzle.z - grip.z };
  for (let i = 0; i < 8; i++) {
    const r = rotateYawPitch(arm, yaw, pitch);
    const dx = -(anchor.x + r.x), dy = -(anchor.y + r.y), dz = -convergence - (anchor.z + r.z);
    const length = Math.hypot(dx, dy, dz);
    // Bore direction (0,0,-1) under 'YXZ' is (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)).
    pitch = Math.asin(dy / length);
    yaw = Math.atan2(-dx, -dz);
  }
  const g = rotateYawPitch(grip, yaw, pitch);
  return { position: { x: anchor.x - g.x, y: anchor.y - g.y, z: anchor.z - g.z }, yaw, pitch };
}

/**
 * How far (m) to slide a hold back along its own bore until every point in
 * `points` (model space) is out of the bottom of the frame: below the edge
 * `slope` = tan(vfov / 2), or behind the near plane. `lift` is how far the
 * view may raise them (view bob), so the clearance survives it.
 *
 * Sliding along the bore keeps the bore line through the convergence point,
 * so the hold still aims where hipHold put it; only the grip leaves its hand
 * point, by exactly the returned distance. 0 when the points already clear.
 */
export function slideToClear(points: readonly Vec3[], hold: HipHold, slope: number, near: number,
  lift: number, step = 0.005, limit = 0.3): number {
  const back = rotateYawPitch({ x: 0, y: 0, z: 1 }, hold.yaw, hold.pitch);
  const placed = points.map(p => {
    const r = rotateYawPitch(p, hold.yaw, hold.pitch);
    return { x: hold.position.x + r.x, y: hold.position.y + r.y, z: hold.position.z + r.z };
  });
  const clear = (slide: number) => placed.every(p => {
    const y = p.y + back.y * slide + lift, z = p.z + back.z * slide;
    return z > -near || y < z * slope;
  });
  for (let slide = 0; slide <= limit; slide += step) if (clear(slide)) return slide;
  throw new Error(`Viewmodel hold: no slide within ${limit} m clears the frame`);
}
