import { describe, expect, test } from 'vitest';
import { Box3, Vector3 } from 'three';
import { elevatorSample, elevatorSupports, elevatorBlocked, type ElevatorBody } from './elevator';
const spec = { lowerY: 0.25, upperY: 5.1, speed: 1.5, dwell: 2 };
const travel = (spec.upperY - spec.lowerY) / spec.speed;
const box = (minY: number, maxY: number, minZ = -2, maxZ = 2): Box3 =>
  new Box3(new Vector3(-2, minY, minZ), new Vector3(2, maxY, maxZ));
const body = (feetY: number, grounded = true): ElevatorBody =>
  ({ x: 0, z: 0, radius: 0.5, height: 2, feetY, grounded });

describe('elevator cycle', () => {
  test('dwells, moves at the configured speed, reverses, and repeats', () => {
    expect(elevatorSample(spec, 1)).toEqual({ topY: 0.25, dock: 'lower' });
    expect(elevatorSample(spec, 3)).toEqual({ topY: 1.75, dock: null });
    expect(elevatorSample(spec, 2 + travel + 1)).toEqual({ topY: 5.1, dock: 'upper' });
    expect(elevatorSample(spec, 4 + travel + 1).topY).toBeCloseTo(3.6);
    expect(elevatorSample(spec, 2 * (2 + travel) + 1)).toEqual({ topY: 0.25, dock: 'lower' });
  });
  test('never overshoots even across endpoint boundaries', () => {
    for (let t = 0; t < 100; t += 0.037) {
      const sample = elevatorSample(spec, t);
      expect(sample.topY).toBeGreaterThanOrEqual(spec.lowerY);
      expect(sample.topY).toBeLessThanOrEqual(spec.upperY);
    }
  });
});

describe('passengers and swept obstruction', () => {
  test('only grounded, overlapping feet on the deck are carried', () => {
    const deck = box(1, 1.25);
    expect(elevatorSupports(body(1.25), deck, [])).toBe(true);
    expect(elevatorSupports(body(1.25, false), deck, [])).toBe(false);
    expect(elevatorSupports(body(1.4), deck, [])).toBe(false);
    expect(elevatorSupports({ ...body(1.25), x: 2.5 }, deck, [])).toBe(false);
  });
  test('a landing takes support at a shared edge', () => {
    const deck = box(4.85, 5.1);
    const landing = box(4.7, 5.1, -4, -2);
    expect(elevatorSupports({ ...body(5.1), z: -1.75 }, deck, [landing])).toBe(false);
  });
  test('free passengers move in either direction without being obstacles', () => {
    const deck = box(3, 3.25);
    expect(elevatorBlocked(deck, 0.1, [body(3.25)], [deck])).toBe(false);
    expect(elevatorBlocked(deck, -0.1, [body(3.25)], [deck])).toBe(false);
  });
  test('sweeps the underside against a non-rider and resumes once clear', () => {
    const deck = box(2.1, 2.35);
    expect(elevatorBlocked(deck, -0.2, [body(0)], [])).toBe(true);
    expect(elevatorBlocked(deck, -0.2, [{ ...body(0), x: 4 }], [])).toBe(false);
  });
  test('stops upward motion before a passenger enters a ceiling', () => {
    const deck = box(1, 1.25), roof = box(3.3, 4);
    expect(elevatorBlocked(deck, 0.1, [body(1.25)], [roof])).toBe(true);
    expect(elevatorBlocked(deck, -0.1, [body(1.25)], [roof])).toBe(false);
  });
  test('a rider cannot descend through an overlapping landing', () => {
    const deck = box(5, 5.25), landing = box(4.7, 5.1, -4, -2);
    expect(elevatorBlocked(deck, -0.2, [{ ...body(5.25), z: -1.75 }], [landing])).toBe(true);
  });
  test('the deck itself cannot sweep through static geometry', () => {
    expect(elevatorBlocked(box(1, 1.25), 2, [], [box(2, 2.5)])).toBe(true);
  });
});
