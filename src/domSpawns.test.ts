import { beforeEach, describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { BOT_SPAWNS, DOM_FLAGS, dom, resetDom, session } from './core/state';
import { pickDomRespawn } from './domSpawns';
import { colliders, resetWorld } from './world';

/** Deterministic PRNG (LCG) for share checks. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Elevation fixture: A crowns the plateau at (-38,3.0,-30), B the slab at
// (0,3.6,0); the T home pocket is x 10..50, z -55..-30 at y 0. Neither ring
// (outer 10 m) reaches the other ring or the T pocket, so classifying a
// respawn by planar distance is unambiguous.
const A = { x: -38, y: 3.0, z: -30 };
const B = { x: 0, y: 3.6, z: 0 };

beforeEach(() => {
  session.map = 'elevation';
  resetDom(DOM_FLAGS.elevation);
  dom.flags[0]!.owner = 'T';
  dom.flags[1]!.owner = 'T';
});

describe('pickDomRespawn', () => {
  test('a constant stream pins the zone pick and the point draw', () => {
    // 0 selects owned[0] (A); angle 0 and radius fraction 0 hug the inner edge.
    const a = pickDomRespawn('T', () => 0, () => true);
    expect([a.x, a.y, a.z]).toEqual([A.x + 4, A.y, A.z]);
  });

  test('0.5 selects the second owned flag (B)', () => {
    const b = pickDomRespawn('T', () => 0.5, () => true);
    expect(b.x).toBeCloseTo(B.x - Math.sqrt(58), 9);
    expect(b.y).toBe(B.y);
    expect(b.z).toBeCloseTo(B.z, 9);
  });

  test('a high draw selects the home zone rect', () => {
    const home = BOT_SPAWNS.elevation.T;
    const h = pickDomRespawn('T', () => 0.999, () => true);
    expect(h.x).toBeCloseTo(home.minX + 0.999 * (home.maxX - home.minX), 9);
    expect(h.y).toBe(home.y);
    expect(h.z).toBeCloseTo(home.minZ + 0.999 * (home.maxZ - home.minZ), 9);
  });

  test('no owned flags means the home zone, whatever the draw', () => {
    for (const f of dom.flags) f.owner = null;
    const home = BOT_SPAWNS.elevation.T;
    const h = pickDomRespawn('T', () => 0, () => true);
    expect([h.x, h.y, h.z]).toEqual([home.minX, home.y, home.minZ]);
  });

  test('a walled first zone falls through to the next zone, not home', () => {
    // Every A-ring point collides; B accepts. The forced-A stream (first draw
    // 0) must still land on B after the zone budget, skipping nothing.
    const nearA = (c: { x: number; z: number }): boolean =>
      Math.hypot(c.x - A.x, c.z - A.z) > 10;
    const b = pickDomRespawn('T', () => 0, nearA);
    expect(Math.hypot(b.x - B.x, b.z - B.z)).toBeLessThanOrEqual(10);
    expect(b.y).toBe(B.y);
  });

  test('a fully walled map returns the last draw instead of hanging', () => {
    const home = BOT_SPAWNS.elevation.T;
    const h = pickDomRespawn('T', () => 0, () => false);
    // Order is A, B, home; the last draw is the home rect at fractions 0,0.
    expect([h.x, h.y, h.z]).toEqual([home.minX, home.y, home.minZ]);
  });

  test('a ring draw over a stairwell void is rejected by the live gate', () => {
    // Only B owned, so the zones are [B-ring, home]. A 3x3 deck slab under
    // B leaves the constant-stream ring draw (angle 0, radius fraction 0 →
    // 4 m past the deck edge, support 2+ m below) over the void.
    // collidesAt alone would accept it — nothing rises above the feet
    // there — so the live standableAt gate must refuse all 16 draws and
    // fall through to the home zone instead of spawning midair.
    for (const f of dom.flags) f.owner = null;
    dom.flags[1]!.owner = 'T';
    resetWorld();
    try {
      colliders.push(new THREE.Box3(
        new THREE.Vector3(B.x - 1.5, B.y - 0.3, B.z - 1.5),
        new THREE.Vector3(B.x + 1.5, B.y, B.z + 1.5),
      ));
      const p = pickDomRespawn('T', () => 0);
      const home = BOT_SPAWNS.elevation.T;
      expect([p.x, p.y, p.z]).toEqual([home.minX, home.y, home.minZ]);
    } finally {
      resetWorld();
    }
  });

  test('A+B owned deals ~1/3 each across seeded respawns', () => {
    const home = BOT_SPAWNS.elevation.T;
    const rng = lcg(1234);
    let a = 0;
    let b = 0;
    let homeCount = 0;
    const n = 900;
    for (let i = 0; i < n; i++) {
      const p = pickDomRespawn('T', rng, () => true);
      if (Math.hypot(p.x - A.x, p.z - A.z) <= 10.001) a++;
      else if (Math.hypot(p.x - B.x, p.z - B.z) <= 10.001) b++;
      else {
        expect(p.x).toBeGreaterThanOrEqual(home.minX);
        expect(p.x).toBeLessThanOrEqual(home.maxX);
        expect(p.z).toBeGreaterThanOrEqual(home.minZ);
        expect(p.z).toBeLessThanOrEqual(home.maxZ);
        expect(p.y).toBe(home.y);
        homeCount++;
      }
    }
    for (const c of [a, b, homeCount]) {
      expect(c / n).toBeGreaterThan(0.28);
      expect(c / n).toBeLessThan(0.39);
    }
  });
});
