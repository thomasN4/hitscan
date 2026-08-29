// perception.test.ts — pins the pure visual-acquisition seam.
//
// The expected values below are restated independently (longhand vector
// arithmetic) rather than mirroring acquireVisual's code paths, the same
// discipline as botBrains.test.ts. The seams the executor relies on get
// explicit pins: inclusive boundaries, one ray per call, copied vectors, and
// the cursor's fairness contract.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  PERCEPTION_FOV_DEG,
  PERCEPTION_RANGE_M,
  acquireVisual,
  type LosProbe,
  type PerceptionId,
  type VisualCandidate,
} from './perception';

const HALF_FOV_RAD = (PERCEPTION_FOV_DEG / 2) * (Math.PI / 180);

/** Canonical perceiver: feet at the origin, eye 1.9 m up, facing +z. */
function selfAt(over: Partial<{ fx: number; fz: number }> = {}) {
  const facing = new THREE.Vector3(over.fx ?? 0, 0, over.fz ?? 1).normalize();
  return {
    eye: new THREE.Vector3(0, 1.9, 0),
    feet: new THREE.Vector3(0, 0, 0),
    facing,
  };
}

/** Candidate at planar offset (x, z), eye 1.9 m up, feet on the ground. */
function cand(id: PerceptionId, x: number, z: number, opts: Partial<{ alive: boolean; eyeY: number; feetY: number }> = {}): VisualCandidate {
  return {
    id,
    feet: new THREE.Vector3(x, opts.feetY ?? 0, z),
    eye: new THREE.Vector3(x, opts.eyeY ?? 1.9, z),
    alive: opts.alive ?? true,
  };
}

/** LOS always true, counting calls. */
function countingLos(): { los: LosProbe; count: () => number } {
  let calls = 0;
  return { los: () => { calls++; return true; }, count: () => calls };
}

/** LOS always false, counting calls. */
function blockedLos(): { los: LosProbe; count: () => number } {
  let calls = 0;
  return { los: () => { calls++; return false; }, count: () => calls };
}

