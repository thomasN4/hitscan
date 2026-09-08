import { beforeEach, expect, test } from 'vitest';
import { Box3, Vector3, Raycaster } from 'three';
import { registerElevator, elevators, colliders, solids, navLinks, resetWorld, updateElevators, elevatorCarry } from './world';
import { buildNav, transportRoute } from './nav';
const spec = { id: 'test', x: 0, z: 0, width: 4, depth: 4, thickness: 0.25,
  lowerY: 0.25, upperY: 5.1, speed: 1.5, dwell: 2,
  lowerLanding: new Vector3(0, 0, 3), upperLanding: new Vector3(0, 5.1, -3) };
beforeEach(resetWorld);

test('registered once, collider and bullet target follow the deck before rendering', () => {
  const e = registerElevator(spec);
  expect(elevators).toEqual([e]);
  expect(solids).toEqual([e.mesh]);
  expect(colliders).toEqual([e.collider]);
  expect(navLinks[0]?.elevatorId).toBe('test');
  updateElevators(3, []);
  expect(e.collider.max.y).toBeCloseTo(1.75);
  expect(new Box3().setFromObject(e.mesh).max.y).toBeCloseTo(e.collider.max.y);
  const hit = new Raycaster(new Vector3(0, 10, 0), new Vector3(0, -1, 0)).intersectObjects(solids)[0];
  expect(hit?.point.y).toBeCloseTo(1.75);
  expect(colliders).toHaveLength(1);
  resetWorld();
  expect(elevators).toHaveLength(0);
  expect(navLinks).toHaveLength(0);
});

test('blocked movement preserves time, then resumes; zero dt is paused', () => {
  const e = registerElevator(spec);
  updateElevators(7.5, []);
  const obstruction = { x: 0, z: 0, feetY: 0, height: 4.6, radius: 0.5, grounded: true };
  const time = e.elapsed, top = e.collider.max.y;
  updateElevators(0.05, [obstruction]);
  expect(e.blocked).toBe(true);
  expect(e.elapsed).toBe(time);
  expect(e.collider.max.y).toBe(top);
  updateElevators(0.05, []);
  expect(e.blocked).toBe(false);
  expect(e.collider.max.y).toBeLessThan(top);
  updateElevators(0, []);
  expect(e.elapsed).toBe(time + 0.05);
  expect(e.deltaY).toBe(0);
});

test('support delta uses the previous deck, in both directions', () => {
  const e = registerElevator(spec);
  const rider = { x: 0, z: 0, feetY: 0.25, height: 2, radius: 0.5, grounded: true };
  updateElevators(2.05, [rider]);
  expect(elevatorCarry(rider)).toBeCloseTo(0.075);
  expect(elevatorCarry({ ...rider, grounded: false })).toBe(0);
  expect(elevatorCarry({ ...rider, x: 5 })).toBe(0);
  updateElevators(5.3, []);
  rider.feetY = e.collider.max.y;
  updateElevators(0.05, [rider]);
  expect(elevatorCarry(rider)).toBeCloseTo(-0.075);
});

test('invalid or duplicate configurations leave no partial registrations', () => {
  expect(() => registerElevator({ ...spec, speed: 0 })).toThrow();
  expect(colliders).toHaveLength(0);
  registerElevator(spec);
  expect(() => registerElevator(spec)).toThrow();
  expect(colliders).toHaveLength(1);
});

test('navigation excludes moving surfaces at every elevator position', () => {
  registerElevator(spec);
  colliders.push(new Box3(new Vector3(-3, 4.7, -5), new Vector3(3, 5.1, -2)));
  const before = buildNav();
  expect(Array.from(before.ys).some(y => Math.abs(y - 0.25) < 0.01)).toBe(false);
  const up = transportRoute(spec.lowerLanding, spec.upperLanding);
  const down = transportRoute(spec.upperLanding, spec.lowerLanding);
  expect(up?.filter(w => w.elevatorId)).toHaveLength(1);
  expect(down?.filter(w => w.elevatorId)).toHaveLength(1);
  updateElevators(3, []);
  const after = buildNav();
  expect(after.ys).toEqual(before.ys);
  expect(after.edgeTo).toEqual(before.edgeTo);
  expect(after.edgeCost).toEqual(before.edgeCost);
});
