import { describe, expect, test, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  solids, colliders, navLinks, resetWorld, stairLink,
  createSolidBox, registerSolid, registerSolidBox, registerGroupParts,
} from './world';

const box = (w = 1, h = 1, d = 1): THREE.Mesh =>
  new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial());

beforeEach(resetWorld);

describe('registerSolidBox', () => {
  test('registers in BOTH registries', () => {
    // The `431ac6e` no-clip bug was exactly this: solids only, no collider.
    const mesh = box();
    registerSolidBox(mesh);
    expect(solids).toContain(mesh);
    expect(colliders).toHaveLength(1);
  });

  test('the AABB matches the mesh world position', () => {
    const mesh = box(2, 2, 2);
    mesh.position.set(10, 0, -5);
    registerSolidBox(mesh);
    const centre = colliders[0]!.getCenter(new THREE.Vector3());
    expect(centre.x).toBeCloseTo(10, 6);
    expect(centre.z).toBeCloseTo(-5, 6);
  });

  test('returns the mesh so callers can chain', () => {
    const mesh = box();
    expect(registerSolidBox(mesh)).toBe(mesh);
  });
});

describe('registerSolid', () => {
  test('adds a raycast target with NO movement AABB', () => {
    // Ground planes: bullets and decals need them, but an AABB would be a
    // zero-height box at y ~ 0 — always steppable, so it could never block
    // anything. Geometry with real height must NOT come through here.
    registerSolid(box());
    expect(solids).toHaveLength(1);
    expect(colliders).toHaveLength(0);
  });
});

describe('registerGroupParts', () => {
  /** A range-target-shaped group: parts positioned locally, group moved away. */
  function target(x: number, z: number) {
    const group = new THREE.Group();
    const post = box(0.15, 1, 0.15);
    const head = box(0.34, 0.34, 0.34);
    head.position.y = 2.0;
    group.add(post, head);
    group.position.set(x, 0, z);
    return { group, post, head };
  }

  test('resolves AABBs at the group world position, not the origin', () => {
    // `faa52c5`: Box3.setFromObject composes against the parent's CURRENT
    // matrixWorld, which is identity until the first render — so without the
    // flush every target's collision box landed at (0,0,0).
    const { group, post, head } = target(-4.5, -25);
    registerGroupParts(group, { shootable: [head], blocking: [post, head] });

    for (const c of colliders) {
      const centre = c.getCenter(new THREE.Vector3());
      expect(centre.x).toBeCloseTo(-4.5, 6);
      expect(centre.z).toBeCloseTo(-25, 6);
    }
  });

  test('and that assertion is not vacuous — without the flush they land at origin', () => {
    // Reproduces the pre-fix behavior directly, so the test above is known to
    // be testing something real.
    const { post } = target(-4.5, -25);
    const unflushed = new THREE.Box3().setFromObject(post);
    const centre = unflushed.getCenter(new THREE.Vector3());
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.z).toBeCloseTo(0, 6);
  });

  test('honours the shootable/blocking asymmetry', () => {
    // A range target's post blocks walking but is not a bullet target.
    const { group, post, head } = target(0, -10);
    registerGroupParts(group, { shootable: [head], blocking: [post, head] });
    expect(solids).toEqual([head]);
    expect(solids).not.toContain(post);
    expect(colliders).toHaveLength(2);
  });

  test('defaults both lists to empty', () => {
    registerGroupParts(new THREE.Group(), {});
    expect(solids).toHaveLength(0);
    expect(colliders).toHaveLength(0);
  });
});

describe('createSolidBox', () => {
  test('`y` is the BASE of the box, not its centre', () => {
    // The only line encoding this convention. Callers place walls and crates
    // by the ground they stand on, so a box of height 3 based at y=0 must
    // span 0..3 — not -1.5..1.5.
    registerSolidBox(createSolidBox(0, 0, 0, 2, 3, 2));
    expect(colliders[0]!.min.y).toBeCloseTo(0, 6);
    expect(colliders[0]!.max.y).toBeCloseTo(3, 6);
  });

  test('and that assertion is not vacuous — without the lift it straddles y=0', () => {
    // Reproduces the un-lifted behavior directly: BoxGeometry centred on the
    // origin sinks half its height below the floor.
    const mesh = createSolidBox(0, 0, 0, 2, 3, 2);
    mesh.position.set(0, 0, 0); // drop the + h / 2
    const sunk = new THREE.Box3().setFromObject(mesh);
    expect(sunk.min.y).toBeCloseTo(-1.5, 6);
  });

  test('a raised box is based at `y`, so it clears the ground', () => {
    // maps/arena.ts stacks crates this way: addSolidBox(-9, 3, ..., 3, 3, 3).
    registerSolidBox(createSolidBox(0, 3, 0, 3, 3, 3));
    expect(colliders[0]!.min.y).toBeCloseTo(3, 6);
    expect(colliders[0]!.max.y).toBeCloseTo(6, 6);
  });

  test('is pure — no scene, no registration', () => {
    const mesh = createSolidBox(0, 0, 0, 1, 1, 1);
    expect(mesh.parent).toBe(null);
    expect(solids).toHaveLength(0);
    expect(colliders).toHaveLength(0);
  });
});

