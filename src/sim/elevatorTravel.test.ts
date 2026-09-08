import { expect, test } from 'vitest';
import { Vector3 } from 'three';
import { elevatorTravel, committedTrip, type ElevatorTrip, type TravelView } from './elevatorTravel';
const view: TravelView = { feet: new Vector3(0, 0, 3), grounded: true, supported: false,
  dock: null, lowerLanding: new Vector3(0, 0, 3), upperLanding: new Vector3(0, 5.1, -3),
  center: new Vector3(0, 0.25, 0), lowerY: 0.25, upperY: 5.1 };
const trip: ElevatorTrip = { id: 'test', destination: 'upper', phase: 'approach' };

test('waits on the landing for a real dock, then boards', () => {
  const waiting = elevatorTravel(trip, view, 0.1);
  expect(waiting.trip?.phase).toBe('wait');
  expect(waiting.step.length()).toBe(0);
  const boarding = elevatorTravel(waiting.trip!, { ...view, dock: 'lower' }, 0.1);
  expect(boarding.trip?.phase).toBe('board');
  expect(boarding.step.z).toBeCloseTo(-0.1);
  expect(committedTrip(boarding.trip)).toBe(false);
});
test('missed boarding returns to the safe landing', () => {
  const result = elevatorTravel({ ...trip, phase: 'board' }, { ...view, feet: new Vector3(0, 0, 2.8) }, 0.1);
  expect(result.trip?.phase).toBe('approach');
  expect(result.step.z).toBeGreaterThan(0);
});
test.each(['upper', 'lower'] as const)('actual support is required to ride toward %s, then exit', destination => {
  const boarding: ElevatorTrip = { ...trip, destination, phase: 'board' };
  const aboard = { ...view, feet: new Vector3(0, 2, 0), supported: true };
  const ride = elevatorTravel(boarding, aboard, 0.1);
  expect(ride.trip?.phase).toBe('ride');
  expect(committedTrip(ride.trip)).toBe(true);
  expect(ride.step.length()).toBe(0);
  const y = destination === 'upper' ? 5.1 : 0.25;
  const exit = elevatorTravel(ride.trip!, { ...aboard, feet: new Vector3(0, y, 0), dock: destination }, 0.1);
  expect(exit.trip?.phase).toBe('exit');
  expect(Math.sign(exit.step.z)).toBe(destination === 'upper' ? -1 : 1);
  const end = destination === 'upper' ? view.upperLanding : view.lowerLanding;
  expect(elevatorTravel(exit.trip!, { ...view, feet: end }, 0.1).trip).toBeNull();
});
test('falling off cancels a ride, and a missed exit waits for the next dock', () => {
  expect(elevatorTravel({ ...trip, phase: 'ride' }, view, 0.1).trip).toBeNull();
  const missed = elevatorTravel({ ...trip, phase: 'exit' }, { ...view, supported: true, feet: new Vector3(0, 4, 0) }, 0.1);
  expect(missed.trip?.phase).toBe('ride');
});

test('a bot that fell below its boarding floor abandons the trip', () => {
  const descending: ElevatorTrip = { id: 'test', destination: 'lower', phase: 'wait' };
  expect(elevatorTravel(descending, { ...view, dock: 'upper' }, 0.1).trip).toBeNull();
});
