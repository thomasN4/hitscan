// Pure vertical elevator motion and swept passenger safety. Geometry bindings
// supply snapshots; neither the engine nor shared gameplay state enters here.
import type { Box3 } from 'three';

export interface ElevatorMotion {
  lowerY: number;
  upperY: number;
  speed: number;
  dwell: number;
}
export interface ElevatorBody {
  x: number;
  z: number;
  feetY: number;
  radius: number;
  height: number;
  grounded: boolean;
}
export interface ElevatorSample {
  topY: number;
  dock: 'lower' | 'upper' | null;
}
const EPS = 1e-6;

export function elevatorSample(spec: ElevatorMotion, elapsed: number): ElevatorSample {
  const travel = (spec.upperY - spec.lowerY) / spec.speed;
  const period = 2 * (travel + spec.dwell);
  const t = ((elapsed % period) + period) % period;
  if (t < spec.dwell) return { topY: spec.lowerY, dock: 'lower' };
  if (t < spec.dwell + travel) return { topY: spec.lowerY + (t - spec.dwell) * spec.speed, dock: null };
  if (t < 2 * spec.dwell + travel) return { topY: spec.upperY, dock: 'upper' };
  return { topY: spec.upperY - (t - 2 * spec.dwell - travel) * spec.speed, dock: null };
}

function overlapsXZ(body: ElevatorBody, box: Box3): boolean {
  return body.x + body.radius > box.min.x + EPS && body.x - body.radius < box.max.x - EPS
    && body.z + body.radius > box.min.z + EPS && body.z - body.radius < box.max.z - EPS;
}

/** A stationary landing wins shared edge support, so stepping off detaches. */
export function elevatorSupports(body: ElevatorBody, deck: Box3, others: readonly Box3[]): boolean {
  return body.grounded && Math.abs(body.feetY - deck.max.y) < EPS * 10
    && overlapsXZ(body, deck)
    && !others.some(c => c !== deck && Math.abs(c.max.y - body.feetY) < EPS * 10 && overlapsXZ(body, c));
}

/** Reject the entire attempted move; callers also retain the old cycle time. */
export function elevatorBlocked(deck: Box3, dy: number, bodies: readonly ElevatorBody[], others: readonly Box3[]): boolean {
  if (Math.abs(dy) < EPS) return false;
  const minY = Math.min(deck.min.y, deck.min.y + dy);
  const maxY = Math.max(deck.max.y, deck.max.y + dy);
  // Moving geometry itself must not enter another solid.
  if (others.some(c => c !== deck && c.min.x < deck.max.x - EPS && c.max.x > deck.min.x + EPS
      && c.min.z < deck.max.z - EPS && c.max.z > deck.min.z + EPS
      && c.min.y < maxY - EPS && c.max.y > minY + EPS)) return true;
  for (const body of bodies) {
    if (elevatorSupports(body, deck, others)) {
      const feet = Math.min(body.feetY, body.feetY + dy);
      const head = Math.max(body.feetY, body.feetY + dy) + body.height;
      if (others.some(c => c !== deck && overlapsXZ(body, c)
          && c.min.y < head - EPS && c.max.y > feet + EPS)) return true;
      // A passenger must not be carried into another body either.
      if (bodies.some(other => other !== body && !elevatorSupports(other, deck, others)
          && Math.abs(body.x - other.x) < body.radius + other.radius - EPS
          && Math.abs(body.z - other.z) < body.radius + other.radius - EPS
          && other.feetY < head - EPS && other.feetY + other.height > feet + EPS)) return true;
    } else if (overlapsXZ(body, deck) && body.feetY < maxY - EPS && body.feetY + body.height > minY + EPS) {
      return true;
    }
  }
  return false;
}