// stairLink — the endpoints navigation aims at.
//
// Every expectation below is the coordinate the MAP states in its own
// comments, not a number re-derived from the formula: maps/elevation.ts says
// its internal flight "tops out at exactly DECK_Y, flush with the slab's south
// edge at z = 0" and its external one lands "against the building at z = 12.5".
// If the arithmetic here and the geometry there ever disagree, bots route to a
// point no staircase reaches, and nothing else in the suite would notice.
describe('stairLink', () => {
  const STEP_H = 0.3, STEP_D = 0.75;

  test("elevation's internal flight: 12 risers to the slab's south edge", () => {
    const link = stairLink(4, 0, -9, 4, STEP_H, STEP_D, 12, 'z+');
    expect([link.bottom.x, link.bottom.y, link.bottom.z]).toEqual([4, 0, -9]);
    expect(link.top.x).toBeCloseTo(4, 12);
    expect(link.top.y).toBeCloseTo(3.6, 12); // DECK_Y
    expect(link.top.z).toBeCloseTo(0, 12);
  });

  test("elevation's external flight ascends z- to the building face", () => {
    const link = stairLink(8, 0, 21.5, 4, STEP_H, STEP_D, 12, 'z-');
    expect(link.top.y).toBeCloseTo(3.6, 12);
    expect(link.top.z).toBeCloseTo(12.5, 12);
  });

  test("elevation's tower flight abuts the tower's south face", () => {
    const link = stairLink(35, 0, 15.5, 4, STEP_H, STEP_D, 12, 'z-');
    expect(link.top.y).toBeCloseTo(3.6, 12);
    expect(link.top.z).toBeCloseTo(6.5, 12);
  });

  test("elevation's plateau flight ascends x- to the plateau's east face", () => {
    // 6 m wide, unlike the 4 m flights — navigation reads halfWidth to tell
    // which sampled nodes count as being ON the flight.
    const link = stairLink(-19.5, 0, -30, 6, STEP_H, STEP_D, 10, 'x-');
    expect(link.halfWidth).toBe(3);
    expect(link.top.x).toBeCloseTo(-27, 12);
    expect(link.top.y).toBeCloseTo(3, 12); // the plateau's lower tier
    expect(link.top.z).toBeCloseTo(-30, 12);
  });

  test("arena's flight reaches the 2.4 m platform", () => {
    const link = stairLink(26, 0, 24, 4, STEP_H, STEP_D, 8, 'z+');
    expect(link.top.y).toBeCloseTo(2.4, 12);
    expect(link.top.z).toBeCloseTo(30, 12);
  });

  test('a flight based above ground carries its base into both ends', () => {
    const link = stairLink(0, 5, 0, 4, STEP_H, STEP_D, 4, 'x+');
    expect(link.bottom.y).toBe(5);
    expect(link.top.y).toBeCloseTo(6.2, 12);
    expect(link.top.x).toBeCloseTo(3, 12);
  });
});

describe('resetWorld', () => {
  test('empties every registry in place', () => {
    const before = { solids, colliders, navLinks };
    registerSolidBox(box());
    navLinks.push(stairLink(0, 0, 0, 4, 0.3, 0.75, 4, 'z+'));
    resetWorld();
    expect(solids).toHaveLength(0);
    expect(colliders).toHaveLength(0);
    expect(navLinks).toHaveLength(0);
    // Same array identities — importers hold references to these.
    expect(before.solids).toBe(solids);
    expect(before.colliders).toBe(colliders);
    expect(before.navLinks).toBe(navLinks);
  });
});
