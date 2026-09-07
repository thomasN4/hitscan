import { Vector3 } from 'three';

/** Fixed-length limb in one coordinate space; pole is an elbow direction.
 * Zero-distance and collinear poles choose a stable perpendicular plane.
 */
export function solveArmIK(shoulder: Vector3, target: Vector3, pole: Vector3,
  upperLength: number, forearmLength: number): { elbow: Vector3; wrist: Vector3; clamped: boolean } {
  if (![...shoulder.toArray(), ...target.toArray(), ...pole.toArray(), upperLength, forearmLength].every(Number.isFinite)
    || upperLength <= 0 || forearmLength <= 0) throw new Error('Arm IK requires finite coordinates and positive lengths');
  const delta = target.clone().sub(shoulder);
  const requested = delta.length();
  const axis = requested > 1e-8 ? delta.divideScalar(requested) : new Vector3(0, 1, 0);
  const distance = Math.max(Math.abs(upperLength - forearmLength) + 1e-7,
    Math.min(upperLength + forearmLength - 1e-7, requested));
  const bend = pole.clone().addScaledVector(axis, -pole.dot(axis));
  if (bend.lengthSq() < 1e-10) {
    bend.set(Math.abs(axis.x) < .9 ? 1 : 0, Math.abs(axis.x) < .9 ? 0 : 1, 0);
    bend.addScaledVector(axis, -bend.dot(axis));
  }
  bend.normalize();
  const along = (upperLength ** 2 - forearmLength ** 2 + distance ** 2) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  return {
    elbow: shoulder.clone().addScaledVector(axis, along).addScaledVector(bend, height),
    wrist: shoulder.clone().addScaledVector(axis, distance),
    clamped: Math.abs(requested - distance) > 1e-6,
  };
}