describe('acquireVisual cheap gates', () => {
  it('accepts a plain candidate dead ahead', () => {
    const self = selfAt();
    const { los } = countingLos();
    const r = acquireVisual(self, [cand(1, 0, 10)], null, 0, los);
    expect(r.observation).not.toBeNull();
    expect(r.observation!.id).toBe(1);
  });

  it('range boundary is inclusive at exactly 80 m, exclusive beyond', () => {
    const self = selfAt();
    const { los } = countingLos();
    expect(PERCEPTION_RANGE_M).toBe(80);
    expect(acquireVisual(self, [cand(1, 0, PERCEPTION_RANGE_M)], null, 0, los).observation).not.toBeNull();
    expect(acquireVisual(self, [cand(2, 0, PERCEPTION_RANGE_M + 0.001)], null, 0, los).observation).toBeNull();
  });

  it('range is the full 3D eye distance, not the planar one', () => {
    const self = selfAt();
    const { los } = countingLos();
    // 60 m planar and 45 m up: eye-to-eye ~75 m — inside.
    const inside = cand(1, 0, 45, { eyeY: 1.9 + 45, feetY: 45 });
    // 45 m planar and 80 m up: eye-to-eye ~92 m — beyond.
    const outside = cand(2, 0, 45, { eyeY: 1.9 + 80, feetY: 80 });
    expect(acquireVisual(self, [inside], null, 0, los).observation).not.toBeNull();
    expect(acquireVisual(self, [outside], null, 0, los).observation).toBeNull();
  });

  it('FOV boundary: just inside the half-angle is visible, just outside is not', () => {
    const self = selfAt();
    const { los } = countingLos();
    const planar = 10;
    // 59.9999° and 60.0001° off facing — the ±1e-7 rad window pins the
    // boundary while staying clear of cos()'s last-ulp rounding either way.
    const eps = 1e-7;
    const insideA = HALF_FOV_RAD - eps;
    const outsideA = HALF_FOV_RAD + eps;
    const inside = cand(1, planar * Math.sin(insideA), planar * Math.cos(insideA));
    const outside = cand(2, planar * Math.sin(outsideA), planar * Math.cos(outsideA));
    expect(acquireVisual(self, [inside], null, 0, los).observation).not.toBeNull();
    expect(acquireVisual(self, [outside], null, 0, los).observation).toBeNull();
  });

  it('FOV boundary is inclusive at a geometrically exact 60-degree offset', () => {
    // Facing 30° off +x, target exactly on +x: the planar angle between them
    // is exactly 60°. The normalized dot product lands one ulp below
    // cos(π/3), so the inclusive comparison must absorb floating-point-scale
    // error at the boundary — without accepting a meaningfully outside one.
    const facing = new THREE.Vector3(Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)).normalize();
    const self = { eye: new THREE.Vector3(0, 1.9, 0), feet: new THREE.Vector3(0, 0, 0), facing };
    const { los } = countingLos();
    const exact = cand(1, 10, 0);
    expect(acquireVisual(self, [exact], null, 0, los).observation).not.toBeNull();
  });

  it('vertical angle never narrows the cone: a deck overhead in the planar cone is seen', () => {
    const self = selfAt();
    const { los } = countingLos();
    // 45° off facing in the plane, ~48 m up: ~78° above horizontal — far
    // outside any vertical cone, but the FOV is horizontal-only and the
    // eye-to-eye range still fits.
    const deck = cand(1, 5, 5, { eyeY: 1.9 + 45, feetY: 45 });
    expect(Math.hypot(5, 45, 5)).toBeLessThan(PERCEPTION_RANGE_M);
    expect(acquireVisual(self, [deck], null, 0, los).observation).not.toBeNull();
  });

  it('dead candidates are cheap rejections that never reach LOS', () => {
    const self = selfAt();
    const { los, count } = blockedLos();
    const r = acquireVisual(self, [cand(1, 0, 10, { alive: false })], null, 0, los);
    expect(r.observation).toBeNull();
    expect(r.attempted).toBeNull();
    expect(count()).toBe(0);
  });

  it('zero-planar-offset candidates (directly overhead) are cheap rejections', () => {
    const self = selfAt();
    const { los, count } = countingLos();
    const overhead = cand(1, 0, 0, { eyeY: 30, feetY: 28 });
    const r = acquireVisual(self, [overhead], null, 0, los);
    expect(r.observation).toBeNull();
    expect(r.attempted).toBeNull();
    expect(count()).toBe(0);
  });
});

