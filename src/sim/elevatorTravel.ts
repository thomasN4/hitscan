// Per-bot elevator traversal, expressed as a pure transition over snapshots.
import { Vector3 } from 'three';
export type ElevatorStop = 'lower' | 'upper';
export interface ElevatorTrip {
  id: string;
  destination: ElevatorStop;
  phase: 'approach' | 'wait' | 'board' | 'ride' | 'exit';
}
export interface TravelView {
  feet: Vector3;
  grounded: boolean;
  supported: boolean;
  dock: ElevatorStop | null;
  lowerLanding: Vector3;
  upperLanding: Vector3;
  center: Vector3;
  lowerY: number;
  upperY: number;
}
export interface TravelResult {
  trip: ElevatorTrip | null;
  step: Vector3;
}
export function committedTrip(trip: ElevatorTrip | null): boolean {
  return trip?.phase === 'ride' || trip?.phase === 'exit';
}

export function elevatorTravel(trip: ElevatorTrip, view: TravelView, distance: number): TravelResult {
  const next = { ...trip };
  const source = trip.destination === 'upper' ? 'lower' : 'upper';
  const start = source === 'lower' ? view.lowerLanding : view.upperLanding;
  const finish = trip.destination === 'lower' ? view.lowerLanding : view.upperLanding;
  const targetY = trip.destination === 'lower' ? view.lowerY : view.upperY;
  const stepTo = (target: Vector3): Vector3 => {
    const delta = new Vector3(target.x - view.feet.x, 0, target.z - view.feet.z);
    return delta.clampLength(0, distance);
  };
  const near = (target: Vector3): boolean => Math.hypot(target.x - view.feet.x, target.z - view.feet.z) < 0.15;
  const stationary = (): TravelResult => ({ trip: next, step: new Vector3() });
  // A fall off the boarding floor invalidates this trip. In particular, a
  // ground bot must not wait underneath a descending deck for an upper stop.
  if (!committedTrip(next) && !view.supported && Math.abs(view.feet.y - start.y) > 0.3) {
    return { trip: null, step: new Vector3() };
  }
  if (next.phase === 'approach') {
    if (!near(start)) return { trip: next, step: stepTo(start) };
    next.phase = 'wait';
  }
  if (next.phase === 'wait') {
    if (view.dock !== source) return stationary();
    next.phase = 'board';
  }
  if (next.phase === 'board') {
    if (view.supported) next.phase = 'ride';
    else if (view.dock !== source) {
      next.phase = 'approach';
      return { trip: next, step: stepTo(start) };
    } else return { trip: next, step: stepTo(view.center) };
  }
  if (next.phase === 'ride') {
    // A knocked-off passenger must not hold a route forever.
    if (!view.supported) return { trip: null, step: new Vector3() };
    if (view.dock === trip.destination) next.phase = 'exit';
    else return { trip: next, step: stepTo(view.center) };
  }
  if (next.phase === 'exit') {
    if (!view.supported && view.grounded && near(finish) && Math.abs(view.feet.y - finish.y) < 0.3) {
      return { trip: null, step: new Vector3() };
    }
    if (view.supported && (view.dock !== trip.destination || Math.abs(view.feet.y - targetY) > 0.01)) {
      next.phase = 'ride';
      return { trip: next, step: stepTo(view.center) };
    }
    if (!view.supported && Math.abs(view.feet.y - finish.y) > 0.3) return { trip: null, step: new Vector3() };
    return { trip: next, step: stepTo(finish) };
  }
  return stationary();
}
