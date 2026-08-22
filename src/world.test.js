import { describe, expect, test, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  solids, colliders, resetWorld,
  registerSolid, registerSolidBox, registerGroupParts,
} from './world.js';

const box = (w = 1, h = 1, d = 1) =>
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
    const centre = colliders[0].getCenter(new THREE.Vector3());
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
    // floor-height box the player is permanently standing inside.
    registerSolid(box());
    expect(solids).toHaveLength(1);
    expect(colliders).toHaveLength(0);
  });
});

describe('registerGroupParts', () => {
  /** A range-target-shaped group: parts positioned locally, group moved away. */
  function target(x, z) {
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

describe('resetWorld', () => {
  test('empties both registries in place', () => {
    const before = { solids, colliders };
    registerSolidBox(box());
    resetWorld();
    expect(solids).toHaveLength(0);
    expect(colliders).toHaveLength(0);
    // Same array identities — importers hold references to these.
    expect(before.solids).toBe(solids);
    expect(before.colliders).toBe(colliders);
  });
});