describe('acquireVisual focus and rotation', () => {
  it('probes the focused candidate first, ahead of the stable order', () => {
    const self = selfAt();
    // Candidate 5 sits earlier in the stable order but focus is 3.
    const c5 = cand(5, 0, 10);
    const c3 = cand(3, 0, 20);
    const seen: PerceptionId[] = [];
    const los: LosProbe = (_f, to) => { seen.push(to.z); return true; };
    const r = acquireVisual(self, [c5, c3], 3, 0, los);
    expect(r.observation!.id).toBe(3);
    expect(seen).toEqual([20]); // only the focus was probed
    expect(r.attempted).toBe(3);
  });

  it('a focused candidate that fails LOS consumes the frame without rotating the cursor', () => {
    const self = selfAt();
    const c1 = cand(1, 0, 10);
    const c2 = cand(2, 0, 20);
    const { los, count } = blockedLos();
    const r = acquireVisual(self, [c1, c2], 1, 0, los);
    expect(r.observation).toBeNull();
    expect(r.attempted).toBe(1);
    expect(r.cursor).toBe(0); // focused attempt: cursor holds
    expect(count()).toBe(1);  // one ray, spent on the focus
  });

  it('a cheaply ineligible focus falls through to the fair rotation from the cursor', () => {
    const self = selfAt();
    const dead = cand(9, 0, 10, { alive: false });
    const a = cand(1, 0, 12);
    const b = cand(2, 0, 15);
    const seen: number[] = [];
    const los: LosProbe = (_f, to) => { seen.push(to.z); return true; };
    // Focus 9 is dead; cursor 0 starts the scan at candidate 1.
    const r = acquireVisual(self, [dead, a, b], 9, 0, los);
    expect(r.observation!.id).toBe(1);
    expect(seen).toEqual([12]);
    expect(r.cursor).toBe(1);
  });

  it('a failed non-focused LOS advances the cursor to the following candidate', () => {
    const self = selfAt();
    const a = cand(1, 0, 10);
    const b = cand(2, 0, 20);
    const seen: number[] = [];
    const los: LosProbe = (_f, to) => { seen.push(to.z); return false; };
    const r = acquireVisual(self, [a, b], null, 0, los);
    expect(r.observation).toBeNull();
    expect(r.attempted).toBe(1);
    expect(r.cursor).toBe(1);
    expect(seen).toEqual([10]);
    // Next call resumes at candidate 2 — the failed one is not retried first.
    const seen2: number[] = [];
    const los2: LosProbe = (_f, to) => { seen2.push(to.z); return false; };
    const r2 = acquireVisual(self, [a, b], null, r.cursor, los2);
    expect(r2.attempted).toBe(2);
    expect(r2.cursor).toBe(0);
    expect(seen2).toEqual([20]);
  });

  it('orders deterministically: player before ascending bot ids, input order irrelevant', () => {
    const self = selfAt();
    const list = [cand(7, 0, 10), cand(3, 0, 20), cand('player', 0, 30)];
    const attempted: PerceptionId[] = [];
    let cursor = 0;
    for (let i = 0; i < 3; i++) {
      const los: LosProbe = () => false;
      const r = acquireVisual(self, list, null, cursor, los);
      attempted.push(r.attempted!);
      cursor = r.cursor;
    }
    expect(attempted).toEqual(['player', 3, 7]);
  });

  it('wraps a stale cursor larger than the candidate count', () => {
    const self = selfAt();
    const a = cand(1, 0, 10);
    const b = cand(2, 0, 20);
    const los: LosProbe = () => false;
    // cursor 7 into a 2-list wraps to 1 → candidate 2 probed first.
    const r = acquireVisual(self, [a, b], null, 7, los);
    expect(r.attempted).toBe(2);
    expect(r.cursor).toBe(0);
  });

  it('spends at most one ray per call, whatever the candidate count', () => {
    const self = selfAt();
    const crowd = [cand(1, 0, 10), cand(2, 0, 12), cand(3, 0, 14), cand(4, 0, 16)];
    const { los, count } = countingLos();
    acquireVisual(self, crowd, null, 0, los);
    expect(count()).toBe(1);
    const { los: losB, count: countB } = blockedLos();
    acquireVisual(self, crowd, null, 0, losB);
    expect(countB()).toBe(1);
  });

  it('returns no observation and a null attempt for an empty candidate list', () => {
    const self = selfAt();
    const { los, count } = countingLos();
    const r = acquireVisual(self, [], null, 3, los);
    expect(r.observation).toBeNull();
    expect(r.attempted).toBeNull();
    expect(r.cursor).toBe(0);
    expect(count()).toBe(0);
  });
});

describe('acquireVisual observations', () => {
  it('copies feet and eye vectors — the candidate is never aliased', () => {
    const self = selfAt();
    const c = cand(1, 3, 4);
    const r = acquireVisual(self, [c], null, 0, () => true);
    const obs = r.observation!;
    expect(obs.feet).not.toBe(c.feet);
    expect(obs.eye).not.toBe(c.eye);
    c.feet.set(100, 100, 100);
    c.eye.set(100, 100, 100);
    expect(obs.feet.x).toBe(3);
    expect(obs.feet.z).toBe(4);
    expect(obs.eye.y).toBe(1.9);
  });

  it('derives planar distance, eye-to-eye 3D distance and rise', () => {
    const self = selfAt();
    // Feet 8 m up at planar offset (3, 4): planar dist 5, rise 8, eye-to-eye
    // hypot(5, 8) — both eyes 1.9 m up so the eye offset is planar + rise.
    const c = cand(1, 3, 4, { feetY: 8, eyeY: 8 + 1.9 });
    const obs = acquireVisual(self, [c], null, 0, () => true).observation!;
    expect(obs.dist).toBeCloseTo(5, 12);
    expect(obs.rise).toBeCloseTo(8, 12);
    expect(obs.dist3).toBeCloseTo(Math.hypot(5, 8), 12);
  });

  it('keeps the observed identity alongside the geometry', () => {
    const self = selfAt();
    const obs = acquireVisual(self, [cand('player', 0, 10)], null, 0, () => true).observation!;
    expect(obs.id).toBe('player');
  });
});
