import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { ARROW_DRAG, ARROW_GRAVITY, ARROW_SUBSTEP, advanceArrow, stepArrow, trimTrail, type ArrowBody, type SegmentCast, type TrailPoint } from './arrow';

function body(speed: number, dir = new THREE.Vector3(0, 0, -1)): ArrowBody {
  return { pos: new THREE.Vector3(0, 1.6, 0), vel: dir.clone().normalize().multiplyScalar(speed), age: 0 };
}

/** A wall across -z at depth `z`, reporting where each chord pierces it. */
function wallAt(z: number): SegmentCast<string> {
  return (from, to) => {
    if (!(from.z > z && to.z <= z)) return null;
    const t = (from.z - z) / (from.z - to.z);
    return { point: from.clone().lerp(to, t), payload: 'wall' };
  };
}

const never: SegmentCast<never> = () => null;

describe('arrow flight', () => {
  test('drops like a thrown body: vertical fall matches ½gt² while drag stays small', () => {
    const b = body(58);
    advanceArrow(b, 0.5, never);
    // Drag also bleeds a sliver of the (tiny) vertical velocity, so allow 1%.
    expect(1.6 - b.pos.y).toBeCloseTo(0.5 * ARROW_GRAVITY * 0.25, 1);
    expect(b.age).toBeCloseTo(0.5, 9);
  });

  test('drag bleeds speed exponentially with path length', () => {
    const b = { pos: new THREE.Vector3(), vel: new THREE.Vector3(0, 0, -58), age: 0 };
    // Flat, drag-only: integrate by hand without gravity to isolate k.
    let travelled = 0;
    while (travelled < 40) {
      const speed = b.vel.length();
      b.vel.multiplyScalar(1 - ARROW_DRAG * speed * ARROW_SUBSTEP);
      travelled += b.vel.length() * ARROW_SUBSTEP;
    }
    expect(b.vel.length() / 58).toBeCloseTo(Math.exp(-ARROW_DRAG * 40), 2);
    // And the tuned number itself: ~93% retained at 40 m.
    expect(Math.exp(-ARROW_DRAG * 40)).toBeGreaterThan(0.92);
    expect(Math.exp(-ARROW_DRAG * 40)).toBeLessThan(0.94);
  });

  test('the flight does not depend on the frame rate', () => {
    const fast = body(58, new THREE.Vector3(0, 0.2, -1));
    const slow = body(58, new THREE.Vector3(0, 0.2, -1));
    for (let i = 0; i < 144; i++) advanceArrow(fast, 1 / 144, never);
    for (let i = 0; i < 20; i++) advanceArrow(slow, 1 / 20, never);
    expect(fast.pos.distanceTo(slow.pos)).toBeLessThan(0.01);
  });

  test('a hit stops the tip on the wall with its arrival speed', () => {
    const b = body(58);
    const hit = advanceArrow(b, 1, wallAt(-20));
    expect(hit?.payload).toBe('wall');
    expect(b.pos.z).toBeCloseTo(-20, 6);
    expect(b.vel.length()).toBeLessThan(58);
    expect(b.vel.length()).toBeGreaterThan(55);
  });

  test('a long frame still cannot tunnel through a thin wall', () => {
    // 0.25 s at 58 m/s is ~14 m in one frame; the wall is a plane with no depth.
    const b = body(58);
    const hit = advanceArrow(b, 0.25, wallAt(-5));
    expect(hit).not.toBeNull();
    expect(b.pos.z).toBeCloseTo(-5, 6);
  });

  test('stepArrow points gravity down and drag against the motion', () => {
    const b = body(58, new THREE.Vector3(1, 0, 0));
    stepArrow(b, 0.01);
    expect(b.vel.y).toBeLessThan(0);
    expect(b.vel.x).toBeLessThan(58);
    expect(b.vel.z).toBeCloseTo(0, 12);
  });
});

describe('trimTrail', () => {
  const point = (age: number): TrailPoint => ({ at: new THREE.Vector3(0, 0, -age * 58), age });

  test('holds the same span of flight however long the arrow has flown', () => {
    // One sample per 60 Hz frame: the trail must keep ~0.3 s of samples late
    // in a flight exactly as it did early — no shrinking to a stub.
    const trail: TrailPoint[] = [];
    const lengths: number[] = [];
    for (let frame = 1; frame <= 240; frame++) {
      trail.push(point(frame / 60));
      trimTrail(trail, frame / 60, 0.3);
      if (frame >= 60) lengths.push(trail.length);
    }
    // Float ages straddle the 0.3 s boundary, so allow one sample of jitter;
    // the old count-based trim fell steadily toward two.
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(18);
    expect(lengths.at(-1)).toBeGreaterThanOrEqual(18);
  });

  test('always keeps two samples to draw a line between', () => {
    const trail = [point(0), point(5)];
    trimTrail(trail, 5, 0.3);
    expect(trail).toHaveLength(2);
  });
});

